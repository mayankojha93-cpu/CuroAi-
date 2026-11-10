import os
import sys
import json
import base64
import asyncio
import audioop
import logging
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from dotenv import load_dotenv

import websockets
from livekit import rtc, api

# Configure paths & env
ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [Exotel-WSS-Bridge]: %(message)s"
)
logger = logging.getLogger("exotel-wss-bridge")

LIVEKIT_URL = os.getenv("LIVEKIT_URL", "wss://ai-calling-agent-ztoubtgz.livekit.cloud")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "")
BRIDGE_PORT = int(os.getenv("EXOTEL_BRIDGE_PORT", "8088"))


class ExotelSession:
    def __init__(self, websocket, path: str):
        self.ws = websocket
        self.path = path
        self.stream_sid = None
        self.call_sid = None
        self.call_id = None
        self.phone = None
        self.room = None
        self.source = None
        self.is_running = True
        self.is_mulaw = False  # Exotel default is 16-bit linear PCM (s16le) at 128kbps
        self.sample_rate = 8000
        self.ratecv_state_in = None
        self.ratecv_state_out = None
        self.out_task = None
        self.in_frames_count = 0
        self.in_bytes_count = 0
        self.out_frames_count = 0
        self.out_bytes_count = 0

        # Parse query params from path if present
        parsed = urlparse(path)
        qs = parse_qs(parsed.query)
        if "callId" in qs:
            self.call_id = qs["callId"][0]
        if "phone" in qs:
            self.phone = qs["phone"][0]

        path_parts = [p for p in parsed.path.strip("/").split("/") if p]
        if len(path_parts) >= 3 and path_parts[-1] not in ("media-stream", "stream"):
            self.call_id = path_parts[-1]

    async def run(self):
        logger.info(f"[STEP 1] ⚡ Exotel WebSocket client connected on path: {self.path}")
        try:
            async for raw_msg in self.ws:
                if not self.is_running:
                    break
                try:
                    data = json.loads(raw_msg)
                except Exception as ex:
                    logger.warning(f"Failed to parse incoming JSON frame: {ex}")
                    continue

                event = data.get("event")
                if event == "connected":
                    logger.info("[STEP 2a] 🤝 Exotel handshake event: 'connected'")
                elif event == "start":
                    await self._handle_start(data)
                elif event == "media":
                    await self._handle_media(data)
                elif event == "stop":
                    logger.info(f"[STEP 7] 🛑 Exotel call stopped (streamSid: {self.stream_sid})")
                    break
                elif event == "clear":
                    logger.info("[STEP 6b] ⚡ Caller interruption / barge-in clear received from Exotel")

        except websockets.exceptions.ConnectionClosed:
            logger.info(f"🔌 Exotel WebSocket connection closed (callId: {self.call_id})")
        except Exception as e:
            logger.error(f"Error in ExotelSession loop: {e}", exc_info=True)
        finally:
            await self.cleanup()

    async def _handle_start(self, data: dict):
        logger.info(f"[STEP 2b] 📥 Received raw start payload: {json.dumps(data)}")
        start_data = data.get("start", {})

        # Extract stream_sid across possible keys
        self.stream_sid = (
            data.get("stream_sid") or data.get("streamSid") or
            start_data.get("stream_sid") or start_data.get("streamSid")
        )
        self.call_sid = (
            data.get("call_sid") or data.get("callSid") or
            start_data.get("call_sid") or start_data.get("callSid")
        )

        # Custom parameters sent by Exotel
        custom_params = start_data.get("custom_parameters") or start_data.get("customParameters") or {}
        if not self.call_id:
            self.call_id = custom_params.get("callId") or custom_params.get("call_id")
        if not self.phone:
            self.phone = custom_params.get("phone") or start_data.get("from")

        # Fallback 1: Query backend by call_sid
        if not self.call_id and self.call_sid:
            try:
                import urllib.request
                req = urllib.request.Request(f"http://127.0.0.1:3000/internal/calls/by-sid/{self.call_sid}")
                with urllib.request.urlopen(req, timeout=2.0) as resp:
                    cdata = json.loads(resp.read().decode())
                    self.call_id = cdata.get("id")
                    if not self.phone:
                        self.phone = cdata.get("phone")
                    logger.info(f"✅ Resolved callId from backend by Call SID {self.call_sid}: {self.call_id}")
            except Exception as e:
                logger.debug(f"Could not resolve call by SID: {e}")

        # Fallback 2: Query backend for most recent active dialing call
        if not self.call_id:
            try:
                import urllib.request
                req = urllib.request.Request("http://127.0.0.1:3000/internal/calls/active-dialing")
                with urllib.request.urlopen(req, timeout=2.0) as resp:
                    cdata = json.loads(resp.read().decode())
                    self.call_id = cdata.get("id")
                    if not self.phone:
                        self.phone = cdata.get("phone")
                    logger.info(f"✅ Resolved callId from backend latest active-dialing: {self.call_id}")
            except Exception as e:
                logger.debug(f"Could not resolve active dialing call: {e}")

        # Media format parsing
        media_format = start_data.get("media_format") or start_data.get("mediaFormat") or {}
        enc = str(media_format.get("encoding", "")).lower()
        # Exotel sends: encoding: 'base64', sample_rate: '8000', bit_rate: '128kbps'
        # 128kbps at 8000Hz = 16 bits per sample (16-bit linear PCM little-endian).
        # Only treat as mulaw if explicitly stated:
        self.is_mulaw = ("mulaw" in enc) or ("ulaw" in enc) or ("pcmu" in enc)

        sr = media_format.get("sample_rate") or media_format.get("sampleRate")
        if sr:
            try:
                self.sample_rate = int(sr)
            except ValueError:
                self.sample_rate = 8000

        codec_desc = "PCMU (mu-law)" if self.is_mulaw else "16-bit Linear PCM (s16le)"
        logger.info(
            f"[STEP 2c] 🎬 Call started: callId={self.call_id} | streamSid={self.stream_sid} | "
            f"callSid={self.call_sid} | format={codec_desc} @ {self.sample_rate}Hz"
        )

        if not self.call_id:
            logger.error("❌ [STEP 2 Error] No callId found in connection! Cannot map to LiveKit room.")
            return

        # Notify backend immediately that telephony is answered
        try:
            import urllib.request
            req = urllib.request.Request(
                f"http://127.0.0.1:3000/internal/real-estate/calls/{self.call_id}/answered",
                headers={"X-Internal-Secret": os.getenv("INTERNAL_SECRET", "internal-agent-secret")},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                logger.info(f"✅ Marked call {self.call_id} as answered in backend (HTTP {resp.status})")
        except Exception as ex:
            logger.debug(f"Could not notify backend answered: {ex}")

        room_name = f"re-call-{self.call_id}"
        participant_identity = f"phone-{str(self.phone or self.call_id).replace('+', '').replace(' ', '')}"

        # Step 3: Generate LiveKit Token
        logger.info(f"[STEP 3] 🔑 Generating LiveKit token for room={room_name}, identity={participant_identity}...")
        token = (
            api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
            .with_identity(participant_identity)
            .with_name(f"Caller ({self.phone or 'Lead'})")
            .with_attributes({
                "sip.callStatus": "active",
                "carrier": "exotel-wss",
                "streamSid": str(self.stream_sid or ""),
                "stream_sid": str(self.stream_sid or ""),
                "callSid": str(self.call_sid or ""),
                "call_sid": str(self.call_sid or "")
            })
            .with_grants(api.VideoGrants(room_join=True, room=room_name))
            .to_jwt()
        )

        self.room = rtc.Room()

        # Step 5: Listen for Priya's audio track publication and room lifecycle events
        @self.room.on("track_subscribed")
        def on_track_subscribed(track, publication, participant):
            if track.kind == rtc.TrackKind.KIND_AUDIO:
                logger.info(f"[STEP 5a] 🎙️ Subscribed to agent audio track ({participant.identity}): {track.sid}")
                if self.out_task and not self.out_task.done():
                    self.out_task.cancel()
                self.out_task = asyncio.create_task(self._stream_agent_to_exotel(track))

        @self.room.on("disconnected")
        def on_room_disconnected():
            logger.info(f"🚪 [DROPOUT] LiveKit room disconnected for callId={self.call_id}. Dropping Exotel telephony leg...")
            asyncio.create_task(self._dropout_exotel("LiveKit room disconnected"))

        @self.room.on("participant_disconnected")
        def on_participant_disconnected(participant):
            if not participant.identity.startswith("phone-"):
                logger.info(f"👋 [DROPOUT] Agent {participant.identity} finished conversation and left room. Dropping Exotel telephony leg...")
                asyncio.create_task(self._dropout_exotel("Agent left room"))

        logger.info(f"[STEP 3b] 🚪 Connecting bridge to LiveKit room: {room_name}...")
        await self.room.connect(LIVEKIT_URL, token)
        logger.info(f"[STEP 3c] ✅ Bridge joined LiveKit room {room_name} as participant (sip.callStatus=active)")

        # Step 4: Create audio source for microphone input into LiveKit (16kHz mono)
        self.source = rtc.AudioSource(16000, 1)
        track = rtc.LocalAudioTrack.create_audio_track("phone-mic", self.source)
        options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        await self.room.local_participant.publish_track(track, options)
        logger.info("[STEP 4] 🎤 Published caller microphone track into LiveKit room.")

        # Check if agent track is already present in room
        for p in self.room.remote_participants.values():
            for pub in p.track_publications.values():
                if pub.track and pub.track.kind == rtc.TrackKind.KIND_AUDIO:
                    logger.info(f"[STEP 5b] 🎙️ Found existing agent audio track from {p.identity}: {pub.track.sid}")
                    if self.out_task and not self.out_task.done():
                        self.out_task.cancel()
                    self.out_task = asyncio.create_task(self._stream_agent_to_exotel(pub.track))
                    break

    async def _handle_media(self, data: dict):
        """Receive caller speech from Exotel and stream it into LiveKit microphone."""
        if not self.source:
            return

        # Track stream_sid if not already set
        if not self.stream_sid:
            self.stream_sid = data.get("stream_sid") or data.get("streamSid")

        payload_b64 = data.get("media", {}).get("payload")
        if not payload_b64:
            return

        try:
            chunk = base64.b64decode(payload_b64)
            # 1. Decode to linear 16-bit PCM if mulaw
            if self.is_mulaw:
                chunk = audioop.ulaw2lin(chunk, 2)

            # 2. Resample to 16kHz if needed (LiveKit expects 16kHz)
            if self.sample_rate != 16000:
                chunk, self.ratecv_state_in = audioop.ratecv(
                    chunk, 2, 1, self.sample_rate, 16000, self.ratecv_state_in
                )

            # 3. Capture frame into LiveKit audio source
            samples_per_channel = len(chunk) // 2
            if samples_per_channel > 0:
                frame = rtc.AudioFrame(
                    data=chunk,
                    sample_rate=16000,
                    num_channels=1,
                    samples_per_channel=samples_per_channel
                )
                await self.source.capture_frame(frame)
                self.in_frames_count += 1
                self.in_bytes_count += len(chunk)
                if self.in_frames_count % 100 == 1:
                    logger.info(
                        f"👂 [Caller -> Priya] Audio frames received: {self.in_frames_count} "
                        f"({self.in_bytes_count} bytes into LiveKit)"
                    )
        except Exception as e:
            logger.error(f"Error handling caller audio frame: {e}")

    async def _stream_agent_to_exotel(self, track: rtc.Track):
        """Read audio frames from Priya and stream them to Exotel over WebSocket."""
        logger.info(
            f"[STEP 6] 🔊 Starting audio stream from Priya -> Exotel: "
            f"sample_rate={self.sample_rate}, is_mulaw={self.is_mulaw}, stream_sid={self.stream_sid}..."
        )
        audio_stream = rtc.AudioStream(track, sample_rate=16000, num_channels=1)
        buffer = bytearray()
        # For 8000Hz 16-bit mono PCM:
        # Exotel requires chunk sizes to be exact multiples of 320 bytes (e.g. 320, 640, 1600, 3200 bytes).
        # 640 bytes = 320 samples = 40ms of 8000Hz audio (smooth low latency).
        chunk_target_bytes = 640 if self.sample_rate == 8000 else 1280

        try:
            async for event in audio_stream:
                if not self.is_running:
                    break

                # Wait for stream_sid if not yet assigned
                if not self.stream_sid:
                    await asyncio.sleep(0.02)
                    continue

                raw_bytes = event.frame.data.tobytes()
                if not raw_bytes:
                    continue

                # 1. Resample from LiveKit 16kHz to Exotel sample rate (e.g. 8kHz)
                chunk = raw_bytes
                if self.sample_rate != 16000:
                    chunk, self.ratecv_state_out = audioop.ratecv(
                        chunk, 2, 1, 16000, self.sample_rate, self.ratecv_state_out
                    )

                # 2. Convert to mu-law ONLY if Exotel requested mu-law
                if self.is_mulaw:
                    chunk = audioop.lin2ulaw(chunk, 2)

                # 3. Buffer into chunks of chunk_target_bytes (multiples of 320 bytes)
                buffer.extend(chunk)
                while len(buffer) >= chunk_target_bytes:
                    packet = bytes(buffer[:chunk_target_bytes])
                    buffer = buffer[chunk_target_bytes:]

                    payload_b64 = base64.b64encode(packet).decode("utf-8")
                    msg = json.dumps({
                        "event": "media",
                        "stream_sid": self.stream_sid,
                        "streamSid": self.stream_sid,
                        "media": {
                            "payload": payload_b64
                        }
                    })
                    await self.ws.send(msg)
                    self.out_frames_count += 1
                    self.out_bytes_count += len(packet)

                    if self.out_frames_count % 50 == 1:
                        logger.info(
                            f"🗣️ [Priya -> Caller] Streamed audio packet #{self.out_frames_count}: "
                            f"{len(packet)} bytes (total {self.out_bytes_count} bytes sent to Exotel)"
                        )

            # Flush remaining buffer at end if any
            if buffer and self.stream_sid:
                # Pad to nearest multiple of 320 bytes
                pad_len = (320 - (len(buffer) % 320)) % 320
                if pad_len > 0:
                    buffer.extend(b"\x00" * pad_len)
                payload_b64 = base64.b64encode(bytes(buffer)).decode("utf-8")
                msg = json.dumps({
                    "event": "media",
                    "stream_sid": self.stream_sid,
                    "streamSid": self.stream_sid,
                    "media": {
                        "payload": payload_b64
                    }
                })
                await self.ws.send(msg)
                self.out_frames_count += 1
                self.out_bytes_count += len(buffer)
                buffer.clear()

        except asyncio.CancelledError:
            logger.info("Agent to Exotel audio task cancelled.")
        except Exception as e:
            logger.error(f"Error streaming agent audio to Exotel: {e}", exc_info=True)
        finally:
            logger.info(
                f"[STEP 6 End] Agent audio streaming ended. Sent {self.out_frames_count} packets "
                f"({self.out_bytes_count} bytes) to Exotel."
            )

    async def _dropout_exotel(self, reason: str = "Conversation completed"):
        """Immediately hangs up / drops the Exotel telephony leg by cleanly closing the WebSocket."""
        if not self.is_running:
            return
        self.is_running = False
        logger.info(f"🛑 [DROPOUT] Dropping Exotel call leg for callId={self.call_id} (Reason: {reason})")
        # Allow 400ms buffer for any final audio playback frames to reach Exotel
        await asyncio.sleep(0.4)
        if self.out_task and not self.out_task.done():
            self.out_task.cancel()
        if self.room:
            try:
                await self.room.disconnect()
            except Exception:
                pass
            self.room = None
        try:
            # Closing the WebSocket causes Exotel's telephony server to immediately hang up the call
            await self.ws.close(code=1000, reason=reason)
            logger.info("✅ [DROPOUT] Exotel WebSocket closed -> Telephony call line hung up.")
        except Exception as e:
            logger.debug(f"Error closing WebSocket on dropout: {e}")

    async def cleanup(self):
        self.is_running = False
        if self.out_task and not self.out_task.done():
            self.out_task.cancel()
        if self.room:
            try:
                await self.room.disconnect()
            except Exception:
                pass
            self.room = None
        logger.info(
            f"🧹 [CLEANUP] ExotelSession closed for callId={self.call_id} | "
            f"Summary: In={self.in_frames_count} frames ({self.in_bytes_count}B), "
            f"Out={self.out_frames_count} frames ({self.out_bytes_count}B)"
        )


async def ws_handler(websocket):
    path = "/"
    if hasattr(websocket, "request") and hasattr(websocket.request, "path"):
        path = websocket.request.path
    elif hasattr(websocket, "path"):
        path = websocket.path
    session = ExotelSession(websocket, path)
    await session.run()


async def main():
    logger.info(f"🚀 Exotel WSS Audio Bridge starting on 0.0.0.0:{BRIDGE_PORT}...")
    async with websockets.serve(ws_handler, "0.0.0.0", BRIDGE_PORT, max_size=10 * 1024 * 1024):
        logger.info(f"✅ Exotel WSS Audio Bridge is LIVE and listening on ws://0.0.0.0:{BRIDGE_PORT}/api/exotel/media-stream")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Bridge stopped by user.")
