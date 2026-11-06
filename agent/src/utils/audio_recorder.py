import os
import wave
import shutil
import asyncio
import logging
import subprocess
import time
from typing import Optional, List, Set, AsyncIterator
import livekit.rtc as rtc

logger = logging.getLogger("audio_recorder")


def get_recordings_dir() -> str:
    candidates = [
        os.environ.get("RECORDING_STORAGE_DIR"),
        os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../recordings")),
        os.path.abspath(os.path.join(os.path.dirname(__file__), "../../recordings")),
        os.path.abspath("./recordings"),
        os.path.abspath("../recordings"),
        "/app/recordings",
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    fallback = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../recordings"))
    os.makedirs(fallback, exist_ok=True)
    return fallback


async def _frame_stream(stream: rtc.AudioStream) -> AsyncIterator[rtc.AudioFrame]:
    """LiveKit AudioStream in v1.1+ yields AudioFrameEvent.

    AudioMixer expects raw AudioFrame instances. This adapter extracts
    event.frame so AudioMixer receives valid frames.
    """
    async for event in stream:
        if hasattr(event, "frame") and event.frame:
            yield event.frame
        elif hasattr(event, "data"):
            yield event


class RoomAudioRecorder:
    """Records two-way call audio (caller + agent) directly into ./recordings/<call_id>.mp3."""

    def __init__(self, call_id: str, sample_rate: int = 16000):
        self.call_id = call_id
        self.sample_rate = sample_rate
        self.recordings_dir = get_recordings_dir()
        self.wav_path = os.path.join(self.recordings_dir, f"{call_id}.wav")
        self.mp3_path = os.path.join(self.recordings_dir, f"{call_id}.mp3")
        self.mixer: Optional[rtc.AudioMixer] = None
        self._streams: List[rtc.AudioStream] = []
        self._attached_track_ids: Set[str] = set()
        self._write_task: Optional[asyncio.Task] = None
        self._stopped = False
        self._wav_file: Optional[wave.Wave_write] = None
        self._frames_written = 0
        self._room: Optional[rtc.Room] = None
        self._last_scan_time: float = 0.0

    async def start(self, room: rtc.Room) -> None:
        if not self.call_id:
            logger.warning("RoomAudioRecorder: No call_id provided, skipping recording.")
            return

        self._room = room
        try:
            os.makedirs(self.recordings_dir, exist_ok=True)
            self._wav_file = wave.open(self.wav_path, "wb")
            self._wav_file.setnchannels(1)
            self._wav_file.setsampwidth(2)  # 16-bit
            self._wav_file.setframerate(self.sample_rate)

            self.mixer = rtc.AudioMixer(sample_rate=self.sample_rate, num_channels=1)
            self._write_task = asyncio.create_task(self._writer_loop())

            # 1. Listen for remote participant audio tracks (caller)
            @room.on("track_subscribed")
            def on_track_subscribed(track: rtc.Track, publication, participant):
                if track.kind == rtc.TrackKind.KIND_AUDIO:
                    part_id = getattr(participant, "identity", "caller")
                    logger.info(f"🎙️ Subscribed to audio track from caller: {part_id}")
                    self._attach_track(track, label=f"caller:{part_id}")

            # 2. Listen for local agent audio tracks (agent)
            @room.on("local_track_published")
            def on_local_track_published(publication, track: rtc.Track):
                target = track or getattr(publication, "track", None)
                if target and target.kind == rtc.TrackKind.KIND_AUDIO:
                    logger.info("🎙️ Captured local agent audio track via local_track_published")
                    self._attach_track(target, label="agent:local")

            @room.on("local_track_republished")
            def on_local_track_republished(publication, previous_sid: str):
                target = getattr(publication, "track", None)
                if target and target.kind == rtc.TrackKind.KIND_AUDIO:
                    logger.info("🎙️ Re-attached local agent audio track via local_track_republished")
                    self._attach_track(target, label="agent:republished")

            # 3. Attach any tracks already active
            self._scan_and_attach_tracks()

            logger.info(f"🎙️ RoomAudioRecorder initialized for call {self.call_id} -> {self.wav_path}")
        except Exception as e:
            logger.error(f"Failed to start RoomAudioRecorder: {e}", exc_info=True)

    def _scan_and_attach_tracks(self) -> None:
        """Finds any remote or local audio tracks that are active and not yet attached."""
        if not self._room or not self.mixer or self._stopped:
            return

        try:
            # Remote caller tracks
            for p in self._room.remote_participants.values():
                for pub in p.track_publications.values():
                    if pub.track and pub.track.kind == rtc.TrackKind.KIND_AUDIO:
                        self._attach_track(pub.track, label=f"caller:{getattr(p, 'identity', 'remote')}")

            # Local agent tracks
            if self._room.isconnected():
                try:
                    lp = self._room.local_participant
                    if lp and lp.track_publications:
                        for pub in lp.track_publications.values():
                            if pub.track and pub.track.kind == rtc.TrackKind.KIND_AUDIO:
                                self._attach_track(pub.track, label="agent:local_pub")
                except Exception as ex:
                    logger.debug(f"Could not inspect local_participant: {ex}")
        except Exception as e:
            logger.debug(f"Error scanning tracks: {e}")

    def _attach_track(self, track: rtc.Track, label: str = "track") -> None:
        if not self.mixer or self._stopped:
            return
        track_key = f"{getattr(track, 'sid', '')}_{id(track)}"
        if track_key in self._attached_track_ids:
            return
        self._attached_track_ids.add(track_key)

        try:
            stream = rtc.AudioStream(track, sample_rate=self.sample_rate, num_channels=1)
            self._streams.append(stream)
            self.mixer.add_stream(_frame_stream(stream))
            logger.info(f"🎙️ Attached audio track {track_key} ({label}) to mixer (active streams: {len(self._streams)})")
        except Exception as e:
            logger.warning(f"Could not attach audio track {track_key} ({label}) to recorder: {e}")

    async def _writer_loop(self) -> None:
        while not self._stopped:
            # Periodically scan for tracks
            now = time.time()
            if now - self._last_scan_time > 0.8:
                self._last_scan_time = now
                self._scan_and_attach_tracks()

            try:
                frame = await asyncio.wait_for(self.mixer.__anext__(), timeout=0.15)
                if frame and frame.data and self._wav_file:
                    self._wav_file.writeframes(frame.data)
                    self._frames_written += 1
            except (asyncio.TimeoutError, StopAsyncIteration):
                continue
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Audio recorder writer exception: {e}")
                break

    async def stop(self) -> Optional[str]:
        if self._stopped:
            return self.get_stream_url()

        self._stopped = True
        logger.info(f"Stopping audio recorder for call {self.call_id} (frames: {self._frames_written}, streams: {len(self._streams)})")

        # Allow in-flight audio chunks to flush
        await asyncio.sleep(0.2)

        # Stop streams and mixer
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
            self._write_task.cancel()
            try:
                await self._write_task
            except Exception:
                pass

        if self._wav_file:
            try:
                self._wav_file.close()
            except Exception as e:
                logger.warning(f"Error closing wav file: {e}")
            self._wav_file = None

        # Convert to MP3 with dynamic audio normalization for crisp, balanced volume
        if os.path.exists(self.wav_path) and os.path.getsize(self.wav_path) > 44:
            ffmpeg_bin = shutil.which("ffmpeg")
            if ffmpeg_bin:
                try:
                    cmd = [
                        ffmpeg_bin,
                        "-y",
                        "-i", self.wav_path,
                        "-af", "dynaudnorm=f=150:g=15",
                        "-codec:a", "libmp3lame",
                        "-b:a", "64k",
                        self.mp3_path
                    ]
                    proc = await asyncio.to_thread(
                        subprocess.run, cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15.0
                    )
                    if proc.returncode != 0:
                        fallback_cmd = [
                            ffmpeg_bin,
                            "-y",
                            "-i", self.wav_path,
                            "-codec:a", "libmp3lame",
                            "-b:a", "64k",
                            self.mp3_path
                        ]
                        proc = await asyncio.to_thread(
                            subprocess.run, fallback_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15.0
                        )

                    if proc.returncode == 0 and os.path.exists(self.mp3_path) and os.path.getsize(self.mp3_path) > 44:
                        logger.info(f"✅ Converted call recording to MP3: {self.mp3_path} ({os.path.getsize(self.mp3_path)} bytes)")
                        try:
                            os.remove(self.wav_path)
                        except OSError:
                            pass
                except Exception as e:
                    logger.warning(f"ffmpeg conversion to MP3 failed (keeping WAV): {e}")

        final_file = self.mp3_path if os.path.exists(self.mp3_path) else self.wav_path
        if os.path.exists(final_file) and os.path.getsize(final_file) > 44:
            logger.info(f"📁 Audio recording successfully preserved at {final_file} ({os.path.getsize(final_file)} bytes)")
            return self.get_stream_url()
        return None

    def get_stream_url(self) -> str:
        return f"/api/calls/{self.call_id}/audio"
