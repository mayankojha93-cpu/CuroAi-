import os
import re
import json
import time
import asyncio
import statistics
import requests
from datetime import datetime
from pathlib import Path
from typing import Optional
from livekit import agents, api
from livekit.agents import AgentSession, AgentServer, TurnHandlingOptions, JobExecutorType
from livekit.plugins import sarvam, silero, openai

from .config import (
    ROOT_DIR,
    logger,
    AGENT_NAME,
    LLM_MODEL,
    SARVAM_API_KEY,
    OPENROUTER_API_KEY,
    OPENROUTER_PROVIDER_SORT,
    PREEMPTIVE_GENERATION,
    ENDPOINT_MIN_DELAY,
    ENDPOINT_MAX_DELAY,
    STT_LANGUAGE,
    TTS_LANGUAGE_HI,
    TTS_LANGUAGE_EN,
    TTS_MODEL,
    TTS_SPEAKER,
    TTS_SPEAKER_HI,
    TTS_SPEAKER_EN,
    DEFAULT_LANGUAGE,
    TTS_PACE,
    TTS_TEMPERATURE,
    FAST_TOOL_REPLY,
    LATENCY_LOG,
    VAD_MIN_SILENCE,
    VAD_DEACTIVATION,
    LLM_MAX_TOKENS,
    OPENROUTER_PROVIDER_ORDER,
    BACKEND_URL,
    INTERNAL_SECRET,
    LLM_PROVIDER,
    GROQ_API_KEY,
    GROQ_MODEL,
    LLM_FALLBACK,
    LLM_ATTEMPT_TIMEOUT,
    PRERENDER_GREETING,
    PRERENDER_COMMON,
)
from .state import RealEstateState, RealEstateStep
from .agent import RealEstateAgent
from .tools import RealEstateTools
from .prompts import _owner_call_name
from .audio_recorder import RoomAudioRecorder
from src.transliteration import romanize_hindi

server = AgentServer(job_executor_type=JobExecutorType.THREAD)

_UUID_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.I)

# ── Conversation File Logger ───────────────────────────────────────────────────
_CONV_LOG_DIR = ROOT_DIR / "recordings" / "conversations"


class ConversationFileLogger:
    """Real-time conversation logger: writes each turn to a .txt file as it happens."""

    def __init__(self, call_id: str, owner_name: str, phone: str, direction: str):
        _CONV_LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_id = (call_id or "unknown")[:36]
        self._path = _CONV_LOG_DIR / f"{ts}_{safe_id}.txt"
        self._call_id = call_id
        self._fh = open(self._path, "w", encoding="utf-8", buffering=1)
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self._fh.write(
            f"{'='*70}\n"
            f"  ESTATE FINDER CONVERSATION LOG\n"
            f"  Call ID  : {call_id}\n"
            f"  Owner    : {owner_name}  |  Phone: {phone}\n"
            f"  Direction: {direction}\n"
            f"  Started  : {now_str}\n"
            f"{'='*70}\n\n"
        )
        logger.info(f"📝 Conversation log started: {self._path}")

    def _ts(self) -> str:
        return datetime.now().strftime("%H:%M:%S")

    def log_agent(self, text: str):
        self._fh.write(f"[{self._ts()}] 🤖  Priya   : {text}\n")

    def log_customer(self, text: str):
        self._fh.write(f"[{self._ts()}] 🗣️  Customer: {text}\n")

    def log_event(self, text: str):
        self._fh.write(f"[{self._ts()}] ──  {text}\n")

    def finalize(self, state: "RealEstateState"):
        try:
            duration_s = int(time.time() - state.start_time)
            mins, secs = divmod(duration_s, 60)
            self._fh.write(
                f"\n{'='*70}\n"
                f"  CALL OUTCOME\n"
                f"  Disposition  : {state.final_disposition}\n"
                f"  Interested   : {state.is_interested}\n"
                f"  Category     : {state.category or 'N/A'}  |  Intent: {state.intent or 'N/A'}\n"
                f"  Property     : {state.project_or_society or 'N/A'}"
                f"{', ' + state.sector_or_location if state.sector_or_location else ''}\n"
                f"  Unit / Floor : {state.unit_number or 'N/A'} / {state.floor_number or 'N/A'}\n"
                f"  Config/Type  : {state.bhk_config or state.commercial_type or 'N/A'}\n"
                f"  Area         : {f'{state.approx_area_sqft} sqft' if state.approx_area_sqft else 'N/A'}\n"
                f"  Furnishing   : {state.furnishing_status or 'N/A'}\n"
                f"  Price / Rent : {state.expected_sale_price or state.expected_monthly_rent or 'N/A'}\n"
                f"  Duration     : {mins}m {secs}s\n"
                f"  Summary      : {state.agent_summary or 'N/A'}\n"
                f"{'='*70}\n"
            )
        except Exception as e:
            self._fh.write(f"\n[ERROR writing outcome: {e}]\n")
        finally:
            try:
                self._fh.close()
            except Exception:
                pass
        logger.info(f"📝 Conversation log saved: {self._path}")


def _load_vad():
    kwargs = dict(
        sample_rate=16000,
        min_speech_duration=0.05,
        min_silence_duration=VAD_MIN_SILENCE,
        activation_threshold=0.45,
    )
    if VAD_DEACTIVATION is not None:
        try:
            return silero.VAD.load(**kwargs, deactivation_threshold=VAD_DEACTIVATION)
        except TypeError:
            logger.warning("silero plugin has no deactivation_threshold; ignoring VAD_DEACTIVATION")
    return silero.VAD.load(**kwargs)


