import time
import asyncio
import logging
from livekit import agents
from livekit.agents import AgentSession

from src.state import Step, ConversationState
from src.tools.api import post_outcome_to_backend

logger = logging.getLogger("agent-watchdog")

async def clean_hangup(ctx: agents.JobContext, session: AgentSession, state: ConversationState):
    """Waits for final audio delivery, ensures outcome is saved, then cleanly disconnects."""
    if not state.outcome:
        state.outcome = "no_response"
    
    # Save outcome and transcript to backend
    post_outcome_to_backend(state)

    # Give TTS audio 3.5 seconds to complete speech playout
    await asyncio.sleep(3.5)
    logger.info(f"Cleanly disconnecting room {ctx.room.name} (Final outcome: {state.outcome})...")
    try:
        await ctx.room.disconnect()
    except Exception as e:
        logger.error(f"Error disconnecting room: {e}")

async def silence_watchdog(
    ctx: agents.JobContext,
    session: AgentSession,
    state: ConversationState,
    timing_tracker: dict
):
    """
    Monitors customer silence. If silence exceeds 9 seconds:
    - 1st silence: Re-prompts once in Hindi.
    - 2nd silence: Apologizes, logs 'no_response', and disconnects cleanly.
    """
    SILENCE_THRESHOLD_SECONDS = 9.0

    while not state.is_completed and not state.is_terminal():
        await asyncio.sleep(1.0)
        now = time.time()
        elapsed = now - timing_tracker.get("last_activity_time", now)

        if elapsed >= SILENCE_THRESHOLD_SECONDS and not state.is_completed:
            if state.silence_count == 0:
                state.silence_count += 1
                timing_tracker["last_activity_time"] = time.time()

                if state.step == Step.IDENTITY:
                    reprompt = f"माफ़ कीजिए, क्या आप मुझे सुन पा रहे हैं? क्या मैं {state.customer_name} जी से बात कर रहा हूँ?"
                elif state.step in [Step.DISCLOSURE_REASON, Step.PICKUP_DECISION]:
                    reprompt = "माफ़ कीजिए, क्या आप मुझे सुन पा रहे हैं? क्या आप वाई-फाई राउटर पिकअप के लिए उपलब्ध हैं?"
                elif state.step == Step.DATE_RESOLUTION:
                    reprompt = "राउटर पिकअप के लिए आप किस दिन उपलब्ध होंगे? जैसे कल या परसों?"
                elif state.step == Step.ADDRESS_CONFIRMATION:
                    reprompt = f"क्या हमारे पास दर्ज पता '{state.address}' सही है?"
                else:
                    reprompt = "माफ़ कीजिए, क्या आप मुझे सुन पा रहे हैं?"

                logger.warning(f"⚠️ Silence detected (Prompt 1). Re-prompting customer: {reprompt}")
                state.add_transcript("assistant", reprompt)
                await session.say(reprompt, allow_interruptions=True)
                timing_tracker["last_activity_time"] = time.time()

            else:
                # Second silence -> terminate with 'no_response'
                logger.warning("⚠️ Persistent silence detected (Prompt 2). Concluding call as 'no_response'.")
                state.is_completed = True
                state.outcome = "no_response"
                state.transition_to(Step.TERMINATED)

                closing_line = "माफ़ कीजिए, आपकी आवाज़ नहीं आ पा रही है। हम आपसे बाद में संपर्क करेंगे। धन्यवाद।"
                state.add_transcript("assistant", closing_line)
                await session.say(closing_line, allow_interruptions=False)
                await clean_hangup(ctx, session, state)
                break
