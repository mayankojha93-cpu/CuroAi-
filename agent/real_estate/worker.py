import asyncio
import re
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, Dict, List, Optional

import aiohttp
import requests

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import EndFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.services.groq.llm import GroqLLMService
from pipecat.services.openrouter.llm import OpenRouterLLMService
from pipecat.services.sarvam.tts import SarvamHttpTTSService
from pipecat.services.soniox.stt import SonioxSTTService
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregatorParams
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import BaseTransport
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .audio_recorder import CallRecorder
from .agent import (  # noqa: F401  (re-exported helpers used by the disposition logic below)
    _DIRECT_NOT_INTERESTED,
    _HUMAN_CALLBACK_RE,
    _STRONG_VM_RE,
    _clean_leaks,
    _is_bare_refusal,
    RealEstateTurnHandler,
)
from .config import (
    AGENT_PERSONA_NAME,
    BACKEND_URL,
    DEFAULT_LANGUAGE,
    GROQ_API_KEY,
    GROQ_MODEL,
    INTERNAL_SECRET,
    LLM_FALLBACK,
    LLM_MAX_TOKENS,
    LLM_MODEL,
    LLM_PROVIDER,
    MAX_CALL_SECONDS,
    MAX_CALL_EXTENSION_SECONDS,
    MAX_SILENCE_PROMPTS,
    OPENROUTER_API_KEY,
    OPENROUTER_PROVIDER_ORDER,
    OPENROUTER_PROVIDER_SORT,
    PIPELINE_IN_SAMPLE_RATE,
    PIPELINE_OUT_SAMPLE_RATE,
    RECORD_CALLS,
    SARVAM_API_KEY,
    SILENCE_PROMPT_SECONDS,
    SONIOX_API_KEY,
    SONIOX_MODEL,
    STT_LANGUAGE,
    TTS_MODEL,
    TTS_PACE,
    TTS_SAMPLE_RATE,
    TTS_SPEAKER_EN,
    TTS_SPEAKER_HI,
    TTS_TEMPERATURE,
    USER_SPEECH_TIMEOUT,
    VAD_CONFIDENCE,
    VAD_MIN_SILENCE,
    logger,
)
from .pipecat_adapter import (
    LLMOutputGuard,
    PipecatSession,
    PlayoutTracker,
    SpeechInjector,
    TurnGate,
    schema_for_tool,
)
from .prompts import _owner_call_name, get_step_instructions
from .state import RealEstateState, RealEstateStep
from .tools import RealEstateTools, explicit_refusal

_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)

# Backend reporting must NEVER block the audio event loop (the old code did a blocking requests.post(timeout=2)
# on every turn, which froze the whole pipeline for up to 2 s each time). One worker keeps turns in order.
_backend_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="re-backend")


