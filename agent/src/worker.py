import json
import time
import asyncio
from livekit import agents
from livekit.agents import AgentSession, Agent, AgentServer
from livekit.plugins import sarvam, silero, openai
try:
    import numpy.fft  # Preload to prevent event loop blocking during audio STFT
except ImportError:
    pass

from src.config import (
    logger,
    AGENT_NAME,
    LLM_MODEL,
    SARVAM_API_KEY,
    OPENROUTER_API_KEY,
)
from src.state import Step, ConversationState
from src.agent import AirtelAgent
from src.tools import AgentTools
from src.utils import silence_watchdog, clean_hangup
from src.tools.api import post_outcome_to_backend, register_inbound_call_to_backend

server = AgentServer()

@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: agents.JobContext):
    logger.info(f"Connecting to room: {ctx.room.name} (Job ID: {ctx.job.id})")
    await ctx.connect()

    # 1. Parse job metadata provided during dispatch
    metadata = {}
    if ctx.job.metadata:
        try:
            metadata = json.loads(ctx.job.metadata)
            logger.info(f"Loaded job metadata: {metadata}")
        except Exception as e:
            logger.warning(f"Could not parse job metadata: {e}")

    call_id = metadata.get("callId", "")
    customer_name = metadata.get("customerName", "Customer")
    address = metadata.get("address", "Flat 402, Sunshine Heights, Koramangala 4th Block, Bengaluru")
    phone = metadata.get("phone", "")
    language = metadata.get("preferredLanguage", "hi")
    account_no = metadata.get("accountNo", "")
    subs_del_no = metadata.get("subsDelNo", "")
    service_end_date = metadata.get("serviceEndDate", "")
    r_date = metadata.get("rDate") or metadata.get("r_date", "")
    attempt_number = int(metadata.get("attemptNumber", 1))

    # Detect inbound call direction (from metadata or room prefix)
    direction = metadata.get("direction", "outbound")
    if ctx.room.name.startswith("inbound-") or not call_id:
        direction = "inbound"

    if direction == "inbound":
        logger.info(f"Detected INBOUND call in room {ctx.room.name}. Registering session...")
        # Wait for the real SIP caller: the dispatch rule fires on join, but remote_participants can
        # still be empty at this instant. Inbound SIP identities look like "sip_<number>" (NOT "phone-").
        sip_participant = None
        try:
            sip_participant = await asyncio.wait_for(ctx.wait_for_participant(), timeout=15.0)
        except Exception as e:
            logger.warning(f"No SIP participant found within 15s: {e}")

        incoming_phone = phone
        sip_call_id = ""
        if sip_participant is not None:
            attrs = getattr(sip_participant, "attributes", None) or {}
            ident = (sip_participant.identity or "")
            for prefix in ("phone-", "sip_", "sip:"):
                if ident.startswith(prefix):
                    ident = ident[len(prefix):]
                    break
            incoming_phone = attrs.get("sip.phoneNumber") or ident or phone
            sip_call_id = attrs.get("sip.callID", "") or ""
        logger.info(f"Inbound caller number: {incoming_phone or 'withheld/unknown'}")

        # requests is blocking -> run in a thread so live audio is never frozen
        inbound_data = await asyncio.to_thread(
            register_inbound_call_to_backend, ctx.room.name, incoming_phone, sip_call_id
        )
        if inbound_data:
            call_info = inbound_data.get("call") or {}
            cust_info = inbound_data.get("customer") or {}
            call_id = call_info.get("id", call_id)
            phone = incoming_phone
            if cust_info:
                customer_name = cust_info.get("name") or customer_name
                phone = cust_info.get("phone") or incoming_phone
                db_address = cust_info.get("address") or ""
                if db_address and db_address != "Pending address verification":
                    address = db_address
                account_no = cust_info.get("account_no") or account_no
                subs_del_no = cust_info.get("subs_del_no") or subs_del_no
                service_end_date = str(cust_info.get("service_end_date") or "")
                r_date = str(cust_info.get("r_date") or "")
        else:
            logger.error("Inbound call could NOT be registered with backend; outcome will not be saved.")

    # 2. Initialize Conversation State with lead info & call direction
    state = ConversationState(
        call_id=call_id,
        customer_name=customer_name,
        phone=phone,
        address=address,
        language=language,
        account_no=account_no,
        subs_del_no=subs_del_no,
        service_end_date=service_end_date,
        r_date=r_date,
        attempt_number=attempt_number,
        direction=direction,
    )

    # Timing metrics and silence watchdog tracking
    timing_tracker = {
        "stt_final": 0.0,
        "last_activity_time": time.time(),
        "is_agent_speaking": False,
        "provider_filler_pending": False,  # True while waiting to inject "One moment please"
        "provider_filler_task": None,      # Asyncio task for the filler timeout
    }

    # 3. Agent and Tools Setup
    tools_instance = AgentTools(state, timing_tracker)
    agent = AirtelAgent(state, tools_instance)
    tools_instance.agent = agent

    # 4. Speech and Audio Pipeline Setup
    stt = sarvam.STT(
        language="hi-IN",
        model="saaras:v4",
        api_key=SARVAM_API_KEY,
    )

    vad = silero.VAD.load(
        sample_rate=16000,
        min_speech_duration=0.05,
        min_silence_duration=0.45,
        activation_threshold=0.45,
    )

    # LLM — OpenRouter
    llm = openai.LLM(
        model=LLM_MODEL,
        base_url="https://openrouter.ai/api/v1",
        api_key=OPENROUTER_API_KEY,
        temperature=0.15,
        parallel_tool_calls=False,
        max_completion_tokens=150,
    )

    tts = sarvam.TTS(
        target_language_code="hi-IN",
        model="bulbul:v3",
        speaker="priya",
        api_key=SARVAM_API_KEY,
    )

    session = AgentSession(
        stt=stt,
        vad=vad,
        llm=llm,
        tts=tts,
        allow_interruptions=True,
        max_tool_steps=1,
    )

    watchdog_task = None

    # Transcripts & Metrics Hooks
    @session.on("user_input_transcribed")
    def on_user_transcribed(ev):
        timing_tracker["last_activity_time"] = time.time()
        # In livekit-agents 1.8+, the transcript is in 'transcript', with fallback to 'text'
        raw_text = getattr(ev, "transcript", None) or getattr(ev, "text", "")
        is_final = getattr(ev, "is_final", True)
        confidence = getattr(ev, "confidence", 1.0) or 1.0

        if is_final:
            # STT failure: empty text or very low confidence (< 0.3) — per spec, ask to repeat up to 2x
            if not raw_text or not raw_text.strip() or confidence < 0.3:
                state.stt_retry_count += 1
                logger.warning(f"⚠️ STT failure (attempt {state.stt_retry_count}/2): empty or low-confidence transcript")
                if state.stt_retry_count <= 2:
                    asyncio.create_task(
                        session.say("माफ़ कीजिए, मैं समझ नहीं पाई। क्या आप दोबारा बोल सकते हैं?", allow_interruptions=True)
                    )
                else:
                    # After 2 retries, apologise and route to 121 per spec
                    state.is_completed = True
                    state.final_disposition = "FAILED"
                    state.customer_note = "STT failed after 2 retries. Routed to Airtel 121."
                    state.transition_to(Step.TERMINATED)
                    logger.error("❌ STT failed after 2 retries. Closing call, routing to 121.")

                    async def _stt_giveup():
                        try:
                            await session.say(
                                "माफ़ कीजिए, आपकी आवाज़ साफ़ नहीं आ रही है। कृपया एयरटेल 121 पर संपर्क करें। धन्यवाद।",
                                allow_interruptions=False,
                            )
                        except Exception:
                            pass
                        await clean_hangup(ctx, session, state)

                    asyncio.create_task(_stt_giveup())
                return

            clean_text = raw_text.strip()
            timing_tracker["stt_final"] = time.time()
            state.stt_retry_count = 0  # Reset on successful transcription
            logger.info(f"🗣️ [Customer]: \"{clean_text}\"")
            state.add_transcript("customer", clean_text)
            state.silence_count = 0

            # Provider timeout: start a 3-second filler timer (spec: LLM/TTS/STT > ~3s → "One moment please")
            if not timing_tracker["provider_filler_pending"] and not state.is_completed:
                timing_tracker["provider_filler_pending"] = True
                timing_tracker["_provider_filler_retry"] = timing_tracker.get("_provider_filler_retry", 0)

                async def _provider_timeout_filler():
                    while timing_tracker.get("provider_filler_pending") and not state.is_completed:
                        await asyncio.sleep(3.2)
                        if not timing_tracker.get("provider_filler_pending") or state.is_completed:
                            return
                        agent_st = getattr(session, "agent_state", "idle")
                        if agent_st in ("speaking", "thinking") or state.is_terminal():
                            timing_tracker["provider_filler_pending"] = False
                            return

                        retry = timing_tracker.get("_provider_filler_retry", 0) + 1
                        timing_tracker["_provider_filler_retry"] = retry
                        if retry == 1:
                            filler = "एक पल रुकिए।"
                            logger.warning("⚠️ Provider timeout >3s. Playing 'One moment please' filler.")
                            timing_tracker["last_activity_time"] = time.time()
                            try:
                                await session.say(filler, allow_interruptions=False)
                                timing_tracker["last_activity_time"] = time.time()
                            except Exception:
                                pass
                        else:
                            # Second timeout → apologise and route to 121 per spec
                            logger.error("❌ Provider timeout after filler retry. Routing to 121.")
                            state.is_completed = True
                            state.final_disposition = "FAILED"
                            state.customer_note = "Provider (LLM/TTS/STT) timed out twice. Routed to Airtel 121."
                            state.transition_to(Step.TERMINATED)
                            try:
                                await session.say(
                                    "माफ़ करें, तकनीकी समस्या आ गई है। कृपया एयरटेल 121 पर संपर्क करें। धन्यवाद।",
                                    allow_interruptions=False
                                )
                            except Exception:
                                pass
                            await clean_hangup(ctx, session, state)
                            break

                filler_task = asyncio.create_task(_provider_timeout_filler())
                timing_tracker["provider_filler_task"] = filler_task

    def is_raw_tool_json(text: str) -> bool:
        s = text.strip()
        if s.startswith("{") and any(k in s for k in ['"name"', '"function"', '"parameters"', '"arguments"', "'tool_name'"]):
            return True
        if s.startswith(('{"name":', '{"function":', '{"parameters":', "{'name':", "{'tool_name'")):
            return True
        return False

    # Real response latency = customer's final transcript -> agent starts SPEAKING
    # (conversation_item_added fires only after playout ends, so it includes the whole sentence)
    @session.on("agent_state_changed")
    def on_agent_state_changed(ev):
        if getattr(ev, "new_state", None) == "speaking":
            stt_time = timing_tracker.get("stt_final", 0)
            if stt_time > 0:
                latency_ms = (time.time() - stt_time) * 1000
                state.add_latency(latency_ms)
                timing_tracker["stt_final"] = 0.0
                logger.info(f"⏱️ Response latency: {latency_ms:.0f} ms")

    @session.on("conversation_item_added")
    def on_conversation_item(ev):
        item = getattr(ev, "item", None)
        if item:
            role = getattr(item, "role", "unknown")
            raw_content = getattr(item, "content", "")

            # Extract clean dialogue text (content can be str, list[str], or list[dict/chunk])
            content_str = ""
            if isinstance(raw_content, list):
                text_parts = []
                for part in raw_content:
                    if isinstance(part, str):
                        part_s = part.strip()
                        if not is_raw_tool_json(part_s):
                            text_parts.append(part_s)
                    elif isinstance(part, dict):
                        if "text" in part and isinstance(part["text"], str) and not is_raw_tool_json(part["text"]):
                            text_parts.append(part["text"].strip())
                    elif hasattr(part, "text") and isinstance(part.text, str) and not is_raw_tool_json(part.text):
                        text_parts.append(part.text.strip())
                content_str = " ".join([p for p in text_parts if p]).strip()
            elif isinstance(raw_content, str):
                part_s = raw_content.strip()
                if not is_raw_tool_json(part_s):
                    content_str = part_s
            elif raw_content:
                part_s = str(raw_content).strip()
                if not is_raw_tool_json(part_s):
                    content_str = part_s

            if role == "assistant":
                # Cancel provider filler as soon as assistant begins or adds an item
                timing_tracker["provider_filler_pending"] = False
                task = timing_tracker.get("provider_filler_task")
                if task and not task.done():
                    task.cancel()

                if content_str and not is_raw_tool_json(content_str):
                    timing_tracker["last_activity_time"] = time.time()
                    logger.info(f"🤖 [Agent]: \"{content_str}\"")
                    state.add_transcript("assistant", content_str)

                # Check if conversation reached a terminal state
                if state.is_terminal() and not state.is_completed:
                    state.is_completed = True
                    if watchdog_task and not watchdog_task.done():
                        watchdog_task.cancel()
                    logger.info(
                        f"Conversation reached terminal state ({state.step.value}, "
                        f"disposition={state.final_disposition}). Preparing clean disconnect..."
                    )
                    asyncio.create_task(clean_hangup(ctx, session, state))

    # Room disconnect handler: ensure outcome is recorded even on abrupt customer drop
    @ctx.room.on("disconnected")
    def on_room_disconnected():
        if watchdog_task and not watchdog_task.done():
            watchdog_task.cancel()
        if not state.is_completed:
            state.is_completed = True
            if not state.is_terminal():
                state.final_disposition = "DISCONNECTED"
                state.customer_note = "Call abruptly dropped / hung up mid-conversation"
            logger.info(f"Room disconnected abruptly. Saving {state.final_disposition} for retry queue.")
            # The blocking HTTP save happens in the shutdown callback below (thread, awaited by the job
            # runner) instead of blocking the event loop inside this sync handler.

    async def _final_save():
        """Runs on job shutdown: guarantees the outcome reaches the backend exactly when still missing."""
        if state.call_id and not state.outcome_posted:
            try:
                state.outcome_posted = bool(await asyncio.to_thread(post_outcome_to_backend, state))
            except Exception as e:
                logger.error(f"Final outcome save failed: {e}")

    ctx.add_shutdown_callback(_final_save)

    # 5. Start agent session
    await session.start(room=ctx.room, agent=agent)
    logger.info("Agent session active in room.")

    # 6. Opening Line: Greeting + Priya persona speaking on behalf of Airtel
    if direction == "inbound":
        name_lower = (customer_name or "").lower().strip()
        is_generic = not name_lower or any(t in name_lower for t in ["customer", "subscriber", "inbound", "caller"])
        if not is_generic:
            opening_line = (
                f"नमस्ते {customer_name} जी, एयरटेल में आपका स्वागत है। मैं प्रिया बोल रही हूँ। क्या आपने अपने वाई-फाई राउटर पिकअप या अकाउंट के संबंध में कॉल किया है?"
            )
        else:
            opening_line = (
                "नमस्ते, एयरटेल में आपका स्वागत है। मैं प्रिया बोल रही हूँ। मैं आपकी क्या मदद कर सकती हूँ?"
            )
    else:
        _n = (customer_name or "").lower().strip()
        if not _n or any(t in _n for t in ["customer", "subscriber", "user", "airtel", "client"]):
            who = "एयरटेल वाई-फाई कनेक्शन के रजिस्टर्ड ग्राहक"
        else:
            who = f"{customer_name} जी"
        opening_line = (
            f"नमस्ते, मैं प्रिया बोल रही हूँ, एयरटेल की तरफ से। क्या मैं {who} से बात कर रही हूँ?"
        )

    logger.info(f"Speaking opening line ({direction}): {opening_line}")
    state.add_transcript("assistant", opening_line)
    await session.say(opening_line, allow_interruptions=True)
    timing_tracker["last_activity_time"] = time.time()

    # 7. Start 5-second silence watchdog task
    watchdog_task = asyncio.create_task(silence_watchdog(ctx, session, state, timing_tracker))
    