import time
from typing import Any, Dict, List, Optional


class SilenceGuard:
    """Tracks dead-air silence and triggers 8s prompts up to 2 times before hanging up."""

    def __init__(self, prompt_seconds: float = 8.0, max_prompts: int = 2):
        self.prompt_seconds = prompt_seconds
        self.max_prompts = max_prompts
        self.prompts = 0
        self.last_prompt_at = 0.0

    def tick(
        self,
        now: float,
        *,
        bot_speaking: bool,
        caller_activity_at: float,
        agent_speech_end_at: float,
        answered_at: float,
        user_speaking: bool = False,
        llm_busy_since: float = 0.0,
    ) -> Optional[str]:
        if bot_speaking or user_speaking:
            return None
        if llm_busy_since > 0.0 and (now - llm_busy_since) < 12.0:
            return None

        ref = max(caller_activity_at, agent_speech_end_at, answered_at, self.last_prompt_at)
        if ref <= 0.0:
            return None
        if caller_activity_at > self.last_prompt_at and self.last_prompt_at > 0.0:
            self.prompts = 0

        if (now - ref) < self.prompt_seconds:
            return None

        if self.prompts >= self.max_prompts:
            return "hangup"

        self.prompts += 1
        self.last_prompt_at = now
        return "prompt"


