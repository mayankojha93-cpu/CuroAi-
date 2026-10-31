import logging
import asyncio
from typing import Optional, List, Dict, Any
from livekit.agents import function_tool
from .state import RealEstateState, RealEstateStep
from .prompts import get_step_instructions

logger = logging.getLogger("real-estate-tools")


class RealEstateTools:
    def __init__(self, state: RealEstateState, post_outcome_func, hangup_func):
        self.state = state
        self.agent = None  # Bound by worker
        self.post_outcome_func = post_outcome_func
        self.hangup_func = hangup_func
        self._hangup_scheduled = False

    async def _go(self, next_step: RealEstateStep):
        """Transition step and synchronize agent instructions and available tools."""
        self.state.step = next_step
        if self.agent:
            try:
                await self.agent.update_instructions(get_step_instructions(self.state))
                await self.agent.update_tools(self.tools_for_step(next_step))
                logger.info(f"Transitioned to step: {next_step.value}")
            except Exception as e:
                logger.warning(f"Error syncing step {next_step}: {e}")

    # ── Tool Definitions ──────────────────────────────────────────

    @function_tool
    async def customer_interested(self, intent: Optional[str] = None) -> str:
        """Call when customer confirms they are interested in selling or renting their property."""
        self.state.is_interested = True
        if intent:
            low = intent.lower()
            if "rent" in low or "lease" in low:
                self.state.intent = "lease"
            elif "sell" in low or "sale" in low:
                self.state.intent = "sale"
        await self._go(RealEstateStep.OWNER_NAME)
        return "Customer confirmed interest. Ask for owner name for our records."

    @function_tool
    async def confirm_owner_name(self, name: str) -> str:
        """Confirm owner name for records."""
        cleaned = name.strip() if name else ""
        self.state.owner_name_confirmed = cleaned if cleaned else self.state.owner_name
        await self._go(RealEstateStep.CATEGORY_SELECT)
        if self.state.intent:
            return f"Recorded owner name: {self.state.owner_name_confirmed}. Now ask if the property is residential or commercial."
        return f"Recorded owner name: {self.state.owner_name_confirmed}. Now ask if the property is residential or commercial, and whether they want to sell or rent it."

    @function_tool
    async def set_category_and_intent(
        self,
        category: Optional[str] = None,
        intent: Optional[str] = None,
    ) -> str:
        """Set property category (residential/commercial) and intent (sale/lease/rent)."""
        if category:
            cat_low = "commercial" if "comm" in category.lower() else "residential"
            self.state.category = cat_low

        if intent:
            int_low = "lease" if ("rent" in intent.lower() or "lease" in intent.lower()) else "sale"
            self.state.intent = int_low

        # If both category and intent are established, transition to the respective branch 4.1 to 4.4
        if self.state.category and self.state.intent:
            cat = self.state.category
            intn = self.state.intent
            if cat == "residential" and intn == "sale":
                next_step = RealEstateStep.RESIDENTIAL_SALE
            elif cat == "residential" and intn == "lease":
                next_step = RealEstateStep.RESIDENTIAL_LEASE
            elif cat == "commercial" and intn == "sale":
                next_step = RealEstateStep.COMMERCIAL_SALE
            else:
                next_step = RealEstateStep.COMMERCIAL_LEASE

            await self._go(next_step)
            missing = self.state.get_missing_fields()
            first_q = missing[0]["question_en"] if self.state.reply_lang == "en" else missing[0]["question_hi"]
            return f"Setup complete ({cat.title()} {intn.title()}). Next question to ask: '{first_q}'"

        if not self.state.category:
            return "Intent recorded. Please ask if the property is residential or commercial."
        return "Category recorded. Please ask whether they want to sell it or rent it out."

    @function_tool
    async def save_property_details(
        self,
        project_or_society: Optional[str] = None,
        sector_or_location: Optional[str] = None,
        unit_number: Optional[str] = None,
        floor_number: Optional[str] = None,
        bhk_config: Optional[str] = None,
        commercial_type: Optional[str] = None,
        approx_area_sqft: Optional[float] = None,
        furnishing_status: Optional[str] = None,
        expected_sale_price: Optional[str] = None,
        expected_monthly_rent: Optional[str] = None,
        is_currently_leased: Optional[bool] = None,
        current_rent_received: Optional[str] = None,
        immediate_occupancy: Optional[bool] = None,
    ) -> str:
        """Save any property details mentioned by customer in the current turn."""
        if project_or_society:
            self.state.project_or_society = project_or_society.strip()
        if sector_or_location:
            self.state.sector_or_location = sector_or_location.strip()
        if unit_number:
            self.state.unit_number = str(unit_number).strip()
        if floor_number:
            self.state.floor_number = str(floor_number).strip()
        if bhk_config:
            self.state.bhk_config = bhk_config.strip()
        if commercial_type:
            self.state.commercial_type = commercial_type.strip()
        if approx_area_sqft is not None:
            try:
                self.state.approx_area_sqft = float(approx_area_sqft)
            except (ValueError, TypeError):
                pass
        if furnishing_status:
            self.state.furnishing_status = furnishing_status.strip()
        if expected_sale_price:
            self.state.expected_sale_price = str(expected_sale_price).strip()
        if expected_monthly_rent:
            self.state.expected_monthly_rent = str(expected_monthly_rent).strip()
        if is_currently_leased is not None:
            self.state.is_currently_leased = is_currently_leased
        if current_rent_received:
            self.state.current_rent_received = str(current_rent_received).strip()
        if immediate_occupancy is not None:
            self.state.immediate_occupancy = immediate_occupancy

        logger.info(
            f"Updated slots: society={self.state.project_or_society}, "
            f"unit={self.state.unit_number}, floor={self.state.floor_number}, "
            f"bhk={self.state.bhk_config}, type={self.state.commercial_type}, "
            f"area={self.state.approx_area_sqft}, furnishing={self.state.furnishing_status}, "
            f"price={self.state.expected_sale_price}, rent={self.state.expected_monthly_rent}, "
            f"leased={self.state.is_currently_leased}, imm_occ={self.state.immediate_occupancy}"
        )

        missing = self.state.get_missing_fields()
        if len(missing) == 0:
            # All details for this branch are captured!
            return await self.finish_property_intake()

        next_field = missing[0]
        q = next_field["question_en"] if self.state.reply_lang == "en" else next_field["question_hi"]
        return f"Details saved successfully. Next question to ask customer: '{q}'"

    @function_tool
    async def finish_property_intake(self) -> str:
        """Call when all property details have been collected to wrap up."""
        cat = (self.state.category or "Residential").title()
        intn = "Sale" if self.state.intent == "sale" else "Lease"
        self.state.final_disposition = f"Qualified - {cat} {intn}"

        details = [f"{cat} {intn}"]
        if self.state.project_or_society:
            loc = f", {self.state.sector_or_location}" if self.state.sector_or_location else ""
            details.append(f"{self.state.project_or_society}{loc}")
        if self.state.unit_number or self.state.floor_number:
            details.append(f"Unit {self.state.unit_number or 'N/A'}, Floor {self.state.floor_number or 'N/A'}")
        if self.state.bhk_config:
            details.append(self.state.bhk_config)
        elif self.state.commercial_type:
            details.append(self.state.commercial_type)
        if self.state.approx_area_sqft:
            details.append(f"{self.state.approx_area_sqft} sqft")
        if self.state.furnishing_status:
            details.append(self.state.furnishing_status)
        if self.state.expected_sale_price:
            details.append(f"Exp Price: {self.state.expected_sale_price}")
        elif self.state.expected_monthly_rent:
            details.append(f"Exp Rent: {self.state.expected_monthly_rent}")
        if self.state.is_currently_leased is not None:
            rent_str = f" ({self.state.current_rent_received})" if self.state.current_rent_received else ""
            details.append("Leased" + rent_str if self.state.is_currently_leased else "Vacant")
        if self.state.immediate_occupancy is not None:
            details.append("Immediate Occupancy: Yes" if self.state.immediate_occupancy else "Immediate Occupancy: No")

        self.state.agent_summary = "; ".join(details)
        await self._go(RealEstateStep.CLOSING)
        return "All details captured! Speak the official closing statement now."

    @function_tool
    async def mark_not_interested(self) -> str:
        """Call when customer is not interested in selling or renting."""
        self.state.is_interested = False
        self.state.final_disposition = "Not Interested"
        if not self.state.agent_summary:
            self.state.agent_summary = "Customer not interested in selling or renting property"
        await self._go(RealEstateStep.CLOSING)
        return "Customer not interested. Speak polite closing and thank them for their time."

    @function_tool
    async def schedule_callback(
        self,
        time_slot: Optional[str] = None,
        preferred_day: Optional[str] = None,
    ) -> str:
        """Call when customer asks to call back later or specifies a preferred day/time slot."""
        slot = f"{preferred_day or ''} {time_slot or ''}".strip() or "General"
        self.state.callback_time_slot = slot
        self.state.final_disposition = f"Schedule Callback ({slot})"
        if not self.state.agent_summary:
            self.state.agent_summary = f"Callback scheduled for: {slot}"
        await self._go(RealEstateStep.CLOSING)
        return f"Callback scheduled for {slot}. Confirm with customer and speak closing."

    @function_tool
    async def book_advisor_handoff(
        self,
        reason: str,
        preferred_time: Optional[str] = None,
    ) -> str:
        """Call when customer sounds impatient, asks for pricing/market valuation, or requests a human advisor."""
        self.state.impatient_detected = "impatient" in reason.lower()
        self.state.advisor_handoff_reason = reason.strip()
        self.state.callback_time_slot = preferred_time
        clean_reason = reason.replace(" ", "_")[:25]
        self.state.final_disposition = f"Advisor Callback Booked ({clean_reason})"
        if not self.state.agent_summary:
            self.state.agent_summary = f"Advisor handoff booked: {reason}"
        await self._go(RealEstateStep.CLOSING)
        return "Senior advisor callback booked. Acknowledge politely and speak closing."

    @function_tool
    async def request_whatsapp_info(
        self,
        phone: Optional[str] = None,
    ) -> str:
        """Call when customer asks to send property details or company information on WhatsApp."""
        self.state.whatsapp_number = (phone or self.state.phone).strip()
        self.state.final_disposition = "WhatsApp Info Requested"
        if not self.state.agent_summary:
            self.state.agent_summary = f"WhatsApp info requested on: {self.state.whatsapp_number}"
        await self._go(RealEstateStep.CLOSING)
        return f"WhatsApp info requested for {self.state.whatsapp_number}. Acknowledge and speak closing."

    @function_tool
    async def suppress_contact_dnc(
        self,
        reason: Optional[str] = None,
    ) -> str:
        """Call when customer says 'mujhe call mat karna', requests Do Not Call, or asks to remove their number."""
        self.state.is_dnc = True
        self.state.final_disposition = "Do Not Call / DNC"
        self.state.agent_summary = f"Customer added to DNC list ({reason or 'Customer requested no further calls'})"
        await self._go(RealEstateStep.CLOSING)
        return "Customer added to Do Not Call (DNC) list. Apologize sincerely and speak closing."

    @function_tool
    async def mark_wrong_number(self) -> str:
        """Call when the customer says this is the wrong number."""
        self.state.final_disposition = "Wrong Number"
        if not self.state.agent_summary:
            self.state.agent_summary = "Wrong number identified by caller"
        await self._go(RealEstateStep.CLOSING)
        return "Wrong number identified. Apologize politely and conclude."

    async def _delayed_hangup(self):
        """Wait for closing speech playout through TTS to the caller phone, then disconnect cleanly."""
        if self._hangup_scheduled:
            return
        self._hangup_scheduled = True
        logger.info("Delayed hangup scheduled: waiting 5.5s for TTS speech playout...")
        await asyncio.sleep(5.5)
        if self.hangup_func:
            await self.hangup_func()

    # ── Tool Filtering per Step ────────────────────────────────────

    def _objection_tools(self) -> List[Any]:
        return [
            self.schedule_callback,
            self.book_advisor_handoff,
            self.request_whatsapp_info,
            self.suppress_contact_dnc,
            self.mark_not_interested,
            self.mark_wrong_number,
        ]

    def tools_for_step(self, step: RealEstateStep) -> List[Any]:
        if step == RealEstateStep.INTRODUCTION:
            return [self.customer_interested] + self._objection_tools()
        elif step == RealEstateStep.OWNER_NAME:
            return [self.confirm_owner_name] + self._objection_tools()
        elif step == RealEstateStep.CATEGORY_SELECT:
            return [self.set_category_and_intent] + self._objection_tools()
        elif step in (
            RealEstateStep.RESIDENTIAL_SALE,
            RealEstateStep.RESIDENTIAL_LEASE,
            RealEstateStep.COMMERCIAL_SALE,
            RealEstateStep.COMMERCIAL_LEASE,
        ):
            return [self.save_property_details, self.finish_property_intake] + self._objection_tools()
        elif step == RealEstateStep.CLOSING:
            # No tools in closing step: prevents LLM tool hallucinations completely
            return []
        return []
