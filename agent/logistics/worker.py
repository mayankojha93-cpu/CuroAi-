import asyncio
import json
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
from pipecat.frames.frames import EndFrame, Frame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.groq.llm import GroqLLMService
from pipecat.services.openrouter.llm import OpenRouterLLMService
from pipecat.services.sarvam.tts import SarvamHttpTTSService
from pipecat.services.soniox.stt import SonioxSTTService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import BaseTransport
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .audio_recorder import CallRecorder
from .config import (
    BACKEND_URL,
    GROQ_API_KEY,
    GROQ_MODEL,
    INTERNAL_SECRET,
    LLM_FALLBACK,
    LLM_MAX_TOKENS,
    LLM_MODEL,
    LLM_PROVIDER,
    MAX_CALL_EXTENSION_SECONDS,
    MAX_CALL_SECONDS,
    MAX_SILENCE_PROMPTS,
    OPENROUTER_API_KEY,
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
    TTS_SPEAKER,
    TTS_TEMPERATURE,
    USER_SPEECH_TIMEOUT,
    VAD_CONFIDENCE,
    VAD_MIN_SILENCE,
    logger,
)
from .pipecat_adapter import (
    LLMOutputGuard,
    LogisticsSession,
    PlayoutTracker,
    SpeechInjector,
)
from .prompts import build_greeting, build_system_prompt
from .state import LogisticsState, SilenceGuard
from .tools import LogisticsTools

_backend_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="logistics-backend")


class _UserTranscriptLogger(FrameProcessor):
    def __init__(self, state: LogisticsState, log_dialogue):
        super().__init__()
        self.state = state
        self.log_dialogue = log_dialogue

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.text and frame.text.strip():
            self.state.last_activity_time = time.time()
            self.log_dialogue("user", frame.text.strip())
        await self.push_frame(frame, direction)


def _build_llm_services() -> list:
    services = []
    prefer_openrouter = LLM_PROVIDER in ("openrouter", "auto")
    if prefer_openrouter and OPENROUTER_API_KEY:
        services.append(
            OpenRouterLLMService(
                api_key=OPENROUTER_API_KEY,
                model=LLM_MODEL,
                params=OpenRouterLLMService.InputParams(max_tokens=LLM_MAX_TOKENS, temperature=0.35),
            )
        )
    if GROQ_API_KEY and (not services or LLM_FALLBACK or LLM_PROVIDER == "groq"):
        groq_svc = GroqLLMService(
            api_key=GROQ_API_KEY,
            model=GROQ_MODEL,
            params=GroqLLMService.InputParams(max_tokens=LLM_MAX_TOKENS, temperature=0.35),
        )
        if LLM_PROVIDER == "groq":
            services.insert(0, groq_svc)
        else:
            services.append(groq_svc)
    if not services and OPENROUTER_API_KEY:
        services.append(
            OpenRouterLLMService(
                api_key=OPENROUTER_API_KEY,
                model=LLM_MODEL,
                params=OpenRouterLLMService.InputParams(max_tokens=LLM_MAX_TOKENS, temperature=0.35),
            )
        )
    if not services:
        raise RuntimeError("No LLM API key configured (OPENROUTER_API_KEY or GROQ_API_KEY required).")
    return services


def _wrap_llm(services: list):
    if len(services) == 1:
        return services[0]
    from pipecat.pipeline.service_switcher import ServiceSwitcher, ServiceSwitcherStrategyFailover

    return ServiceSwitcher(services=services, strategy_type=ServiceSwitcherStrategyFailover)


def _build_tts(session: aiohttp.ClientSession) -> SarvamHttpTTSService:
    kwargs: Dict[str, Any] = dict(
        voice=TTS_SPEAKER,
        model=TTS_MODEL,
        language=Language.HI_IN,
        pace=TTS_PACE,
    )
    if "v3" in TTS_MODEL:
        kwargs["temperature"] = TTS_TEMPERATURE
    return SarvamHttpTTSService(
        api_key=SARVAM_API_KEY,
        aiohttp_session=session,
        sample_rate=TTS_SAMPLE_RATE,
        settings=SarvamHttpTTSService.Settings(**kwargs),
    )


