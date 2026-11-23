import re
import logging
from typing import Optional

from src.carrier_filter import classify_carrier_message
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

_WANTS_HUMAN_RE = re.compile(
    r"\b("
    r"talk\s+to\s+(a\s+)?(human|person|agent|representative|executive|live\s+person)"
    r"|speak\s+to\s+(a\s+)?(human|person|agent|representative|executive)"
    r"|connect\s+to\s+(a\s+)?(human|person|agent|representative)"
    r"|kisi\s+insaan\s+se\s+baat"
    r"|insaan\s+se\s+baat"
    r"|executive\s+se\s+baat"
    r"|agent\s+se\s+baat"
    r")\b",
    re.I,
)


class AirtelTurnHandler:
    """Deterministic per-turn logic for Airtel Router Return Pickup agent (Pipecat edition).

    Runs on the COMPLETE user turn, after the user aggregator and before the LLM. Any shortcut
    returns True (or raises StopResponse) which makes TurnGate drop the LLM run for that turn.
    `session` is a PipecatSession (update_instructions / update_tools / say / interrupt).
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
        elif s.step in (Step.PICKUP_DECISION, Step.DATE_RESOLUTION):
            when = self._tools._offered_spoken()
            return f"Can I schedule the pickup of your Wi-Fi router for {when}?" if en else f"क्या मैं {when} को आपके वाई-फाई राउटर का पिकअप शेड्यूल कर सकती हूँ?"
        elif s.step == Step.ADDRESS_CONFIRMATION:
            return f"Is your registered address '{s.address}' correct?" if en else f"क्या आपका रजिस्टर्ड पता '{s.address}' सही है?"
        return "How may I help you with your router return?" if en else "क्या मैं आपके राउटर रिटर्न में मदद कर सकती हूँ?"

    async def handle_turn(self, text: str) -> bool:
        """Called by TurnGate when a complete customer turn is transcribed.
        Returns True if the turn was handled deterministically and LLM should be skipped.
        """
        text = (text or "").strip()
        if not text:
            return True

        if self._state.closing_spoken:
            return True

        # 1. Carrier announcements (call-waiting "on hold", voicemail, not reachable) are NOT the customer.
        kind = classify_carrier_message(text)
        if kind:
            logger.warning(f"📵 Carrier announcement ({kind}) ignored, dropping call / skipping LLM: \"{text[:120]}\"")
            self._state.ivr_detected = True
            self._state.final_disposition = "Voicemail or IVR Detected"
            self._state.customer_note = f"Voicemail or IVR Detected ({kind}): {text[:120]}"
            if self._tools.hangup_func:
                await self._tools.hangup_func()
            return True

        # 2. Follow customer language (Hindi <-> English)
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

        # 3. Virtual assistant disclosure rule:
        # If customer asks whether they are speaking to a person or a machine / robot / AI:
        # Clearly state virtual assistant calling on behalf of Airtel. Never claim to be human.
        # If they demand a live human representative, route them to 121.
        if _WANTS_HUMAN_RE.search(text):
            logger.info(f"👤 Customer requested human representative: '{text}' -> routing to 121")
            await self._tools.escalate_to_121("Customer requested to speak to a human representative")
            return True

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
            self.session.say(disclosure_line, allow_interruptions=True)
            return True

        # 4. If customer named a pickup date, handle it directly (no LLM guess), then skip LLM.
        try:
            handled = await self._tools.try_handle_date_utterance(text)
        except Exception as e:
            logger.error(f"Direct date handling failed, falling back to LLM: {e}")
            handled = False
        if handled:
            logger.info("📅 Direct date handling succeeded -> skipping LLM")
            return True

        return False


# Compatibility alias
AirtelAgent = AirtelTurnHandler