def prewarm(proc: agents.JobProcess):
    try:
        proc.userdata["vad"] = _load_vad()
    except Exception as e:
        logger.warning(f"VAD prewarm failed: {e}")


server.setup_fnc = prewarm


# ── Latency helpers ────────────────────────────────────────────────────────────
def _build_llm():
    """Primary = Groq direct (fast), fallback = OpenRouter. Falls back to OpenRouter-only if Groq is not set up."""
    common = dict(temperature=0.05, parallel_tool_calls=False, max_completion_tokens=LLM_MAX_TOKENS)

    def _openrouter():
        extra = {}
        if OPENROUTER_PROVIDER_ORDER:
            extra["extra_body"] = {"provider": {"order": OPENROUTER_PROVIDER_ORDER, "allow_fallbacks": True}}
        elif OPENROUTER_PROVIDER_SORT:
            extra["extra_body"] = {"provider": {"sort": OPENROUTER_PROVIDER_SORT}}
        return openai.LLM(model=LLM_MODEL, base_url="https://openrouter.ai/api/v1",
                          api_key=OPENROUTER_API_KEY, **common, **extra)

    def _groq():
        return openai.LLM(model=GROQ_MODEL, base_url="https://api.groq.com/openai/v1",
                          api_key=GROQ_API_KEY, **common)

    provider = LLM_PROVIDER
    if provider == "auto":
        provider = "groq" if GROQ_API_KEY else "openrouter"
    if provider == "groq" and not GROQ_API_KEY:
        logger.warning("LLM_PROVIDER=groq but GROQ_API_KEY is empty -> using OpenRouter")
        provider = "openrouter"

    if provider != "groq":
        logger.info(f"🧠 LLM: OpenRouter {LLM_MODEL}")
        return _openrouter()

    primary = _groq()
    if LLM_FALLBACK and OPENROUTER_API_KEY:
        try:
            from livekit.agents import llm as lk_llm
            secondary = _openrouter()
            try:
                adapter = lk_llm.FallbackAdapter([primary, secondary], attempt_timeout=LLM_ATTEMPT_TIMEOUT, max_retry_per_llm=0)
            except TypeError:
                adapter = lk_llm.FallbackAdapter([primary, secondary])
            logger.info(f"🧠 LLM: Groq {GROQ_MODEL} (fallback -> OpenRouter {LLM_MODEL})")
            return adapter
        except Exception as e:
            logger.warning(f"FallbackAdapter unavailable ({e}); using Groq only")
    logger.info(f"🧠 LLM: Groq {GROQ_MODEL} (no fallback)")
    return primary


async def _prerender_tts(tts_obj, text: str, timeout: float = 10.0):
    """Synthesise `text` ahead of time and return the audio frames (used for the opening greeting)."""
    frames = []

    async def _run():
        stream = tts_obj.synthesize(text)
        try:
            async for ev in stream:
                fr = getattr(ev, "frame", None)
                if fr is not None:
                    frames.append(fr)
        finally:
            try:
                await stream.aclose()
            except Exception:
                pass

    await asyncio.wait_for(_run(), timeout=timeout)
    return frames


async def _replay_frames(frames):
    for f in frames:
        yield f


# ── Helpers ────────────────────────────────────────────────────────────────────
def _resolve_call_id(ctx, metadata: dict) -> str:
    """callId from job/room metadata, else the UUID inside the room name (re-call-<uuid>)."""
    cid = str(metadata.get("callId") or metadata.get("call_id") or "").strip()
    if cid:
        return cid
    names = []
    for getter in (
        lambda: ctx.room.name,
        lambda: ctx.job.room.name,
    ):
        try:
            n = getter()
            if n:
                names.append(n)
        except Exception:
            pass
    for n in names:
        m = _UUID_RE.search(n)
        if m:
            return m.group(0)
        if n.startswith("re-call-"):
            return n[8:]
        if n.startswith("call-"):
            return n[5:]
    return ""


def _callee_status(p) -> Optional[str]:
    try:
        attrs = getattr(p, "attributes", None) or {}
        if attrs.get("carrier") == "exotel-wss":
            return "active"
        if getattr(p, "identity", "").startswith("phone-"):
            return "active"
        return attrs.get("sip.callStatus")
    except Exception:
        return None


async def _wait_for_answer(ctx, state: RealEstateState, timeout: float) -> bool:
    """Outbound SIP participants join the room when DIALING starts, not when the phone is answered.
    Waits for the callee to answer (sip.callStatus == 'active').
    Never returns True while the call is still ringing or dialing."""
    is_outbound = getattr(state, "direction", "outbound") == "outbound"
    if not is_outbound:
        return True

    answer_event = asyncio.Event()

    def _check_participants() -> Optional[bool]:
        # True = active/answered
        # False = hung up / failed
        # None = still waiting / ringing
        participants = list(ctx.room.remote_participants.values())
        for p in participants:
            st = _callee_status(p)
            if st == "active":
                return True
            if st == "hangup":
                return False
        return None

    init_status = _check_participants()
    if init_status is True:
        return True
    if init_status is False:
        return False

    def on_attrs(changed_attrs, participant):
        attrs = changed_attrs or {}
        st = attrs.get("sip.callStatus") or _callee_status(participant)
        if st == "active":
            logger.info("📞 [EVENT] Participant sip.callStatus transitioned to 'active'")
            answer_event.set()

    ctx.room.on("participant_attributes_changed", on_attrs)

    end_time = time.time() + timeout
    try:
        while time.time() < end_time:
            if state.hangup_started or not ctx.room.isconnected():
                return False

            st_val = _check_participants()
            if st_val is True:
                return True
            if st_val is False:
                return False

            remaining = end_time - time.time()
            if remaining <= 0:
                break

            try:
                await asyncio.wait_for(answer_event.wait(), timeout=min(0.5, remaining))
                if answer_event.is_set():
                    return True
            except asyncio.TimeoutError:
                pass
    finally:
        try:
            ctx.room.off("participant_attributes_changed", on_attrs)
        except Exception:
            pass

    return _check_participants() is True


