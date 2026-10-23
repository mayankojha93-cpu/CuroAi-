import logging

from livekit.agents import Agent, StopResponse

from src.carrier_filter import classify_carrier_message
from src.prompts import get_step_instructions

logger = logging.getLogger("telecom-voice-agent")


class AirtelAgent(Agent):
    """Agent whose instructions AND tools change with the conversation step."""

    def __init__(self, state, tools_instance):
        self._airtel_state = state
        self._airtel_tools = tools_instance
        super().__init__(
            instructions=get_step_instructions(state),
            tools=tools_instance.tools_for_step(state.step),
        )

    async def sync_step(self):
        """Called by AgentTools._go() after every step change."""
        await self.update_instructions(get_step_instructions(self._airtel_state))
        await self.update_tools(self._airtel_tools.tools_for_step(self._airtel_state.step))

    async def on_user_turn_completed(self, turn_ctx, new_message):
        """
        Gate between the customer's transcript and the LLM.
        Carrier announcements (call-waiting "on hold", voicemail, not reachable) are NOT the customer.
        Raising StopResponse means the LLM never sees them, so no tool can be triggered by them.
        (worker.py handles the call outcome for voicemail.)
        """
        text = (getattr(new_message, "text_content", None) or "").strip()
        kind = classify_carrier_message(text)
        if kind:
            logger.warning(f"📵 Carrier announcement ({kind}) ignored, not sent to LLM: \"{text[:120]}\"")
            raise StopResponse()

    async def llm_node(self, chat_ctx, tools, model_settings):
        """
        One tool per customer turn.
        When the last item in the context is a tool result, the LLM's only job is to
        speak that result. Hide all tools so it cannot chain a second (hallucinated) call.
        """
        items = getattr(chat_ctx, "items", None) or []
        if items and getattr(items[-1], "type", None) == "function_call_output":
            tools = []
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            yield chunk

    def tts_node(self, text, model_settings):
        """Safety net: if the LLM ever writes a tool call as text, never speak it."""
        async def guard():
            checked, drop = False, False
            async for chunk in text:
                if not checked and chunk.strip():
                    checked = True
                    drop = chunk.lstrip().startswith("{")
                if not drop:
                    yield chunk

        return Agent.default.tts_node(self, guard(), model_settings)