# ── Helpers ────────────────────────────────────────────────────────────────────
def _resolve_call_id(ctx=None, metadata: Optional[dict] = None) -> str:
    """callId from metadata or fallback room name."""
    metadata = metadata or {}
    cid = str(metadata.get("callId") or metadata.get("call_id") or "").strip()
    if cid:
        return cid
    if ctx:
        names = []
        for getter in (
            lambda: getattr(getattr(ctx, "room", None), "name", None),
            lambda: getattr(getattr(getattr(ctx, "job", None), "room", None), "name", None),
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


def _build_greeting(state: RealEstateState) -> str:
    """Builds the opening greeting line according to customer name, property records, and language."""
    loc = state.initial_property_location
    name_call = _owner_call_name(state)
    salutation_en = f"Hello {name_call}" if name_call != "Sir" else "Hello Sir"
    salutation_hi = f"Hello {name_call} ji" if name_call != "Sir" else "Hello Sir"
    if loc:
        clean_loc = loc.split(";")[0].strip()
        raw_parts = [p.strip() for p in clean_loc.split(",") if p.strip()]
        parts = list(dict.fromkeys(raw_parts))
        if len(parts) >= 2:
            has_sub = any(kw in parts[1].lower() for kw in ("sector", "sec", "phase", "block", "pocket", "plot", "flat", "unit"))
            spoken_loc = f"{parts[1]}, {parts[0]}" if has_sub else f"{parts[0]}, {parts[1]}"
        else:
            spoken_loc = parts[0] if parts else clean_loc
        return (
            f"{salutation_en}, {AGENT_PERSONA_NAME} this side from My Estate Finder. I'm calling about your property in {spoken_loc}."
            if state.reply_lang == "en"
            else f"{salutation_hi}, main {AGENT_PERSONA_NAME} baat kar rahi hoon My Estate Finder se. Aapki {spoken_loc} wali property ke baare mein call kiya tha."
        )
    return (
        f"{salutation_en}, {AGENT_PERSONA_NAME} this side from My Estate Finder."
        if state.reply_lang == "en"
        else f"{salutation_hi}, main {AGENT_PERSONA_NAME} baat kar rahi hoon My Estate Finder se."
    )


def _apply_ivr_disposition(state: RealEstateState):
    """IVR / voicemail was detected and no human took over."""
    if (
        getattr(state, "ivr_detected", False)
        or state.final_disposition == "Voicemail or IVR Detected"
        or (state.agent_summary and ("carrier announcement" in state.agent_summary.lower() or "ivr" in state.agent_summary.lower() or "voicemail" in state.agent_summary.lower()))
    ):
        state.final_disposition = "Voicemail or IVR Detected"
        state.agent_summary = state.agent_summary or "Carrier announcement / voicemail / IVR detected; no human answered"


def _apply_disconnect_disposition(state: RealEstateState):
    if (
        getattr(state, "ivr_detected", False)
        or state.final_disposition == "Voicemail or IVR Detected"
    ):
        _apply_ivr_disposition(state)
        return

    is_answered = getattr(state, "answered_at", None) is not None or getattr(state, "callee_connected", False)
    has_customer_speech = any(t.get("role") in ("customer", "user") for t in state.transcript)

    if not is_answered and not has_customer_speech:
        state.final_disposition = "Not Connected (No Answer)"
        state.agent_summary = state.agent_summary or "Call unanswered by recipient within timeout period"
        return

    state.callee_connected = True
    details_captured = []
    if state.unit_number and state.unit_number != "Standalone":
        details_captured.append(f"unit {state.unit_number}")
    if state.floor_number and state.floor_number != "Ground":
        details_captured.append(f"floor {state.floor_number}")
    if state.bhk_config:
        details_captured.append(state.bhk_config)
    if state.commercial_type:
        details_captured.append(state.commercial_type)
    if state.approx_area_sqft:
        details_captured.append(f"{state.approx_area_sqft} sq ft")
    if state.furnishing_status:
        details_captured.append(state.furnishing_status)
    if state.expected_sale_price:
        details_captured.append(f"price {state.expected_sale_price}")
    if state.expected_monthly_rent:
        details_captured.append(f"rent {state.expected_monthly_rent}")

    if state.final_disposition in (
        "Abruptly Disconnected Call",
        "Not Connected (No Answer)",
        "Interested (Disconnected)",
        "Partial Details Captured (Disconnected)",
    ):
        callee_asked_valuation = getattr(state, "valuation_requested", False)
        advisor_mentioned = False
        is_already_interested = (state.is_interested is True) or (state.intent in ("sale", "sell", "rent", "lease"))

        caller_refused = False
        for turn in state.transcript:
            if turn.get("role") in ("customer", "user"):
                t_text = (turn.get("text") or "").strip()
                if not t_text:
                    continue
                if is_already_interested:
                    if _DIRECT_NOT_INTERESTED.search(t_text):
                        caller_refused = True
                        break
                else:
                    if explicit_refusal(t_text) or _is_bare_refusal(t_text) or _DIRECT_NOT_INTERESTED.search(t_text):
                        caller_refused = True
                        break

        if caller_refused and not (details_captured and len(details_captured) >= 3):
            state.is_interested = False
            state.final_disposition = "Not Interested"
            state.agent_summary = "Customer not interested in selling or renting property"
            return

        is_interested = state.is_interested or (state.intent in ("sale", "sell", "rent", "lease"))

        if (is_interested and (details_captured or callee_asked_valuation or advisor_mentioned)) or callee_asked_valuation:
            state.final_disposition = "Advisor Callback Booked"
            state.valuation_requested = True
            desc_parts = []
            if state.intent:
                desc_parts.append(f"to {state.intent}")
            if details_captured:
                desc_parts.append(", ".join(details_captured[:4]))
            summary_desc = " | ".join(desc_parts) if desc_parts else "property details captured"
            state.agent_summary = f"Caller expressed interest ({summary_desc}); advisor follow-up booked"
        elif is_interested:
            state.final_disposition = "Advisor Callback Booked"
            intent_desc = f"to {state.intent}" if state.intent else ""
            state.agent_summary = f"Caller expressed interest {intent_desc}; senior advisor follow-up scheduled".strip()
        elif details_captured:
            summary_desc = ", ".join(details_captured[:4])
            state.final_disposition = "Advisor Callback Booked"
            state.agent_summary = f"Property details captured ({summary_desc}); senior advisor follow-up scheduled"
        else:
            state.final_disposition = "Abruptly Disconnected Call"
            if not has_customer_speech:
                state.agent_summary = state.agent_summary or "Customer answered the call but hung up during introduction"
            else:
                state.agent_summary = state.agent_summary or "Customer hung up abruptly during the call"


def post_re_outcome_sync(state: RealEstateState) -> bool:
    if not state.call_id:
        logger.error("post_re_outcome_sync: call_id is empty, nothing can be saved")
        return False

    url = f"{BACKEND_URL}/internal/real-estate/calls/{state.call_id}/outcome"
    headers = {
        "X-Internal-Secret": INTERNAL_SECRET,
        "Content-Type": "application/json",
    }
    has_customer = any(t.get("role") in ("customer", "user") for t in state.transcript)

    if getattr(state, "answered_at", None):
        duration = max(1, int(time.time() - state.answered_at))
    elif has_customer or getattr(state, "callee_connected", False):
        duration = max(1, int(time.time() - state.start_time))
    else:
        duration = 0

    category_val = state.category or "residential"
    bhk_val = state.bhk_config
    comm_val = state.commercial_type

    median_ms = int(statistics.median(state.latency_samples) * 1000) if state.latency_samples else None

    if getattr(state, "ivr_detected", False):
        _apply_ivr_disposition(state)

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
        "recording_url": getattr(state, "recording_url", None),
    }

    logger.info(f"📤 Posting RE outcome to {url} (call={state.call_id}, duration={duration}s, disp={state.final_disposition})")
    for attempt in range(1, 6):
        try:
            res = requests.post(url, json=payload, headers=headers, timeout=8.0)
            if res.status_code in (200, 201):
                logger.info(f"✅ Real estate outcome saved for call {state.call_id} (Disp: {state.final_disposition})")
                return True
            logger.error(f"❌ Outcome POST attempt {attempt} -> HTTP {res.status_code}: {res.text[:200]}")
            if res.status_code in (400, 401, 403) or (res.status_code == 404 and attempt >= 3):
                break
        except Exception as e:
            logger.error(f"❌ Exception posting RE outcome (attempt {attempt}): {e}")
        time.sleep(min(4.0, 1.0 * attempt))
    return False


