import re
import logging
from livekit.agents import Agent, StopResponse
from src.carrier_filter import classify_carrier_message
from .prompts import get_step_instructions
from .state import RealEstateState

logger = logging.getLogger("real-estate-agent")


class RealEstateAgent(Agent):
    """Voice agent for My Estate Finder property intake (Sagar)."""

    def __init__(self, state: RealEstateState, tools_instance):
        self._re_state = state
        self._re_tools = tools_instance
        self.on_language_change = None
        super().__init__(
            instructions=get_step_instructions(state),
            tools=tools_instance.tools_for_step(state.step),
        )

    async def sync_step(self):
        """Sync instructions and available tools when step changes."""
        await self.update_instructions(get_step_instructions(self._re_state))
        await self.update_tools(self._re_tools.tools_for_step(self._re_state.step))

    async def on_user_turn_completed(self, turn_ctx, new_message):
        text = (getattr(new_message, "text_content", None) or "").strip()
        kind = classify_carrier_message(text)
        if kind:
            logger.warning(f"📵 Carrier announcement ({kind}) ignored: '{text[:100]}'")
            raise StopResponse()

        state = self._re_state
        low_text = text.lower()
        impatient_phrases = (
            "jaldi bolo", "jaldi batao", "time nahi", "time nhi", "bahut sawal", "kitna sawal",
            "kitne sawal", "hurry up", "don't have time", "dont have time", "wrap it up",
            "seedha point", "stop asking", "bakwas band", "short me bolo", "short mein",
        )
        if any(p in low_text for p in impatient_phrases):
            logger.info(f"⚠️ Impatience pattern detected in caller utterance: '{text}'")
            state.impatient_detected = True

        lang_switched = state.update_reply_lang(text)
        if lang_switched or state.impatient_detected:
            lang = state.reply_lang
            if lang_switched:
                logger.info(f"🌐 Customer switched language -> {lang}")
                if self.on_language_change:
                    try:
                        self.on_language_change(lang)
                    except Exception as e:
                        logger.warning(f"Language switch callback failed: {e}")
            try:
                await self.update_instructions(get_step_instructions(state))
            except Exception as e:
                logger.warning(f"Failed to refresh instructions: {e}")

    async def llm_node(self, chat_ctx, tools, model_settings):
        """Prevent hallucinated second tool call when last item was tool output."""
        items = getattr(chat_ctx, "items", None) or []
        if items and getattr(items[-1], "type", None) == "function_call_output":
            tools = []
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            yield chunk

    def tts_node(self, text, model_settings):
        """Safety net to prevent raw JSON tool payloads or tool leaks like close_call{} from being spoken."""
        async def guard():
            checked, drop = False, False
            async for chunk in text:
                if not checked and chunk.strip():
                    checked = True
                    drop = chunk.lstrip().startswith("{")
                if not drop:
                    # Clean any leaked tool call syntax like close_call{} or func_name(...)
                    cleaned = re.sub(r'\b[a-zA-Z_][a-zA-Z0-9_]*\s*\{[^}]*\}', '', chunk)
                    if cleaned:
                        yield cleaned

        return Agent.default.tts_node(self, guard(), model_settings)

