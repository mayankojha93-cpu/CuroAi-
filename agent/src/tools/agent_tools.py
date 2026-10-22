import time
import asyncio
import logging
from livekit.agents import function_tool

from src.state import Step, ConversationState
from src.utils.dates import resolve_relative_date, get_next_available_pickup_date
from src.tools.api import post_outcome_to_backend

logger = logging.getLogger("agent-tools")

GENERIC_NAME_TOKENS = ("customer", "subscriber", "user", "airtel", "client", "inbound", "caller")

CLOSING_LINE = "पुष्टि के लिए धन्यवाद। किसी भी अन्य जानकारी के लिए कृपया एयरटेल 121 पर संपर्क करें।"


_YES_WORDS = {
    "yes", "y", "yeah", "yep", "true", "1", "ok", "okay", "agree", "agreed", "accept", "accepted",
    "confirm", "confirmed", "sure", "haan", "han", "ha", "haa", "ji", "theek", "theek hai",
    "हाँ", "हां", "हा", "जी", "ठीक है", "ठीक",
}


def _is_yes(v) -> bool:
    """LLMs pass 'Yes', 'true', 'haan' ... - treat all as agreement; anything else is NOT consent."""
    return _clean(v).lower() in _YES_WORDS


def _clean(v) -> str:
    """LLMs sometimes send 'null' / 'none' as strings for empty args."""
    if v is None:
        return ""
    s = str(v).strip()
    return "" if s.lower() in ("null", "none", "n/a", "nil") else s