# ── Service factories ─────────────────────────────────────────────────────────
def _stt_languages() -> List[Language]:
    langs: List[Language] = []
    for code in (STT_LANGUAGE or "hi,en").replace(" ", "").split(","):
        try:
            langs.append(Language(code.split("-")[0].lower()))
        except ValueError:
            logger.warning(f"Unknown STT language hint '{code}' ignored")
    return langs or [Language.HI, Language.EN]


def _build_llm_services() -> list:
    """Groq (fast LPU endpoint) first when keyed, OpenRouter as fallback / sole provider."""
    services = []
    provider = LLM_PROVIDER
    use_groq = bool(GROQ_API_KEY) and provider in ("auto", "groq")
    use_or = bool(OPENROUTER_API_KEY) and (provider in ("auto", "openrouter") or (use_groq and LLM_FALLBACK))

    if use_groq:
        services.append(
            GroqLLMService(
                api_key=GROQ_API_KEY,
                settings=GroqLLMService.Settings(model=GROQ_MODEL, temperature=0.05, max_tokens=LLM_MAX_TOKENS),
            )
        )
    if use_or:
        if OPENROUTER_PROVIDER_ORDER:
            prov: Any = {"order": OPENROUTER_PROVIDER_ORDER, "allow_fallbacks": True}
        elif OPENROUTER_PROVIDER_SORT and OPENROUTER_PROVIDER_SORT.lower() != "none":
            prov = {"sort": OPENROUTER_PROVIDER_SORT}
        else:
            prov = None
        or_kwargs: Dict[str, Any] = dict(model=LLM_MODEL, temperature=0.05, max_tokens=LLM_MAX_TOKENS)
        if prov:
            or_kwargs["provider"] = prov
        services.append(
            OpenRouterLLMService(api_key=OPENROUTER_API_KEY, settings=OpenRouterLLMService.Settings(**or_kwargs))
        )
    if not services:
        raise RuntimeError("No LLM configured: set GROQ_API_KEY and/or OPENROUTER_API_KEY")
    if not LLM_FALLBACK:
        services = services[:1]
    return services


