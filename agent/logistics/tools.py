import logging
from typing import Callable, Optional
from .state import LogisticsState

logger = logging.getLogger("logistics-tools")


class LogisticsTools:
    """Function tools exposed to the LLM during the Mittal Pigments driver call."""

    def __init__(self, state: LogisticsState, hangup_cb: Optional[Callable] = None, say_cb: Optional[Callable] = None):
        self.state = state
        self.hangup_cb = hangup_cb
        self.say_cb = say_cb

    async def record_call_status(
        self,
        call_status: str,
        callback_time: str = "",
    ) -> str:
        """Record call connectivity status when the driver is busy, driving, or wrong person.
        Args:
            call_status: One of 'connected', 'no_answer', 'busy_callback', 'wrong_person'.
            callback_time: When to call back if busy or unavailable.
        """
        if call_status in ("connected", "no_answer", "busy_callback", "wrong_person"):
            self.state.call_status = call_status
        if callback_time:
            self.state.callback_time = callback_time.strip()
        if call_status == "wrong_person":
            self.state.escalate_to_human = "yes"
        logger.info(f"[TOOL] record_call_status: status={self.state.call_status}, callback={self.state.callback_time}")
        return f"Recorded call_status={self.state.call_status}."

    async def record_unloading_status(
        self,
        unloaded: str,
        current_location: str = "",
        unloading_delay_reason: str = "none",
        waiting_hours: str = "",
        pod_signed_received: str = "na",
        shortage_or_damage_reported: str = "no",
        issue_details: str = "",
        money_demanded_amount: str = "",
    ) -> str:
        """Record unloading status, location, documents, delay reason, and issues.
        Args:
            unloaded: 'yes', 'no', 'on_the_way', or 'unknown'.
            current_location: Where the vehicle currently is.
            unloading_delay_reason: 'queue', 'party_closed', 'weighbridge', 'documents', 'shortage_damage', 'union_charges', 'breakdown', 'other', or 'none'.
            waiting_hours: How many hours waiting if in queue.
            pod_signed_received: 'yes', 'no', or 'na'.
            shortage_or_damage_reported: 'yes' or 'no'.
            issue_details: Any problem or shortage/damage details.
            money_demanded_amount: Amount demanded by labour/union if any.
        """
        if unloaded in ("yes", "no", "on_the_way", "unknown"):
            self.state.unloaded = unloaded
        if current_location:
            self.state.current_location = current_location.strip()
        if unloading_delay_reason:
            self.state.unloading_delay_reason = unloading_delay_reason.strip()
        if waiting_hours:
            self.state.waiting_hours = waiting_hours.strip()
        if pod_signed_received in ("yes", "no", "na"):
            self.state.pod_signed_received = pod_signed_received
        if shortage_or_damage_reported in ("yes", "no"):
            self.state.shortage_or_damage_reported = shortage_or_damage_reported
        if issue_details:
            self.state.issue_details = issue_details.strip()
        if money_demanded_amount:
            self.state.money_demanded_amount = money_demanded_amount.strip()
            self.state.escalate_to_human = "yes"
        if self.state.shortage_or_damage_reported == "yes" or unloading_delay_reason in (
            "shortage_damage", "union_charges", "breakdown", "documents"
        ):
            self.state.escalate_to_human = "yes"
        logger.info(
            f"[TOOL] record_unloading_status: unloaded={self.state.unloaded}, reason={self.state.unloading_delay_reason}"
        )
        return "Unloading status recorded."

    async def record_next_assignment(
        self,
        next_assignment_communicated: str = "yes",
        driver_accepted_next_assignment: str = "yes",
        driver_departure_eta: str = "",
    ) -> str:
        """Record whether the next trip assignment was communicated and accepted, and departure ETA.
        Args:
            next_assignment_communicated: 'yes' or 'no'.
            driver_accepted_next_assignment: 'yes', 'no', or 'needs_discussion'.
            driver_departure_eta: When the driver expects to leave for the next trip.
        """
        if next_assignment_communicated in ("yes", "no"):
            self.state.next_assignment_communicated = next_assignment_communicated
        if driver_accepted_next_assignment in ("yes", "no", "needs_discussion"):
            self.state.driver_accepted_next_assignment = driver_accepted_next_assignment
            if driver_accepted_next_assignment in ("no", "needs_discussion"):
                self.state.escalate_to_human = "yes"
        if driver_departure_eta:
            self.state.driver_departure_eta = driver_departure_eta.strip()
        logger.info(
            f"[TOOL] record_next_assignment: accepted={self.state.driver_accepted_next_assignment}, eta={self.state.driver_departure_eta}"
        )
        return "Next assignment status recorded."

    async def flag_safety_or_escalation(
        self,
        priority: str = "high",
        issue_details: str = "",
        driver_questions_for_ops: str = "",
    ) -> str:
        """Flag an emergency, breakdown, RTO/police issue, or driver question for the ops team.
        Args:
            priority: 'normal', 'high', or 'urgent'.
            issue_details: Details of breakdown, accident, RTO, or objection.
            driver_questions_for_ops: Verbatim question from driver about payment, detention, advance, etc.
        """
        if priority in ("normal", "high", "urgent"):
            # Never downgrade an already-higher priority
            rank = {"normal": 0, "high": 1, "urgent": 2}
            if rank.get(priority, 0) >= rank.get(self.state.priority, 0):
                self.state.priority = priority
        self.state.escalate_to_human = "yes"
        if issue_details:
            self.state.issue_details = (
                f"{self.state.issue_details}; {issue_details.strip()}"
                if self.state.issue_details
                else issue_details.strip()
            )
        if driver_questions_for_ops:
            self.state.driver_questions_for_ops = (
                f"{self.state.driver_questions_for_ops}; {driver_questions_for_ops.strip()}"
                if self.state.driver_questions_for_ops
                else driver_questions_for_ops.strip()
            )
        logger.warning(f"[TOOL] flag_safety_or_escalation: priority={self.state.priority}, details={self.state.issue_details}")
        return f"Escalated to ops with priority={self.state.priority}."

    async def end_logistics_call(self, closing_message: str = "") -> str:
        """End the call politely after delivering the final closing message.
        Args:
            closing_message: Final polite Hindi sentence to speak before hanging up.
        """
        self.state.closing_spoken = True
        if closing_message and self.say_cb:
            await self.say_cb(closing_message.strip())
        if self.hangup_cb:
            await self.hangup_cb()
        return "Call ending."
