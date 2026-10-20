import json
import time
import asyncio
from livekit import agents
from livekit.agents import AgentSession, Agent, AgentServer
from livekit.plugins import sarvam, groq, silero

from src.config import (
    logger,
    AGENT_NAME,
    LLM_MODEL,
    SARVAM_API_KEY,
    GROQ_API_KEY,
)
from src.state import Step, ConversationState
from src.prompts import get_step_instructions
from src.tools import AgentTools
from src.utils import silence_watchdog, clean_hangup
from src.tools.api import post_outcome_to_backend

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
    attempt_number = int(metadata.get("attemptNumber", 1))

    # 2. Initialize Conversation State with Airtel Campaign lead info
    state = ConversationState(
        call_id=call_id,
        customer_name=customer_name,
        phone=phone,
        address=address,
        language=language,
        account_no=account_no,
        subs_del_no=subs_del_no,
        service_end_date=service_end_date,
        attempt_number=attempt_number,
    )

    # 3. Initialize Agent Tools for all 17 Airtel campaign scenarios
    tools_instance = AgentTools(state)
    tools = [
        tools_instance.confirm_identity,
        tools_instance.set_pickup,
        tools_instance.record_willing_no_date,
        tools_instance.set_pickup_date,
        tools_instance.confirm_address,
        tools_instance.record_refusal,
        tools_instance.record_device_issue,
        tools_instance.record_recharge,
        tools_instance.record_already_returned,
        tools_instance.record_shifted,
        tools_instance.record_language_barrier,
        tools_instance.record_do_not_call,
        tools_instance.escalate_to_121,
        tools_instance.record_temporarily_unavailable,
        tools_instance.record_still_using_device,
    ]

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

    llm = groq.LLM(
        model=LLM_MODEL,
        api_key=GROQ_API_KEY,
        temperature=0.2,
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
    )

    # Timing metrics and silence watchdog tracking
    timing_tracker = {
        "stt_final": 0.0,
        "last_activity_time": time.time(),
        "is_agent_speaking": False,
    }

    # Transcripts & Metrics Hooks
    @session.on("user_input_transcribed")
    def on_user_transcribed(ev):
        timing_tracker["last_activity_time"] = time.time()
        if ev.is_final and ev.text.strip():
            timing_tracker["stt_final"] = time.time()
            logger.info(f"🗣️ [Customer]: \"{ev.text}\"")
            state.add_transcript("customer", ev.text)
            state.silence_count = 0

    @session.on("conversation_item_added")
    def on_conversation_item(ev):
        item = getattr(ev, "item", None)
        if item:
            role = getattr(item, "role", "unknown")
            content = getattr(item, "content", "")
            if role == "assistant" and content.strip():
                timing_tracker["last_activity_time"] = time.time()
                stt_time = timing_tracker.get("stt_final", 0)
                if stt_time > 0:
                    latency_ms = (time.time() - stt_time) * 1000
                    state.add_latency(latency_ms)
                    latency_str = f"({latency_ms:.0f} ms)"
                else:
                    latency_str = ""

                logger.info(f"🤖 [Agent]: \"{content}\" {latency_str}")
                state.add_transcript("assistant", content)

                # Check if conversation reached a terminal state
                if state.is_terminal() and not state.is_completed:
                    state.is_completed = True
                    logger.info(
                        f"Conversation reached terminal state ({state.step.value}, "
                        f"disposition={state.final_disposition}). Preparing clean disconnect..."
                    )
                    asyncio.create_task(clean_hangup(ctx, session, state))

    # Room disconnect handler: ensure outcome is recorded even on abrupt customer drop
    @ctx.room.on("disconnected")
    def on_room_disconnected():
        if not state.is_completed:
            state.is_completed = True
            if not state.is_terminal():
                state.final_disposition = "DISCONNECTED"
                state.customer_note = "Call abruptly dropped / hung up mid-conversation"
            logger.info(f"Room disconnected abruptly. Saving {state.final_disposition} for retry queue.")
            post_outcome_to_backend(state)

    # 5. Build dynamic instructions and start agent
    instructions = get_step_instructions(state)
    agent = Agent(instructions=instructions, tools=tools)

    await session.start(room=ctx.room, agent=agent)
    logger.info("Agent session active in room.")

    # 6. Opening Line: Greeting + Priya persona speaking on behalf of Airtel (Build Brief Section 2)
    opening_line = (
        f"नमस्ते, मैं प्रिया बोल रही हूँ, एयरटेल की तरफ से। क्या मैं {customer_name} जी से बात कर रही हूँ?"
    )

    logger.info(f"Speaking opening line: {opening_line}")
    state.add_transcript("assistant", opening_line)
    await session.say(opening_line, allow_interruptions=True)
    timing_tracker["last_activity_time"] = time.time()

    # 7. Start 5-second silence watchdog task
    asyncio.create_task(silence_watchdog(ctx, session, state, timing_tracker))
