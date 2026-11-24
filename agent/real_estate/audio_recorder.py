"""Two-way call recording for the Pipecat pipeline.

The previous implementation recorded a *LiveKit room* (rtc.AudioMixer / rtc.AudioStream). The pipeline now runs
directly on the Exotel websocket through Pipecat, so there is no room: the recorder was never started and
`state.recording_url` always stayed empty. This version uses Pipecat's AudioBufferProcessor, which sees both the
caller audio (input frames) and the agent audio (what was really sent to the line) and mixes them to mono.

    recorder = CallRecorder(call_id)
    pipeline = Pipeline([..., transport.output(), recorder.processor, ...])
    ...
    url = await recorder.finalize()      # after the pipeline has ended -> WAV -> MP3 -> S3, returns stream URL
"""
import asyncio
import logging
import os
import shutil
import subprocess
import wave
from typing import Optional

from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor

logger = logging.getLogger("audio_recorder")


def get_recordings_dir() -> str:
    # Explicitly prioritize RECORDING_STORAGE_DIR if configured
    env_dir = os.environ.get("RECORDING_STORAGE_DIR")
    if env_dir:
        os.makedirs(env_dir, exist_ok=True)
        return env_dir

    candidates = [
        os.path.abspath(os.path.join(os.path.dirname(__file__), "../../recordings")),
        os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../recordings")),
        os.path.abspath("./recordings"),
        os.path.abspath("../recordings"),
        "/app/recordings",
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    fallback = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../recordings"))
    os.makedirs(fallback, exist_ok=True)
    return fallback


class CallRecorder:
    """Streams the mixed call audio into <recordings>/<call_id>.wav while the call runs (so a crash loses at most
    a few seconds), then converts to MP3 and uploads to S3 in finalize()."""

    def __init__(self, call_id: str, sample_rate: int = 16000):
        self.call_id = call_id
        self.sample_rate = sample_rate
        self.recordings_dir = get_recordings_dir()
        self.wav_path = os.path.join(self.recordings_dir, f"{call_id}.wav")
        self.mp3_path = os.path.join(self.recordings_dir, f"{call_id}.mp3")
        self._wav: Optional[wave.Wave_write] = None
        self._bytes = 0
        self._finalized = False
        self._final_result: Optional[str] = None

        # buffer_size is in bytes of 16-bit mono PCM -> flush to disk every 1 second so even short calls get saved.
        self.processor = AudioBufferProcessor(
            sample_rate=sample_rate,
            num_channels=1,
            buffer_size=sample_rate * 2 * 1,
            auto_start_recording=True,
        )

        @self.processor.event_handler("on_audio_data")
        async def _on_audio_data(_proc, audio: bytes, sample_rate: int, num_channels: int):
            self._write(audio, sample_rate, num_channels)

    # ── capture ──────────────────────────────────────────────────────────
    def _write(self, audio: bytes, sample_rate: int, num_channels: int):
        if not audio or not self.call_id:
            return
        try:
            if self._wav is None:
                os.makedirs(self.recordings_dir, exist_ok=True)
                self._wav = wave.open(self.wav_path, "wb")
                self._wav.setnchannels(num_channels)
                self._wav.setsampwidth(2)
                self._wav.setframerate(sample_rate)
                logger.info(f"🎙️ Recording call {self.call_id} -> {self.wav_path} ({sample_rate} Hz)")
            self._wav.writeframes(audio)
            self._bytes += len(audio)
        except Exception as e:
            logger.warning(f"Recorder write failed: {e}")

    async def stop_capture(self):
        """Flush whatever is still buffered and close the WAV. Call once the pipeline has finished."""
        try:
            await self.processor.stop_recording()  # triggers a last on_audio_data with the remaining audio
        except Exception as e:
            logger.debug(f"stop_recording: {e}")
        if self._wav is not None:
            try:
                self._wav.close()
            except Exception as e:
                logger.warning(f"Error closing wav file: {e}")
            self._wav = None

    # ── finalize: WAV -> MP3 -> S3 ───────────────────────────────────────
    async def finalize(self) -> Optional[str]:
        """Returns the backend stream URL only if a real audio file exists."""
        if self._finalized:
            return self._final_result
        self._finalized = True
        await self.stop_capture()

        if os.path.exists(self.wav_path) and os.path.getsize(self.wav_path) > 44:
            ffmpeg_bin = shutil.which("ffmpeg")
            if ffmpeg_bin:
                try:
                    base = [ffmpeg_bin, "-y", "-i", self.wav_path]
                    tail = ["-codec:a", "libmp3lame", "-b:a", "64k", self.mp3_path]
                    proc = await asyncio.to_thread(
                        subprocess.run, base + ["-af", "dynaudnorm=f=150:g=15"] + tail,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60.0,
                    )
                    if proc.returncode != 0:
                        proc = await asyncio.to_thread(
                            subprocess.run, base + tail,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60.0,
                        )
                    if proc.returncode == 0 and os.path.exists(self.mp3_path) and os.path.getsize(self.mp3_path) > 44:
                        logger.info(f"✅ Converted recording to MP3: {self.mp3_path} ({os.path.getsize(self.mp3_path)} bytes)")
                        try:
                            os.remove(self.wav_path)
                        except OSError:
                            pass
                except Exception as e:
                    logger.warning(f"ffmpeg conversion failed (keeping WAV): {e}")
            else:
                logger.warning("ffmpeg not found on PATH; keeping WAV recording")

        final_file = self.mp3_path if os.path.exists(self.mp3_path) else self.wav_path
        if os.path.exists(final_file) and os.path.getsize(final_file) > 44:
            logger.info(f"📁 Recording preserved at {final_file} ({os.path.getsize(final_file)} bytes)")
            s3_url = None
            try:
                s3_url = await self._upload_to_s3(final_file)
            except Exception as e:
                logger.warning(f"S3 upload attempt encountered error: {e}")

            if s3_url:
                # Backend stream URL: the browser plays seekable audio through the backend proxy (no S3 CORS issues)
                self._final_result = self.get_stream_url()
            else:
                s3_configured = bool(os.environ.get("S3_BUCKET"))
                allow_local = os.environ.get("ALLOW_LOCAL_RECORDING_STREAM", "false").lower() in ("true", "1", "yes")
                if not s3_configured or allow_local:
                    self._final_result = self.get_stream_url()
                else:
                    logger.warning(f"S3 upload failed for call {self.call_id}; suppressing local stream URL to prevent dead links.")
                    self._final_result = None
        else:
            logger.warning(f"No usable audio was captured for call {self.call_id} ({self._bytes} bytes)")
            self._final_result = None
        return self._final_result

    async def _upload_to_s3(self, file_path: str) -> Optional[str]:
        bucket = os.environ.get("S3_BUCKET")
        access_key = os.environ.get("AWS_ACCESS_KEY_ID")
        secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
        region = os.environ.get("S3_REGION", "ap-south-1")
        if not (bucket and access_key and secret_key):
            return None

        is_mp3 = file_path.endswith(".mp3")
        content_type = "audio/mpeg" if is_mp3 else "audio/wav"
        s3_key = f"recordings/{self.call_id}.{'mp3' if is_mp3 else 'wav'}"

        def _sync_upload():
            import boto3
            from botocore.config import Config
            s3_client = boto3.client(
                "s3",
                region_name=region,
                aws_access_key_id=access_key,
                aws_secret_access_key=secret_key,
                config=Config(signature_version="s3v4"),
            )
            s3_client.upload_file(
                file_path, bucket, s3_key,
                ExtraArgs={"ContentType": content_type, "Metadata": {"call-id": str(self.call_id)}},
            )
            return f"https://{bucket}.s3.{region}.amazonaws.com/{s3_key}"

        try:
            s3_url = await asyncio.to_thread(_sync_upload)
            logger.info(f"☁️ Recording uploaded to S3: {s3_url}")
            return s3_url
        except Exception as e:
            logger.warning(f"Failed to upload audio to S3 (kept locally at {file_path}): {e}")
            return None

    def get_stream_url(self) -> str:
        return f"/api/calls/{self.call_id}/audio"
        