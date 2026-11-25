import re
import time
import logging
from typing import Optional

from src.carrier_filter import classify_carrier
from src.config import (
    CARRIER_WEAK_MIN_WORDS,
    ENABLE_HUMAN_REGEX_SHORTCUTS,
    FASTPATH_ENABLED,
    HOLD_WAIT_SECONDS,
    PERSONA_NAME,
)
from src.intents import (
    DETAIL_TOPIC_RE,
    is_dnd,
    is_fee_or_policy_question,
    is_greeting,
    strict_no,
    strict_yes,
    wants_human,
)
from src.prompts import get_step_instructions
from src.state import ConversationState, Step
from src.tools.agent_tools import AgentTools

logger = logging.getLogger("telecom-voice-agent")


class StopResponse(Exception):
    """Raised when a fast-reply, date match, or carrier drop ends the turn without calling the LLM."""
    pass


_AI_MACHINE_Q_LATIN = re.compile(
    r"\b("
    r"(are\s+you\s+(a\s+)?(person\s+or\s+(a\s+)?machine|human\s+or\s+(a\s+)?(robot|bot|machine)|real\s+person|human|robot|bot|ai(\s*agent)?|machine|computer|virtual\s*assistant))"
    r"|(am\s+i\s+speaking\s+to\s+(a\s+)?(person\s+or\s+(a\s+)?machine|human|real\s+person|robot|bot|ai|machine|computer))"
    r"|(is\s+this\s+(a\s+)?(person\s+or\s+machine|human|real\s+person|robot|bot|ai|machine|automated\s*call|computer))"
    r"|(who\s+is\s+speaking|who\s+are\s+you)"
    r"|(insaan\s+ho\s+ya\s+(machine|robot|computer)|machine\s+ho\s+ya\s+insaan|real\s+person\s+ho\s+ya\s+bot)"
    r"|(kya\s+aap\s+(insaan|robot|ai|machine|computer)\s*ho)"
    r"|(kya\s+main\s+kisi\s+insaan\s+se\s+baat\s+kar\s+raha)"
    r"|(robot\s+ho\s+kya|ai\s+ho\s+kya|machine\s+ho\s+kya|insaan\s+bol\s+raha\s+hai)"
    r"|(kaun\s+bol\s+raha\s+hai|aap\s+kaun\s+ho)"
    r")\b",
    re.I,
)

_AI_MACHINE_Q_DEV = re.compile(
    r"(क्या\s*(आप|ये|यह)\s*(इंसान|इन्सान|रोबोट|मशीन|कंप्यूटर|एआई)|(इंसान|इन्सान)\s*हो\s*या\s*(रोबोट|मशीन)|(रोबोट|एआई|मशीन)\s*(हो|बोल\s*रहा|है)|कौन\s*बोल\s*रहा\s*है)"
)