def _wrap_llm(services: list):
    """One service -> use it directly. Several -> ServiceSwitcher with automatic failover."""
    if len(services) == 1:
        return services[0]
    from pipecat.pipeline.service_switcher import ServiceSwitcher, ServiceSwitcherStrategyFailover

    return ServiceSwitcher(services=services, strategy_type=ServiceSwitcherStrategyFailover)


def _build_tts(session: aiohttp.ClientSession, lang: str) -> SarvamHttpTTSService:
    settings_kwargs: Dict[str, Any] = dict(
        voice=TTS_SPEAKER_EN if lang == "en" else TTS_SPEAKER_HI,
        model=TTS_MODEL,
        language=Language.EN_IN if lang == "en" else Language.HI_IN,
        pace=TTS_PACE,
    )
    # bulbul:v4-flash ignores `temperature` (Pipecat logs a warning) -> only send it to models that honour it.
    if "v3" in TTS_MODEL:
        settings_kwargs["temperature"] = TTS_TEMPERATURE
    return SarvamHttpTTSService(
        api_key=SARVAM_API_KEY,
        aiohttp_session=session,
        sample_rate=TTS_SAMPLE_RATE,
        settings=SarvamHttpTTSService.Settings(**settings_kwargs),
    )


# ── Pipecat Real Estate Pipeline ─────────────────────────────────────────────
async def run_real_estate_pipeline(
    transport: BaseTransport,
    call_id: Optional[str] = None,
    phone: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
):
    """Safety wrapper: whatever goes wrong while the pipeline is being BUILT or run (bad API key, service init
    error, ...), the outcome (disposition, transcript so far, duration, recording) is still posted to the backend.
    Before this, an exception before runner.run() skipped _finish_call(), the backend never got an outcome and
    showed its own default ("Completed" + "Abruptly Disconnected Call", no duration / recording / transcript)."""
    holder: Dict[str, Any] = {}
    try:
        await _run_real_estate_pipeline(transport, call_id, phone, metadata, holder)
    except Exception as e:
        logger.error(f"Real-estate pipeline failed for call {call_id}: {e}", exc_info=True)
        st = holder.get("state")
        if st is not None and not st.outcome_posted:
            # The stream was opened by Exotel, so the callee did pick up: don't report it as "No Answer".
            st.callee_connected = True
            st.agent_summary = st.agent_summary or f"System error during call ({type(e).__name__}: {str(e)[:120]})"
            await asyncio.shield(_finish_call(st, holder.get("recorder")))
        raise


