import time
import asyncio
import logging
from livekit import agents, api
from livekit.agents import AgentSession

from src.state import Step, ConversationState
from src.lang import L
from src.tools.api import post_outcome_to_backend

logger = logging.getLogger("agent-watchdog")


async def _end_call(ctx: agents.JobContext, room_name: str):
    """Really hang up the phone call.

    Leaving the room (ctx.room.disconnect()) only removes the AGENT: the SIP/phone participant stays connected,
    so the call never ends. Deleting the room disconnects everyone, including the phone leg."""
    try:
        await ctx.api.room.delete_room(api.DeleteRoomRequest(room=room_name))
        logger.info(f"Room {room_name} deleted: phone call ended.")
        return
    except Exception as e:  # noqa: BLE001
        logger.warning(f"delete_room failed ({e}); removing participants one by one.")

    try:
        for p in list(ctx.room.remote_participants.values()):
            try:
                await ctx.api.room.remove_participant(
                    api.RoomParticipantIdentity(room=room_name, identity=p.identity)
                )
            except Exception as e:  # noqa: BLE001
                logger.warning(f"remove_participant({p.identity}) failed: {e}")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Could not enumerate participants: {e}")


async def clean_hangup(ctx: agents.JobContext, session: AgentSession, state: ConversationState, speech=None):
    """Waits for the final line to finish playing, saves the outcome, then ENDS the call.

    speech: the SpeechHandle of the closing line (when known), so we hang up exactly when it has been spoken."""
    if state.hangup_started:
        return
    state.hangup_started = True
    state.is_completed = True
    room_name = ctx.room.name or getattr(getattr(ctx.job, "room", None), "name", "")

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

    # Wait for the closing line ("... for any other help dial 121, thank you") to be fully spoken
    try:
        if speech is not None:
            await asyncio.wait_for(speech.wait_for_playout(), timeout=15.0)
        else:
            # Give up to 1.5s for the speech handle to be scheduled if just queued
            for _ in range(15):
                if getattr(session, "current_speech", None):
                    break
                await asyncio.sleep(0.1)

            if getattr(session, "current_speech", None):
                await asyncio.wait_for(session.current_speech.wait_for_playout(), timeout=15.0)
            elif hasattr(session, "wait_for_idle"):
                await asyncio.wait_for(session.wait_for_idle(), timeout=12.0)
            else:
                await asyncio.sleep(4.0)
    except Exception as e:
        logger.debug(f"Wait for audio playout note: {e}")
        await asyncio.sleep(2.0)

    # Short grace period to ensure final audio packets reach the caller
    await asyncio.sleep(0.8)

    # Collect the backend save. Only a successful save marks the outcome as posted.
    try:
        if await asyncio.wait_for(post_task, timeout=12.0):
            state.outcome_posted = True
    except Exception as e:  # noqa: BLE001
        logger.error(f"Outcome post at hangup failed: {e}")
    if not state.outcome_posted:
        logger.error(f"❌ Outcome for call {state.call_id} was NOT saved to the backend.")

    # Gracefully close the agent session
    try:
        if hasattr(session, "aclose"):
            await asyncio.wait_for(session.aclose(), timeout=3.0)
    except Exception:
        pass

    logger.info(f"Ending call in room {room_name} (Final disposition: {state.final_disposition})...")
    await _end_call(ctx, room_name)
    try:
        await ctx.room.disconnect()
    except Exception as e:
        logger.debug(f"Room disconnect note: {e}")
    try:
        ctx.shutdown(reason="call completed")
    except Exception as e:
        logger.debug(f"Shutdown note: {e}")


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
    # played (LLM returned nothing / TTS hiccup), so the hangup was never triggered.
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
        line = state.closing_line or L(
            state,
            "धन्यवाद। किसी भी जानकारी के लिए कृपया एयरटेल 121 पर संपर्क करें।",
            "Thank you. For any other help, please dial Airtel 121.",
        )
        state.add_transcript("assistant", line)
        speech = None
        try:
            speech = session.say(line, allow_interruptions=False)
        except Exception as e:
            logger.debug(f"Fallback closing line failed: {e}")
        await clean_hangup(ctx, session, state, speech=speech)


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
        # The CUSTOMER talking is not silence either.
        # Capped at 30s so line noise that VAD mistakes for speech can never keep the call alive forever.
        user_speaking = getattr(session, "user_state", "listening") == "speaking"
        if user_speaking:
            since = timing_tracker.setdefault("_user_speaking_since", now)
            user_speaking = (now - since) < 30.0
        else:
            timing_tracker.pop("_user_speaking_since", None)

        if is_busy or user_speaking:
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
                reprompt = L(state, "नमस्ते, क्या आप मुझे सुन पा रहे हैं?", "Hello, can you hear me?")

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
                reprompt = L(
                    state,
                    f"नमस्ते {state.customer_name} जी, क्या मेरी आवाज़ आप तक पहुँच रही है?",
                    f"Hello {state.customer_name}, is my voice reaching you?",
                )

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

                closing_line = L(
                    state,
                    "शायद आपकी आवाज़ नहीं आ पा रही है। हम आपसे बाद में संपर्क करेंगे। धन्यवाद।",
                    "I think your voice is not reaching me. We will contact you later. Thank you.",
                )
                state.add_transcript("assistant", closing_line)
                speech = None
                try:
                    speech = session.say(closing_line, allow_interruptions=False)
                except Exception as e:
                    logger.debug(f"Session closed before closing line: {e}")
                await clean_hangup(ctx, session, state, speech=speech)
                break
            