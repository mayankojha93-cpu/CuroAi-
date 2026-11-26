"""Exotel <-> Pipecat audio bridge.

Exotel opens a websocket to  /api/exotel/media-stream  (the Node backend proxies it here, see index.ts), sends
`connected` + `start` and then 8 kHz PCM `media` events. The old file re-implemented a complete Pipecat transport by
hand (own receive loop, own resampler, own 40 ms pacing, own clear handling, `audioop` which is removed in
Python 3.13). Pipecat already ships exactly this: FastAPIWebsocketTransport + ExotelFrameSerializer, which handle
resampling, packetisation, pacing, barge-in `clear` events and clean disconnects. This module now only does the
Exotel-specific handshake (resolve callId / phone / metadata) and then hands the socket to that transport.
"""
import asyncio
import json
import logging
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
AGENT_DIR = Path(__file__).resolve().parent
for p in (str(AGENT_DIR), str(ROOT_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

load_dotenv(AGENT_DIR / ".env")
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] [Exotel-WSS-Pipecat]: %(message)s")
logger = logging.getLogger("exotel-wss-pipecat")

import uvicorn  # noqa: E402
from fastapi import FastAPI, WebSocket, WebSocketDisconnect  # noqa: E402
from pipecat.serializers.exotel import ExotelFrameSerializer  # noqa: E402
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport  # noqa: E402
try:
    from pipecat.audio.filters.rnnoise_filter import RNNoiseFilter
except Exception as _filter_err:
    RNNoiseFilter = None
    logger.warning(f"Could not import RNNoiseFilter: {_filter_err}")

from real_estate.worker import run_real_estate_pipeline  # noqa: E402
from src.worker import run_airtel_pipeline  # noqa: E402
from logistics.worker import run_logistics_pipeline  # noqa: E402

BRIDGE_PORT = int(os.getenv("EXOTEL_BRIDGE_PORT", "8088"))
BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:3000").rstrip("/")
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "")
if not INTERNAL_SECRET:
    logger.warning("INTERNAL_SECRET is not set; backend /internal calls will be rejected.")

# Pipeline used when neither the URL/custom parameters nor the backend metadata say which agent this call is for.
# It used to fall through to the Airtel pipeline, so one failed metadata fetch ran the wrong agent.
DEFAULT_PIPELINE = os.getenv("EXOTEL_DEFAULT_PIPELINE", "real_estate").strip().lower()

# Real-time RNNoise filter for incoming caller audio stream (suppresses ambient noise, fans, traffic)
ENABLE_NOISE_CANCELLATION = os.getenv("ENABLE_NOISE_CANCELLATION", "1") == "1"

HANDSHAKE_TIMEOUT = float(os.getenv("EXOTEL_HANDSHAKE_TIMEOUT", "10"))
# Last-resort callId lookup ("newest call in DIALING state"). It can attach the WRONG call when several calls dial
# at the same time, so it is OFF unless explicitly enabled. Prefer passing callId as a query/custom parameter.
ALLOW_ACTIVE_DIALING_FALLBACK = os.getenv("EXOTEL_ALLOW_ACTIVE_DIALING_FALLBACK", "0") == "1"


