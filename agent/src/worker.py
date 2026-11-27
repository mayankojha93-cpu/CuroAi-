"""Pipecat Voice AI worker for Airtel Wi-Fi Router Return Pickup agent (Priya / Kavitha).

Telephony pipeline running directly over Exotel WSS stream:
  Exotel media-stream -> FastAPIWebsocketTransport -> Silero VAD -> Soniox STT
  -> ContextAggregator -> TurnGate (AirtelTurnHandler) -> LLM (Groq / OpenRouter)
  -> LLMOutputGuard -> SpeechInjector -> Sarvam TTS -> FastAPIWebsocketTransport output.
"""
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
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.services.groq.llm import GroqLLMService
from pipecat.services.openrouter.llm import OpenRouterLLMService
from pipecat.services.sarvam.tts import SarvamHttpTTSService
from pipecat.services.soniox.stt import SonioxSTTService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import BaseTransport
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from src.agent import AirtelTurnHandler
from src.config import (
    BACKEND_URL,
    GROQ_API_KEY,
    GROQ_MODEL,
    INTERNAL_SECRET,
    LLM_FALLBACK,
    LLM_MAX_TOKENS,
    LLM_MODEL,
    LLM_PROVIDER,
    MAX_CALL_SECONDS,
    MAX_SILENCE_PROMPTS,
    OPENROUTER_API_KEY,
    OPENROUTER_PROVIDER_ORDER,
    OPENROUTER_PROVIDER_SORT,
    PERSONA_NAME,
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
    VAD_MIN_SILENCE,
    logger,
)
from src.lang import L
from src.pipecat_adapter import (
    LLMOutputGuard,
    PipecatSession,
    PlayoutTracker,
    SpeechInjector,
    TurnGate,
)
from src.prompts import get_step_instructions
from src.state import ConversationState, Step
from src.tools.agent_tools import AgentTools
from src.tools.api import post_outcome_to_backend
from src.utils.audio_recorder import CallRecorder

_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)

_backend_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="airtel-backend")


def _resolve_call_id(metadata: Optional[dict] = None) -> str:
    metadata = metadata or {}
    cid = str(metadata.get("callId") or metadata.get("call_id") or "").strip()
    if cid:
        return cid
    return ""


def _build_greeting(state: ConversationState) -> str:
    customer_name = state.customer_name or "Customer"
    is_inbound = state.direction == "inbound"
    _n = customer_name.lower().strip()
    is_generic = not _n or any(t in _n for t in ["customer", "subscriber", "user", "airtel", "client"])

    if is_inbound:
        if state.reply_lang == "en":
            if not is_generic:
                return f"Hello {customer_name}, welcome to Airtel. I am {PERSONA_NAME}. Have you called regarding your Wi-Fi router pickup or account?"
            return f"Hello, welcome to Airtel. I am {PERSONA_NAME}. How may I assist you today?"
        else:
            if not is_generic:
                return f"नमस्ते {customer_name} जी, एयरटेल में आपका स्वागत है। मैं {PERSONA_NAME} बोल रही हूँ। क्या आपने अपने वाई-फाई राउटर पिकअप या अकाउंट के संबंध में कॉल किया है?"
            return f"नमस्ते, एयरटेल में आपका स्वागत है। मैं {PERSONA_NAME} बोल रही हूँ। मैं आपकी क्या मदद कर सकती हूँ?"
    else:
        if state.reply_lang == "en":
            who = "the registered Airtel Wi-Fi customer" if is_generic else f"{customer_name}"
            return f"Hello, I am {PERSONA_NAME} calling from Airtel. Am I speaking with {who}?"
        else:
            who = "एयरटेल वाई-फाई कनेक्शन के रजिस्टर्ड ग्राहक" if is_generic else f"{customer_name} जी"
            return f"नमस्ते, मैं {PERSONA_NAME} बोल रही हूँ, एयरटेल की तरफ से। क्या मैं {who} से बात कर रही हूँ?"


def _stt_languages() -> List[Language]:
    langs: List[Language] = []
    for code in (STT_LANGUAGE or "hi,en").replace(" ", "").split(","):
        try:
            langs.append(Language(code.split("-")[0].lower()))
        except ValueError:
            logger.warning(f"Unknown STT language hint '{code}' ignored")
    return langs or [Language.HI, Language.EN]


def _build_llm_services() -> list:
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
        is_lpu_model = any(k in LLM_MODEL.lower() for k in ("llama", "mistral", "mixtral", "qwen"))
        if OPENROUTER_PROVIDER_ORDER and is_lpu_model:
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
    if len(services) == 1:
        return services[0]
    from pipecat.pipeline.service_switcher import ServiceSwitcher, ServiceSwitcherStrategyFailover

    return ServiceSwitcher(services=services, strategy_type=ServiceSwitcherStrategyFailover)


from tts_factory import build_tts_service, extract_tts_provider


def _build_tts(session: aiohttp.ClientSession, lang: str, tts_provider: str = "sarvam"):
    return build_tts_service(
        tts_provider,
        session,
        lang=lang,
        speaker_en=TTS_SPEAKER_EN,
        speaker_hi=TTS_SPEAKER_HI,
        model=TTS_MODEL,
        sample_rate=TTS_SAMPLE_RATE,
        pace=TTS_PACE,
        temperature=TTS_TEMPERATURE,
    )