def _extract_end_of_call_json_sync(state: LogisticsState) -> Dict[str, Any]:
    """Run structured end-of-call JSON extraction from transcript + tool state."""
    payload = state.to_outcome_payload()

    dialogue_lines = [
        f"{t.get('role', 'user')}: {t.get('text', '')}"
        for t in state.transcript
        if t.get("text")
    ]
    dialogue_text = "\n".join(dialogue_lines)

    if not dialogue_text.strip():
        payload["call_status"] = "no_answer" if state.silence_count >= MAX_SILENCE_PROMPTS else payload["call_status"]
        payload["summary_in_english"] = "No response from driver on the call."
        return payload

    api_url = None
    api_key = None
    model = None
    if OPENROUTER_API_KEY:
        api_url = "https://openrouter.ai/api/v1/chat/completions"
        api_key = OPENROUTER_API_KEY
        model = LLM_MODEL
    elif GROQ_API_KEY:
        api_url = "https://api.groq.com/openai/v1/chat/completions"
        api_key = GROQ_API_KEY
        model = GROQ_MODEL

    if api_url and api_key:
        prompt = f"""Analyze this logistics truck-driver call transcript and current extracted state.
Return ONLY valid JSON (no markdown, no extra text) matching this exact schema:
{{
  "call_status": "connected | no_answer | busy_callback | wrong_person",
  "callback_time": "",
  "vehicle_number": "{state.vehicle_number}",
  "lr_number": "{state.lr_number}",
  "unloaded": "yes | no | on_the_way | unknown",
  "current_location": "",
  "unloading_delay_reason": "queue | party_closed | weighbridge | documents | shortage_damage | union_charges | breakdown | other | none",
  "waiting_hours": "",
  "pod_signed_received": "yes | no | na",
  "shortage_or_damage_reported": "yes | no",
  "issue_details": "",
  "money_demanded_amount": "",
  "next_assignment_communicated": "yes | no",
  "driver_accepted_next_assignment": "yes | no | needs_discussion",
  "driver_departure_eta": "",
  "priority": "normal | high | urgent",
  "escalate_to_human": "yes | no",
  "driver_questions_for_ops": "",
  "summary_in_english": "2 line summary in English"
}}

Current tool-recorded state: {json.dumps(payload, ensure_ascii=False)}

Transcript:
{dialogue_text[:5000]}"""

        try:
            resp = requests.post(
                api_url,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "max_tokens": 500,
                },
                timeout=8.0,
            )
            if resp.status_code == 200:
                content = resp.json()["choices"][0]["message"]["content"].strip()
                m = re.search(r"\{.*\}", content, re.S)
                if m:
                    parsed = json.loads(m.group(0))
                    if isinstance(parsed, dict):
                        for k in payload:
                            if k in parsed and parsed[k] not in (None, ""):
                                payload[k] = parsed[k]
        except Exception as e:
            logger.warning(f"LLM end-of-call JSON extraction failed (using tool state): {e}")

    if not payload.get("summary_in_english"):
        payload["summary_in_english"] = (
            f"Call {payload['call_status']} for vehicle {state.vehicle_number} (LR {state.lr_number}). "
            f"Unloaded: {payload['unloaded']}; Priority: {payload['priority']}."
        )
    return payload


def _post_outcome_sync(state: LogisticsState):
    extracted = _extract_end_of_call_json_sync(state)
    duration_seconds = max(1, int(time.time() - (state.answered_at or state.start_time)))
    median_latency_ms = int(statistics.median(state.latency_samples) * 1000) if state.latency_samples else None

    body = {
        **extracted,
        "raw_json": extracted,
        "transcript": state.transcript,
        "duration_seconds": duration_seconds,
        "median_latency_ms": median_latency_ms,
        "recording_url": state.recording_url,
    }
    try:
        resp = requests.post(
            f"{BACKEND_URL}/internal/logistics/calls/{state.call_id}/outcome",
            headers={"X-Internal-Secret": INTERNAL_SECRET, "Content-Type": "application/json"},
            json=body,
            timeout=5.0,
        )
        logger.info(f"📤 Posted logistics outcome for {state.call_id} (HTTP {resp.status_code})")
    except Exception as e:
        logger.error(f"Failed to post logistics outcome for {state.call_id}: {e}")


