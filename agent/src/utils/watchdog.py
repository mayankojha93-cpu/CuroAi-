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
    # Ensure disposition is set
    if not state.final_disposition or state.final_disposition == "DISCONNECTED":
        if state.step == Step.CLOSE and state.confirmed_date:
            state.final_disposition = "CONFIRMED_FOR_PICKUP"
        elif not state.is_terminal():
            state.final_disposition = "DISCONNECTED"

    # Save outcome and transcript to backend
    post_outcome_to_backend(state)

    # Give TTS audio 3.0 seconds to complete playout
    await asyncio.sleep(3.0)
    logger.info(f"Cleanly disconnecting room {ctx.room.name} (Final disposition: {state.final_disposition})...")
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
    Monitors customer silence based on Airtel Campaign rules (Image 4):
    - Waits 5 seconds: Asks "नमस्ते, क्या आप मुझे सुन पा रहे हैं?"
    - Waits 5 more seconds: repeats once more.
    - If still silent: ends politely, marks 'NO_RESPONSE', sent back to retry queue.
    """
    SILENCE_THRESHOLD_SECONDS = 5.0

    while not state.is_completed and not state.is_terminal():
        await asyncio.sleep(1.0)

        # Check if session or room is still active
        if getattr(session, "_activity", None) is None:
            break
        if not getattr(ctx.room, "is_connected", lambda: True)():
            break

        now = time.time()
        elapsed = now - timing_tracker.get("last_activity_time", now)

        if elapsed >= SILENCE_THRESHOLD_SECONDS and not state.is_completed:
            # Check again before attempting to speak
            if getattr(session, "_activity", None) is None:
                break

            if state.silence_count == 0:
                state.silence_count += 1
                timing_tracker["last_activity_time"] = time.time()
                reprompt = "नमस्ते, क्या आप मुझे सुन पा रहे हैं?"

                logger.warning(f"⚠️ Silence detected (5s). Re-prompting: {reprompt}")
                state.add_transcript("assistant", reprompt)
                try:
                    await session.say(reprompt, allow_interruptions=True)
                except Exception as e:
                    logger.debug(f"Watchdog session.say stopped (session closed): {e}")
                    break
                timing_tracker["last_activity_time"] = time.time()

            elif state.silence_count == 1:
                state.silence_count += 1
                timing_tracker["last_activity_time"] = time.time()
                reprompt = f"नमस्ते {state.customer_name} जी, क्या मेरी आवाज़ आप तक पहुँच रही है?"

                logger.warning(f"⚠️ Second silence detected (10s total). Final re-prompt: {reprompt}")
                state.add_transcript("assistant", reprompt)
                try:
                    await session.say(reprompt, allow_interruptions=True)
                except Exception as e:
                    logger.debug(f"Watchdog session.say stopped (session closed): {e}")
                    break
                timing_tracker["last_activity_time"] = time.time()

            else:
                # Persistent silence -> conclude as NO_RESPONSE and retry
                logger.warning("⚠️ Persistent silence. Concluding call as NO_RESPONSE (back to retry queue).")
                state.is_completed = True
                state.final_disposition = "NO_RESPONSE"
                state.customer_note = "Call ended due to persistent customer silence (NO_RESPONSE)"
                state.transition_to(Step.TERMINATED)

                closing_line = "शायद आपकी आवाज़ नहीं आ पा रही है। हम आपसे बाद में संपर्क करेंगे। धन्यवाद।"
                state.add_transcript("assistant", closing_line)
                try:
                    await session.say(closing_line, allow_interruptions=False)
                except Exception as e:
                    logger.debug(f"Session closed before closing line: {e}")
                await clean_hangup(ctx, session, state)
                break