class LogisticsState:
    def __init__(
        self,
        call_id: str,
        trip_id: Optional[str],
        phone: str,
        driver_name: Optional[str],
        vehicle_number: str,
        lr_number: str,
        origin: Optional[str] = None,
        destination: Optional[str] = None,
        consignee: Optional[str] = None,
        material: Optional[str] = None,
        expected_unload_date: Optional[str] = None,
        call_round: int = 1,
        next_assignment: Optional[str] = None,
        ops_number: str = "9800011122",
    ):
        self.call_id = call_id
        self.trip_id = trip_id
        self.phone = phone
        self.driver_name = (driver_name or "").strip() or None
        self.vehicle_number = (vehicle_number or "").strip()
        self.lr_number = (lr_number or "").strip()
        self.origin = origin
        self.destination = destination
        self.consignee = consignee
        self.material = material
        self.expected_unload_date = expected_unload_date
        self.call_round = 2 if call_round == 2 else 1
        self.next_assignment = next_assignment
        self.ops_number = ops_number or "9800011122"

        # Runtime flags
        self.callee_connected: bool = False
        self.opening_speech_active: bool = False
        self.opening_speech_interrupted: bool = False
        self.answered_at: Optional[float] = None
        self.start_time: float = time.time()
        self.last_activity_time: float = time.time()
        self.last_agent_speech_end: float = 0.0
        self.user_speaking: bool = False
        self.llm_busy_since: float = 0.0
        self.closing_spoken: bool = False
        self.hangup_started: bool = False
        self.outcome_posted: bool = False
        self.recording_url: Optional[str] = None
        self.silence_count: int = 0
        self.latency_samples: List[float] = []
        self.transcript: List[Dict[str, Any]] = []

        # Backend conversation state & barge-in tracking
        self.current_step: str = "opening"
        self.pending_question: str = ""
        self.last_bot_utterance: str = ""
        self.barge_in_pending: bool = False
        self.interrupted_step: str = ""
        self.interrupted_question: str = ""
        self.last_interruption_type: str = ""
        self.last_user_utterance: str = ""
        self.barge_in_count: int = 0

        # End-of-call output fields
        self.call_status: str = "connected"
        self.callback_time: str = ""
        self.unloaded: str = "unknown"
        self.current_location: str = ""
        self.unloading_delay_reason: str = "none"
        self.waiting_hours: str = ""
        self.pod_signed_received: str = "na"
        self.shortage_or_damage_reported: str = "no"
        self.issue_details: str = ""
        self.money_demanded_amount: str = ""
        self.next_assignment_communicated: str = "no"
        self.driver_accepted_next_assignment: str = "no"
        self.driver_departure_eta: str = ""
        self.priority: str = "normal"
        self.escalate_to_human: str = "no"
        self.driver_questions_for_ops: str = ""
        self.summary_in_english: str = ""

    def to_outcome_payload(self) -> Dict[str, Any]:
        return {
            "trip_id": self.trip_id,
            "call_status": self.call_status,
            "callback_time": self.callback_time,
            "vehicle_number": self.vehicle_number,
            "lr_number": self.lr_number,
            "unloaded": self.unloaded,
            "current_location": self.current_location,
            "unloading_delay_reason": self.unloading_delay_reason,
            "waiting_hours": self.waiting_hours,
            "pod_signed_received": self.pod_signed_received,
            "shortage_or_damage_reported": self.shortage_or_damage_reported,
            "issue_details": self.issue_details,
            "money_demanded_amount": self.money_demanded_amount,
            "next_assignment_communicated": self.next_assignment_communicated,
            "driver_accepted_next_assignment": self.driver_accepted_next_assignment,
            "driver_departure_eta": self.driver_departure_eta,
            "priority": self.priority,
            "escalate_to_human": self.escalate_to_human,
            "driver_questions_for_ops": self.driver_questions_for_ops,
            "summary_in_english": self.summary_in_english,
        }

    def collected_summary(self) -> List[str]:
        """Return human-readable list of already-collected backend state fields."""
        items: List[str] = []
        if self.call_status != "connected":
            items.append(f"call_status={self.call_status}")
        if self.callback_time:
            items.append(f"callback_time={self.callback_time}")
        if self.unloaded != "unknown":
            items.append(f"unloaded={self.unloaded}")
        if self.current_location:
            items.append(f"current_location={self.current_location}")
        if self.unloading_delay_reason != "none":
            items.append(f"unloading_delay_reason={self.unloading_delay_reason}")
        if self.waiting_hours:
            items.append(f"waiting_hours={self.waiting_hours}")
        if self.pod_signed_received != "na":
            items.append(f"pod_signed_received={self.pod_signed_received}")
        if self.shortage_or_damage_reported == "yes":
            items.append("shortage_or_damage_reported=yes")
        if self.money_demanded_amount:
            items.append(f"money_demanded_amount={self.money_demanded_amount}")
        if self.issue_details:
            items.append(f"issue_details={self.issue_details}")
        if self.next_assignment_communicated == "yes":
            items.append(f"next_assignment_communicated=yes (accepted={self.driver_accepted_next_assignment})")
        if self.driver_departure_eta:
            items.append(f"driver_departure_eta={self.driver_departure_eta}")
        if self.driver_questions_for_ops:
            items.append(f"driver_questions_for_ops={self.driver_questions_for_ops}")
        return items

    def missing_fields(self) -> List[str]:
        """Return remaining fields needed based on the active branch."""
        if self.call_status in ("busy_callback", "wrong_person") or self.closing_spoken:
            return []
        if self.unloaded == "unknown":
            return ["unloaded (yes / no / on_the_way)"]
        if self.unloaded == "yes":
            missing: List[str] = []
            if not self.current_location:
                missing.append("current_location")
            if self.pod_signed_received == "na":
                missing.append("pod_signed_received")
            if self.next_assignment_communicated == "no":
                missing.append("next_assignment_communicated")
            elif self.driver_accepted_next_assignment == "yes" and not self.driver_departure_eta:
                missing.append("driver_departure_eta")
            return missing
        # Branch B: not unloaded / on_the_way
        missing = []
        if self.unloading_delay_reason == "none" and not self.issue_details and not self.current_location:
            missing.append("delay_reason_or_eta")
        return missing

    def advance_state_from_fields(self) -> None:
        """Recompute current_step deterministically from collected backend fields."""
        if self.closing_spoken or self.hangup_started:
            self.current_step = "closing"
            return
        if self.call_status in ("busy_callback", "wrong_person"):
            self.current_step = "closing"
            return
        if self.unloaded == "unknown":
            if (
                self.callee_connected
                and self.current_step == "opening"
                and not self.opening_speech_active
                and not self.barge_in_pending
            ):
                self.current_step = "unloading_status"
            return
        if self.unloaded == "yes":
            if not self.current_location:
                self.current_step = "location"
            elif self.pod_signed_received == "na":
                self.current_step = "pod_check"
            elif self.next_assignment_communicated == "no":
                self.current_step = "next_assignment"
            elif self.driver_accepted_next_assignment == "yes" and not self.driver_departure_eta:
                self.current_step = "departure_eta"
            else:
                self.current_step = "closing"
            return
        # unloaded in ("no", "on_the_way")
        if self.unloading_delay_reason == "none" and not self.issue_details and not self.current_location:
            self.current_step = "delay_reason"
        else:
            self.current_step = "closing"
