import re
import json
import time
import asyncio
import requests
from typing import Optional
from livekit import agents, api
from livekit.agents import AgentSession, AgentServer, TurnHandlingOptions
from livekit.plugins import sarvam, silero, openai

from .config import (
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
    TTS_SPEAKER,
    TTS_PACE,
    TTS_TEMPERATURE,
    TTS_PITCH,
    TTS_LOUDNESS,
    BACKEND_URL,
    INTERNAL_SECRET,
)
from .state import RealEstateState, RealEstateStep
from .agent import RealEstateAgent
from .tools import RealEstateTools

server = AgentServer()


def _load_vad():
    return silero.VAD.load(
        sample_rate=16000,
        min_speech_duration=0.05,
        min_silence_duration=0.45,
        activation_threshold=0.45,
    )


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
    payload = {
        "lead_id": state.lead_id,
        "final_disposition": state.final_disposition,
        "is_interested": state.is_interested,
        "owner_name_confirmed": state.owner_name_confirmed or state.owner_name,
        "category": state.category,
        "intent": state.intent,
        "project_or_society": state.project_or_society,
        "sector_or_location": state.sector_or_location,
        "unit_number": state.unit_number,
        "floor_number": state.floor_number,
        "bhk_config": state.bhk_config,
        "commercial_type": state.commercial_type,
        "approx_area_sqft": state.approx_area_sqft,
        "furnishing_status": state.furnishing_status,
        "expected_sale_price": state.expected_sale_price,
        "expected_monthly_rent": state.expected_monthly_rent,
        "is_currently_leased": state.is_currently_leased,
        "current_rent_received": state.current_rent_received,
        "immediate_occupancy": state.immediate_occupancy,
        "agent_summary": state.agent_summary,
        "transcript": state.transcript,
        "duration_seconds": int(time.time() - state.start_time) if state.callee_connected else 0,
        "median_latency_ms": int(sum(state.latency_samples) / len(state.latency_samples) * 1000) if state.latency_samples else None,
    }

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

    owner_name = metadata.get("customerName") or metadata.get("ownerName", "Property Owner")
    phone = metadata.get("phone", "")
    preferred_language = metadata.get("preferredLanguage", "en")
    lead_id = metadata.get("leadId")
    direction = metadata.get("direction", "outbound")

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
    if OPENROUTER_PROVIDER_SORT:
        llm_extra["extra_body"] = {"provider": {"sort": OPENROUTER_PROVIDER_SORT}}

    llm = openai.LLM(
        model=LLM_MODEL,
        base_url="https://openrouter.ai/api/v1",
        api_key=OPENROUTER_API_KEY,
        temperature=0.2,
        parallel_tool_calls=False,
        max_completion_tokens=150,
        **llm_extra,
    )

    tts = sarvam.TTS(
        target_language_code=TTS_LANGUAGE_EN if preferred_language == "en" else TTS_LANGUAGE_HI,
        model="bulbul:v3",
        speaker=TTS_SPEAKER,
        pace=TTS_PACE,
        temperature=TTS_TEMPERATURE,
        pitch=TTS_PITCH,
        loudness=TTS_LOUDNESS,
        enable_preprocessing=True,
        api_key=SARVAM_API_KEY,
    )

    def _set_tts_language(lang: str):
        code = TTS_LANGUAGE_EN if lang == "en" else TTS_LANGUAGE_HI
        try:
            tts.update_options(
                target_language_code=code,
                pace=TTS_PACE,
                temperature=TTS_TEMPERATURE,
            )
            logger.info(f"TTS language updated -> {code} (pace={TTS_PACE})")
        except Exception as e:
            logger.warning(f"TTS update failed: {e}")

    state = RealEstateState(
        call_id=call_id,
        lead_id=lead_id,
        owner_name=owner_name,
        phone=phone,
        preferred_language=preferred_language,
        direction=direction,
    )

    async def hangup_session():
        if not state.hangup_started:
            state.hangup_started = True
            await asyncio.to_thread(post_re_outcome_sync, state)
            state.outcome_posted = True
            try:
                await ctx.room.disconnect()
            except Exception:
                pass

    tools_instance = RealEstateTools(state, post_re_outcome_sync, None)
    agent = RealEstateAgent(state, tools_instance)
    tools_instance.agent = agent
    agent.on_language_change = _set_tts_language

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

    async def _end_room():
        try:
            await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
            logger.info(f"Room {ctx.room.name} deleted: call terminated cleanly.")
        except Exception as e:
            logger.warning(f"delete_room failed: {e}")

    async def _save_and_shutdown():
        if not state.outcome_posted and state.call_id:
            await asyncio.to_thread(post_re_outcome_sync, state)
            state.outcome_posted = True
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
            state.last_activity_time = time.time()
            logger.info(f"🗣️ [Customer]: \"{clean_text}\"")
            state.add_transcript("customer", clean_text)

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

            if role == "assistant" and content_str:
                # Clean any leaked function-call syntax like close_call{}
                clean_agent_text = re.sub(r'\b[a-zA-Z_][a-zA-Z0-9_]*\s*\{[^}]*\}', '', content_str).strip()
                if clean_agent_text and not (state.transcript and state.transcript[-1].get("text") == clean_agent_text):
                    logger.info(f"🤖 [Agent]: \"{clean_agent_text}\"")
                    state.add_transcript("assistant", clean_agent_text)

                if state.step == RealEstateStep.CLOSING or "close_call" in content_str:
                    logger.info("Closing message spoken; initiating delayed hangup...")
                    asyncio.create_task(tools_instance._delayed_hangup())

    @ctx.room.on("participant_disconnected")
    def on_participant_disconnected(participant):
        if state.hangup_started:
            return
        state.hangup_started = True
        logger.info("Participant disconnected / hung up.")
        if state.final_disposition == "Abruptly Disconnected Call":
            if state.is_interested:
                state.final_disposition = "Interested (Disconnected)"
            elif state.project_or_society or state.category:
                state.final_disposition = "Partial Details Captured (Disconnected)"
        asyncio.create_task(_save_and_shutdown())

    ctx.add_shutdown_callback(_save_and_shutdown)

    # 1. Wait for callee to answer the call
    logger.info("Waiting for callee to answer phone...")
    callee_connected = False
    start_wait = time.time()

    while time.time() - start_wait < 45.0:
        if state.hangup_started:
            return

        remotes = list(ctx.room.remote_participants.values())
        if remotes:
            p = remotes[0]
            call_status = p.attributes.get("sip.callStatus")
            # If web tester (no phone- prefix) or SIP call is active
            if not p.identity.startswith("phone-") or call_status == "active":
                logger.info(f"🎉 Callee answered! (Identity: {p.identity}, Status: {call_status}). Starting dialogue.")
                callee_connected = True
                state.callee_connected = True
                state.start_time = time.time()
                break
            elif call_status in ("failed", "busy", "rejected", "hangup"):
                logger.warning(f"Call ended before pickup: {call_status}")
                if not state.is_interested:
                    state.final_disposition = "Not Connected (No Answer)"
                    state.agent_summary = f"Call disconnected by carrier (status: {call_status})"
                await _save_and_shutdown()
                return

        await asyncio.sleep(0.5)

    if not callee_connected:
        logger.warning("Call ringing timed out after 45s without answer.")
        if not state.is_interested:
            state.final_disposition = "Not Connected (No Answer)"
            state.agent_summary = "Call timed out before callee answered"
        await _save_and_shutdown()
        return

    # 2. Start session on the room
    await session.start(room=ctx.room, agent=agent)
    logger.info("Real Estate agent session started in room.")

    # 3. Queue opening greeting
    greeting = (
        "Hello, I’m Sagar, calling from My Estate Finder. Sir, we help property owners to sell or rent their properties. Are you also considering selling or renting a property of yours?"
        if state.reply_lang == "en"
        else "Hello, main Sagar bol raha hoon My Estate Finder se. Sir, hum property owners ko unki property sell ya rent karne mein help karte hain. Kya aap bhi apni koi property sell ya rent karne ka soch rahe hain?"
    )

    state.last_activity_time = time.time()
    opening_speech = session.say(greeting, allow_interruptions=False)
    state.add_transcript("assistant", greeting)

    # 4. Silence Watchdog loop
    async def silence_watchdog():
        consecutive_silence = 0
        while not state.hangup_started:
            await asyncio.sleep(2.0)
            if state.hangup_started:
                break
            idle = time.time() - state.last_activity_time
            if idle > 12.0:
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
                        await asyncio.wait_for(speech.wait_for_playout(), timeout=6.0)
                    except Exception:
                        pass
                    if not state.is_interested:
                        state.final_disposition = "Not Connected (No Answer)"
                    await _save_and_shutdown()
                    break
            elif idle < 3.0:
                consecutive_silence = 0

    asyncio.create_task(silence_watchdog())

    # 5. Call Duration Cap Watchdog (Cap at ~3 minutes = 180s)
    async def call_duration_watchdog():
        while not state.hangup_started:
            await asyncio.sleep(2.0)
            if state.hangup_started:
                break
            elapsed = time.time() - state.start_time
            # At 165s (~2m45s), initiate graceful wrap-up to conclude within 3 minutes
            if elapsed >= 165.0 and state.step != RealEstateStep.CLOSING:
                logger.info(f"⏳ Call reached {int(elapsed)}s (3-minute cap). Gracefully wrapping up with advisor callback...")
                state.step = RealEstateStep.CLOSING
                disp_lower = state.final_disposition.lower()
                if not ("qualified" in disp_lower or "dnc" in disp_lower or "whatsapp" in disp_lower):
                    state.final_disposition = "Advisor Callback Booked (3-Min Cap)"
                    if not state.agent_summary:
                        state.agent_summary = "Call capped at 3 minutes; advisor follow-up scheduled"
                wrapup_line = (
                    "Thank you for your time! I’ve noted the essential details, and our senior property advisor will follow up with you to finalize everything. Have a great day!"
                    if state.reply_lang == "en"
                    else "Apna time dene ke liye thank you! Maine main details note kar li hain, aur hamare senior property advisor aapse baki details ke liye follow-up karenge. Have a great day!"
                )
                try:
                    speech = session.say(wrapup_line, allow_interruptions=False)
                    state.add_transcript("assistant", wrapup_line)
                    await asyncio.wait_for(speech.wait_for_playout(), timeout=6.5)
                except Exception as e:
                    logger.warning(f"Duration cap wrapup playout error: {e}")
                await _save_and_shutdown()
                break

    asyncio.create_task(call_duration_watchdog())

    try:
        await asyncio.wait_for(opening_speech.wait_for_playout(), timeout=8.0)
    except Exception as e:
        logger.warning(f"Initial greeting playout completed or timed out: {e}")
    state.last_activity_time = time.time()

