import os
import wave
import shutil
import asyncio
import logging
import subprocess
from typing import Optional, List, Dict, Callable, AsyncIterator
import livekit.rtc as rtc

logger = logging.getLogger("audio_recorder")


def get_recordings_dir() -> str:
    # Set RECORDING_STORAGE_DIR to the SAME absolute path for the agent and the backend.
    candidates = [
        os.environ.get("RECORDING_STORAGE_DIR"),
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


async def _frame_stream(stream: rtc.AudioStream) -> AsyncIterator[rtc.AudioFrame]:
    """AudioStream yields AudioFrameEvent; AudioMixer wants raw AudioFrame objects."""
    async for event in stream:
        if hasattr(event, "frame") and event.frame:
            yield event.frame
        elif hasattr(event, "data"):
            yield event


class RoomAudioRecorder:
    """Records two-way call audio (caller + agent) into <recordings>/<call_id>.mp3.

    Lifecycle is split in two so the phone line can be dropped immediately:
      stop_capture()  fast: stops streams, closes the WAV           (call before hanging up)
      finalize()      slow: ffmpeg WAV->MP3 + S3 upload             (call after hanging up)
      stop()          both, kept for backwards compatibility
    """

    def __init__(self, call_id: str, sample_rate: int = 16000):
        self.call_id = call_id
        self.sample_rate = sample_rate
        self.recordings_dir = get_recordings_dir()
        self.wav_path = os.path.join(self.recordings_dir, f"{call_id}.wav")
        self.mp3_path = os.path.join(self.recordings_dir, f"{call_id}.mp3")
        self.mixer: Optional[rtc.AudioMixer] = None
        self._streams: List[rtc.AudioStream] = []
        self._attached_keys = set()
        self._write_task: Optional[asyncio.Task] = None
        self._scan_task: Optional[asyncio.Task] = None
        self._wav_file: Optional[wave.Wave_write] = None
        self._frames_written = 0
        self._room: Optional[rtc.Room] = None
        self._handlers: Dict[str, Callable] = {}
        self._started = False
        self._stopped = False          # no more attaching / writing
        self._capture_closed = False
        self._finalized = False
        self._final_result: Optional[str] = None

    # ── start ────────────────────────────────────────────────────────────
    async def start(self, room: rtc.Room) -> None:
        if not self.call_id:
            logger.error("RoomAudioRecorder: no call_id, recording is DISABLED for this call.")
            return

        self._room = room
        try:
            os.makedirs(self.recordings_dir, exist_ok=True)
            self._wav_file = wave.open(self.wav_path, "wb")
            self._wav_file.setnchannels(1)
            self._wav_file.setsampwidth(2)  # 16-bit
            self._wav_file.setframerate(self.sample_rate)

            self.mixer = rtc.AudioMixer(sample_rate=self.sample_rate, num_channels=1)
            self._started = True
            self._write_task = asyncio.create_task(self._writer_loop())

            def on_track_subscribed(track: rtc.Track, publication, participant):
                if track.kind == rtc.TrackKind.KIND_AUDIO:
                    part_id = getattr(participant, "identity", "caller")
                    logger.info(f"🎙️ Subscribed to audio track from caller: {part_id}")
                    self._attach_track(track, label=f"caller:{part_id}")

            def on_local_track_published(publication, track: rtc.Track):
                target = track or getattr(publication, "track", None)
                if target and target.kind == rtc.TrackKind.KIND_AUDIO:
                    logger.info("🎙️ Captured local agent audio track")
                    self._attach_track(target, label="agent:local")

            def on_local_track_republished(publication, previous_sid: str):
                target = getattr(publication, "track", None)
                if target and target.kind == rtc.TrackKind.KIND_AUDIO:
                    self._attach_track(target, label="agent:republished")

            self._handlers = {
                "track_subscribed": on_track_subscribed,
                "local_track_published": on_local_track_published,
                "local_track_republished": on_local_track_republished,
            }
            for ev, fn in self._handlers.items():
                room.on(ev, fn)

            # Attach tracks that already exist, then keep scanning (agent TTS track can appear late)
            self._scan_and_attach_tracks()
            self._scan_task = asyncio.create_task(self._scan_loop())

            logger.info(f"🎙️ RoomAudioRecorder started for call {self.call_id} -> {self.wav_path}")
        except Exception as e:
            logger.error(f"Failed to start RoomAudioRecorder: {e}", exc_info=True)

    def _scan_and_attach_tracks(self) -> None:
        if not self._room or not self.mixer or self._stopped:
            return
        try:
            for p in self._room.remote_participants.values():
                for pub in p.track_publications.values():
                    if pub.track and pub.track.kind == rtc.TrackKind.KIND_AUDIO:
                        self._attach_track(pub.track, label=f"caller:{getattr(p, 'identity', 'remote')}")
            if self._room.isconnected():
                lp = self._room.local_participant
                if lp and lp.track_publications:
                    for pub in lp.track_publications.values():
                        if pub.track and pub.track.kind == rtc.TrackKind.KIND_AUDIO:
                            self._attach_track(pub.track, label="agent:local_pub")
        except Exception as e:
            logger.debug(f"Error scanning tracks: {e}")

    def _attach_track(self, track: rtc.Track, label: str = "track") -> None:
        if not self.mixer or self._stopped:
            return
        # Key by SID only: the same track can reach us as different Python objects, and attaching it
        # twice doubles the audio.
        track_key = getattr(track, "sid", None) or str(id(track))
        if track_key in self._attached_keys:
            return
        self._attached_keys.add(track_key)
        try:
            stream = rtc.AudioStream(track, sample_rate=self.sample_rate, num_channels=1)
            self._streams.append(stream)
            self.mixer.add_stream(_frame_stream(stream))
            logger.info(f"🎙️ Attached {track_key} ({label}) to mixer (streams: {len(self._streams)})")
        except Exception as e:
            self._attached_keys.discard(track_key)
            logger.warning(f"Could not attach audio track {track_key} ({label}): {e}")

    async def _scan_loop(self) -> None:
        try:
            while not self._stopped:
                await asyncio.sleep(0.8)
                self._scan_and_attach_tracks()
        except asyncio.CancelledError:
            pass

    async def _writer_loop(self) -> None:
        # Plain `async for`: never cancel mixer.__anext__() with wait_for() (that can wedge the iterator).
        try:
            async for frame in self.mixer:
                if frame is not None and frame.data and self._wav_file:
                    self._wav_file.writeframes(bytes(frame.data))
                    self._frames_written += 1
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"Audio recorder writer exception: {e}")

    # ── stop (fast part) ─────────────────────────────────────────────────
    async def stop_capture(self) -> None:
        if not self._started or self._capture_closed:
            return
        self._capture_closed = True
        self._stopped = True
        logger.info(f"Stopping audio capture for call {self.call_id} (frames: {self._frames_written}, streams: {len(self._streams)})")

        if self._room:
            for ev, fn in self._handlers.items():
                try:
                    self._room.off(ev, fn)
                except Exception:
                    pass

        await asyncio.sleep(0.2)  # let in-flight audio flush

        if self._scan_task and not self._scan_task.done():
            self._scan_task.cancel()

        for s in self._streams:
            try:
                await s.aclose()
            except Exception:
                pass
        self._streams.clear()

        if self.mixer:
            try:
                await self.mixer.aclose()
            except Exception:
                pass

        if self._write_task and not self._write_task.done():
            try:
                await asyncio.wait_for(self._write_task, timeout=3.0)
            except Exception:
                self._write_task.cancel()

        if self._wav_file:
            try:
                self._wav_file.close()
            except Exception as e:
                logger.warning(f"Error closing wav file: {e}")
            self._wav_file = None

    # ── stop (slow part) ─────────────────────────────────────────────────
    async def finalize(self) -> Optional[str]:
        """WAV -> MP3, upload to S3. Returns the stream URL only if a real audio file exists."""
        if self._finalized:
            return self._final_result
        self._finalized = True
        if not self._started:
            return None
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
            try:
                await self._upload_to_s3(final_file)
            except Exception as e:
                logger.warning(f"S3 upload attempt encountered error: {e}")
            self._final_result = self.get_stream_url()
        else:
            logger.warning(f"No usable audio was captured for call {self.call_id} (frames: {self._frames_written})")
            self._final_result = None
        return self._final_result

    async def stop(self) -> Optional[str]:
        await self.stop_capture()
        return await self.finalize()

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
        