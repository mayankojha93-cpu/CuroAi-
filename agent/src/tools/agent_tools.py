import time
import logging
from livekit.agents import function_tool

from src.state import Step, ConversationState
from src.utils.dates import resolve_relative_date
from src.tools.api import post_outcome_to_backend

logger = logging.getLogger("agent-tools")


class AgentTools:
    """
    17 FAQ scenarios mapped to LLM-callable tools.

    Scenario → Tool mapping:
    1.  Damaged Device                          → record_device_issue(issue_type="damaged")
    2.  Lost Device                             → record_device_issue(issue_type="lost")
    3.  Refund Request                          → record_refusal(objection_type="refund_request")
    4.  Not Available / Temporarily Unavailable → record_temporarily_unavailable()
    5.  Recharged Device                        → record_recharge()
    6.  Complaint / Escalation                  → escalate_to_121()
    7.  Refusal – Device Becomes Free           → record_refusal(objection_type="ownership_claim")
    8.  Customer Shifted – Device With Customer → record_shifted(device_location="with_customer")
    9.  Customer Shifted – Device With Relative → record_shifted(device_location="with_relative")
    10. Customer Shifted – Left at Previous     → record_shifted(device_location="left_at_previous")
    11. Ringing / No Answer                     → handled by call_status (NO_ANSWER) — backend only
    12. Call Disconnected                       → handled by room disconnect event — backend only
    13. Voicemail / Switched Off                → handled by call_status (VOICEMAIL) — backend only
    14. Already Picked Up                       → record_already_picked_up()
    15. DND                                     → record_do_not_call()
    16. Wrong Number                            → confirm_identity(is_correct=False, is_wrong_person=True)
    17. Already Using Device                    → record_still_using_device()
    """

    def __init__(self, state: ConversationState, timing_tracker: dict = None):
        self.state = state
        self.timing_tracker = timing_tracker if timing_tracker is not None else {}

    def _notify_tool_activity(self):
        """Cancels any pending provider filler task and refreshes watchdog activity timestamp."""
        if self.timing_tracker:
            self.timing_tracker["provider_filler_pending"] = False
            self.timing_tracker["last_activity_time"] = time.time()
            task = self.timing_tracker.get("provider_filler_task")
            if task and not task.done():
                task.cancel()

    # ─────────────────────────────────────────────────────────────────────────
    # Core flow tools
    # ─────────────────────────────────────────────────────────────────────────

    @function_tool
    async def confirm_identity(
        self,
        is_correct: bool,
        is_wrong_person: bool = False,
        call_later: bool = False
    ) -> str:
        """
        Confirms whether the callee is the intended customer.
        - is_correct=True   → customer confirmed identity → move to pickup decision.
        - is_wrong_person=True → wrong number; close as WRONG_NUMBER_OR_IDENTITY_NOT_CONFIRMED.
        - call_later=True   → customer busy; schedule callback.

        Scenario 16 (Wrong Number): call with is_wrong_person=True after validating
        that the registered address/customer details are NOT known to this person.
        """
        self._notify_tool_activity()
        logger.info(f"[Tool] confirm_identity: correct={is_correct}, wrong={is_wrong_person}, later={call_later}")

        if is_wrong_person or (not is_correct and not call_later):
            self.state.identity_confirmed = False
            self.state.final_disposition = "WRONG_NUMBER_OR_IDENTITY_NOT_CONFIRMED"
            self.state.customer_note = "Wrong number or identity not confirmed"
            self.state.transition_to(Step.WRONG_PERSON)
            post_outcome_to_backend(self.state)
            return "माफ़ कीजिए, गलत नंबर लग गया। आपका दिन शुभ हो।"

        if call_later:
            self.state.identity_confirmed = True
            self.state.final_disposition = "SCHEDULE_CALLBACK"
            self.state.customer_note = "Customer requested callback"
            self.state.transition_to(Step.CALLBACK_REQUESTED)
            post_outcome_to_backend(self.state)
            return "ठीक है, हम बाद में कॉल करेंगे। धन्यवाद।"

        self.state.identity_confirmed = True
        self.state.transition_to(Step.PICKUP_DECISION)
        return (
            "आपके एयरटेल वाई-फाई का अकाउंट रिचार्ज न होने के कारण सस्पेंड हो गया है। "
            "क्या मैं कल आपके राउटर का पिकअप शेड्यूल कर सकती हूँ?"
        )

    @function_tool
    async def set_pickup(self, decision: str, date_text: str = "") -> str:
        """
        Records customer's pickup decision.
        - decision='yes'      → customer agrees to pickup.
        - decision='no'       → routes to record_refusal.
        - decision='callback' → customer is busy, schedule callback.
        - date_text           → optional preferred date if mentioned in same turn.
        """
        self._notify_tool_activity()
        logger.info(f"[Tool] set_pickup: decision={decision}, date='{date_text}'")
        decision_clean = decision.lower().strip()

        if decision_clean in ["no", "decline", "refuse", "reject"]:
            return await self.record_refusal("Customer refused router pickup")

        if decision_clean in ["callback", "busy", "later"]:
            self.state.final_disposition = "SCHEDULE_CALLBACK"
            self.state.transition_to(Step.CALLBACK_REQUESTED)
            post_outcome_to_backend(self.state)
            return "ठीक है, हम बाद में संपर्क करेंगे। धन्यवाद।"

        self.state.pickup_accepted = True

        if date_text and date_text.strip():
            iso, spoken, err = resolve_relative_date(date_text)
            if not err and iso and spoken:
                self.state.proposed_date = iso
                self.state.confirmed_date = iso
                self.state.pickup_date_spoken = spoken
                self.state.transition_to(Step.ADDRESS_CONFIRMATION)
                return (
                    f"{spoken} को पिकअप तय हुआ। "
                    f"क्या आपका पता '{self.state.address}' सही है?"
                )

        self.state.transition_to(Step.DATE_RESOLUTION)
        return "पिकअप के लिए कौन सा दिन ठीक रहेगा — कल या परसों?"

    @function_tool
    async def record_willing_no_date(self) -> str:
        """
        Customer agrees to return but cannot commit to a date.
        Sets WILLING_TO_PICKUP — triggers exactly one follow-up call per spec.
        """
        self._notify_tool_activity()
        logger.info("[Tool] record_willing_no_date")
        self.state.pickup_accepted = True
        self.state.final_disposition = "WILLING_TO_PICKUP"
        self.state.customer_note = "Willing to return but could not confirm date"
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "ठीक है, हम तारीख तय करने के लिए दोबारा कॉल करेंगे। धन्यवाद!"

    @function_tool
    async def set_pickup_date(self, date_text: str) -> str:
        """
        Resolves the preferred pickup date from the customer's utterance.
        Examples: 'kal', 'parso', 'agle somwar', '22 tarikh'.
        """
        self._notify_tool_activity()
        logger.info(f"[Tool] set_pickup_date: '{date_text}'")
        iso, spoken, err = resolve_relative_date(date_text)

        if err == "past_date":
            return "यह तारीख बीत चुकी है। कोई आने वाली तारीख बताएं।"

        if err or not iso or not spoken:
            self.state.date_retry_count += 1
            if self.state.date_retry_count > 2:
                iso, spoken, _ = resolve_relative_date("kal")
                self.state.proposed_date = iso
                self.state.confirmed_date = iso
                self.state.pickup_date_spoken = spoken
                self.state.transition_to(Step.ADDRESS_CONFIRMATION)
                return (
                    f"कल ({spoken}) के लिए पिकअप तय किया। "
                    f"क्या आपका पता '{self.state.address}' सही है?"
                )
            return "माफ़ कीजिए, तारीख समझ नहीं आई। कल, परसों, या कोई दिन बताएं।"

        self.state.proposed_date = iso
        self.state.confirmed_date = iso
        self.state.pickup_date_spoken = spoken
        self.state.transition_to(Step.ADDRESS_CONFIRMATION)
        return (
            f"{spoken} को पिकअप तय हुआ। "
            f"क्या आपका पता '{self.state.address}' सही है?"
        )

    @function_tool
    async def confirm_address(
        self,
        confirmed: bool,
        new_address: str = "",
        alternate_phone: str = ""
    ) -> str:
        """
        Confirms or updates the pickup address.
        - confirmed=True    → address on file is correct.
        - confirmed=False   → capture new_address from customer.
        - alternate_phone   → optional alternate contact number.
        """
        self._notify_tool_activity()
        logger.info(f"[Tool] confirm_address: confirmed={confirmed}, new='{new_address}'")
        self.state.registered_address_confirmed = confirmed
        if not confirmed and new_address:
            self.state.new_address = new_address.strip()
        if alternate_phone:
            self.state.alternate_phone = alternate_phone.strip()

        if self.state.date_retry_count > 0 or (
            self.state.pickup_date_spoken and "कल" not in self.state.pickup_date_spoken
        ):
            self.state.final_disposition = "PICKUP_CONFIRMED_NEW_DATE"
        else:
            self.state.final_disposition = "PICKUP_CONFIRMED"

        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "पुष्टि के लिए शुक्रिया। किसी और जानकारी के लिए 121 पर संपर्क करें। शुभ दिन!"

    # ─────────────────────────────────────────────────────────────────────────
    # FAQ scenario tools (all 17 covered)
    # ─────────────────────────────────────────────────────────────────────────

    @function_tool
    async def record_refusal(self, reason: str, objection_type: str = "general_refusal") -> str:
        """
        Scenario 3 — Refund Request: customer refuses to return and asks for refund.
        Scenario 7 — Refusal: customer believes device becomes free after 3-4 months.
        - objection_type: 'refund_request' | 'ownership_claim' | 'general_refusal'
        Do NOT argue repeatedly. State once, record, and close.
        """
        logger.info(f"[Tool] record_refusal: reason='{reason}', type='{objection_type}'")
        self.state.pickup_accepted = False

        if "refund" in objection_type.lower() or "refund" in reason.lower():
            self.state.final_disposition = "REFUND_OR_OWNERSHIP_QUERY"
            self.state.customer_note = f"Refund demand: {reason}"
        elif "ownership" in objection_type.lower() or "free" in reason.lower():
            self.state.final_disposition = "REFUND_OR_OWNERSHIP_QUERY"
            self.state.customer_note = f"Ownership claim / device free belief: {reason}"
        else:
            self.state.final_disposition = "PICKUP_DECLINED"
            self.state.customer_note = f"Customer refused: {reason}"

        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return (
            "राउटर एयरटेल की संपत्ति है, सब्सक्रिप्शन फीस से ओनरशिप नहीं मिलती। "
            "अधिक जानकारी के लिए 121 पर कॉल करें। धन्यवाद।"
        )

    @function_tool
    async def record_device_issue(self, issue_type: str) -> str:
        """
        Scenario 1 — Damaged Device: device is completely damaged — no pickup needed.
        Scenario 2 — Lost Device: device is lost/not available — no pickup needed.
        - issue_type: 'damaged' or 'lost'
        """
        logger.info(f"[Tool] record_device_issue: type='{issue_type}'")
        self.state.pickup_accepted = False
        if "lost" in issue_type.lower():
            self.state.final_disposition = "LOST_DEVICE"
            self.state.customer_note = "Device lost. No pickup required."
        else:
            self.state.final_disposition = "DAMAGED_DEVICE"
            self.state.customer_note = "Device completely damaged. No pickup required."

        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "समझ गई। पिकअप की ज़रूरत नहीं है। शुभ दिन!"

    @function_tool
    async def record_recharge(self, recharge_date: str = "") -> str:
        """
        Scenario 5 — Recharged Device: customer says they have recharged the device.
        Capture when they recharged; if recharge date is later than disconnection date,
        update as 'Recharged Device' and close.
        """
        logger.info(f"[Tool] record_recharge: date='{recharge_date}'")
        self.state.final_disposition = "RECHARGED_DEVICE"
        self.state.customer_note = f"Customer recharged on: {recharge_date or 'recently'}"
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "बहुत अच्छा। रिचार्ज के बाद पिकअप की ज़रूरत नहीं। धन्यवाद!"

    @function_tool
    async def record_already_picked_up(self) -> str:
        """
        Scenario 14 — Already Picked Up: customer confirms device has already been collected.
        Update as 'Already Picked Up' and close. Do NOT initiate another pickup.
        """
        logger.info("[Tool] record_already_picked_up")
        self.state.final_disposition = "ALREADY_PICKED_UP"
        self.state.customer_note = "Customer confirmed device already collected"
        self.state.pickup_accepted = False
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "ठीक है, सिस्टम में अपडेट कर दिया गया। शुभ दिन!"

    @function_tool
    async def record_already_returned(self) -> str:
        """
        Customer confirmed device has already been returned/collected (alternate phrasing).
        Uses ALREADY_RETURNED disposition.
        """
        logger.info("[Tool] record_already_returned")
        self.state.final_disposition = "ALREADY_RETURNED"
        self.state.customer_note = "Customer confirmed device already returned"
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "जानकारी के लिए धन्यवाद। सिस्टम अपडेट कर दिया। शुभ दिन!"

    @function_tool
    async def record_shifted(
        self,
        device_location: str,
        new_address: str = "",
        relative_phone: str = "",
        occupant_contact: str = ""
    ) -> str:
        """
        Scenario 8 — Shifted, Device With Customer: get new address, arrange pickup there.
        Scenario 9 — Shifted, Device With Relative: get relative's number, confirm availability.
        Scenario 10 — Shifted, Device Left at Previous Address: get current occupant contact
                       if available; if not, record and close.
        - device_location: 'with_customer' | 'with_relative' | 'left_at_previous'
        - new_address: customer's new address (scenario 8)
        - relative_phone: relative's contact number (scenario 9)
        - occupant_contact: current occupant at previous address (scenario 10)
        """
        logger.info(
            f"[Tool] record_shifted: loc={device_location}, "
            f"new='{new_address}', rel='{relative_phone}', occupant='{occupant_contact}'"
        )
        loc = device_location.lower()

        if "relative" in loc:
            # Scenario 9: validate with relative before updating pickup
            self.state.final_disposition = "SHIFTED_DEVICE_WITH_RELATIVE"
            self.state.alternate_phone = relative_phone
            self.state.customer_note = (
                f"Device with relative. Contact: {relative_phone or 'not provided'}"
            )
        elif "previous" in loc or "old" in loc:
            # Scenario 10: try to get current occupant contact
            if occupant_contact:
                self.state.final_disposition = "SHIFTED_DEVICE_LEFT_PREVIOUS"
                self.state.customer_note = (
                    f"Device left at previous address. "
                    f"Current occupant contact: {occupant_contact}"
                )
            else:
                self.state.final_disposition = "SHIFTED_DEVICE_LEFT_PREVIOUS"
                self.state.customer_note = (
                    "Device left at previous rented address. "
                    "No occupant contact available."
                )
        else:
            # Scenario 8: get new address, arrange pickup
            self.state.final_disposition = "SHIFTED_DEVICE_WITH_CUSTOMER"
            self.state.new_address = new_address
            self.state.customer_note = f"Customer shifted with device. New address: {new_address}"

        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "विवरण नोट कर लिया। हमारी टीम संपर्क करेगी। धन्यवाद!"

    @function_tool
    async def record_temporarily_unavailable(
        self,
        alternate_address: str = "",
        alternate_phone: str = "",
        schedule_callback: bool = True
    ) -> str:
        """
        Scenario 4 — Not Available for Specific Time:
        Customer is temporarily unavailable at registered address.
        - If device is available elsewhere: capture alternate_address + alternate_phone.
        - If no feasible pickup location: schedule callback.
        """
        logger.info(
            f"[Tool] record_temporarily_unavailable: "
            f"addr='{alternate_address}', phone='{alternate_phone}'"
        )
        if alternate_address:
            self.state.new_address = alternate_address
            self.state.alternate_phone = alternate_phone
            self.state.final_disposition = "CONFIRMED_FOR_PICKUP"
            self.state.customer_note = (
                f"Temporarily unavailable; alternate pickup: {alternate_address}"
            )
            self.state.transition_to(Step.CLOSE)
            post_outcome_to_backend(self.state)
            return "ठीक है, वैकल्पिक पते पर पिकअप नोट कर लिया। धन्यवाद!"
        else:
            self.state.final_disposition = "SCHEDULE_CALLBACK"
            self.state.customer_note = (
                "Temporarily unavailable. No alternate location. Callback scheduled."
            )
            self.state.transition_to(Step.CALLBACK_REQUESTED)
            post_outcome_to_backend(self.state)
            return "ठीक है, हम बाद में संपर्क करेंगे। धन्यवाद!"

    @function_tool
    async def record_still_using_device(self) -> str:
        """
        Scenario 17 — Already Using Device:
        Customer says they are still using the device/connection.
        Validate the connection/service ID and disconnection status.
        If connection is active → update disposition and close.
        If disconnected → proceed with recovery on the applicable scenario.
        """
        logger.info("[Tool] record_still_using_device")
        self.state.final_disposition = "ALREADY_USING_DEVICE"
        self.state.customer_note = (
            f"Customer claims active usage. Account: {self.state.account_no or self.state.subs_del_no}. "
            "Backend to validate connection/disconnection status."
        )
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "समझ गई। हमारी टीम आपके कनेक्शन की स्थिति जाँचेगी। शुभ दिन!"

    @function_tool
    async def record_language_barrier(self) -> str:
        """
        Customer cannot converse in Hindi or English.
        Route to regional language executive.
        """
        logger.info("[Tool] record_language_barrier")
        self.state.final_disposition = "LANGUAGE_BARRIER"
        self.state.customer_note = "Language barrier. Regional agent required."
        self.state.transition_to(Step.TERMINATED)
        post_outcome_to_backend(self.state)
        return "Thank you. Our regional executive will call you. Have a good day."

    @function_tool
    async def record_do_not_call(self) -> str:
        """
        Scenario 15 — DND: customer is on DND list or demands no further calls.
        Follow the approved DND process. Do NOT independently override DND controls.
        """
        logger.info("[Tool] record_do_not_call")
        self.state.final_disposition = "DO_NOT_CALL"
        self.state.customer_note = "Customer on DND / requested no further calls"
        self.state.transition_to(Step.TERMINATED)
        post_outcome_to_backend(self.state)
        return "आपकी डीएनडी रिक्वेस्ट दर्ज कर ली है। दोबारा कॉल नहीं होगी। धन्यवाद।"

    @function_tool
    async def escalate_to_121(self, reason: str) -> str:
        """
        Scenario 6 — Complaint / Escalation:
        Direct customer to Airtel Customer Service (121 / Airtel Thanks App).
        Use for any dispute, policy question, or query outside approved script.
        Never invent policies, fees, or refund answers — always route to 121.
        """
        logger.info(f"[Tool] escalate_to_121: reason='{reason}'")
        self.state.final_disposition = "NEEDS_AIRTEL_SUPPORT"
        self.state.customer_note = f"Escalated to 121: {reason}"
        self.state.escalation_required = True
        self.state.transition_to(Step.ESCALATED)
        post_outcome_to_backend(self.state)
        return "इसके लिए कृपया एयरटेल 121 पर या एयरटेल Thanks ऐप पर संपर्क करें। धन्यवाद।"
