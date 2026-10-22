import logging
from livekit.agents import Agent
from src.state import ConversationState
from src.prompts import get_step_instructions
from src.tools.agent_tools import AgentTools

logger = logging.getLogger("airtel-agent")


class AirtelAgent(Agent):
    """
    Airtel Voice Agent class wrapping conversation state, dynamic prompt
    instructions, and telephony tool bindings.
    """

    def __init__(self, state: ConversationState, tools_instance: AgentTools):
        self.state = state
        self.tools_instance = tools_instance

        tools = [
            # Core flow tools
            tools_instance.confirm_identity,
            tools_instance.set_pickup,
            tools_instance.record_willing_no_date,
            tools_instance.set_pickup_date,
            tools_instance.confirm_address,
            # FAQ Scenarios 1-10
            tools_instance.record_device_issue,
            tools_instance.record_refusal,
            tools_instance.record_temporarily_unavailable,
            tools_instance.record_recharge,
            tools_instance.escalate_to_121,
            tools_instance.record_shifted,
            # FAQ Scenarios 14-17
            tools_instance.record_already_picked_up,
            tools_instance.record_already_returned,
            tools_instance.record_do_not_call,
            tools_instance.record_still_using_device,
            # Utility
            tools_instance.record_language_barrier,
        ]

        super().__init__(
            instructions=get_step_instructions(state),
            tools=tools,
        )

    def refresh_instructions(self):
        """Updates the system instructions to match the current step."""
        try:
            self.update_instructions(get_step_instructions(self.state))
        except Exception as e:
            logger.debug(f"Failed to update instructions: {e}")