class AirtelTurnHandler:
    """Deterministic per-turn logic for the Airtel Router Return Pickup agent (Pipecat edition).

    Runs on the COMPLETE user turn, after the user aggregator and before the LLM. Any shortcut
    returns True which makes TurnGate drop the LLM run for that turn.
    `session` is a PipecatSession (update_instructions / update_tools / say / interrupt).

    Who decides what (regex = closed-set / compliance / latency, LLM = open-ended meaning):

      1. carrier gate     regex   IVR / voicemail / "not reachable" -> hang up; "on hold" -> wait;
                                  weak patterns only count on long utterances, twice in a row
      2. language         regex   follow the customer (Hindi <-> English), conservative
      3. compliance       regex   human request, do-not-call, "are you a bot", fee / policy / complaint -> 121
      4. date shortcut    code    explicit pickup date in the customer's own words (step-scoped, needs a date cue)
      5. yes/no fast-path regex   1-5 word, purely affirmative / negative answers to the pending question
      6. everything else  LLM     reasons, mixed intents, free-text details, odd questions
         (the tools the LLM calls are still validated by code: consent needs a clear yes, phone numbers come
         from the customer's words, dates are parsed by code)
    """

    def __init__(self, state: ConversationState, tools_instance: AgentTools, session):
        self._state = state
        self._tools = tools_instance
        self.session = session
        self.on_language_change = None

    async def sync_step(self):
        """Called by AgentTools._go() after every step change."""
        await self.session.update_instructions(get_step_instructions(self._state))
        await self.session.update_tools(self._tools.tools_for_step(self._state.step))

    def _pending_question(self) -> str:
        s = self._state
        en = s.reply_lang == "en"
        if s.step == Step.IDENTITY:
            if getattr(s, "direction", "outbound") == "inbound":
                return "May I know the purpose of your call?" if en else "क्या मैं जान सकती हूँ आपने किस संबंध में कॉल किया है?"
            who = s.customer_name if s.customer_name and s.customer_name.lower() not in ("customer", "subscriber", "user") else ("the registered customer" if en else "रजिस्टर्ड ग्राहक")
            return f"Am I speaking with {who}?" if en else f"क्या मैं {who} जी से बात कर रही हूँ?"
        elif s.step == Step.PICKUP_DECISION:
            when = self._tools._offered_spoken()
            return f"Can I schedule the pickup of your Wi-Fi router for {when}?" if en else f"क्या मैं {when} को आपके वाई-फाई राउटर का पिकअप शेड्यूल कर सकती हूँ?"
        elif s.step == Step.DATE_RESOLUTION:
            return "Which day would suit you for the pickup?" if en else "पिकअप के लिए कौन सा दिन ठीक रहेगा?"
        elif s.step == Step.ADDRESS_CONFIRMATION:
            if s.awaiting_detail:
                return "Please tell me your correct address." if en else "कृपया अपना सही पता बताइए।"
            return f"Is your registered address '{s.address}' correct?" if en else f"क्या आपका रजिस्टर्ड पता '{s.address}' सही है?"
        return "How may I help you with your router return?" if en else "क्या मैं आपके राउटर रिटर्न में मदद कर सकती हूँ?"

    # ───────────────────────── 1. carrier gate ─────────────────────────

    async def _drop_call(self, kind: str, text: str):
        logger.warning(f"📵 Carrier announcement ({kind}) ignored, dropping call / skipping LLM: \"{text[:120]}\"")
        self._state.ivr_detected = True
        self._state.final_disposition = "Voicemail or IVR Detected"
        self._state.customer_note = f"Voicemail or IVR Detected ({kind}): {text[:120]}"
        if self._tools.hangup_func:
            await self._tools.hangup_func()

    async def _carrier_gate(self, text: str) -> bool:
        """True = the turn is a carrier message and is fully handled (LLM skipped)."""
        s = self._state
        hit = classify_carrier(text)
        if hit is None:
            s.carrier_weak_hits = 0
            return False

        if hit.kind == "hold":
            # "Your call is on hold" is not the customer and not a reason to hang up: stay silent and wait.
            s.hold_until = time.time() + HOLD_WAIT_SECONDS
            logger.info(f"⏸️ Hold announcement ignored, waiting {HOLD_WAIT_SECONDS:.0f}s: \"{text[:120]}\"")
            return True

        if hit.strong:
            await self._drop_call(hit.kind, text)
            return True

        # WEAK pattern: a real customer (or a relative who picked up) can say these too.
        # Announcements are long, customer answers are short.
        if hit.words < CARRIER_WEAK_MIN_WORDS:
            s.carrier_weak_hits = 0
            logger.info(f"Weak carrier pattern ({hit.kind}) on a short utterance -> treated as the customer: \"{text[:120]}\"")
            return False
        s.carrier_weak_hits += 1
        if s.carrier_weak_hits >= 2:
            await self._drop_call(hit.kind, text)
        else:
            logger.info(f"Weak carrier pattern ({hit.kind}) on a long utterance -> turn dropped silently (hit 1/2): \"{text[:120]}\"")
        return True

    # ───────────────────────── 2. language ─────────────────────────

    async def _follow_language(self, text: str):
        state = self._state
        if state.update_reply_lang(text):
            lang = state.reply_lang
            logger.info(f"🌐 Customer switched language -> {lang}")
            try:
                if self.on_language_change:
                    self.on_language_change(lang)
            except Exception as e:
                logger.warning(f"TTS language switch failed: {e}")
            try:
                await self.session.update_instructions(get_step_instructions(state))
            except Exception as e:
                logger.warning(f"Could not refresh instructions after language switch: {e}")

    # ───────────────────────── 5. yes / no fast-path ─────────────────────────

    async def _fast_path(self, text: str) -> bool:
        """Act on a short, purely affirmative / negative answer to the pending question without the LLM.
        Anything with extra words, both polarities, a question or a deferral ("theek nahi", "dekh lo",
        "haan but kal nahi") is NOT strict and goes to the LLM, which also enforces the CONSENT RULE."""
        s = self._state
        t = self._tools
        inbound = getattr(s, "direction", "outbound") == "inbound"

        # The customer just picked up and says "hello": repeat the identity question (scripted, no LLM).
        if s.step == Step.IDENTITY and not inbound and is_greeting(text):
            if s.agent_speaking:
                logger.info("Greeting while the opening line is still playing -> ignored")
                return True
            if s.strikes.get("greeting", 0) < 3:
                s.strikes["greeting"] = s.strikes.get("greeting", 0) + 1
                q = t._identity_question()
                line = (f"Hello, I am {PERSONA_NAME} calling from Airtel. {q}" if s.reply_lang == "en"
                        else f"नमस्ते, मैं एयरटेल से {PERSONA_NAME} बोल रही हूँ। {q}")
                logger.info("⚡ Fast-path: greeting -> identity question")
                if t.log_dialogue_func:
                    t.log_dialogue_func("assistant", line)
                self.session.say(line, allow_interruptions=True)
                return True
            return False

        yes, no = strict_yes(text), strict_no(text)
        if not (yes or no):
            return False

        if s.step == Step.IDENTITY and not inbound:
            if yes:
                logger.info("⚡ Fast-path: identity confirmed")
                return await t.run_direct(t.confirm_identity, is_correct=True)
            logger.info("⚡ Fast-path: identity denied")
            return await t.run_direct(t.confirm_identity, is_correct=False, is_wrong_person=True)

        if s.step == Step.PICKUP_DECISION:
            logger.info(f"⚡ Fast-path: pickup decision = {'yes' if yes else 'no'}")
            return await t.run_direct(t.set_pickup, decision="yes" if yes else "no")

        # A bare "no" at the address step is ambiguous (wrong address? no pickup?): the LLM decides.
        if s.step == Step.ADDRESS_CONFIRMATION and yes:
            logger.info("⚡ Fast-path: registered address confirmed")
            return await t.run_direct(t.confirm_address, confirmed=True)

        return False

    # ───────────────────────── main entry ─────────────────────────

    async def handle_turn(self, text: str) -> bool:
        """Called by TurnGate when a complete customer turn is transcribed.
        Returns True if the turn was handled deterministically and LLM should be skipped.
        """
        text = (text or "").strip()
        if not text:
            return True

        state = self._state
        if state.closing_spoken:
            return True

        # 1. Carrier announcements (voicemail, IVR, "not reachable") are NOT the customer; "on hold" just waits.
        if await self._carrier_gate(text):
            return True

        # 2. Follow customer language (Hindi <-> English)
        await self._follow_language(text)

        # 3. Compliance triggers (regex). These never depend on the LLM remembering a rule.
        if wants_human(text):
            logger.info(f"👤 Customer requested human representative: '{text}' -> routing to 121")
            if await self._tools.run_direct(self._tools.escalate_to_121, "Customer requested to speak to a human representative"):
                return True

        if is_dnd(text):
            logger.info(f"🚫 Do-not-call request: '{text}'")
            if await self._tools.run_direct(self._tools.record_do_not_call):
                return True

        # Virtual assistant disclosure rule: say clearly that this is a virtual assistant calling on behalf
        # of Airtel, never claim to be human, then repeat the pending question.
        if _AI_MACHINE_Q_LATIN.search(text) or _AI_MACHINE_Q_DEV.search(text):
            en = state.reply_lang == "en"
            pending_q = self._pending_question()
            if en:
                disclosure_line = f"I am a virtual assistant calling on behalf of Airtel. {pending_q}"
            else:
                disclosure_line = f"जी, मैं एयरटेल की तरफ से वर्चुअल असिस्टेंट बात कर रही हूँ। {pending_q}"
            logger.info(f"🤖 Virtual assistant disclosure triggered: '{text}' -> '{disclosure_line}'")
            log_fn = getattr(self._tools, "log_dialogue_func", None)
            if log_fn:
                log_fn("assistant", disclosure_line)
            else:
                state.add_transcript("assistant", disclosure_line)
            self.session.say(disclosure_line, allow_interruptions=True)  # PipecatSession.say is synchronous
            return True

        # Fees, penalties, refund amounts, deposits, policy, complaints: never answered by the bot.
        # (Skipped at IDENTITY: nothing about the account has been said to this person yet.)
        if state.step != Step.IDENTITY and is_fee_or_policy_question(text):
            logger.info(f"💸 Fee / policy / complaint question: '{text}' -> routing to 121")
            if await self._tools.run_direct(self._tools.escalate_to_121, text[:200]):
                return True

        if not ENABLE_HUMAN_REGEX_SHORTCUTS:
            # PURE LLM PIPELINE (regex used strictly for IVR / carrier announcement detection above).
            # All human conversational turns proceed directly to the LLM (google/gemini-2.5-flash-lite).
            return False

        # 4 + 5. Step-scoped shortcuts. Skipped when the agent has just asked for a free-text detail
        # (address, phone, recharge date ...): that reply is not a date and not a bare yes/no.
        blocked = state.awaiting_detail
        state.awaiting_detail = False
        if not blocked:
            try:
                handled = await self._tools.try_handle_date_utterance(text)
            except Exception as e:
                logger.error(f"Direct date handling failed, falling back to LLM: {e}")
                handled = False
            if handled:
                logger.info("📅 Direct date handling succeeded -> skipping LLM")
                return True

            if FASTPATH_ENABLED:
                try:
                    if await self._fast_path(text):
                        return True
                except Exception as e:
                    logger.error(f"Fast-path failed, falling back to LLM: {e}", exc_info=True)

        # Detail-style topics (recharged, shifted, damaged, already picked up, refund...) make the LLM ask a
        # follow-up whose answer may contain a date: do not read that date as a pickup date.
        if DETAIL_TOPIC_RE.search(text):
            state.awaiting_detail = True

        # 6. Everything else -> LLM
        return False


# Compatibility alias
AirtelAgent = AirtelTurnHandler
