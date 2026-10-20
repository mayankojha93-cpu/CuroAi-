from enum import Enum
from typing import Optional, List, Dict, Any

class Step(str, Enum):
    IDENTITY = "IDENTITY"
    DISCLOSURE_REASON = "DISCLOSURE_REASON"
    PICKUP_DECISION = "PICKUP_DECISION"
    DATE_RESOLUTION = "DATE_RESOLUTION"
    ADDRESS_CONFIRMATION = "ADDRESS_CONFIRMATION"
    CLOSE = "CLOSE"
    WRONG_PERSON = "WRONG_PERSON"
    CALLBACK_REQUESTED = "CALLBACK_REQUESTED"
    ESCALATED = "ESCALATED"
    TERMINATED = "TERMINATED"

class ConversationState:
    def __init__(
        self,
        call_id: str = "",
        customer_name: str = "Customer",
        phone: str = "",
        address: str = "",
        language: str = "hi"
    ):
        self.call_id = call_id
        self.customer_name = customer_name
        self.phone = phone
        self.address = address
        self.language = language

        # Current state
        self.step: Step = Step.IDENTITY
        self.identity_confirmed: Optional[bool] = None
        self.pickup_agreed: Optional[bool] = None
        self.pickup_date: Optional[str] = None          # YYYY-MM-DD
        self.pickup_date_spoken: Optional[str] = None   # 'मंगलवार, 20 अक्टूबर'
        self.address_confirmed: Optional[bool] = None
        self.corrected_address: Optional[str] = None
        self.outcome: Optional[str] = None              # pickup_scheduled, pickup_declined, wrong_person, callback_requested, escalated, no_response
        self.escalation_reason: Optional[str] = None

        # Call transcript tracking
        self.transcript: List[Dict[str, Any]] = []

        # Error / retry counters
        self.silence_count: int = 0
        self.date_retry_count: int = 0
        self.is_completed: bool = False

    def add_transcript(self, role: str, message: str):
        if message and message.strip():
            self.transcript.append({
                "role": role,
                "message": message.strip()
            })

    def transition_to(self, next_step: Step):
        self.step = next_step

    def is_terminal(self) -> bool:
        return self.step in [
            Step.CLOSE,
            Step.WRONG_PERSON,
            Step.CALLBACK_REQUESTED,
            Step.ESCALATED,
            Step.TERMINATED
        ]