async def run_airtel_pipeline(
    transport: BaseTransport,
    call_id: Optional[str] = None,
    phone: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
):
    metadata = metadata or {}
    resolved_call_id = call_id or _resolve_call_id(metadata=metadata)
    resolved_phone = phone or metadata.get("phone", "")
    customer_name = metadata.get("customerName") or metadata.get("name") or "Customer"
    address = metadata.get("address") or metadata.get("propertyLocation") or "Delhi, 110011, burari, sant nagar"
    raw_lang = (metadata.get("preferredLanguage") or metadata.get("language") or "hi").strip().lower()
    language = "en" if raw_lang in ("en", "english", "en-in") else "hi"
    account_no = metadata.get("accountNo") or metadata.get("account_no", "")
    subs_del_no = metadata.get("subsDelNo") or metadata.get("subs_del_no", "")
    service_end_date = metadata.get("serviceEndDate") or metadata.get("service_end_date", "")
    r_date = metadata.get("rDate") or metadata.get("r_date", "")
    direction = metadata.get("direction", "outbound")
    attempt_number = int(metadata.get("attemptNumber", 1))

    state = ConversationState(
        call_id=resolved_call_id,
        customer_name=customer_name,
        phone=resolved_phone,
        address=address,
        language=language,
        account_no=account_no,
        subs_del_no=subs_del_no,
        service_end_date=service_end_date,
        r_date=r_date,
        attempt_number=attempt_number,
        direction=direction,
    )

    def _post_turn(role: str, text: str, ts: str):
        try:
            requests.post(
                f"{BACKEND_URL}/internal/calls/{resolved_call_id}/turn",
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
        now_str = datetime.now().strftime("%H:%M:%S")
        prefix = f"[{now_str}] 🤖 [Agent ({PERSONA_NAME})]:" if is_agent else f"[{now_str}] 🗣️ [Customer]:"
        logger.info(f"{prefix} {clean}")
        state.add_transcript("assistant" if is_agent else "customer", clean)
        if resolved_call_id:
            _backend_pool.submit(_post_turn, "assistant" if is_agent else "customer", clean, datetime.now().isoformat())

    def _post_state(payload: dict):
        if not resolved_call_id:
            return
        try:
            requests.post(
                f"{BACKEND_URL}/internal/calls/{resolved_call_id}/state",
                headers={"X-Internal-Secret": INTERNAL_SECRET},
                json=payload,
                timeout=3.0,
            )
        except Exception as ex:
            logger.debug(f"Incremental Airtel state sync note: {ex}")

    def sync_state():
        if not resolved_call_id:
            return
        payload = {
            "step": state.step.value,
            "identity_confirmed": state.identity_confirmed,
            "pickup_accepted": state.pickup_accepted,
            "proposed_date": state.proposed_date,
            "confirmed_date": state.confirmed_date,
            "offered_date": state.offered_date,
            "registered_address_confirmed": state.registered_address_confirmed,
            "new_address": state.new_address,
            "pending_question": state.closing_line or None,
        }
        _backend_pool.submit(_post_state, payload)

    timing_tracker: Dict[str, Any] = {"last_activity_time": time.time()}
    tools = AgentTools(state, timing_tracker)
    tools.log_dialogue_func = log_dialogue
    tools.sync_state_func = sync_state

    recorder: Optional[CallRecorder] = None
    if RECORD_CALLS and resolved_call_id:
        recorder = CallRecorder(resolved_call_id, sample_rate=PIPELINE_IN_SAMPLE_RATE)

    async with aiohttp.ClientSession() as aiohttp_session:
        vad = VADProcessor(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=VAD_MIN_SILENCE))
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
        tts_provider = extract_tts_provider(metadata)
        tts = _build_tts(aiohttp_session, state.reply_lang, tts_provider)

        context = LLMContext(messages=[{"role": "system", "content": get_step_instructions(state)}])
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
        session = PipecatSession(state, tools, context, injector, tracker, log_dialogue, tts_provider=tts_provider)
        tools.agent = session
        handler = AirtelTurnHandler(state, tools, session)
        handler.on_language_change = session.set_reply_language
        gate = TurnGate(state, handler, context, log_dialogue)
        guard = LLMOutputGuard(state, handler, log_dialogue)
        session.guard = guard

        all_tools = [
            tools.confirm_identity, tools.set_pickup, tools.set_pickup_date, tools.record_willing_no_date,
            tools.schedule_callback, tools.confirm_address, tools.record_device_issue, tools.record_refusal,
            tools.record_temporarily_unavailable, tools.record_recharge, tools.escalate_to_121,
            tools.record_shifted, tools.record_already_picked_up, tools.record_already_returned,
            tools.record_still_using_device, tools.record_do_not_call, tools.record_language_barrier,
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
                allow_interruptions=True,
            ),
        )
        session.task = task

        async def _hangup():
            if state.hangup_started:
                return
            state.hangup_started = True
            logger.info("📞 [Airtel] Hanging up (EndFrame queued).")
            await task.queue_frame(EndFrame())

        tools.hangup_func = _hangup

        @transport.event_handler("on_client_disconnected")
        async def _on_disconnect(_transport, _ws):
            logger.info("🔌 Caller side closed the stream -> cancelling Airtel pipeline")
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
            session.say(greeting, allow_interruptions=True)

        async def _max_duration_watchdog():
            try:
                await asyncio.sleep(MAX_CALL_SECONDS)
                if state.closing_spoken or state.hangup_started:
                    return
                _w = 0.0
                while tracker.speaking and _w < 10.0:
                    await asyncio.sleep(0.5)
                    _w += 0.5
                logger.info(f"⏰ [Watchdog] Airtel Call {state.call_id} reached {MAX_CALL_SECONDS}s limit -> closing.")
                # tools._say() no longer speaks non-terminal lines by itself, and the old code queued the hangup
                # right after it, cutting the closing line off. Speak it, wait for playout, then hang up.
                closing = tools._closing()
                state.closing_spoken = True
                state.closing_line = closing
                log_dialogue("assistant", closing)
                handle = session.say(closing, allow_interruptions=False)
                await handle.wait_for_playout()
                await asyncio.sleep(0.8)
                await _hangup()
            except asyncio.CancelledError:
                pass

        async def _silence_watchdog():
            prompts = 0
            try:
                while True:
                    await asyncio.sleep(1.0)
                    if state.closing_spoken or state.hangup_started or tracker.speaking:
                        continue
                    now = time.time()
                    if now < state.hold_until:
                        continue
                    ref = max(state.last_activity_time, state.last_agent_speech_end, state.answered_at or 0.0)
                    if now - ref < SILENCE_PROMPT_SECONDS:
                        continue
                    prompts += 1
                    state.silence_count = prompts
                    if prompts > MAX_SILENCE_PROMPTS:
                        logger.info("🔇 Persistent silence -> concluding Airtel call as NO_RESPONSE")
                        state.final_disposition = "NO_RESPONSE"
                        state.customer_note = "Call ended due to persistent customer silence (NO_RESPONSE)"
                        state.transition_to(Step.TERMINATED)
                        closing = L(
                            state,
                            "शायद आपकी आवाज़ नहीं आ पा रही है। हम आपसे बाद में संपर्क करेंगे। धन्यवाद।",
                            "I think your voice is not reaching me. We will contact you later. Thank you.",
                        )
                        log_dialogue("assistant", closing)
                        session.say(closing, allow_interruptions=False)
                        await asyncio.sleep(3.0)
                        await _hangup()
                        return

                    if prompts == 1:
                        line = L(state, "नमस्ते, क्या आप मुझे सुन पा रहे हैं?", "Hello, can you hear me?")
                    else:
                        line = L(
                            state,
                            f"नमस्ते {state.customer_name} जी, क्या मेरी आवाज़ आप तक पहुँच रही है?",
                            f"Hello {state.customer_name}, is my voice reaching you?",
                        )
                    log_dialogue("assistant", line)
                    session.say(line)
                    state.last_activity_time = now
            except asyncio.CancelledError:
                pass

        watchdogs = [asyncio.create_task(_max_duration_watchdog()), asyncio.create_task(_silence_watchdog())]

        runner = PipelineRunner(handle_sigint=False)
        try:
            logger.info(f"▶️ Running Pipecat Airtel Pipeline for call {state.call_id}...")
            await runner.run(task)
        finally:
            for w in watchdogs:
                w.cancel()
            await session.close()
            await asyncio.shield(_finish_call(state, recorder))

    logger.info(f"🏁 Finished Airtel call {state.call_id}. Disposition: {state.final_disposition}")