class AgentTools:
    """
    Baseline script (client-approved):
      IDENTITY -> PICKUP_DECISION -> (DATE_RESOLUTION) -> ADDRESS_CONFIRMATION -> CLOSE

    FAQ sheet -> tool mapping:
      Damaged / Lost                     record_device_issue
      Refund request / Device is free    record_refusal   (explain once, then record + close)
      Not available for specific time    record_temporarily_unavailable
      Recharged device                   record_recharge
      Complaint / Escalation             escalate_to_121
      Shifted (customer / relative / old address)  record_shifted
      Already picked up                  record_already_picked_up
      DND                                record_do_not_call
      Wrong number                       confirm_identity(is_wrong_person=True)  (validate once, then close)
      Already using device               record_still_using_device (validate once, then close)
      Ringing / Disconnected / Voicemail backend retry logic (not handled here)

    Design rules:
      * Only the tools valid for the CURRENT step are exposed to the LLM (tools_for_step).
      * Every tool returns the exact line to speak ("Say exactly ...").
      * The outcome is posted ONCE, when the call reaches a terminal step.
      * A tool never calls another tool.
    """

    def __init__(self, state: ConversationState, timing_tracker: dict = None):
        self.state = state
        self.timing_tracker = timing_tracker if timing_tracker is not None else {}
        self.agent = None  # set in worker.py after AirtelAgent is created

    # ───────────────────────── helpers ─────────────────────────

    def _notify_tool_activity(self):
        if self.timing_tracker:
            self.timing_tracker["provider_filler_pending"] = False
            self.timing_tracker["last_activity_time"] = time.time()
            task = self.timing_tracker.get("provider_filler_task")
            if task and not task.done():
                task.cancel()

    @staticmethod
    def _say(text: str) -> str:
        return f"Say exactly this to the customer, nothing else: {text}"

    async def _post_outcome(self):
        """Post outcome. Runs in a thread (requests is blocking and would freeze live audio).
        A backend failure must never break the call; only a SUCCESSFUL post counts as posted,
        and clean_hangup posts again regardless."""
        s = self.state
        if s.outcome_posted:
            return
        try:
            ok = await asyncio.to_thread(post_outcome_to_backend, s)
        except Exception as e:  # noqa: BLE001
            logger.error(f"Failed to post outcome (will retry at hangup): {e}")
            ok = False
        if ok:
            s.outcome_posted = True
        else:
            logger.error("Outcome not saved yet; clean_hangup will retry.")

    async def _go(self, step: Step):
        """Move to next step AND swap the LLM's instructions + tools for that step."""
        self.state.transition_to(step)
        if self.agent is not None:
            try:
                await self.agent.sync_step()
            except Exception as e:  # noqa: BLE001
                logger.error(f"sync_step failed for {step.value}: {e}")

    async def _finish(self, step: Step, disposition: str, note: str, line: str) -> str:
        s = self.state
        s.final_disposition = disposition
        s.customer_note = note
        s.closing_line = line  # fallback if the LLM never speaks it (see watchdog)
        await self._post_outcome()
        await self._go(step)
        return self._say(line)

    def _strike(self, key: str) -> int:
        n = self.state.strikes.get(key, 0) + 1
        self.state.strikes[key] = n
        return n

    def _is_generic_name(self) -> bool:
        name = (self.state.customer_name or "").lower().strip()
        return not name or any(t in name for t in GENERIC_NAME_TOKENS)

    async def _accept_date(self, iso: str, spoken: str) -> str:
        s = self.state
        s.proposed_date = iso
        s.confirmed_date = iso
        s.pickup_date_spoken = spoken

        # Shifted with the device: the new address is already known, so no address question.
        if getattr(s, "shifted_with_customer", False) and s.new_address:
            return await self._finish(
                Step.CLOSE, "SHIFTED_DEVICE_WITH_CUSTOMER",
                f"Customer shifted with device. New address: {s.new_address}. Pickup date: {spoken}. "
                f"Contact: {s.alternate_phone or s.phone or 'calling number'}.",
                f"ठीक है, {spoken} के लिए आपके नए पते से पिकअप कन्फर्म हो गया है। {CLOSING_LINE}",
            )

        await self._go(Step.ADDRESS_CONFIRMATION)
        return self._say(
            f"ठीक है, {spoken} के लिए आपका पिकअप कन्फर्म हो गया है। "
            f"कृपया पुष्टि करें कि आपका रजिस्टर्ड पता '{s.address}' सही है?"
        )

    async def _date_problem(self, err: str) -> str:
        """Unparseable / past date. Capped so the call can never loop on a bad date."""
        s = self.state
        if err == "past_date":
            await self._go(Step.DATE_RESOLUTION)
            return self._say("यह तारीख बीत चुकी है। कृपया कोई आने वाली तारीख बताएं।")
        s.date_retry_count += 1
        if s.date_retry_count > 2:
            # Never invent a date. Record willingness and let the follow-up call fix the date.
            return await self._finish(
                Step.CLOSE, "WILLING_TO_PICKUP", "Willing to return but could not confirm date",
                "ठीक है, हम तारीख तय करने के लिए दोबारा कॉल करेंगे। धन्यवाद।",
            )
        await self._go(Step.DATE_RESOLUTION)
        return self._say("माफ़ कीजिए, तारीख समझ नहीं आई। कल, परसों, या कोई और दिन बताएं।")

    async def _decline_offer(self) -> str:
        """Customer said 'no' / rejected the offered date, reason not known yet."""
        if self._strike("decline_offer") == 1:
            return self._say("क्या आप किसी और दिन पिकअप करवाना चाहेंगे, या राउटर वापस नहीं करना चाहते?")
        return await self._refusal_impl("Customer declined pickup", "general_refusal")

    async def _refusal_impl(self, reason: str, objection_type: str = "general_refusal") -> str:
        s = self.state
        reason = _clean(reason) or "not given"
        s.pickup_accepted = False
        ot = (objection_type or "").lower()

        # FAQ: explain ONCE, then if they still refuse, record the reason and close. Never argue.
        if self._strike("refusal") == 1:
            return self._say(
                "राउटर एयरटेल की संपत्ति है, और सब्सक्रिप्शन चार्ज या अवधि से ओनरशिप ट्रांसफर नहीं होती। "
                "क्या मैं पिकअप शेड्यूल कर दूँ?"
            )

        if "refund" in ot or "ownership" in ot or "refund" in reason.lower():
            disp, note = "REFUND_OR_OWNERSHIP_QUERY", f"Customer continues to refuse ({ot}): {reason}"
        else:
            disp, note = "PICKUP_DECLINED", f"Customer refused: {reason}"
        return await self._finish(
            Step.CLOSE, disp, note,
            "ठीक है, मैंने आपकी बात नोट कर ली है। अधिक जानकारी के लिए कृपया 121 पर संपर्क करें। धन्यवाद।",
        )

    def tools_for_step(self, step: Step) -> list:
        t = self
        faq = [
            t.record_device_issue, t.record_refusal, t.record_temporarily_unavailable,
            t.record_recharge, t.escalate_to_121, t.record_shifted,
            t.record_already_picked_up, t.record_already_returned,
            t.record_still_using_device, t.record_do_not_call, t.record_language_barrier,
        ]
        return {
            Step.IDENTITY: [t.confirm_identity, t.record_do_not_call, t.record_language_barrier],
            Step.PICKUP_DECISION: [t.set_pickup, t.set_pickup_date, t.record_willing_no_date, t.schedule_callback] + faq,
            Step.DATE_RESOLUTION: [t.set_pickup, t.set_pickup_date, t.record_willing_no_date, t.schedule_callback] + faq,
            Step.ADDRESS_CONFIRMATION: [t.confirm_address, t.set_pickup_date, t.schedule_callback] + faq,
        }.get(step, [])  # terminal steps: NO tools

    # ───────────────────────── core flow ─────────────────────────

    @function_tool
    async def confirm_identity(
        self, is_correct: bool, is_wrong_person: bool = False, call_later: bool = False
    ) -> str:
        """Call after the customer answers 'am I speaking with X?'.
        is_correct=true if they confirm. is_wrong_person=true if they say wrong number.
        call_later=true if they are busy."""
        self._notify_tool_activity()
        logger.info(f"[Tool] confirm_identity: correct={is_correct}, wrong={is_wrong_person}, later={call_later}")
        s = self.state

        if is_wrong_person or (not is_correct and not call_later):
            # FAQ: validate whether the registered customer details are known to this person
            if self._strike("wrong_number") == 1:
                if self._is_generic_name():
                    return self._say("क्या आपके पास एयरटेल वाई-फाई का कनेक्शन है?")
                return self._say(f"क्या आप {s.customer_name} जी को जानते हैं?")
            s.identity_confirmed = False
            return await self._finish(
                Step.WRONG_PERSON, "WRONG_NUMBER_OR_IDENTITY_NOT_CONFIRMED",
                "Wrong number or identity not confirmed",
                "माफ़ कीजिए, गलत नंबर लग गया। आपका दिन शुभ हो।",
            )

        if call_later:
            s.identity_confirmed = True
            return await self._finish(
                Step.CALLBACK_REQUESTED, "SCHEDULE_CALLBACK", "Customer requested callback",
                "ठीक है, हम बाद में कॉल करेंगे। धन्यवाद।",
            )

        s.identity_confirmed = True

        # Inbound caller who is not in the campaign list: there is no suspended account / pickup to
        # arrange, so never offer a pickup date. Route to 121 instead.
        if getattr(s, "direction", "outbound") == "inbound" and not (s.account_no or s.subs_del_no):
            s.escalation_required = True
            return await self._finish(
                Step.ESCALATED, "NEEDS_AIRTEL_SUPPORT",
                "Inbound caller not found in campaign records. Routed to 121.",
                "आपका अकाउंट हमारे रिकॉर्ड में नहीं मिला। कृपया एयरटेल 121 पर या एयरटेल Thanks ऐप पर संपर्क करें। धन्यवाद।",
            )

        # Offer next available working date (skips Sundays)
        iso, spoken = get_next_available_pickup_date(skip_sundays=True)
        s.offered_date, s.offered_date_spoken = iso, spoken
        await self._go(Step.PICKUP_DECISION)
        when = s.offered_date_spoken or "कल"
        return self._say(
            "आपका एयरटेल वाई-फाई राउटर अकाउंट लंबे समय से रिचार्ज न होने के कारण सस्पेंड हो गया है। "
            f"क्या मैं {when} को आपके वाई-फाई राउटर का पिकअप शेड्यूल कर सकती हूँ?"
        )

    @function_tool
    async def set_pickup(self, decision: str, date_text: str = "") -> str:
        """Customer answered the pickup question.
        decision='yes' if they agree to the offered date.
        decision='no' if they say no / reject the offered date without giving a reason.
        (Busy / call later -> use schedule_callback. A reason like shifted, damaged, refund -> use that tool.)
        date_text: ONLY if the customer themselves named a different date. Otherwise leave empty."""
        self._notify_tool_activity()
        logger.info(f"[Tool] set_pickup: decision={decision}, date='{date_text}'")
        s = self.state
        if not _is_yes(decision):
            return await self._decline_offer()

        s.pickup_accepted = True
        date_text = _clean(date_text)
        if date_text:
            iso, spoken, err = resolve_relative_date(date_text)
            if not err and iso and spoken:
                return await self._accept_date(iso, spoken)
            return await self._date_problem(err or "unparseable_date")

        if s.offered_date:
            return await self._accept_date(s.offered_date, s.offered_date_spoken)
        await self._go(Step.DATE_RESOLUTION)
        return self._say("पिकअप के लिए कौन सा दिन ठीक रहेगा?")

    @function_tool
    async def schedule_callback(self) -> str:
        """Use ONLY when the customer explicitly says they are busy right now or asks to be called later.
        NEVER use for 'no', for rejecting a date, or for any objection."""
        self._notify_tool_activity()
        logger.info("[Tool] schedule_callback")
        return await self._finish(
            Step.CALLBACK_REQUESTED, "SCHEDULE_CALLBACK", "Customer busy; callback requested",
            "ठीक है, हम बाद में संपर्क करेंगे। धन्यवाद।",
        )

    @function_tool
    async def set_pickup_date(self, date_text: str) -> str:
        """Customer named a specific pickup date, e.g. 'parso', 'agle somwar', '25 tarikh'."""
        self._notify_tool_activity()
        logger.info(f"[Tool] set_pickup_date: '{date_text}'")
        s = self.state
        s.pickup_accepted = True
        iso, spoken, err = resolve_relative_date(_clean(date_text))
        if err or not iso or not spoken:
            return await self._date_problem(err or "unparseable_date")
        return await self._accept_date(iso, spoken)

    @function_tool
    async def record_willing_no_date(self) -> str:
        """Customer agrees to return the router but cannot commit to any date."""
        self._notify_tool_activity()
        logger.info("[Tool] record_willing_no_date")
        self.state.pickup_accepted = True
        return await self._finish(
            Step.CLOSE, "WILLING_TO_PICKUP", "Willing to return but could not confirm date",
            "ठीक है, हम तारीख तय करने के लिए दोबारा कॉल करेंगे। धन्यवाद।",
        )

    @function_tool
    async def confirm_address(
        self, confirmed: bool, new_address: str = "", alternate_phone: str = ""
    ) -> str:
        """Call ONLY after the customer answered the address question.
        confirmed=true if the registered address is right.
        confirmed=false plus new_address (full address, spoken by the customer) if changed."""
        self._notify_tool_activity()
        s = self.state
        new_address, alternate_phone = _clean(new_address), _clean(alternate_phone)
        logger.info(f"[Tool] confirm_address: confirmed={confirmed}, new='{new_address}'")

        if s.step != Step.ADDRESS_CONFIRMATION or not s.confirmed_date:
            return "Not allowed yet: pickup date is not confirmed. Continue the current step."
        if not confirmed and not new_address:
            return self._say("कृपया अपना सही पता बताइए।")

        s.registered_address_confirmed = confirmed
        if not confirmed:
            s.new_address = new_address
        if alternate_phone:
            s.alternate_phone = alternate_phone

        changed = s.offered_date and s.confirmed_date != s.offered_date
        disposition = "PICKUP_CONFIRMED_NEW_DATE" if changed else "PICKUP_CONFIRMED"
        note = "Pickup confirmed"
        if not confirmed:
            note += f". Address updated by customer: {new_address}"
        if s.alternate_phone:
            note += f". Alternate phone: {s.alternate_phone}"
        return await self._finish(Step.CLOSE, disposition, note, CLOSING_LINE)

    # ───────────────────────── FAQ scenarios ─────────────────────────

    @function_tool
    async def record_refusal(self, reason: str = "", objection_type: str = "general_refusal") -> str:
        """Customer refuses to return the router.
        objection_type: 'refund_request' | 'ownership_claim' (thinks device becomes free) | 'general_refusal'."""
        self._notify_tool_activity()
        logger.info(f"[Tool] record_refusal: reason='{reason}', type='{objection_type}'")
        return await self._refusal_impl(reason, objection_type)

    @function_tool
    async def record_device_issue(self, issue_type: str = "damaged") -> str:
        """Customer confirms the device is completely damaged ('damaged') or lost ('lost')."""
        self._notify_tool_activity()
        logger.info(f"[Tool] record_device_issue: type='{issue_type}'")
        self.state.pickup_accepted = False
        if "lost" in (issue_type or "").lower():
            disp, note = "LOST_DEVICE", "Device lost. No pickup required."
        else:
            disp, note = "DAMAGED_DEVICE", "Device completely damaged. No pickup required."
        return await self._finish(Step.CLOSE, disp, note, "समझ गई। पिकअप की ज़रूरत नहीं है। धन्यवाद!")

    @function_tool
    async def record_recharge(self, recharge_date: str = "") -> str:
        """Customer says they recharged. Ask WHEN first, then call with recharge_date."""
        self._notify_tool_activity()
        recharge_date = _clean(recharge_date)
        logger.info(f"[Tool] record_recharge: date='{recharge_date}'")
        if not recharge_date:
            return "Ask the customer when they recharged, then call this tool again with recharge_date."
        s = self.state
        return await self._finish(
            Step.CLOSE, "RECHARGED_DEVICE",
            f"Customer says recharged on: {recharge_date}. Service end/disconnection date: "
            f"{s.service_end_date or 'unknown'}. Backend to verify recharge is later than disconnection.",
            "ठीक है, जानकारी नोट कर ली है। धन्यवाद!",
        )

    @function_tool
    async def record_already_picked_up(self, pickup_details: str = "") -> str:
        """Customer says the device was ALREADY collected by Airtel. Pass who/when if they said it."""
        self._notify_tool_activity()
        pickup_details = _clean(pickup_details)
        logger.info(f"[Tool] record_already_picked_up: details='{pickup_details}'")
        # FAQ: obtain basic pickup details wherever available (ask once)
        if not pickup_details and self._strike("picked_details") == 1:
            return self._say("क्या आप बता सकते हैं कि राउटर कब और किसने लिया था?")
        self.state.pickup_accepted = False
        return await self._finish(
            Step.CLOSE, "ALREADY_PICKED_UP",
            f"Customer confirmed device already collected. {pickup_details}".strip(),
            "ठीक है, सिस्टम में अपडेट कर दिया गया है। धन्यवाद!",
        )

    @function_tool
    async def record_already_returned(self, return_details: str = "") -> str:
        """Customer says they ALREADY returned the device themselves (e.g. at a store)."""
        self._notify_tool_activity()
        logger.info("[Tool] record_already_returned")
        self.state.pickup_accepted = False
        return await self._finish(
            Step.CLOSE, "ALREADY_RETURNED",
            f"Customer confirmed device already returned. {_clean(return_details)}".strip(),
            "जानकारी के लिए धन्यवाद। सिस्टम अपडेट कर दिया है।",
        )

    @function_tool
    async def record_shifted(
        self, device_location: str = "", customer_stated_location: bool = False,
        new_address: str = "", relative_phone: str = "", occupant_contact: str = "",
        alternate_phone: str = "",
    ) -> str:
        """Customer says they have shifted house.
        device_location: 'with_customer' (needs new_address), 'with_relative' (needs relative_phone),
        'left_at_previous' (occupant_contact if known).
        customer_stated_location: true ONLY if the customer explicitly said where the router is.
        If they have not said it yet, pass false and the tool will ask them."""
        self._notify_tool_activity()
        new_address, relative_phone, occupant_contact, alternate_phone = map(
            _clean, (new_address, relative_phone, occupant_contact, alternate_phone)
        )
        logger.info(
            f"[Tool] record_shifted: loc={device_location}, stated={customer_stated_location}, "
            f"new='{new_address}', rel='{relative_phone}', occ='{occupant_contact}'"
        )
        s = self.state
        loc = _clean(device_location).lower()
        new_address = new_address or _clean(s.new_address)  # reuse if the LLM drops it on the follow-up call

        # Never guess where the router is: ask once if the customer has not said it.
        if not customer_stated_location and self._strike("shift_location") == 1:
            return self._say("क्या राउटर अभी आपके साथ है, किसी रिश्तेदार के पास है, या पुराने पते पर रह गया है?")

        # Scenario: device with a relative -> get relative's number, team validates before pickup
        if "relative" in loc:
            if not relative_phone:
                return self._say("क्या आप उन रिश्तेदार का कॉन्टैक्ट नंबर बता सकते हैं?")
            s.alternate_phone = relative_phone
            return await self._finish(
                Step.CLOSE, "SHIFTED_DEVICE_WITH_RELATIVE",
                f"Device with relative. Contact: {relative_phone}. Validate with relative before pickup.",
                "विवरण नोट कर लिया है। हमारी टीम उनसे संपर्क करके पिकअप तय करेगी। धन्यवाद।",
            )

        # Scenario: device left at previous address -> occupant contact if any; never arrange pickup blindly
        if "previous" in loc or "old" in loc or "left" in loc:
            if not occupant_contact and self._strike("occupant") == 1:
                return self._say("क्या पुराने पते पर रहने वाले किसी व्यक्ति का नंबर आपके पास है?")
            note = (f"Device left at previous address. Occupant contact: {occupant_contact}"
                    if occupant_contact
                    else "Device left at previous address. No occupant contact. No pickup without device confirmation.")
            return await self._finish(
                Step.CLOSE, "SHIFTED_DEVICE_LEFT_PREVIOUS", note,
                # With an occupant contact the team follows up; without one the case is simply closed
                # (spec: "update the appropriate disposition and close"), so don't promise a call.
                ("विवरण नोट कर लिया है। हमारी टीम उनसे संपर्क करेगी। धन्यवाद।" if occupant_contact
                 else "विवरण नोट कर लिया है। किसी भी जानकारी के लिए कृपया एयरटेल 121 पर संपर्क करें। धन्यवाद।"),
            )

        # Scenario: shifted but still has the device -> new address, then arrange pickup from there
        if not new_address:
            return self._say("कृपया अपना नया पता बताइए।")
        s.new_address = new_address
        s.pickup_accepted = True
        if alternate_phone:
            s.alternate_phone = alternate_phone

        if s.confirmed_date:  # date was already agreed earlier in this call
            return await self._finish(
                Step.CLOSE, "SHIFTED_DEVICE_WITH_CUSTOMER",
                f"Customer shifted with device. New address: {new_address}. Pickup date: {s.pickup_date_spoken}. "
                f"Contact: {s.alternate_phone or s.phone or 'calling number'}.",
                f"ठीक है, नया पता नोट कर लिया है। {CLOSING_LINE}",
            )
        s.shifted_with_customer = True
        s.final_disposition = "SHIFTED_DEVICE_WITH_CUSTOMER"
        s.customer_note = (f"Customer shifted with device. New address: {new_address}. "
                           f"Contact: {s.alternate_phone or s.phone or 'calling number'}. Pickup date pending.")
        when = s.offered_date_spoken or "कल"
        return self._say(f"ठीक है, नया पता नोट कर लिया है। क्या मैं {when} को नए पते से राउटर का पिकअप शेड्यूल कर दूँ?")

    @function_tool
    async def record_temporarily_unavailable(self, alternate_address: str = "", alternate_phone: str = "") -> str:
        """Customer is not available at the registered address right now.
        If the device is elsewhere, pass alternate_address and alternate_phone."""
        self._notify_tool_activity()
        alternate_address, alternate_phone = _clean(alternate_address), _clean(alternate_phone)
        logger.info(f"[Tool] record_temporarily_unavailable: addr='{alternate_address}', phone='{alternate_phone}'")
        s = self.state

        if alternate_address:
            # FAQ: obtain the alternate address AND contact details
            if not alternate_phone and self._strike("unavail_phone") == 1:
                return self._say("उस पते पर संपर्क के लिए कोई फ़ोन नंबर बता सकते हैं?")
            s.new_address = alternate_address
            if alternate_phone:
                s.alternate_phone = alternate_phone
            return await self._finish(
                Step.CLOSE, "CONFIRMED_FOR_PICKUP",
                f"Temporarily unavailable; alternate pickup location: {alternate_address}. "
                f"Contact: {alternate_phone or 'not provided'}. "
                f"Pickup date: {s.pickup_date_spoken or 'to be confirmed by team'}",
                "ठीक है, वैकल्पिक पते पर पिकअप नोट कर लिया है। धन्यवाद!",
            )
        if self._strike("unavailable") == 1:
            return self._say("क्या राउटर किसी और पते पर उपलब्ध है, जहाँ से पिकअप हो सके?")
        return await self._finish(
            Step.CALLBACK_REQUESTED, "SCHEDULE_CALLBACK",
            "Temporarily unavailable. No feasible pickup location. Callback scheduled.",
            "ठीक है, हम बाद में संपर्क करेंगे। धन्यवाद।",
        )

    @function_tool
    async def record_still_using_device(self) -> str:
        """Customer says they are still using the connection/device."""
        self._notify_tool_activity()
        logger.info("[Tool] record_still_using_device")
        s = self.state
        # FAQ: validate status. Our records show it as suspended -> go back to recovery once.
        if self._strike("still_using") == 1:
            return self._say("हमारे सिस्टम में यह कनेक्शन सस्पेंड दिख रहा है। क्या मैं राउटर का पिकअप शेड्यूल कर दूँ?")
        return await self._finish(
            Step.CLOSE, "ALREADY_USING_DEVICE",
            f"Customer claims active usage. Account: {s.account_no or s.subs_del_no}. Backend to validate connection status.",
            "समझ गई। हमारी टीम आपके कनेक्शन की स्थिति जाँचेगी। धन्यवाद।",
        )

    @function_tool
    async def record_language_barrier(self) -> str:
        """Customer cannot speak Hindi or English."""
        self._notify_tool_activity()
        logger.info("[Tool] record_language_barrier")
        return await self._finish(
            Step.TERMINATED, "LANGUAGE_BARRIER", "Language barrier. Regional agent required.",
            "Thank you. Our regional executive will call you. Have a good day.",
        )

    @function_tool
    async def record_do_not_call(self) -> str:
        """Customer says they are on DND or asks not to be called again."""
        self._notify_tool_activity()
        logger.info("[Tool] record_do_not_call")
        return await self._finish(
            Step.TERMINATED, "DO_NOT_CALL", "Customer on DND / requested no further calls",
            "आपकी रिक्वेस्ट दर्ज कर ली है। धन्यवाद।",
        )

    @function_tool
    async def escalate_to_121(self, reason: str = "") -> str:
        """Complaint, dispute, or any question outside the script (fees, policy, refunds).
        Never answer these yourself."""
        self._notify_tool_activity()
        logger.info(f"[Tool] escalate_to_121: reason='{reason}'")
        self.state.escalation_required = True
        return await self._finish(
            Step.ESCALATED, "NEEDS_AIRTEL_SUPPORT", f"Escalated to 121: {reason}",
            "इसके लिए कृपया एयरटेल 121 पर या एयरटेल Thanks ऐप पर संपर्क करें। धन्यवाद।",
        )