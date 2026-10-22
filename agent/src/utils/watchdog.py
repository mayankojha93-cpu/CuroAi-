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

    # Save outcome + FINAL transcript/duration. The backend save is an idempotent upsert, so this is
    # safe even if a tool already posted at the terminal step (that earlier post lacks the closing line).
    # It runs in a thread, concurrently with the closing-line playout below.
    post_task = asyncio.create_task(asyncio.to_thread(post_outcome_to_backend, state))

    # Wait gracefully for closing line TTS synthesis & audio playback to complete
    try:
        # Give up to 1.5s for the speech handle to be scheduled if just queued
        for _ in range(15):
            if getattr(session, "current_speech", None):
                break
            await asyncio.sleep(0.1)

        if getattr(session, "current_speech", None):
            await asyncio.wait_for(session.current_speech.wait_for_playout(), timeout=12.0)
        elif hasattr(session, "wait_for_idle"):
            await asyncio.wait_for(session.wait_for_idle(), timeout=12.0)
        else:
            await asyncio.sleep(4.0)
    except Exception as e:
        logger.debug(f"Wait for audio playout note: {e}")
        await asyncio.sleep(2.0)

    # Short grace period to ensure final audio packets reach the caller
    await asyncio.sleep(1.0)

    # Collect the backend save. Only a successful save marks the outcome as posted.
    try:
        if await asyncio.wait_for(post_task, timeout=12.0):
            state.outcome_posted = True
    except Exception as e:  # noqa: BLE001
        logger.error(f"Outcome post at hangup failed: {e}")
    if not state.outcome_posted:
        logger.error(f"❌ Outcome for call {state.call_id} was NOT saved to the backend.")

    # Allow audio queues to drain cleanly
    try:
        if hasattr(session, "drain"):
            await asyncio.wait_for(session.drain(), timeout=1.5)
    except Exception:
        pass

    # Gracefully close session before disconnecting room transport
    try:
        if hasattr(session, "aclose"):
            await asyncio.wait_for(session.aclose(), timeout=2.0)
    except Exception:
        pass

    logger.info(f"Cleanly disconnecting room {ctx.room.name} (Final disposition: {state.final_disposition})...")
    try:
        await ctx.room.disconnect()
    except Exception as e:
        logger.debug(f"Room disconnect note: {e}")

async def silence_watchdog(
    ctx: agents.JobContext,
    session: AgentSession,
    state: ConversationState,
    timing_tracker: dict
):
    """
    Monitors customer silence based on Airtel Campaign rules:
    - Waits 5 seconds: Asks "नमस्ते, क्या आप मुझे सुन पा रहे हैं?"
    - Waits 5 more seconds: repeats once more.
    - If still silent: ends politely, marks 'NO_RESPONSE', sent back to retry queue.
    """
    SILENCE_THRESHOLD_SECONDS = 5.0

    await _silence_loop(ctx, session, state, timing_tracker, SILENCE_THRESHOLD_SECONDS)

    # Fallback: a tool already moved the call to a terminal step, but the closing line was never
    # played (LLM returned nothing / TTS hiccup), so worker.py never triggered the hangup.
    if state.is_terminal() and not state.is_completed:
        for _ in range(20):
            await asyncio.sleep(1.0)
            if state.is_completed:
                return  # normal path took over
        if getattr(session, "agent_state", "idle") in ("speaking", "thinking"):
            await asyncio.sleep(5.0)
            if state.is_completed:
                return
        logger.warning("⚠️ Terminal step reached but no closing line was played. Speaking fallback and hanging up.")
        state.is_completed = True
        line = state.closing_line or "धन्यवाद। किसी भी जानकारी के लिए कृपया एयरटेल 121 पर संपर्क करें।"
        state.add_transcript("assistant", line)
        try:
            await session.say(line, allow_interruptions=False)
        except Exception as e:
            logger.debug(f"Fallback closing line failed: {e}")
        await clean_hangup(ctx, session, state)


async def _silence_loop(ctx, session, state, timing_tracker, SILENCE_THRESHOLD_SECONDS):
    while not state.is_completed and not state.is_terminal():
        await asyncio.sleep(1.0)

        # Check if session or room is still active
        if getattr(session, "_activity", None) is None:
            break
        if not getattr(ctx.room, "is_connected", lambda: True)():
            break

        now = time.time()

        # Do NOT treat as customer silence if agent is speaking, generating, or running filler
        agent_state = getattr(session, "agent_state", "idle")
        is_busy = (
            agent_state in ("speaking", "thinking")
            or timing_tracker.get("is_agent_speaking", False)
            or timing_tracker.get("provider_filler_pending", False)
        )
        if is_busy:
            timing_tracker["last_activity_time"] = now
            continue

        elapsed = now - timing_tracker.get("last_activity_time", now)

        if elapsed >= SILENCE_THRESHOLD_SECONDS and not state.is_completed and not state.is_terminal():
            # Double check session active state before speaking
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
            