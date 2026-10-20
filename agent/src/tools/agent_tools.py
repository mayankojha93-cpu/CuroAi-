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
            self.state.outcome = "wrong_person"
            self.state.transition_to(Step.WRONG_PERSON)
            post_outcome_to_backend(self.state)
            return "माफ़ कीजिए, गलत नंबर डायल हो गया था। आपका दिन शुभ हो।"

        if call_later:
            self.state.identity_confirmed = True
            self.state.outcome = "callback_requested"
            self.state.transition_to(Step.CALLBACK_REQUESTED)
            post_outcome_to_backend(self.state)
            return "जी ठीक है, हम आपसे बाद में संपर्क करेंगे। धन्यवाद।"

        self.state.identity_confirmed = True
        self.state.transition_to(Step.PICKUP_DECISION)
        return (
            "हम आपके बंद हुए वाई-फाई कनेक्शन के राउटर पिकअप के लिए कॉल कर रहे हैं। "
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
            self.state.pickup_agreed = False
            self.state.outcome = "pickup_declined"
            self.state.transition_to(Step.CLOSE)
            post_outcome_to_backend(self.state)
            return "कोई बात नहीं, हमने आपकी असहमति दर्ज कर ली है। अधिक जानकारी के लिए आप 121 पर कॉल कर सकते हैं। धन्यवाद।"

        if decision_clean in ["callback", "busy", "later"]:
            self.state.outcome = "callback_requested"
            self.state.transition_to(Step.CALLBACK_REQUESTED)
            post_outcome_to_backend(self.state)
            return "जी ठीक है, हम आपसे बाद में संपर्क करेंगे। धन्यवाद।"

        # Customer agreed
        self.state.pickup_agreed = True

        # Check if date was already given
        if date_text and date_text.strip():
            iso, spoken, err = resolve_relative_date(date_text)
            if not err and iso and spoken:
                self.state.pickup_date = iso
                self.state.pickup_date_spoken = spoken
                self.state.transition_to(Step.ADDRESS_CONFIRMATION)
                return (
                    f"धन्यवाद! हमने {spoken} को पिकअप तय किया है। "
                    f"हमारे पास आपका पता है: {self.state.address}। क्या यह पता सही है?"
                )

        self.state.transition_to(Step.DATE_RESOLUTION)
        return "राउटर पिकअप के लिए आप किस दिन उपलब्ध होंगे? जैसे कल या परसों?"

    @function_tool
    def set_pickup_date(self, date_text: str) -> str:
        """
        Resolves the preferred pickup date given by the customer (e.g. 'kal', 'parso', 'agle somwar', '25 tareekh').
        """
        logger.info(f"[Tool] set_pickup_date: date_text='{date_text}'")
        iso, spoken, err = resolve_relative_date(date_text)

        if err == "past_date":
            return "यह तारीख निकल चुकी है। कृपया आने वाले किसी दिन की तारीख बताएं, जैसे कल या परसों।"

        if err or not iso or not spoken:
            self.state.date_retry_count += 1
            if self.state.date_retry_count > 2:
                # Fallback to tomorrow if struggling
                iso, spoken, _ = resolve_relative_date("kal")
                self.state.pickup_date = iso
                self.state.pickup_date_spoken = spoken
                self.state.transition_to(Step.ADDRESS_CONFIRMATION)
                return (
                    f"हमने कल ({spoken}) के लिए पिकअप तय कर लिया है। "
                    f"हमारे पास आपका पता है: {self.state.address}। क्या यह पता सही है?"
                )
            return "माफ़ कीजिए, मैं तारीख ठीक से समझ नहीं पाया। क्या आप कल, परसों, या कोई खास दिन बता सकते हैं?"

        self.state.pickup_date = iso
        self.state.pickup_date_spoken = spoken
        self.state.transition_to(Step.ADDRESS_CONFIRMATION)
        return (
            f"बहुत अच्छा, हमने {spoken} को पिकअप तय कर लिया है। "
            f"हमारे पास आपका पता दर्ज है: {self.state.address}। क्या यह पता सही है?"
        )

    @function_tool
    def confirm_address(self, confirmed: bool, corrected_address: str = "") -> str:
        """
        Confirms or corrects the pickup address on file.
        - confirmed: True if address on file is correct, False otherwise.
        - corrected_address: If confirmed is False, the new address provided by customer.
        """
        logger.info(f"[Tool] confirm_address: confirmed={confirmed}, corrected='{corrected_address}'")
        self.state.address_confirmed = confirmed
        if not confirmed and corrected_address:
            self.state.corrected_address = corrected_address.strip()

        self.state.outcome = "pickup_scheduled"
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        pickup_when = self.state.pickup_date_spoken or "तय तारीख"
        return f"धन्यवाद {self.state.customer_name} जी! आपका राउटर पिकअप {pickup_when} के लिए शेड्यूल हो गया है। आपका दिन शुभ हो!"

    @function_tool
    def escalate(self, reason: str) -> str:
        """
        Escalates unresolvable queries, customer complaints, or out-of-scope requests to dialing 121.
        """
        logger.info(f"[Tool] escalate: reason='{reason}'")
        self.state.outcome = "escalated"
        self.state.escalation_reason = reason
        self.state.transition_to(Step.ESCALATED)
        post_outcome_to_backend(self.state)
        return "इसके लिए कृपया हमारे कस्टमर केयर नंबर 121 पर संपर्क करें। वे आपकी पूरी सहायता करेंगे। धन्यवाद।"

    @function_tool
    def save_outcome(
        self,
        outcome: str,
        pickup_date: str = "",
        address_confirmed: bool = True,
        corrected_address: str = ""
    ) -> str:
        """
        Records the final outcome of the call.
        Outcome options: 'pickup_scheduled', 'pickup_declined', 'wrong_person', 'callback_requested', 'escalated', 'no_response'.
        """
        logger.info(f"[Tool] save_outcome: outcome={outcome}, date={pickup_date}")
        self.state.outcome = outcome
        if pickup_date:
            self.state.pickup_date = pickup_date
        self.state.address_confirmed = address_confirmed
        if corrected_address:
            self.state.corrected_address = corrected_address
        self.state.transition_to(Step.CLOSE)
        post_outcome_to_backend(self.state)
        return "कॉल का परिणाम सुरक्षित कर लिया गया है। धन्यवाद।"