async def _run_real_estate_pipeline(
    transport: BaseTransport,
    call_id: Optional[str],
    phone: Optional[str],
    metadata: Optional[Dict[str, Any]],
    holder: Dict[str, Any],
):
    metadata = metadata or {}
    resolved_call_id = call_id or _resolve_call_id(metadata=metadata)
    resolved_phone = phone or metadata.get("phone", "")
    owner_name = metadata.get("customerName") or metadata.get("ownerName", "")
    raw_loc = (metadata.get("propertyLocation") or metadata.get("address") or metadata.get("location") or metadata.get("customerAddress") or "").strip()
    raw_category = (metadata.get("category") or metadata.get("propertyCategory") or "").strip()

    if not raw_category or raw_category.lower() in ("none", "null", "undefined", ""):
        raw_category = "residential"

    clean_owner = (owner_name or "").strip()
    if not clean_owner or clean_owner.lower() in ("property owner", "test subscriber", "test customer", "none", "null", "undefined", "customer"):
        owner_name = None
    else:
        owner_name = clean_owner

    raw_pref = (metadata.get("preferredLanguage") or metadata.get("language") or DEFAULT_LANGUAGE).strip().lower()
    preferred_language = "hi" if raw_pref in ("hi", "hindi", "hi-in", "hinglish") else "en"
    lead_id = metadata.get("leadId")
    direction = metadata.get("direction", "outbound")
    property_location = None if not raw_loc or raw_loc.lower() in ("none", "null", "undefined", "n/a") else raw_loc

    state = RealEstateState(
        call_id=resolved_call_id,
        lead_id=lead_id,
        owner_name=owner_name,
        phone=resolved_phone,
        preferred_language=preferred_language,
        direction=direction,
        property_location=property_location,
        category=raw_category,
    )

    # Real-time transcript reporting. Fire-and-forget on a worker thread: never blocks the audio loop.
    def _post_turn(role: str, text: str, ts: str):
        try:
            requests.post(
                f"{BACKEND_URL}/internal/real-estate/calls/{resolved_call_id}/turn",
                headers={"X-Internal-Secret": INTERNAL_SECRET},
                json={"role": role, "text": text, "timestamp": ts},
                timeout=3.0,
            )
        except Exception as ex:
            logger.debug(f"Incremental turn save note: {ex}")

    def log_dialogue(role: str, text: str):
        clean = (text or "").strip()
        if not clean:
            return
        is_agent = role in ("assistant", "agent")
        clean = _clean_leaks(clean).strip() if is_agent else clean
        if not clean:
            return
        now_str = datetime.now().strftime("%H:%M:%S")
        prefix = f"[{now_str}] 🤖 [Agent ({AGENT_PERSONA_NAME})]:" if is_agent else f"[{now_str}] 🗣️ [Customer]:"
        logger.info(f"{prefix} {clean}")
        state.add_transcript("assistant" if is_agent else "customer", clean)
        if resolved_call_id:
            _backend_pool.submit(_post_turn, "assistant" if is_agent else "customer", clean, datetime.now().isoformat())

    tools = RealEstateTools(state, None, None)
    tools.log_dialogue_func = log_dialogue
    holder["state"] = state

    recorder: Optional[CallRecorder] = None
    if RECORD_CALLS and resolved_call_id:
        recorder = CallRecorder(resolved_call_id, sample_rate=PIPELINE_IN_SAMPLE_RATE)
    holder["recorder"] = recorder

    async with aiohttp.ClientSession() as aiohttp_session:
        vad = VADProcessor(
            vad_analyzer=SileroVADAnalyzer(
                params=VADParams(stop_secs=VAD_MIN_SILENCE, confidence=VAD_CONFIDENCE)
            )
        )
        stt = SonioxSTTService(
            api_key=SONIOX_API_KEY,
            settings=SonioxSTTService.Settings(
                model=SONIOX_MODEL,
                language_hints=_stt_languages(),
                enable_language_identification=True,
            ),
        )
        llm_services = _build_llm_services()
        llm = _wrap_llm(llm_services)
        tts = _build_tts(aiohttp_session, state.reply_lang)

        # System prompt + tools for the FIRST step. Both are refreshed by PipecatSession on every step change.
        context = LLMContext(messages=[{"role": "system", "content": get_step_instructions(state)}])
        # Explicit end-of-turn: Pipecat's DEFAULT is the Smart-Turn v3 ONNX model, which the Dockerfile never
        # pre-downloaded and which adds its own latency. A plain "VAD silence + short timeout" rule is predictable
        # and tuned by USER_SPEECH_TIMEOUT (VAD_MIN_SILENCE + this = time from caller's last word to our reply start).
        user_agg, assistant_agg = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(
                user_turn_strategies=UserTurnStrategies(
                    stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=USER_SPEECH_TIMEOUT)]
                ),
            ),
        )

        injector = SpeechInjector()
        tracker = PlayoutTracker(state)
        session = PipecatSession(state, tools, context, injector, tracker, log_dialogue)
        tools.agent = session                       # tools.py: update_instructions / update_tools / .session.say
        handler = RealEstateTurnHandler(state, tools, session)
        handler.on_language_change = session.set_reply_language
        gate = TurnGate(state, handler, context, log_dialogue)
        guard = LLMOutputGuard(state, handler, log_dialogue)
        session.guard = guard

        # Register EVERY tool on every LLM service (the per-step subset is what the LLM is shown; _dispatch also
        # rejects a tool that is not allowed at the current step).
        all_tools = [
            tools.customer_interested, tools.not_interested_in_this_location, tools.has_other_property,
            tools.set_new_property_location, tools.confirm_owner_name, tools.set_category_and_intent,
            tools.save_property_details, tools.customer_does_not_know, tools.finish_property_intake,
            tools.mark_not_interested, tools.schedule_callback, tools.book_advisor_handoff,
            tools.request_whatsapp_info, tools.suppress_contact_dnc, tools.mark_wrong_number,
        ]
        for svc in llm_services:
            session.register_tools_on(svc, all_tools)
        await session.update_tools(tools.tools_for_step(state.step))

        processors = [
            transport.input(),
            vad,
            stt,
            user_agg,
            gate,
            llm,
            guard,
            injector,
            tts,
            transport.output(),
        ]
        if recorder:
            processors.append(recorder.processor)
        processors += [tracker, assistant_agg]

        task = PipelineTask(
            Pipeline(processors),
            params=PipelineParams(
                audio_in_sample_rate=PIPELINE_IN_SAMPLE_RATE,
                audio_out_sample_rate=PIPELINE_OUT_SAMPLE_RATE,
            ),
        )
        session.task = task

        async def _hangup():
            if state.hangup_started:
                return
            state.hangup_started = True
            logger.info("📞 Hanging up (EndFrame queued).")
            await task.queue_frame(EndFrame())

        tools.hangup_func = _hangup

        @transport.event_handler("on_client_disconnected")
        async def _on_disconnect(_transport, _ws):
            logger.info("🔌 Caller side closed the stream -> cancelling pipeline")
            state.hangup_started = True
            await task.cancel()

        greeting = _build_greeting(state)

        @task.event_handler("on_pipeline_started")
        async def _on_started(_task, _frame):
            session.start()
            state.callee_connected = True
            state.answered_at = time.time()
            state.last_activity_time = time.time()
            log_dialogue("assistant", greeting)
            context.add_message({"role": "assistant", "content": greeting})
            # Non-interruptible so pickup noise / "hello?" cannot cancel the opening line.
            session.say(greeting, allow_interruptions=False)

        # ── watchdogs ──
        async def _max_duration_watchdog():
            try:
                await asyncio.sleep(MAX_CALL_SECONDS)
                if state.closing_spoken or state.hangup_started:
                    return
                # Intake almost finished: give it one short extension instead of cutting off the last question.
                try:
                    _left = len(state.get_missing_fields())
                    _in_intake = state.step.value in ("RESIDENTIAL_SALE", "RESIDENTIAL_LEASE", "COMMERCIAL_SALE", "COMMERCIAL_LEASE")
                except Exception:
                    _left, _in_intake = 99, False
                if _in_intake and 0 < _left <= 3 and MAX_CALL_EXTENSION_SECONDS > 0:
                    logger.info(f"⏰ [Watchdog] {_left} field(s) left at the limit -> extending by {MAX_CALL_EXTENSION_SECONDS}s")
                    await asyncio.sleep(MAX_CALL_EXTENSION_SECONDS)
                    if state.closing_spoken or state.hangup_started:
                        return
                # Never cut the caller / agent off mid-sentence: wait (max 10s) for the line to go quiet.
                _w = 0.0
                while tracker.speaking and _w < 10.0:
                    await asyncio.sleep(0.5)
                    _w += 0.5
                logger.info(f"⏰ [Watchdog] Call {state.call_id} reached {MAX_CALL_SECONDS}s limit -> closing.")
                tools._speak_closing_and_hangup()
            except asyncio.CancelledError:
                pass

        async def _silence_watchdog():
            """Dead-air handling (the old pipeline just sat silent forever)."""
            prompts = 0
            try:
                while True:
                    await asyncio.sleep(1.0)
                    if state.closing_spoken or state.hangup_started or tracker.speaking:
                        continue
                    now = time.time()
                    if now < state.hold_until:          # caller asked us to wait ("ek minute")
                        continue
                    ref = max(state.last_activity_time, state.last_agent_speech_end, state.answered_at or 0.0)
                    if now - ref < SILENCE_PROMPT_SECONDS:
                        continue
                    prompts += 1
                    state.silence_count = prompts
                    if prompts > MAX_SILENCE_PROMPTS:
                        logger.info("🔇 No response after repeated prompts -> ending call")
                        await _hangup()
                        return
                    en = state.reply_lang == "en"
                    if prompts == 1:
                        line = "Hello Sir, are you still there?" if en else "Hello Sir, kya aap line par hain?"
                    else:
                        line = ("Sir, if this is a bad time, I can call you back later." if en
                                else "Sir, agar abhi busy hain toh main baad mein call kar sakti hoon.")
                    log_dialogue("assistant", line)
                    session.say(line)
                    state.last_activity_time = now
            except asyncio.CancelledError:
                pass

        watchdogs = [asyncio.create_task(_max_duration_watchdog()), asyncio.create_task(_silence_watchdog())]

        runner = PipelineRunner(handle_sigint=False)
        try:
            logger.info(f"▶️ Running Pipecat Real Estate Pipeline for call {state.call_id}...")
            await runner.run(task)
        finally:
            for w in watchdogs:
                w.cancel()
            await session.close()
            # Everything below must finish even if this coroutine is being cancelled.
            await asyncio.shield(_finish_call(state, recorder))

    logger.info(f"🏁 Finished call {state.call_id}. Disposition: {state.final_disposition}")


async def _finish_call(state: RealEstateState, recorder: Optional[CallRecorder]):
    """Recording first (so the URL goes into the outcome), then disposition + outcome POST (off the event loop)."""
    if recorder:
        try:
            state.recording_url = await recorder.finalize()
        except Exception as e:
            logger.warning(f"Recording finalize failed: {e}")
    _apply_disconnect_disposition(state)
    if state.outcome_posted:
        return
    state.outcome_posted = True
    await asyncio.to_thread(post_re_outcome_sync, state)


# Compatibility alias
entrypoint = run_real_estate_pipeline