def _apply_disconnect_disposition(state: RealEstateState):
    has_customer_speech = any(t.get("role") == "customer" for t in state.transcript)
    if getattr(state, "answered_at", None) is None and not has_customer_speech:
        state.final_disposition = "Not Connected (No Answer)"
        state.agent_summary = state.agent_summary or "Call disconnected before the customer answered"
        return
    state.callee_connected = True
    if state.final_disposition in ("Abruptly Disconnected Call", "Not Connected (No Answer)"):
        if state.is_interested:
            state.final_disposition = "Interested (Disconnected)"
        elif state.project_or_society or state.category:
            state.final_disposition = "Partial Details Captured (Disconnected)"
        else:
            state.final_disposition = "Abruptly Disconnected Call"


def post_re_outcome_sync(state: RealEstateState) -> bool:
    if not state.call_id:
        logger.error("post_re_outcome_sync: call_id is empty, nothing can be saved")
        return False

    url = f"{BACKEND_URL}/internal/real-estate/calls/{state.call_id}/outcome"
    headers = {
        "X-Internal-Secret": INTERNAL_SECRET,
        "Content-Type": "application/json",
    }
    has_customer = any(t.get("role") == "customer" for t in state.transcript)

    # Duration counts from the moment the phone was answered, never from ringing time.
    if getattr(state, "answered_at", None):
        duration = max(1, int(time.time() - state.answered_at))
    elif has_customer:
        duration = max(5, int(time.time() - state.start_time))
    else:
        duration = 0

    is_comm = (
        state.category == "commercial"
        or bool(state.commercial_type)
        or bool(state.project_or_society and any(w in state.project_or_society.lower() for w in ["commercial", "office", "shop", "retail", "showroom", "warehouse"]))
        or bool(state.sector_or_location and any(w in state.sector_or_location.lower() for w in ["commercial", "office", "shop", "retail", "showroom", "warehouse"]))
    )
    if is_comm:
        category_val = "commercial"
        bhk_val = None
        comm_val = state.commercial_type or "Commercial Unit"
    elif state.category == "residential" or state.bhk_config:
        category_val = "residential"
        bhk_val = state.bhk_config
        comm_val = None
    else:
        category_val = state.category
        bhk_val = state.bhk_config
        comm_val = state.commercial_type

    median_ms = int(statistics.median(state.latency_samples) * 1000) if state.latency_samples else None

    payload = {
        "lead_id": state.lead_id,
        "final_disposition": state.final_disposition,
        "is_interested": state.is_interested,
        "owner_name_confirmed": state.owner_name_confirmed or state.owner_name,
        "category": category_val,
        "intent": state.intent,
        "project_or_society": state.project_or_society,
        "sector_or_location": state.sector_or_location,
        "unit_number": state.unit_number,
        "floor_number": state.floor_number,
        "bhk_config": bhk_val,
        "commercial_type": comm_val,
        "approx_area_sqft": state.approx_area_sqft,
        "furnishing_status": state.furnishing_status,
        "expected_sale_price": state.expected_sale_price,
        "expected_monthly_rent": state.expected_monthly_rent,
        "is_currently_leased": state.is_currently_leased,
        "current_rent_received": state.current_rent_received,
        "immediate_occupancy": state.immediate_occupancy,
        "agent_summary": state.agent_summary,
        "transcript": state.transcript,
        "duration_seconds": duration,
        "median_latency_ms": median_ms,
        "language": state.reply_lang,
        "initial_language": state.initial_language,
        "language_switched": state.language_switched,
        "failure_reason": (state.agent_summary or "Dialing timeout: callee did not answer within timeout period") if duration == 0 else None,
        # Only send a recording URL when a real file was produced; the backend marks it 'done' otherwise.
        "recording_url": getattr(state, "recording_url", None),
    }

    logger.info(f"📤 Posting RE outcome to {url} (call={state.call_id}, duration={duration}s, turns={len(state.transcript)}, disp={state.final_disposition})")
    for attempt in range(1, 7):
        try:
            res = requests.post(url, json=payload, headers=headers, timeout=8.0)
            if res.status_code in (200, 201):
                logger.info(f"✅ Real estate outcome saved for call {state.call_id} (Disp: {state.final_disposition})")
                return True
            logger.error(f"❌ Failed to save RE outcome ({res.status_code}) attempt {attempt}: {res.text}")
            if res.status_code in (400, 401, 403, 404):
                break  # retrying will not help
        except Exception as e:
            logger.error(f"❌ Exception posting RE outcome (attempt {attempt}): {e}")
        time.sleep(min(5.0, 1.5 * attempt))
    return False


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: agents.JobContext):
    logger.info(f"🏠 Real Estate Agent connecting to room: {ctx.room.name} (Job ID: {ctx.job.id})")
    await ctx.connect()

    metadata = {}
    if ctx.job.metadata:
        try:
            metadata = json.loads(ctx.job.metadata)
            logger.info(f"Loaded RE job metadata: {metadata}")
        except Exception as e:
            logger.warning(f"Could not parse job metadata: {e}")

    if not metadata and getattr(ctx.room, "metadata", None):
        try:
            metadata = json.loads(ctx.room.metadata)
            logger.info(f"Loaded RE room metadata: {metadata}")
        except Exception as e:
            logger.warning(f"Could not parse room metadata: {e}")

    call_id = _resolve_call_id(ctx, metadata)
    if call_id:
        logger.info(f"📌 Resolved call_id={call_id}")
    else:
        logger.error(f"❌ Could not resolve call_id (room={ctx.room.name}, metadata keys={list(metadata.keys())}). "
                     "Outcome, answered-callback and recording will NOT work for this call.")

    phone = metadata.get("phone", "")
    owner_name = metadata.get("customerName") or metadata.get("ownerName", "")
    raw_loc = (metadata.get("propertyLocation") or metadata.get("address") or metadata.get("location") or metadata.get("customerAddress") or "").strip()

    if call_id and (not phone or not owner_name or not raw_loc):
        def _fetch_call_info():
            try:
                res = requests.get(
                    f"{BACKEND_URL}/internal/calls/{call_id}",
                    headers={"X-Internal-Secret": INTERNAL_SECRET},
                    timeout=2.0,
                )
                if res.status_code == 200:
                    return res.json().get("call") or {}
            except Exception as e:
                logger.debug(f"Backend call info lookup note: {e}")
            return {}

        c_data = await asyncio.to_thread(_fetch_call_info)
        if c_data:
            phone = phone or c_data.get("phone", "") or c_data.get("customer_phone", "")
            owner_name = owner_name or c_data.get("customerName") or c_data.get("customer_name") or ""
            backend_loc = (c_data.get("property_location") or c_data.get("propertyLocation") or c_data.get("customer_address") or c_data.get("address") or "").strip()
            if backend_loc and not raw_loc:
                raw_loc = backend_loc

    clean_owner = (owner_name or "").strip()
    if not clean_owner or clean_owner.lower() in ("property owner", "test subscriber", "test customer", "none", "null", "undefined", "customer"):
        owner_name = None
    else:
        owner_name = clean_owner

    raw_pref = (metadata.get("preferredLanguage") or metadata.get("language") or DEFAULT_LANGUAGE).strip().lower()
    preferred_language = "en" if raw_pref in ("en", "english", "en-in") else "hi"
    lead_id = metadata.get("leadId")
    direction = metadata.get("direction", "outbound")
    if not raw_loc or raw_loc.lower() in ("delhi, 110011, burari, sant nagar", "none", "null", "undefined"):
        property_location = None
    else:
        property_location = raw_loc

    # Audio & speech pipeline
    stt = sarvam.STT(
        language=STT_LANGUAGE,
        model="saaras:v4",
        api_key=SARVAM_API_KEY,
    )

    vad = ctx.proc.userdata.get("vad") if getattr(ctx, "proc", None) else None
    if vad is None:
        vad = await asyncio.to_thread(_load_vad)

    logger.info(
        f"⚙️ Latency config: FAST_TOOL_REPLY={FAST_TOOL_REPLY} VAD_MIN_SILENCE={VAD_MIN_SILENCE} "
        f"endpoint=({ENDPOINT_MIN_DELAY},{ENDPOINT_MAX_DELAY}) preemptive={PREEMPTIVE_GENERATION} "
        f"prerender_greeting={PRERENDER_GREETING}"
    )

    llm = _build_llm()

    initial_code = TTS_LANGUAGE_EN if preferred_language == "en" else TTS_LANGUAGE_HI
    initial_speaker = TTS_SPEAKER_EN if preferred_language == "en" else TTS_SPEAKER_HI

    tts = sarvam.TTS(
        target_language_code=initial_code,
        model=TTS_MODEL,
        speaker=initial_speaker,
        pace=TTS_PACE,
        temperature=TTS_TEMPERATURE,
        api_key=SARVAM_API_KEY,
    )

    def _set_tts_language(lang: str):
        code = TTS_LANGUAGE_EN if lang == "en" else TTS_LANGUAGE_HI
        speaker = TTS_SPEAKER_EN if lang == "en" else TTS_SPEAKER_HI
        try:
            tts.update_options(
                model=TTS_MODEL,
                speaker=speaker,
                target_language_code=code,
                pace=TTS_PACE,
                temperature=TTS_TEMPERATURE,
            )
            logger.info(f"TTS language updated -> {code} (speaker={speaker})")
        except Exception as e:
            logger.warning(f"TTS update failed: {e}")

    state = RealEstateState(
        call_id=call_id,
        lead_id=lead_id,
        owner_name=owner_name,
        phone=phone,
        preferred_language=preferred_language,
        direction=direction,
        property_location=property_location,
    )

    recorder = RoomAudioRecorder(call_id=call_id) if call_id else None

    conv_logger = ConversationFileLogger(
        call_id=call_id,
        owner_name=owner_name,
        phone=phone,
        direction=direction,
    )

    tools_instance = RealEstateTools(state, post_re_outcome_sync, None)
    agent = RealEstateAgent(state, tools_instance)
    tools_instance.agent = agent
    agent.on_language_change = _set_tts_language

    # ── Console & Transcript Logger ────────────────────────────────
    _last_logged = {"role": None, "text": None}

    def _mark_answered():
        if getattr(state, "answered_at", None) is None:
            state.answered_at = time.time()
        state.callee_connected = True
        state.last_activity_time = time.time()

    def log_dialogue(role: str, text: str):
        clean = (text or "").strip()
        if not clean:
            return
        is_agent = role in ("assistant", "agent")
        if is_agent:
            clean = re.sub(r'\b[a-zA-Z_][a-zA-Z0-9_]*\s*\{[^}]*\}', '', clean).strip()
            if not clean:
                return

        norm_role = "assistant" if is_agent else "customer"
        if _last_logged["role"] == norm_role and _last_logged["text"] == clean:
            return
        _last_logged["role"] = norm_role
        _last_logged["text"] = clean

        now_str = datetime.now().strftime("%H:%M:%S")
        if is_agent:
            banner = f"[{now_str}] 🤖 [Agent (Priya)]: {clean}"
            print(f"\n\033[1;36m{banner}\033[0m\n", flush=True)
            logger.info(banner)
            state.add_transcript("assistant", clean)
            try:
                conv_logger.log_agent(clean)
            except Exception:
                pass
        else:
            banner = f"[{now_str}] 🗣️ [Customer]: {clean}"
            print(f"\n\033[1;32m{banner}\033[0m\n", flush=True)
            logger.info(banner)
            _mark_answered()
            state.add_transcript("customer", clean)
            try:
                conv_logger.log_customer(clean)
            except Exception:
                pass

        # Real-time incremental persistence to PostgreSQL
        if call_id:
            def _push_incremental():
                try:
                    requests.post(
                        f"{BACKEND_URL}/internal/real-estate/calls/{call_id}/turn",
                        headers={"X-Internal-Secret": INTERNAL_SECRET},
                        json={
                            "role": norm_role,
                            "text": clean,
                            "timestamp": datetime.now().isoformat(),
                        },
                        timeout=2.0,
                    )
                except Exception as ex:
                    logger.debug(f"Incremental turn save note: {ex}")
            asyncio.create_task(asyncio.to_thread(_push_incremental))

    tools_instance.log_dialogue_func = log_dialogue

    def print_console_summary(s: RealEstateState):
        duration_s = int(time.time() - s.start_time)
        mins, secs = divmod(duration_s, 60)
        summary_lines = [
            "",
            "=" * 70,
            f"  📞 REAL ESTATE CONVERSATION SUMMARY (Call ID: {s.call_id})",
            f"  Owner: {s.owner_name_confirmed or s.owner_name} | Phone: {s.phone}",
            "-" * 70,
        ]
        for t in s.transcript:
            role_label = "\033[1;36m🤖 Priya   \033[0m" if t.get("role") in ("assistant", "agent") else "\033[1;32m🗣️ Customer\033[0m"
            summary_lines.append(f"  {role_label}: {t.get('text')}")
        summary_lines.extend([
            "-" * 70,
            f"  Disposition: \033[1;33m{s.final_disposition}\033[0m | Duration: {mins}m {secs}s",
            f"  Summary    : {s.agent_summary or 'N/A'}",
            "=" * 70,
            "",
        ])
        summary_text = "\n".join(summary_lines)
        print(summary_text, flush=True)
        for line in summary_lines:
            if line:
                logger.info(line)

    turn_opts = {"preemptive_generation": {"enabled": PREEMPTIVE_GENERATION}}
    endpointing_opts = {}
    if ENDPOINT_MIN_DELAY is not None:
        endpointing_opts["min_delay"] = ENDPOINT_MIN_DELAY
    if ENDPOINT_MAX_DELAY is not None:
        endpointing_opts["max_delay"] = ENDPOINT_MAX_DELAY
    if endpointing_opts:
        turn_opts["endpointing"] = endpointing_opts

    session = AgentSession(
        stt=stt,
        vad=vad,
        llm=llm,
        tts=tts,
        allow_interruptions=True,
        max_tool_steps=1,
        turn_handling=TurnHandlingOptions(**turn_opts),
    )

    # ── Per-turn latency (also feeds state.latency_samples -> median_latency_ms) ──
    _lat = {"eou": None, "llm": [], "tts_done": False}

    @session.on("metrics_collected")
    def _on_metrics(ev):
        try:
            m = ev.metrics
            kind = type(m).__name__
            if kind == "EOUMetrics":
                _lat["eou"] = getattr(m, "end_of_utterance_delay", None)
                _lat["llm"] = []
                _lat["tts_done"] = False
                if LATENCY_LOG:
                    logger.info(f"⏱ EOU delay={(_lat['eou'] or 0):.2f}s")
            elif kind == "LLMMetrics":
                ttft = getattr(m, "ttft", None)
                if ttft is not None and ttft >= 0:
                    _lat["llm"].append(ttft)
                    if LATENCY_LOG:
                        logger.info(f"⏱ LLM call #{len(_lat['llm'])} ttft={ttft:.2f}s step={state.step.value}")
            elif kind == "TTSMetrics":
                ttfb = getattr(m, "ttfb", None)
                if ttfb is None or ttfb < 0:
                    return
                if _lat["eou"] is not None and not _lat["tts_done"]:
                    _lat["tts_done"] = True
                    total = (_lat["eou"] or 0) + sum(_lat["llm"]) + ttfb
                    state.latency_samples.append(total)
                    if LATENCY_LOG:
                        logger.info(
                            f"⏱ TTS ttfb={ttfb:.2f}s | 🔔 TURN ≈ {total:.2f}s "
                            f"(eou {(_lat['eou'] or 0):.2f} + llm {sum(_lat['llm']):.2f} "
                            f"[{len(_lat['llm'])} call(s)] + tts {ttfb:.2f})"
                        )
                elif LATENCY_LOG:
                    logger.info(f"⏱ TTS ttfb={ttfb:.2f}s (scripted line)")
        except Exception as e:
            logger.debug(f"metrics log error: {e}")

    # ── Teardown ───────────────────────────────────────────────────────────────
    _room_deleted = False
    _shutdown_task: Optional[asyncio.Task] = None

    async def _end_room():
        """Drop the phone leg: remove every remote participant (sends SIP BYE), delete room, disconnect."""
        nonlocal _room_deleted
        if _room_deleted:
            return
        _room_deleted = True

        try:
            for p in list(ctx.room.remote_participants.values()):
                try:
                    await ctx.api.room.remove_participant(
                        api.RoomParticipantIdentity(room=ctx.room.name, identity=p.identity)
                    )
                    logger.info(f"Forcibly removed participant {p.identity} from room {ctx.room.name}")
                except Exception as ex:
                    logger.debug(f"remove_participant error ({p.identity}): {ex}")
        except Exception as e:
            logger.debug(f"Error enumerating remote participants: {e}")

        try:
            if hasattr(ctx, "delete_room"):
                await ctx.delete_room()
        except Exception:
            pass

        try:
            await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
            logger.info(f"Room {ctx.room.name} deleted: call terminated cleanly.")
        except Exception as e:
            if "not_found" in str(e).lower() or "404" in str(e):
                logger.debug(f"Room {ctx.room.name} was already deleted.")
            else:
                logger.warning(f"delete_room failed: {e}")

        try:
            await ctx.room.disconnect()
        except Exception:
            pass

    async def _do_shutdown():
        try:
            print_console_summary(state)
        except Exception as e:
            logger.debug(f"Error printing console summary: {e}")

        # 1. First drop the caller phone line immediately by removing remote participants.
        # This sends SIP BYE or closes the Exotel WSS bridge leg instantly so caller hears NO dead air.
        # Note: We do NOT delete the room or disconnect the agent yet!
        try:
            for p in list(ctx.room.remote_participants.values()):
                try:
                    await ctx.api.room.remove_participant(
                        api.RoomParticipantIdentity(room=ctx.room.name, identity=p.identity)
                    )
                    logger.info(f"📞 Dropped caller telephony leg ({p.identity})")
                except Exception as ex:
                    logger.debug(f"remove_participant note ({p.identity}): {ex}")
        except Exception as e:
            logger.debug(f"Error enumerating remote participants: {e}")

        # 2. Stop audio capture and finalise recording (ffmpeg WAV -> MP3 + S3 upload)
        if recorder:
            try:
                await recorder.stop_capture()
                rec_url = await recorder.finalize()
                if rec_url:
                    setattr(state, "recording_url", rec_url)
            except Exception as e:
                logger.warning(f"Error finalizing audio recording: {e}")

        # 3. Save outcome (with full transcript, property dossier, and recording URL) to backend
        # We save BEFORE deleting the room so the backend reconciler never sees an empty room without an outcome!
        if not state.outcome_posted and state.call_id:
            ok = await asyncio.to_thread(post_re_outcome_sync, state)
            state.outcome_posted = bool(ok)

        try:
            conv_logger.finalize(state)
        except Exception as e:
            logger.warning(f"Error finalizing conversation log: {e}")

        # 4. Now that outcome is safely in DB and disk, delete room and tear down session
        await _end_room()

        try:
            await session.aclose()
        except Exception:
            pass
        ctx.shutdown(reason="session closed")

    async def _save_and_shutdown():
        """Idempotent. Every caller (hangup, close event, participant_disconnected, framework shutdown
        callback) awaits the SAME task, so the job is never torn down while the recording/outcome is
        still being saved by the first caller."""
        nonlocal _shutdown_task
        if _shutdown_task is None:
            _shutdown_task = asyncio.ensure_future(_do_shutdown())
        elif asyncio.current_task() is _shutdown_task:
            return
        try:
            await asyncio.shield(_shutdown_task)
        except Exception as e:
            logger.warning(f"Shutdown task error: {e}")

    async def hangup_session():
        if not state.hangup_started:
            state.hangup_started = True
        await _save_and_shutdown()

    tools_instance.hangup_func = hangup_session

    @session.on("agent_state_changed")
    def on_agent_state_changed(ev):
        if getattr(ev, "new_state", None) == "speaking":
            state.last_activity_time = time.time()

    @session.on("user_input_transcribed")
    def on_user_transcribed(ev):
        raw_text = getattr(ev, "transcript", None) or getattr(ev, "text", "")
        is_final = getattr(ev, "is_final", True)
        if is_final and raw_text and raw_text.strip():
            romanized_text = romanize_hindi(raw_text.strip())
            log_dialogue("customer", romanized_text)

    @session.on("conversation_item_added")
    def on_conversation_item(ev):
        state.last_activity_time = time.time()
        item = getattr(ev, "item", None)
        if item:
            role = getattr(item, "role", "unknown")
            raw_content = getattr(item, "content", "")
            content_str = ""
            if isinstance(raw_content, list):
                text_parts = []
                for part in raw_content:
                    if isinstance(part, str):
                        part_s = part.strip()
                        if not part_s.startswith("{"):
                            text_parts.append(part_s)
                    elif hasattr(part, "text") and isinstance(part.text, str) and not part.text.strip().startswith("{"):
                        text_parts.append(part.text.strip())
                content_str = " ".join(text_parts).strip()
            elif isinstance(raw_content, str):
                part_s = raw_content.strip()
                if not part_s.startswith("{"):
                    content_str = part_s

            if role in ("user", "customer") and content_str:
                log_dialogue("customer", romanize_hindi(content_str.strip()))

            elif role == "assistant" and content_str:
                clean_agent_text = re.sub(r'\b[a-zA-Z_][a-zA-Z0-9_]*\s*\{[^}]*\}', '', content_str).strip()
                if clean_agent_text:
                    log_dialogue("assistant", clean_agent_text)

                if state.step == RealEstateStep.CLOSING or "close_call" in content_str:
                    logger.info("Closing message spoken; initiating delayed hangup (no-op if already scheduled)...")
                    asyncio.create_task(tools_instance._delayed_hangup())

    @session.on("close")
    def on_session_close(ev):
        if not state.hangup_started:
            state.hangup_started = True
            logger.info("Session closed.")
            _apply_disconnect_disposition(state)
        asyncio.create_task(_save_and_shutdown())

    @ctx.room.on("participant_disconnected")
    def on_participant_disconnected(participant):
        logger.info(f"Participant disconnected / hung up: {getattr(participant, 'identity', 'unknown')}")
        if not state.hangup_started:
            state.hangup_started = True
            _apply_disconnect_disposition(state)
        # ALWAYS save (previously an early return could skip this when hangup_started was already set)
        asyncio.create_task(_save_and_shutdown())

    @ctx.room.on("disconnected")
    def on_room_disconnected(*_args):
        logger.info("Room disconnected")
        if not state.hangup_started:
            state.hangup_started = True
            _apply_disconnect_disposition(state)
        asyncio.create_task(_save_and_shutdown())

    ctx.add_shutdown_callback(_save_and_shutdown)

    # ── Use the ringing time: warm every connection and pre-render the opening line ────────────────
    # The backend dispatches this agent BEFORE it dials Exotel, so we have several idle seconds here.
    def _build_greeting() -> str:
        loc = state.initial_property_location
        name_call = _owner_call_name(state)
        salutation_en = f"Hello {name_call} Sir" if name_call != "Sir" else "Hello Sir"
        salutation_hi = f"Hello {name_call} ji" if name_call != "Sir" else "Hello Sir"
        if loc:
            return (
                f"{salutation_en}, I’m Priya from My Estate Finder. Regarding your property at {loc}, are you considering selling or renting it out?"
                if state.reply_lang == "en"
                else f"{salutation_hi}, main Priya bol rahi hoon, My Estate Finder se. {loc} par jo aapki property hai, kya aap use sell ya rent karne ka soch rahe hain?"
            )
        return (
            f"{salutation_en}, I’m Priya from My Estate Finder. We help property owners sell or rent their properties. Are you also thinking of selling or renting out a property?"
            if state.reply_lang == "en"
            else f"{salutation_hi}, main Priya bol rahi hoon, My Estate Finder se. Hum property owners ko unki property sell ya rent karne mein help karte hain. Kya aap bhi apni koi property sell ya rent karne ka soch rahe hain?"
        )

    greeting = _build_greeting()

    for _name, _comp in (("stt", stt), ("tts", tts), ("llm", llm)):
        _fn = getattr(_comp, "prewarm", None)
        if callable(_fn):
            try:
                _fn()
                logger.info(f"🔥 {_name} prewarm requested (during ring)")
            except Exception as e:
                logger.debug(f"{_name} prewarm failed: {e}")

    prerender_task: Optional[asyncio.Task] = None
    if PRERENDER_GREETING:
        prerender_task = asyncio.create_task(_prerender_tts(tts, greeting))

    common_task: Optional[asyncio.Task] = None
    if PRERENDER_GREETING and PRERENDER_COMMON:
        async def _prerender_common():
            # sequential and after the greeting, so the TTS service is never hit with parallel streams
            from types import SimpleNamespace
            from .prompts import get_closing_text
            from .tools import other_property_question, ask_new_location_question
            try:
                if prerender_task is not None:
                    await asyncio.wait_for(asyncio.shield(prerender_task), timeout=12.0)
            except Exception:
                pass
            lang = state.reply_lang
            lines = [other_property_question(lang), ask_new_location_question(lang)]
            for disp in ('Not Interested', 'Qualified Lead', 'Advisor Callback Booked'):
                lines.append(get_closing_text(SimpleNamespace(
                    final_disposition=disp, reply_lang=lang, valuation_requested=False, intent=None)))
            for t in lines:
                try:
                    state.audio_cache[t] = await _prerender_tts(tts, t)
                except Exception as e:
                    logger.debug(f'common prerender skipped: {e}')
            logger.info(f'🔥 pre-rendered {len(state.audio_cache)} fixed lines during ring')
        common_task = asyncio.create_task(_prerender_common())

    def _cancel_prerender():
        if prerender_task is not None and not prerender_task.done():
            prerender_task.cancel()
        if common_task is not None and not common_task.done():
            common_task.cancel()

    # 1. Wait for the callee to actually ANSWER (not just for the SIP leg to appear while ringing)
    ring_timeout = 65.0 if direction == "outbound" else 20.0
    deadline = time.time() + ring_timeout
    logger.info(f"⏳ Waiting for callee to answer (timeout {ring_timeout}s)...")
    if not ctx.room.remote_participants:
        try:
            await asyncio.wait_for(ctx.wait_for_participant(), timeout=ring_timeout)
        except asyncio.TimeoutError:
            logger.warning(f"❌ No participant joined within {ring_timeout}s.")
        except Exception as e:
            logger.warning(f"Wait for participant error: {e}")

    answered = await _wait_for_answer(ctx, state, max(1.0, deadline - time.time()))
    if not answered:
        if not state.hangup_started:
            state.hangup_started = True
            state.final_disposition = "Not Connected (No Answer)"
            state.agent_summary = "Call unanswered by recipient within timeout period"
            logger.warning("❌ Callee did not answer (timeout / rejected / hung up while ringing).")
        _cancel_prerender()
        await _save_and_shutdown()
        return

    logger.info("🎉 Callee answered (sip.callStatus=active)")
    _mark_answered()
    state.start_time = time.time()
    state.answered_at = state.start_time

    # Tell backend the call is answered right away so no sweeper marks it NO_ANSWER
    def _notify_answered():
        if not state.call_id:
            logger.error("Cannot notify answered: call_id is empty")
            return
        try:
            r = requests.post(
                f"{BACKEND_URL}/internal/real-estate/calls/{state.call_id}/answered",
                headers={"X-Internal-Secret": INTERNAL_SECRET},
                timeout=3.0,
            )
            logger.info(f"Marked call {state.call_id} as answered in backend (HTTP {r.status_code})")
        except Exception as ex:
            logger.warning(f"Failed to notify answered: {ex}")
    asyncio.create_task(asyncio.to_thread(_notify_answered))

    # 2. Start session, then recorder (so the greeting is recorded too)
    await session.start(room=ctx.room, agent=agent)
    logger.info("Real Estate agent session started in room.")
    if recorder:
        await recorder.start(ctx.room)

    # 3. Opening greeting: play the pre-rendered audio if it is ready, else synthesise as before
    state.last_activity_time = time.time()
    opening_speech = None
    pre_frames = None
    if prerender_task is not None:
        if prerender_task.done() and not prerender_task.cancelled() and prerender_task.exception() is None:
            pre_frames = prerender_task.result()
        else:
            _cancel_prerender()
    if pre_frames:
        try:
            opening_speech = session.say(greeting, audio=_replay_frames(pre_frames), allow_interruptions=False)
            logger.info("⚡ Greeting played from pre-rendered audio (TTS wait skipped)")
        except Exception as e:
            logger.warning(f"Pre-rendered greeting failed ({e}); synthesising normally")
            opening_speech = None
    if opening_speech is None:
        opening_speech = session.say(greeting, allow_interruptions=False)
    log_dialogue("assistant", greeting)

    # 4. Silence watchdog
    async def silence_watchdog():
        consecutive_silence = 0
        while not state.hangup_started:
            await asyncio.sleep(2.0)
            if state.hangup_started:
                break
            idle = time.time() - state.last_activity_time
            if idle > 22.0:
                consecutive_silence += 1
                state.last_activity_time = time.time()
                if consecutive_silence == 1:
                    reprompt = (
                        "Are you still with me? Could you hear me?"
                        if state.reply_lang == "en"
                        else "Kya aap line par hain? Kya aap mujhe sun pa rahe hain?"
                    )
                    try:
                        session.say(reprompt, allow_interruptions=True)
                        log_dialogue("assistant", reprompt)
                    except Exception:
                        pass
                elif consecutive_silence >= 2:
                    goodbye = (
                        "I cannot hear you at the moment. We will call you back later. Have a great day!"
                        if state.reply_lang == "en"
                        else "Mujhe aapki aawaz nahi aa rahi hai. Hum aapse baad mein connect karenge. Have a great day!"
                    )
                    try:
                        speech = session.say(goodbye, allow_interruptions=False)
                        log_dialogue("assistant", goodbye)
                        await asyncio.wait_for(speech.wait_for_playout(), timeout=6.0)
                    except Exception:
                        pass
                    has_customer = any(t.get("role") == "customer" for t in state.transcript)
                    if not has_customer:
                        state.final_disposition = "Not Connected (No Answer)"
                    elif state.final_disposition in ("Abruptly Disconnected Call", "Not Connected (No Answer)"):
                        state.final_disposition = "Abruptly Disconnected Call"
                    state.hangup_started = True
                    await _save_and_shutdown()
                    break
            elif idle < 3.0:
                consecutive_silence = 0

    asyncio.create_task(silence_watchdog())

    # 5. Safety ceiling
    async def call_duration_watchdog():
        max_safety_seconds = float(os.getenv("CALL_MAX_DURATION_SECONDS", "900"))
        while not state.hangup_started:
            await asyncio.sleep(5.0)
            if state.hangup_started:
                break
            elapsed = time.time() - state.start_time
            if elapsed >= max_safety_seconds and state.step != RealEstateStep.CLOSING:
                logger.info(f"⏳ Call reached maximum safety ceiling ({int(elapsed)}s). Wrapping up cleanly.")
                state.step = RealEstateStep.CLOSING
                state.closing_spoken = True
                tools_instance._hangup_scheduled = True   # we own the hangup; stop _delayed_hangup cutting the line early
                disp_lower = state.final_disposition.lower()
                if not ("qualified" in disp_lower or "dnc" in disp_lower or "whatsapp" in disp_lower):
                    state.final_disposition = "Advisor Callback Booked"
                    if not state.agent_summary:
                        state.agent_summary = "Call completed maximum duration ceiling; advisor follow-up scheduled"
                wrapup_line = (
                    "Thank you for your time! I’ve noted your details, and our senior property advisor will follow up with you. Have a wonderful day!"
                    if state.reply_lang == "en"
                    else "Apna time dene ke liye thank you! Maine saari details note kar li hain, aur hamare senior property advisor aapse follow-up karenge. Have a great day!"
                )
                try:
                    speech = session.say(wrapup_line, allow_interruptions=False)
                    log_dialogue("assistant", wrapup_line)
                    await asyncio.wait_for(speech.wait_for_playout(), timeout=7.0)
                except Exception as e:
                    logger.warning(f"Safety ceiling wrapup playout error: {e}")
                state.hangup_started = True
                await _save_and_shutdown()
                break

    asyncio.create_task(call_duration_watchdog())

    try:
        await asyncio.wait_for(opening_speech.wait_for_playout(), timeout=8.0)
    except Exception as e:
        logger.warning(f"Initial greeting playout completed or timed out: {e}")
    state.last_activity_time = time.time()
    