def _http_sync(url: str, method: str = "GET", headers: Optional[dict] = None, timeout: float = 2.0):
    """Blocking HTTP call; always run through asyncio.to_thread()."""
    req = urllib.request.Request(url, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode()


def _auth() -> Dict[str, str]:
    return {"X-Internal-Secret": INTERNAL_SECRET}


async def _get_json(url: str, attempts: int = 3) -> Optional[Dict[str, Any]]:
    for i in range(1, attempts + 1):
        try:
            status, body = await asyncio.to_thread(_http_sync, url, "GET", _auth(), 3.0)
            if status in (200, 201):
                return json.loads(body)
        except Exception as e:
            # was logger.debug: a failed metadata lookup silently sent the call to the WRONG pipeline
            logger.warning(f"GET {url} failed (attempt {i}/{attempts}): {e}")
        if i < attempts:
            await asyncio.sleep(0.3 * i)
    return None


def _as_dict(v: Any) -> Dict[str, Any]:
    """Exotel sends custom_parameters either as an object or as a JSON / query string."""
    if isinstance(v, dict):
        return v
    if isinstance(v, str) and v.strip():
        try:
            parsed = json.loads(v)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
        return {k: vals[0] for k, vals in parse_qs(v).items() if vals}
    return {}


async def _read_start_event(ws: WebSocket) -> Optional[dict]:
    """Consume `connected` (and anything else) until the `start` event. Returns None if the call ends first."""
    async def _loop():
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except Exception:
                logger.warning("Ignoring non-JSON frame during handshake")
                continue
            ev = data.get("event")
            if ev == "connected":
                logger.info("[STEP 2a] 🤝 Exotel handshake event: 'connected'")
            elif ev == "start":
                return data
            elif ev == "stop":
                logger.info("[STEP 7] 🛑 Exotel call stopped before start")
                return None

    return await asyncio.wait_for(_loop(), timeout=HANDSHAKE_TIMEOUT)


app = FastAPI()


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.websocket("/api/exotel/media-stream")
@app.websocket("/api/exotel/media-stream/{path_call_id}")
async def media_stream(ws: WebSocket, path_call_id: Optional[str] = None):
    await ws.accept()
    qs = ws.query_params
    call_id = path_call_id or qs.get("callId") or qs.get("call_id")
    phone = qs.get("phone")
    logger.info(f"[STEP 1] ⚡ Exotel WebSocket connected (path={ws.url.path}, callId={call_id})")

    try:
        start = await _read_start_event(ws)
    except asyncio.TimeoutError:
        logger.warning(f"No 'start' event from Exotel within handshake timeout (callId={call_id}); no outcome will be posted by the agent")
        await _safe_close(ws)
        return
    except WebSocketDisconnect:
        logger.warning(f"Exotel disconnected during handshake (callId={call_id}); no pipeline ran, no outcome will be posted by the agent")
        return
    if not start:
        logger.warning(f"Exotel sent 'stop' before 'start' (callId={call_id}); no pipeline ran, no outcome will be posted by the agent")
        await _safe_close(ws)
        return

    logger.info(f"[STEP 2b] 📥 Received start payload: {json.dumps(start)[:600]}")
    sd = start.get("start", {}) or {}
    stream_sid = start.get("stream_sid") or start.get("streamSid") or sd.get("stream_sid") or sd.get("streamSid")
    call_sid = start.get("call_sid") or start.get("callSid") or sd.get("call_sid") or sd.get("callSid")
    custom = _as_dict(sd.get("custom_parameters") or sd.get("customParameters"))

    call_id = call_id or custom.get("callId") or custom.get("call_id")
    phone = phone or custom.get("phone") or sd.get("from")

    if not stream_sid:
        logger.error("Exotel 'start' event had no stream_sid; cannot stream audio. Closing.")
        await _safe_close(ws)
        return

    # Fallback 1: resolve by Exotel call SID
    if not call_id and call_sid:
        cdata = await _get_json(f"{BACKEND_URL}/internal/calls/by-sid/{call_sid}")
        if cdata:
            call_id = cdata.get("id")
            phone = phone or cdata.get("phone")
            logger.info(f"✅ Resolved callId from backend by Call SID {call_sid}: {call_id}")

    # Fallback 2 (opt-in): newest dialing call
    if not call_id and ALLOW_ACTIVE_DIALING_FALLBACK:
        cdata = await _get_json(f"{BACKEND_URL}/internal/calls/active-dialing")
        if cdata:
            call_id = cdata.get("id")
            phone = phone or cdata.get("phone")
            logger.warning(f"⚠️ callId guessed from latest active-dialing call: {call_id}")

    logger.info(f"[STEP 2c] 🎬 Call started: callId={call_id} | streamSid={stream_sid} | callSid={call_sid}")

    metadata: Dict[str, Any] = {}
    if call_id:
        # answered-notification and metadata fetch are independent -> run together
        async def _notify_answered():
            try:
                st, _ = await asyncio.to_thread(
                    _http_sync, f"{BACKEND_URL}/internal/real-estate/calls/{call_id}/answered", "POST", _auth(), 2.5
                )
                logger.info(f"✅ Marked call {call_id} as answered in backend (HTTP {st})")
            except Exception as ex:
                logger.debug(f"Could not notify backend answered: {ex}")

        notify_task = asyncio.create_task(_notify_answered())
        metadata = await _get_json(f"{BACKEND_URL}/internal/calls/{call_id}") or {}
        if metadata:
            logger.info(f"📋 Loaded call metadata for {call_id}")
        await notify_task
    else:
        logger.warning("No callId could be resolved: the call will run but its outcome cannot be saved.")

    audio_in_filter = None
    if ENABLE_NOISE_CANCELLATION and RNNoiseFilter is not None:
        try:
            audio_in_filter = RNNoiseFilter()
            logger.info("🛡️ RNNoise noise suppression filter enabled for incoming audio stream")
        except Exception as _filter_err:
            logger.warning(f"Failed to instantiate RNNoiseFilter: {_filter_err}")

    transport = FastAPIWebsocketTransport(
        websocket=ws,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            audio_in_filter=audio_in_filter,
            serializer=ExotelFrameSerializer(stream_sid=str(stream_sid), call_sid=call_sid),
        ),
    )

    req_pipeline = (qs.get("pipeline") or qs.get("agent") or custom.get("pipeline") or custom.get("agent") or "").lower()

    # Determine which pipeline to run
    selected_pipeline = None
    if req_pipeline in ("logistics", "mittal", "mittal_pigments", "driver"):
        selected_pipeline = "logistics"
    elif req_pipeline in ("real_estate", "realestate", "estate", "estate_finder", "sagar"):
        selected_pipeline = "real_estate"
    elif req_pipeline in ("telecom", "airtel", "priya", "habot"):
        selected_pipeline = "airtel"
    elif metadata:
        call_obj = metadata.get("call") or {}
        if call_obj.get("logistics_trip_id") or str(call_obj.get("pipeline", "")).lower() == "logistics" or metadata.get("logisticsTrip"):
            selected_pipeline = "logistics"
        elif call_obj.get("re_lead_id") or (metadata.get("leadId") and not metadata.get("customerId")):
            selected_pipeline = "real_estate"
        elif call_obj.get("customer_id") or metadata.get("customerId"):
            selected_pipeline = "airtel"
        elif "real estate" in str(call_obj.get("script", "")).lower() or "estate" in str(call_obj.get("script", "")).lower():
            selected_pipeline = "real_estate"
        else:
            selected_pipeline = "real_estate" if DEFAULT_PIPELINE in ("real_estate", "realestate", "estate") else "airtel"
    else:
        selected_pipeline = "real_estate" if DEFAULT_PIPELINE in ("real_estate", "realestate", "estate") else "airtel"
        logger.warning(f"⚠️ No pipeline hint and no metadata for call {call_id}; using default '{DEFAULT_PIPELINE}'")

    try:
        if selected_pipeline == "logistics":
            logger.info(f"🚀 Running Pipecat Logistics Pipeline for call {call_id}...")
            await run_logistics_pipeline(transport=transport, call_id=call_id, phone=phone, metadata=metadata)
        elif selected_pipeline == "real_estate":
            logger.info(f"🚀 Running Pipecat Real Estate Pipeline for call {call_id}...")
            await run_real_estate_pipeline(transport=transport, call_id=call_id, phone=phone, metadata=metadata)
        else:
            logger.info(f"🚀 Running Pipecat Airtel Telecom Pipeline for call {call_id}...")
            await run_airtel_pipeline(transport=transport, call_id=call_id, phone=phone, metadata=metadata)
    except Exception as e:
        logger.error(f"Pipeline crashed for call {call_id}: {e}", exc_info=True)
    finally:
        await _safe_close(ws)
        logger.info(f"🧹 [CLEANUP] session closed for callId={call_id}")


async def _safe_close(ws: WebSocket):
    try:
        await ws.close(code=1000)
    except Exception:
        pass


async def main():
    logger.info(f"🚀 Exotel WSS Pipecat Audio Bridge starting on 0.0.0.0:{BRIDGE_PORT}...")
    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=BRIDGE_PORT,
        log_level="info",
        ws_max_size=10 * 1024 * 1024,
        ws_ping_interval=None,   # Exotel does not answer websocket pings reliably
        timeout_graceful_shutdown=10,
    )
    await uvicorn.Server(config).serve()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Bridge stopped by user.")
        