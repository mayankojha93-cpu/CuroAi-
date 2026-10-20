import logging
from livekit.agents import function_tool

from src.state import Step, ConversationState
from src.utils.dates import resolve_relative_date
from src.tools.api import post_outcome_to_backend

logger = logging.getLogger("agent-tools")

class AgentTools:
    def __init__(self, state: ConversationState):
        self.state = state

    @function_tool
    def confirm_identity(
        self,
        is_correct: bool,
        is_wrong_person: bool = False,
        call_later: bool = False
    ) -> str:
        """
        Confirms whether the callee is the target customer.
        - is_correct: True if callee confirms their name.
        - is_wrong_person: True if callee states they are someone else or wrong number.
        - call_later: True if callee is busy or requests a callback.
        """
        logger.info(f"[Tool] confirm_identity: correct={is_correct}, wrong={is_wrong_person}, later={call_later}")

        if is_wrong_person or (not is_correct and not call_later):
            self.state.identity_confirmed = False
            self.state.final_disposition = "WRONG_NUMBER"
            self.state.customer_note = "Callee confirmed wrong number / wrong person"
            self.state.transition_to(Step.WRONG_PERSON)
            post_outcome_to_backend(self.state)
            return "माफ़ कीजिए, गलत नंबर डायल हो गया था। आपका दिन शुभ हो।"

        if call_later:
            self.state.identity_confirmed = True
            self.state.final_disposition = "SCHEDULE_CALLBACK"
            self.state.customer_note = "Customer requested callback at a later time"
            self.state.transition_to(Step.CALLBACK_REQUESTED)
            post_outcome_to_backend(self.state)
            return "जी ठीक है, हम आपसे बाद में संपर्क करेंगे। धन्यवाद।"

        self.state.identity_confirmed = True
        self.state.transition_to(Step.PICKUP_DECISION)
        return (
            "हम आपके बंद हुए एयरटेल वाई-फाई कनेक्शन के राउटर पिकअप के लिए कॉल कर रहे हैं। "
            "क्या आप राउटर पिकअप के लिए तैयार हैं?"
        )

    @function_tool
    def set_pickup(self, decision: str, date_text: str = "") -> str:
        """
        Records the customer's decision regarding router pickup.
        - decision: 'yes' (agrees), 'no' (declines), 'callback' (call later).
        - date_text: Optional preferred date if mentioned in the same turn (e.g., 'kal', 'parso').
        """
        logger.info(f"[Tool] set_pickup: decision={decision}, date_text='{date_text}'")
        decision_clean = decision.lower().strip()

        if decision_clean in ["no", "decline", "refuse", "reject"]:
            return self.record_refusal("Customer refused router pickup", "general_refusal")

        if decision_clean in ["callback", "busy", "later"]:
            self.state.final_disposition = "SCHEDULE_CALLBACK"
            self.state.transition_to(Step.CALLBACK_REQUESTED)
            post_outcome_to_backend(self.state)
            return "जी ठीक है, हम आपसे बाद में संपर्क करेंगे। धन्यवाद।"

        # Customer agreed
        self.state.pickup_accepted = True

        if date_text and date_text.strip():
            iso, spoken, err = resolve_relative_date(date_text)
            if not err and iso and spoken:
                self.state.proposed_date = iso
                self.state.confirmed_date = iso
                self.state.pickup_date_spoken = spoken
                self.state.transition_to(Step.ADDRESS_CONFIRMATION)
                return (
                    f"धन्यवाद! हमने {spoken} को पिकअप तय किया है। "
                    f"हमारे पास आपका पता दर्ज है: {self.state.address}। क्या यह पता सही है?"
                )

        self.state.transition_to(Step.DATE_RESOLUTION)
        return "राउटर पिकअप के लिए आप किस दिन उपलब्ध होंगे? जैसे कल या परसों?"

    @function_tool
    def record_willing_no_date(self) -> str:
        """
        Records that customer agrees to return router, but cannot commit to a specific date right now.
        Sets disposition to WILLING_TO_PICKUP (triggers 1 follow-up call as per policy).
        """
        logger.info("[Tool] record_willing_no_date")
        self.state.pickup_accepted = True
        self.state.final_disposition = "WILLING_TO_PICKUP"
        self.state.customer_note = "Customer willing to return router but could not finalize date"
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "कोई बात नहीं, हम पिकअप की तारीख तय करने के लिए आपसे दोबारा संपर्क करेंगे। धन्यवाद!"

    @function_tool
    def set_pickup_date(self, date_text: str) -> str:
        """
        Resolves the preferred pickup date given by the customer (e.g. 'kal', 'parso', 'agle somwar').
        """
        logger.info(f"[Tool] set_pickup_date: date_text='{date_text}'")
        iso, spoken, err = resolve_relative_date(date_text)

        if err == "past_date":
            return "यह तारीख निकल चुकी है। कृपया आने वाले किसी दिन की तारीख बताएं, जैसे कल या परसों।"

        if err or not iso or not spoken:
            self.state.date_retry_count += 1
            if self.state.date_retry_count > 2:
                iso, spoken, _ = resolve_relative_date("kal")
                self.state.proposed_date = iso
                self.state.confirmed_date = iso
                self.state.pickup_date_spoken = spoken
                self.state.transition_to(Step.ADDRESS_CONFIRMATION)
                return (
                    f"हमने कल ({spoken}) के लिए पिकअप तय किया है। "
                    f"हमारे पास आपका पता दर्ज है: {self.state.address}। क्या यह पता सही है?"
                )
            return "माफ़ कीजिए, मैं तारीख समझ नहीं पाया। क्या आप कल, परसों, या कोई खास दिन बता सकते हैं?"

        self.state.proposed_date = iso
        self.state.confirmed_date = iso
        self.state.pickup_date_spoken = spoken
        self.state.transition_to(Step.ADDRESS_CONFIRMATION)
        return (
            f"बहुत अच्छा, हमने {spoken} को पिकअप तय किया है। "
            f"हमारे पास आपका पता दर्ज है: {self.state.address}। क्या यह पता सही है?"
        )

    @function_tool
    def confirm_address(
        self,
        confirmed: bool,
        new_address: str = "",
        alternate_phone: str = ""
    ) -> str:
        """
        Confirms or records a new pickup address and optional alternate phone number.
        - confirmed: True if address on file is correct.
        - new_address: If confirmed is False, customer's new address.
        - alternate_phone: Optional alternate contact number.
        """
        logger.info(f"[Tool] confirm_address: confirmed={confirmed}, new_address='{new_address}'")
        self.state.registered_address_confirmed = confirmed
        if not confirmed and new_address:
            self.state.new_address = new_address.strip()
        if alternate_phone:
            self.state.alternate_phone = alternate_phone.strip()

        self.state.final_disposition = "CONFIRMED_FOR_PICKUP"
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)

        pickup_when = self.state.pickup_date_spoken or self.state.confirmed_date or "तय तारीख"
        return f"धन्यवाद {self.state.customer_name} जी! आपका राउटर पिकअप {pickup_when} के लिए कन्फर्म हो गया है। आपका दिन शुभ हो!"

    @function_tool
    def record_refusal(self, reason: str, objection_type: str = "general_refusal") -> str:
        """
        Records customer refusal to return router, handling ownership beliefs or refund demands.
        - objection_type: 'ownership_claim' | 'refund_request' | 'general_refusal'
        """
        logger.info(f"[Tool] record_refusal: reason='{reason}', type='{objection_type}'")
        self.state.pickup_accepted = False

        if "refund" in objection_type.lower() or "refund" in reason.lower():
            self.state.final_disposition = "REFUND_REQUEST"
        else:
            self.state.final_disposition = "REFUSED_TO_RETURN"

        self.state.customer_note = f"{objection_type}: {reason}"
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "आपकी बात नोट कर ली गई है। एयरटेल पॉलिसी के अनुसार आगे की जानकारी के लिए आप 121 पर संपर्क कर सकते हैं। धन्यवाद।"

    @function_tool
    def record_device_issue(self, issue_type: str) -> str:
        """
        Records that customer's device is damaged or lost. (No pickup required).
        - issue_type: 'damaged' or 'lost'
        """
        logger.info(f"[Tool] record_device_issue: issue_type='{issue_type}'")
        if "lost" in issue_type.lower():
            self.state.final_disposition = "LOST_DEVICE"
            self.state.customer_note = "Customer confirms device is lost / not available. No pickup required."
        else:
            self.state.final_disposition = "DAMAGED_DEVICE"
            self.state.customer_note = "Customer confirms device is completely damaged. No pickup required."

        self.state.pickup_accepted = False
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "आपकी जानकारी नोट कर ली गई है। इसके लिए कोई पिकअप की आवश्यकता नहीं है। आपका दिन शुभ हो।"

    @function_tool
    def record_recharge(self, recharge_date: str = "") -> str:
        """
        Records when customer claims they have already recharged or are willing to recharge.
        """
        logger.info(f"[Tool] record_recharge: recharge_date='{recharge_date}'")
        self.state.final_disposition = "RECHARGED_DEVICE"
        self.state.customer_note = f"Customer claims recharged on: {recharge_date or 'Recent'}"
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "बहुत अच्छा, यदि आपका कनेक्शन रीचार्ज हो चुका है तो पिकअप की आवश्यकता नहीं है। धन्यवाद!"

    @function_tool
    def record_already_returned(self) -> str:
        """
        Records when customer confirms device has already been collected/returned.
        """
        logger.info("[Tool] record_already_returned")
        self.state.final_disposition = "ALREADY_RETURNED"
        self.state.customer_note = "Customer confirmed device has already been collected/returned"
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "जानकारी के लिए धन्यवाद, हमने सिस्टम में अपडेट कर दिया है कि डिवाइस पहले ही वापस हो चुका है। आपका दिन शुभ हो!"

    @function_tool
    def record_shifted(
        self,
        device_location: str,
        new_address: str = "",
        relative_phone: str = ""
    ) -> str:
        """
        Records relocated customer scenarios:
        - device_location: 'with_customer' | 'with_relative' | 'left_at_previous'
        """
        logger.info(f"[Tool] record_shifted: location={device_location}, new_addr='{new_address}', relative='{relative_phone}'")
        loc = device_location.lower()
        if "relative" in loc:
            self.state.final_disposition = "SHIFTED_DEVICE_WITH_RELATIVE"
            self.state.alternate_phone = relative_phone
            self.state.customer_note = f"Device left with relative. Contact: {relative_phone}"
        elif "previous" in loc or "old" in loc:
            self.state.final_disposition = "SHIFTED_DEVICE_LEFT_PREVIOUS"
            self.state.customer_note = "Customer shifted and left device at previous rented accommodation."
        else:
            self.state.final_disposition = "SHIFTED_DEVICE_WITH_CUSTOMER"
            self.state.new_address = new_address
            self.state.customer_note = f"Customer shifted with device. New address: {new_address}"

        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "विवरण सुरक्षित कर लिया गया है। हमारी टीम इस जानकारी के आधार पर पिकअप का समन्वय करेगी। धन्यवाद!"

    @function_tool
    def record_language_barrier(self) -> str:
        """
        Records customer unable to converse in Hindi or English (Language Barrier).
        """
        logger.info("[Tool] record_language_barrier")
        self.state.final_disposition = "LANGUAGE_BARRIER"
        self.state.customer_note = "Language barrier detected. Customer requires regional language agent."
        self.state.transition_to(Step.TERMINATED)
        post_outcome_to_backend(self.state)
        return "Thank you. Our regional language executive will connect with you. Have a good day."

    @function_tool
    def record_do_not_call(self) -> str:
        """
        Records customer demanding DND (Do Not Call).
        """
        logger.info("[Tool] record_do_not_call")
        self.state.final_disposition = "DO_NOT_CALL"
        self.state.customer_note = "Customer requested Do Not Call / DND"
        self.state.transition_to(Step.TERMINATED)
        post_outcome_to_backend(self.state)
        return "हमने आपकी डीएनडी रिक्वेस्ट दर्ज कर ली है। आपको दोबारा कॉल नहीं किया जाएगा। धन्यवाद।"

    @function_tool
    def escalate_to_121(self, reason: str) -> str:
        """
        Escalates unresolvable complaints or requests to Airtel customer care 121.
        """
        logger.info(f"[Tool] escalate_to_121: reason='{reason}'")
        self.state.final_disposition = "COMPLAINT_ESCALATION"
        self.state.customer_note = f"Customer raised complaint/inquiry: {reason}"
        self.state.escalation_required = True
        self.state.transition_to(Step.ESCALATED)
        post_outcome_to_backend(self.state)
        return "इस संबंध में अधिक सहायता के लिए कृपया एयरटेल 121 पर कॉल करें या एयरटेल थैंक्स ऐप का उपयोग करें। धन्यवाद।"

    @function_tool
    def record_temporarily_unavailable(
        self,
        alternate_address: str = "",
        alternate_phone: str = "",
        schedule_callback: bool = True
    ) -> str:
        """
        Records Scenario 4: Customer is temporarily unavailable at the registered address.
        - If device is elsewhere: capture alternate_address and alternate_phone to arrange pickup.
        - If no feasible location: schedule callback.
        """
        logger.info(f"[Tool] record_temporarily_unavailable: addr='{alternate_address}', phone='{alternate_phone}', callback={schedule_callback}")
        if alternate_address:
            self.state.new_address = alternate_address
            self.state.alternate_phone = alternate_phone
            self.state.final_disposition = "CONFIRMED_FOR_PICKUP"
            self.state.customer_note = f"Temporarily unavailable at registered address; alternate pickup arranged at: {alternate_address}"
            self.state.transition_to(Step.CLOSE)
            post_outcome_to_backend(self.state)
            return f"धन्यवाद, हमने आपके दिए गए वैकल्पिक पते पर पिकअप नोट कर लिया है। आपका दिन शुभ हो!"
        else:
            self.state.final_disposition = "SCHEDULE_CALLBACK"
            self.state.customer_note = "Customer temporarily unavailable at registered address. No alternate location available. Callback scheduled."
            self.state.transition_to(Step.CALLBACK_REQUESTED)
            post_outcome_to_backend(self.state)
            return "जी ठीक है, हम आपकी सुविधा अनुसार बाद में आपसे दोबारा संपर्क करेंगे। धन्यवाद!"

    @function_tool
    def record_still_using_device(self) -> str:
        """
        Records Scenario 17: Customer claims they are still actively using the device/connection.
        """
        logger.info("[Tool] record_still_using_device")
        self.state.final_disposition = "ALREADY_USING_DEVICE"
        self.state.customer_note = f"Customer confirms active device usage for account: {self.state.account_no or self.state.subs_del_no}"
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "धन्यवाद, हमने सिस्टम में दर्ज कर लिया है कि आप अभी भी सेवा का उपयोग कर रहे हैं। आपके कनेक्शन की स्थिति की जांच कर ली जाएगी। आपका दिन शुभ हो!"

