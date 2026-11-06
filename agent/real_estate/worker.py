import os
import re
import json
import time
import asyncio
import requests
from datetime import datetime
from pathlib import Path
from typing import Optional
from livekit import agents, api
from livekit.agents import AgentSession, AgentServer, TurnHandlingOptions
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
)
from .state import RealEstateState, RealEstateStep
from .agent import RealEstateAgent
from .tools import RealEstateTools
from .prompts import _owner_call_name
from .audio_recorder import RoomAudioRecorder
from src.transliteration import romanize_hindi

server = AgentServer()


# ── Conversation File Logger ───────────────────────────────────────────────────
# Writes a human-readable .txt log per call under recordings/conversations/.
# Format mirrors the console logs so it is easy to read and grep.

_CONV_LOG_DIR = ROOT_DIR / "recordings" / "conversations"


class ConversationFileLogger:
    """Real-time conversation logger: writes each turn to a .txt file as it happens."""

    def __init__(self, call_id: str, owner_name: str, phone: str, direction: str):
        _CONV_LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_id = (call_id or "unknown")[:36]
        self._path = _CONV_LOG_DIR / f"{ts}_{safe_id}.txt"
        self._call_id = call_id
        self._fh = open(self._path, "w", encoding="utf-8", buffering=1)  # line-buffered
        # Write header
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
        """Write outcome summary and close the file."""
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