async def _finish_call(state: ConversationState, recorder: Optional[CallRecorder]):
    if recorder:
        try:
            state.recording_url = await recorder.finalize()
        except Exception as e:
            logger.warning(f"Recording finalize failed: {e}")

    # Set disconnect disposition if needed
    is_answered = getattr(state, "answered_at", None) is not None or getattr(state, "callee_connected", False)
    has_customer_speech = any(t.get("role") in ("customer", "user") for t in state.transcript)

    if not is_answered and not has_customer_speech:
        state.final_disposition = "Not Connected (No Answer)"
        state.customer_note = state.customer_note or "Call unanswered by recipient within timeout period"
    elif getattr(state, "ivr_detected", False) or state.final_disposition == "Voicemail or IVR Detected":
        state.final_disposition = "Voicemail or IVR Detected"
    elif not state.is_terminal():
        if state.step == Step.CLOSE and state.confirmed_date:
            state.final_disposition = "CONFIRMED_FOR_PICKUP"
        else:
            state.final_disposition = "Abruptly Disconnected Call"
            if not has_customer_speech:
                state.customer_note = state.customer_note or "Customer answered the call but hung up during introduction"
            else:
                state.customer_note = state.customer_note or "Customer hung up abruptly during the call"

    if state.outcome_posted:
        return
    state.outcome_posted = True
    await asyncio.to_thread(post_outcome_to_backend, state)
    