async def run_logistics_pipeline(
    transport: BaseTransport,
    call_id: Optional[str] = None,
    phone: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
):
    holder: Dict[str, Any] = {}
    try:
        await _run_logistics_pipeline(transport, call_id, phone, metadata, holder)
    except Exception as e:
        logger.error(f"Logistics pipeline failed for call {call_id}: {e}", exc_info=True)
        st: Optional[LogisticsState] = holder.get("state")
        if st is not None and not st.outcome_posted:
            st.callee_connected = True
            st.issue_details = st.issue_details or f"System error: {type(e).__name__}"
            await asyncio.shield(_finish_call(st, holder.get("recorder")))
        raise


async def _run_logistics_pipeline(
    transport: BaseTransport,
    call_id: Optional[str],
    phone: Optional[str],
    metadata: Optional[Dict[str, Any]],
    holder: Dict[str, Any],
):
    metadata = metadata or {}
    call_obj = metadata.get("call") or {}
    trip_obj = metadata.get("logisticsTrip") or metadata.get("trip") or {}

    resolved_call_id = str(call_id or metadata.get("callId") or call_obj.get("id") or "")
    resolved_phone = phone or metadata.get("phone") or trip_obj.get("driver_phone") or ""

    state = LogisticsState(
        call_id=resolved_call_id,
        trip_id=trip_obj.get("id") or call_obj.get("logistics_trip_id"),
        phone=resolved_phone,
        driver_name=trip_obj.get("driver_name") or metadata.get("driverName"),
        vehicle_number=trip_obj.get("vehicle_number") or metadata.get("vehicleNumber") or "",
        lr_number=trip_obj.get("lr_number") or metadata.get("lrNumber") or "",
        origin=trip_obj.get("origin") or metadata.get("origin"),
        destination=trip_obj.get("destination") or metadata.get("destination"),
        consignee=trip_obj.get("consignee") or metadata.get("consignee"),
        material=trip_obj.get("material") or metadata.get("material"),
        expected_unload_date=trip_obj.get("expected_unload_date") or metadata.get("expectedUnloadDate"),
        call_round=int(trip_obj.get("current_call_round") or call_obj.get("attempt_number") or 1),
        next_assignment=trip_obj.get("next_assignment") or metadata.get("nextAssignment"),
        ops_number=trip_obj.get("ops_number") or metadata.get("opsNumber") or "9800011122",
    )
    holder["state"] = state

    def _post_turn(role: str, text: str, ts: str):
        try:
            requests.post(
                f"{BACKEND_URL}/internal/logistics/calls/{resolved_call_id}/turn",
                headers={"X-Internal-Secret": INTERNAL_SECRET},
                json={"role": role, "text": text, "timestamp": ts},
                timeout=3.0,
            )
        except Exception as exc:
            logger.debug(f"Turn POST failed: {exc}")

    def log_dialogue(role: str, text: str):
        ts = datetime.utcnow().isoformat() + "Z"
        state.transcript.append({"role": role, "text": text, "timestamp": ts})
        logger.info(f"💬 [{role.upper()}]: {text}")
        if resolved_call_id:
            _backend_pool.submit(_post_turn, role, text, ts)

    recorder = CallRecorder(resolved_call_id, sample_rate=PIPELINE_OUT_SAMPLE_RATE) if (RECORD_CALLS and resolved_call_id) else None
    holder["recorder"] = recorder

    async with aiohttp.ClientSession() as aiohttp_session:
        vad = VADProcessor(
            vad_analyzer=SileroVADAnalyzer(
                params=VADParams(confidence=VAD_CONFIDENCE, min_silence_secs=VAD_MIN_SILENCE)
            )
        )
        stt = SonioxSTTService(
            api_key=SONIOX_API_KEY,
            model=SONIOX_MODEL,
            sample_rate=PIPELINE_IN_SAMPLE_RATE,
            params=SonioxSTTService.InputParams(
                language_hints=[l.strip() for l in STT_LANGUAGE.split(",") if l.strip()],
                enable_language_identification=True,
            ),
        )
        llm_services = _build_llm_services()
        llm = _wrap_llm(llm_services)
        tts = _build_tts(aiohttp_session)

        context = LLMContext(messages=[{"role": "system", "content": build_system_prompt(state)}])
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
        session = LogisticsSession(state, context, injector, tracker)
        user_logger = _UserTranscriptLogger(state, log_dialogue)
        guard = LLMOutputGuard(state, log_dialogue)

        async def _hangup():
            if state.hangup_started:
                return
            state.hangup_started = True
            logger.info("📞 Logistics call hanging up (EndFrame queued).")
            if session.task:
                await session.task.queue_frame(EndFrame())

        tools = LogisticsTools(state=state, hangup_cb=_hangup, say_cb=session.say)
        tool_fns = [
            tools.record_call_status,
            tools.record_unloading_status,
            tools.record_next_assignment,
            tools.flag_safety_or_escalation,
            tools.end_logistics_call,
        ]
        for svc in llm_services:
            session.register_tools_on(svc, tool_fns)

        processors = [
            transport.input(),
            vad,
            stt,
            user_logger,
            user_agg,
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

        @transport.event_handler("on_client_disconnected")
        async def _on_disconnect(_transport, _ws):
            logger.info("🔌 Driver side closed the stream -> cancelling logistics pipeline")
            state.hangup_started = True
            await task.cancel()

        greeting = build_greeting(state)

        @task.event_handler("on_pipeline_started")
        async def _on_started(_task, _frame):
            state.callee_connected = True
            state.answered_at = time.time()
            state.last_activity_time = time.time()
            log_dialogue("assistant", greeting)
            context.add_message({"role": "assistant", "content": greeting})
            await injector.speak(greeting)

        async def _max_duration_watchdog():
            try:
                await asyncio.sleep(MAX_CALL_SECONDS)
                if state.closing_spoken or state.hangup_started:
                    return
                if state.priority in ("high", "urgent") and MAX_CALL_EXTENSION_SECONDS > 0:
                    await asyncio.sleep(MAX_CALL_EXTENSION_SECONDS)
                    if state.closing_spoken or state.hangup_started:
                        return
                w = 0.0
                while tracker.speaking and w < 10.0:
                    await asyncio.sleep(0.5)
                    w += 0.5
                closing = f"धन्यवाद भैया, कोई दिक्कत हो तो {state.ops_number} पर फ़ोन कर लेना। सुरक्षित चलाइएगा।"
                log_dialogue("assistant", closing)
                await session.say(closing)
                await _hangup()
            except asyncio.CancelledError:
                pass

        async def _silence_watchdog():
            silence = SilenceGuard(SILENCE_PROMPT_SECONDS, MAX_SILENCE_PROMPTS)
            try:
                while True:
                    await asyncio.sleep(1.0)
                    if state.closing_spoken or state.hangup_started:
                        continue
                    action = silence.tick(
                        time.time(),
                        bot_speaking=tracker.speaking,
                        caller_activity_at=state.last_activity_time,
                        agent_speech_end_at=state.last_agent_speech_end,
                        answered_at=state.answered_at or 0.0,
                        user_speaking=state.user_speaking,
                        llm_busy_since=state.llm_busy_since,
                    )
                    if action is None:
                        continue
                    state.silence_count = silence.prompts
                    if action == "hangup":
                        state.call_status = "no_answer"
                        closing = "ठीक है भैया, आवाज़ नहीं आ रही, मैं बाद में फ़ोन करती हूँ। धन्यवाद।"
                        log_dialogue("assistant", closing)
                        await session.say(closing)
                        await _hangup()
                        return
                    prompt_line = "हेलो भैया, आवाज़ आ रही है?"
                    log_dialogue("assistant", prompt_line)
                    await session.say(prompt_line)
            except asyncio.CancelledError:
                pass

        watchdogs = [asyncio.create_task(_max_duration_watchdog()), asyncio.create_task(_silence_watchdog())]
        runner = PipelineRunner(handle_sigint=False)
        try:
            logger.info(f"▶️ Running Pipecat Logistics Pipeline for call {state.call_id}...")
            await runner.run(task)
        finally:
            for w in watchdogs:
                w.cancel()
            await asyncio.shield(_finish_call(state, recorder))


async def _finish_call(state: LogisticsState, recorder: Optional[CallRecorder]):
    if recorder:
        try:
            state.recording_url = await recorder.finalize()
        except Exception as e:
            logger.warning(f"Logistics recording finalize failed: {e}")
    if state.outcome_posted:
        return
    state.outcome_posted = True
    await asyncio.to_thread(_post_outcome_sync, state)
