import time
from enum import Enum
from typing import Optional, List, Dict, Any

class Step(str, Enum):
    IDENTITY = "IDENTITY"
    DISCLOSURE_REASON = "DISCLOSURE_REASON"
    PICKUP_DECISION = "PICKUP_DECISION"
    DATE_RESOLUTION = "DATE_RESOLUTION"
    ADDRESS_CONFIRMATION = "ADDRESS_CONFIRMATION"
    DAMAGED_OR_LOST = "DAMAGED_OR_LOST"
    RECHARGED = "RECHARGED"
    REFUSAL = "REFUSAL"
    SHIFTED = "SHIFTED"
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
        language: str = "hi",
        account_no: str = "",
        subs_del_no: str = "",
        service_end_date: str = "",
        r_date: str = "",
        attempt_number: int = 1,
        direction: str = "outbound",
    ):
        self.call_id = call_id
        self.customer_name = customer_name
        self.phone = phone
        self.address = address
        self.language = language
        self.account_no = account_no
        self.subs_del_no = subs_del_no
        self.service_end_date = service_end_date
        self.r_date = r_date
        self.attempt_number = attempt_number
        self.direction = direction

        # Timing and latency measurement
        self.start_time: float = time.time()
        self.latency_samples: List[float] = []

        # Current conversation step
        self.step: Step = Step.IDENTITY

        # Core fields matching Airtel Campaign Outcome Spec
        self.identity_confirmed: Optional[bool] = None
        self.pickup_accepted: Optional[bool] = None
        self.proposed_date: Optional[str] = None          # YYYY-MM-DD
        self.pickup_date_spoken: Optional[str] = None     # e.g. 'कल, 21 अक्टूबर'
        self.confirmed_date: Optional[str] = None         # YYYY-MM-DD
        self.offered_date: Optional[str] = None
        self.offered_date_spoken: Optional[str] = None
        self.strikes: Dict[str, int] = {}
        self.outcome_posted: bool = False
        self.registered_address_confirmed: Optional[bool] = None
        self.new_address: Optional[str] = None
        self.alternate_phone: Optional[str] = None

        # Final disposition (Airtel campaign standardized string)
        self.final_disposition: str = "DISCONNECTED"
        self.customer_note: Optional[str] = None
        self.escalation_required: bool = False

        # Transcript tracking
        self.transcript: List[Dict[str, Any]] = []

        # Error / retry counters
        self.silence_count: int = 0
        self.date_retry_count: int = 0
        self.stt_retry_count: int = 0      # Tracks STT failures (max 2 retries per spec)
        self.is_completed: bool = False

    def add_transcript(self, role: str, message: Any):
        if isinstance(message, list):
            message = " ".join(str(m) for m in message if m)
        elif not isinstance(message, str):
            message = str(message) if message is not None else ""
        if message and message.strip():
            self.transcript.append({
                "role": role,
                "message": message.strip(),
                "timestamp": time.time(),
            })

    def add_latency(self, latency_ms: float):
        if latency_ms > 0:
            self.latency_samples.append(latency_ms)

    def get_median_latency(self) -> int:
        if not self.latency_samples:
            return 250
        sorted_samples = sorted(self.latency_samples)
        mid = len(sorted_samples) // 2
        return int(sorted_samples[mid])

    def get_duration_seconds(self) -> int:
        return max(1, int(time.time() - self.start_time))

    def get_estimated_cost_inr(self) -> float:
        duration_mins = self.get_duration_seconds() / 60.0
        return round(duration_mins * 2.4, 2)

    def transition_to(self, next_step: Step):
        self.step = next_step

    def is_terminal(self) -> bool:
        return self.step in [
            Step.CLOSE,
            Step.WRONG_PERSON,
            Step.CALLBACK_REQUESTED,
            Step.ESCALATED,
            Step.TERMINATED,
        ]