def post_re_outcome_sync(state: RealEstateState) -> bool:
    if not state.call_id:
        return False

    url = f"{BACKEND_URL}/internal/real-estate/calls/{state.call_id}/outcome"
    headers = {
        "X-Internal-Secret": INTERNAL_SECRET,
        "Content-Type": "application/json",
    }
    has_turns = len(state.transcript) >= 1
    has_customer = any(t.get("role") == "customer" for t in state.transcript)
    callee_was_connected = state.callee_connected or has_customer or has_turns or (time.time() - state.start_time >= 5.0)
    duration = int(time.time() - state.start_time) if callee_was_connected else 0
    if duration <= 0 and (has_customer or has_turns or state.callee_connected):
        duration = max(5, int(time.time() - state.start_time))

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
        "median_latency_ms": int(sum(state.latency_samples) / len(state.latency_samples) * 1000) if state.latency_samples else None,
        "language": state.reply_lang,
        "initial_language": state.initial_language,
        "language_switched": state.language_switched,
        "recording_url": getattr(state, "recording_url", None) or f"/api/calls/{state.call_id}/audio",
    }

    logger.info(f"📤 Posting RE outcome to {url} for call {state.call_id} (duration={duration}s, turns={len(state.transcript)}, disp={state.final_disposition})")
    try:
        res = requests.post(url, json=payload, headers=headers, timeout=5.0)
        if res.status_code in (200, 201):
            logger.info(f"✅ Real estate outcome saved for call {state.call_id} (Disp: {state.final_disposition})")
            return True
        logger.error(f"❌ Failed to save RE outcome ({res.status_code}): {res.text}")
    except Exception as e:
        logger.error(f"❌ Exception posting RE outcome: {e}")
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

    call_id = metadata.get("callId", "")
    if not call_id and ctx.room.name.startswith("re-call-"):
        call_id = ctx.room.name[8:]
    elif not call_id and ctx.room.name.startswith("call-"):
        call_id = ctx.room.name[5:]

    phone = metadata.get("phone", "")
    owner_name = metadata.get("customerName") or metadata.get("ownerName", "")
    clean_owner = (owner_name or "").strip()
    if not clean_owner or clean_owner in ("Property Owner", "Test Subscriber", "Test Customer", "None", "null"):
        owner_name = "Raja Nayak"
    else:
        owner_name = clean_owner

    raw_pref = (metadata.get("preferredLanguage") or metadata.get("language") or DEFAULT_LANGUAGE).strip().lower()
    preferred_language = "en" if raw_pref in ("en", "english", "en-in") else "hi"
    lead_id = metadata.get("leadId")
    direction = metadata.get("direction", "outbound")
    raw_loc = (metadata.get("propertyLocation") or metadata.get("address") or metadata.get("location") or "").strip()
    if not raw_loc or raw_loc in ("Delhi, 110011, burari, sant nagar", "None", "null"):
        property_location = "DLF Phase 5, Sector 54, Gurgaon"
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

    llm_extra = {}
    if OPENROUTER_PROVIDER_ORDER:
        # Pin fast providers (stable) but still allow OpenRouter to fall back if they are down.
        llm_extra["extra_body"] = {"provider": {"order": OPENROUTER_PROVIDER_ORDER, "allow_fallbacks": True}}
    elif OPENROUTER_PROVIDER_SORT:
        llm_extra["extra_body"] = {"provider": {"sort": OPENROUTER_PROVIDER_SORT}}
    logger.info(
        f"⚙️ Latency config: FAST_TOOL_REPLY={FAST_TOOL_REPLY} VAD_MIN_SILENCE={VAD_MIN_SILENCE} "
        f"provider={llm_extra.get('extra_body')} endpoint=({ENDPOINT_MIN_DELAY},{ENDPOINT_MAX_DELAY}) "
        f"preemptive={PREEMPTIVE_GENERATION}"
    )

    llm = openai.LLM(
        model=LLM_MODEL,
        base_url="https://openrouter.ai/api/v1",
        api_key=OPENROUTER_API_KEY,
        temperature=0.05,       # Very low: scripted intake agent must not hallucinate or improvise
        parallel_tool_calls=False,
        max_completion_tokens=LLM_MAX_TOKENS,  # was 120: truncated multi-field tool calls -> dead air
        **llm_extra,
    )

    # Initial TTS uses default Hindi + English (Hinglish/Hindi) voice: priya (bulbul:v3)
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
        # Switch language code:
        #   English        → en-IN (Priya / Simran female English voice)
        #   Hindi/Hinglish → hi-IN (Priya / Simran female Hindi/Hinglish voice)
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
            state.add_transcript("customer", clean)
            try:
                conv_logger.log_customer(clean)
            except Exception:
                pass

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

    # ── Per-turn latency breakdown ─────────────────────────────────────────────
    # EOU  = user stopped speaking -> turn accepted (VAD silence + endpointing)
    # LLM  = time-to-first-token (a tool turn shows 2 LLM lines unless FAST_REPLY skipped the 2nd)
    # TTS  = time-to-first-audio-byte
    # TURN ≈ EOU + sum(LLM ttft) + TTS ttfb  (excludes tool run time and network playout)
    if LATENCY_LOG:
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
                    logger.info(f"⏱ EOU delay={(_lat['eou'] or 0):.2f}s")
                elif kind == "LLMMetrics":
                    ttft = getattr(m, "ttft", None)
                    if ttft is not None and ttft >= 0:
                        _lat["llm"].append(ttft)
                        logger.info(f"⏱ LLM call #{len(_lat['llm'])} ttft={ttft:.2f}s step={state.step.value}")
                elif kind == "TTSMetrics":
                    ttfb = getattr(m, "ttfb", None)
                    if ttfb is None or ttfb < 0:
                        return
                    if _lat["eou"] is not None and not _lat["tts_done"]:
                        _lat["tts_done"] = True
                        total = (_lat["eou"] or 0) + sum(_lat["llm"]) + ttfb
                        logger.info(
                            f"⏱ TTS ttfb={ttfb:.2f}s | 🔔 TURN ≈ {total:.2f}s "
                            f"(eou {(_lat['eou'] or 0):.2f} + llm {sum(_lat['llm']):.2f} "
                            f"[{len(_lat['llm'])} call(s)] + tts {ttfb:.2f})"
                        )
                    else:
                        logger.info(f"⏱ TTS ttfb={ttfb:.2f}s (scripted line)")
            except Exception as e:
                logger.debug(f"metrics log error: {e}")

    _room_deleted = False
    _shutdown_in_progress = False

    async def _end_room():
        nonlocal _room_deleted
        if _room_deleted:
            return
        _room_deleted = True
        try:
            await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
            logger.info(f"Room {ctx.room.name} deleted: call terminated cleanly.")
        except Exception as e:
            if "not_found" in str(e).lower() or "404" in str(e):
                logger.debug(f"Room {ctx.room.name} was already deleted.")
            else:
                logger.warning(f"delete_room failed: {e}")

    async def _save_and_shutdown():
        nonlocal _shutdown_in_progress
        if _shutdown_in_progress:
            return
        _shutdown_in_progress = True
        try:
            print_console_summary(state)
        except Exception as e:
            logger.debug(f"Error printing console summary: {e}")
        if recorder:
            try:
                rec_url = await recorder.stop()
                if rec_url:
                    setattr(state, "recording_url", rec_url)
            except Exception as e:
                logger.warning(f"Error stopping audio recorder: {e}")
        if not state.outcome_posted and state.call_id:
            await asyncio.to_thread(post_re_outcome_sync, state)
            state.outcome_posted = True
        try:
            conv_logger.finalize(state)
        except Exception as e:
            logger.warning(f"Error finalizing conversation log: {e}")
        try:
            await session.aclose()
        except Exception:
            pass
        await _end_room()
        ctx.shutdown(reason="session closed")

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
            clean_text = raw_text.strip()
            romanized_text = romanize_hindi(clean_text)
            state.callee_connected = True
            state.last_activity_time = time.time()
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
                clean_user_text = content_str.strip()
                romanized_text = romanize_hindi(clean_user_text)
                state.callee_connected = True
                state.last_activity_time = time.time()
                log_dialogue("customer", romanized_text)

            elif role == "assistant" and content_str:
                # Clean any leaked function-call syntax like close_call{}
                clean_agent_text = re.sub(r'\b[a-zA-Z_][a-zA-Z0-9_]*\s*\{[^}]*\}', '', content_str).strip()
                if clean_agent_text:
                    log_dialogue("assistant", clean_agent_text)

                if state.step == RealEstateStep.CLOSING or "close_call" in content_str:
                    logger.info("Closing message spoken; initiating delayed hangup...")
                    asyncio.create_task(tools_instance._delayed_hangup())

    @session.on("close")
    def on_session_close(ev):
        if state.hangup_started:
            return
        state.hangup_started = True
        logger.info("Session closed.")
        has_customer_speech = any(t.get("role") == "customer" for t in state.transcript)
        elapsed = time.time() - state.start_time
        if not has_customer_speech and not state.callee_connected and elapsed < 8.0:
            state.final_disposition = "Not Connected (No Answer)"
            state.agent_summary = "Call disconnected before customer spoke"
        else:
            state.callee_connected = True
            if state.final_disposition in ("Abruptly Disconnected Call", "Not Connected (No Answer)"):
                if state.is_interested:
                    state.final_disposition = "Interested (Disconnected)"
                elif state.project_or_society or state.category:
                    state.final_disposition = "Partial Details Captured (Disconnected)"
                else:
                    state.final_disposition = "Abruptly Disconnected Call"
        asyncio.create_task(_save_and_shutdown())

    @ctx.room.on("participant_disconnected")
    def on_participant_disconnected(participant):
        if state.hangup_started:
            return
        state.hangup_started = True
        part_ident = getattr(participant, "identity", "unknown")
        logger.info(f"Participant disconnected / hung up: {part_ident}")
        has_customer_speech = any(t.get("role") == "customer" for t in state.transcript)
        elapsed = time.time() - state.start_time
        if not has_customer_speech and not state.callee_connected and elapsed < 8.0:
            state.final_disposition = "Not Connected (No Answer)"
            state.agent_summary = "Call disconnected before customer spoke"
        else:
            state.callee_connected = True
            if state.final_disposition in ("Abruptly Disconnected Call", "Not Connected (No Answer)"):
                if state.is_interested:
                    state.final_disposition = "Interested (Disconnected)"
                elif state.project_or_society or state.category:
                    state.final_disposition = "Partial Details Captured (Disconnected)"
                else:
                    state.final_disposition = "Abruptly Disconnected Call"
        asyncio.create_task(_save_and_shutdown())

    ctx.add_shutdown_callback(_save_and_shutdown)

    # 1. For inbound calls, wait for remote participant; for outbound calls, start session immediately
    if direction == "inbound":
        try:
            if not ctx.room.remote_participants:
                await asyncio.wait_for(ctx.wait_for_participant(), timeout=15.0)
                logger.info("Remote participant joined room.")
        except Exception as e:
            logger.warning(f"Wait for participant completed or timed out: {e}")

    # 2. Start session on the room immediately so audio pipeline & STT/VAD are active
    await session.start(room=ctx.room, agent=agent)
    logger.info("Real Estate agent session started in room.")
    if recorder:
        await recorder.start(ctx.room)

    # Warm provider connections while the greeting is generated/played, so the first real
    # customer turn doesn't pay cold-connection cost.
    for _name, _comp in (("tts", tts), ("llm", llm)):
        _fn = getattr(_comp, "prewarm", None)
        if callable(_fn):
            try:
                _fn()
                logger.info(f"🔥 {_name} prewarm requested")
            except Exception as e:
                logger.debug(f"{_name} prewarm failed: {e}")
    state.start_time = time.time()

    # Mark call as answered in backend immediately so sweeper never sweeps it to NO_ANSWER
    def _notify_answered():
        if state.call_id:
            try:
                requests.post(
                    f"{BACKEND_URL}/internal/real-estate/calls/{state.call_id}/answered",
                    headers={"X-Internal-Secret": INTERNAL_SECRET},
                    timeout=3.0,
                )
                logger.info(f"Marked call {state.call_id} as answered in backend")
            except Exception as ex:
                logger.debug(f"Failed to notify answered: {ex}")
    asyncio.create_task(asyncio.to_thread(_notify_answered))

    # 3. Queue opening greeting
    loc = state.initial_property_location
    name_call = _owner_call_name(state)
    salutation_en = f"Hello {name_call} Sir" if name_call != "Sir" else "Hello Sir"
    salutation_hi = f"Hello {name_call} ji" if name_call != "Sir" else "Hello Sir"

    if loc:
        greeting = (
            f"{salutation_en}, I’m Priya, calling from My Estate Finder. Sir, regarding your property at {loc}, are you considering selling or renting it out?"
            if state.reply_lang == "en"
            else f"{salutation_hi}, main Priya bol rahi hoon My Estate Finder se. Sir, {loc} par jo aapki property hai, kya aap use sell ya rent karne ka soch rahe hain?"
        )
    else:
        greeting = (
            "Hello, I’m Priya, calling from My Estate Finder. Sir, we help property owners to sell or rent their properties. Are you also considering selling or renting a property of yours?"
            if state.reply_lang == "en"
            else "Hello, main Priya bol rahi hoon My Estate Finder se. Sir, hum property owners ko unki property sell ya rent karne mein help karte hain. Kya aap bhi apni koi property sell ya rent karne ka soch rahe hain?"
        )

    state.last_activity_time = time.time()
    opening_speech = session.say(greeting, allow_interruptions=False)
    log_dialogue("assistant", greeting)

    # 4. Silence Watchdog loop (Friendly reprompts if caller is silent)
    async def silence_watchdog():
        consecutive_silence = 0
        while not state.hangup_started:
            await asyncio.sleep(2.0)
            if state.hangup_started:
                break
            idle = time.time() - state.last_activity_time
            if idle > 18.0:
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
                    await _save_and_shutdown()
                    break
            elif idle < 3.0:
                consecutive_silence = 0

    asyncio.create_task(silence_watchdog())

    # 5. Natural Conversation Lifecycle Watchdog
    # The call is NOT cut by arbitrary short timers. It stays alive until the conversation completes naturally.
    # An emergency safety backstop of 15 minutes (900s) prevents orphan sessions if the phone stays off-hook.
    async def call_duration_watchdog():
        max_safety_seconds = float(os.getenv("CALL_MAX_DURATION_SECONDS", "900"))  # 15 minutes safety ceiling
        while not state.hangup_started:
            await asyncio.sleep(5.0)
            if state.hangup_started:
                break
            elapsed = time.time() - state.start_time
            if elapsed >= max_safety_seconds and state.step != RealEstateStep.CLOSING:
                logger.info(f"⏳ Call reached maximum emergency safety ceiling ({int(elapsed)}s). Wrapping up cleanly.")
                state.step = RealEstateStep.CLOSING
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
                await _save_and_shutdown()
                break

    asyncio.create_task(call_duration_watchdog())

    try:
        await asyncio.wait_for(opening_speech.wait_for_playout(), timeout=8.0)
    except Exception as e:
        logger.warning(f"Initial greeting playout completed or timed out: {e}")
    state.last_activity_time = time.time()
    