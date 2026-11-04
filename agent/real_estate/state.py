import time
from enum import Enum
from typing import Optional, List, Dict, Any
from src.lang import detect_language


class RealEstateStep(str, Enum):
    INTRODUCTION = "INTRODUCTION"
    OWNER_NAME = "OWNER_NAME"
    CATEGORY_SELECT = "CATEGORY_SELECT"
    RESIDENTIAL_SALE = "RESIDENTIAL_SALE"
    RESIDENTIAL_LEASE = "RESIDENTIAL_LEASE"
    COMMERCIAL_SALE = "COMMERCIAL_SALE"
    COMMERCIAL_LEASE = "COMMERCIAL_LEASE"
    CLOSING = "CLOSING"
    NOT_INTERESTED = "NOT_INTERESTED"
    WRONG_PERSON = "WRONG_PERSON"
    CALLBACK_REQUESTED = "CALLBACK_REQUESTED"
    TERMINATED = "TERMINATED"


class RealEstateState:
    def __init__(
        self,
        call_id: str = "",
        lead_id: Optional[str] = None,
        owner_name: str = "Property Owner",
        phone: str = "",
        preferred_language: str = "hi",
        direction: str = "outbound",
    ):
        self.call_id = call_id
        self.lead_id = lead_id
        self.owner_name = owner_name
        self.phone = phone
        self.preferred_language = preferred_language
        self.direction = direction

        # Default is Hindi + English (Hinglish/Hindi) 'hi' with simran_enhi_customer; switches dynamically to English ('en') with simran_en_sales if caller speaks English
        self.reply_lang: str = preferred_language if preferred_language in ("hi", "en") else "hi"
        self.callee_connected: bool = False
        self.start_time: float = time.time()
        self.last_activity_time: float = time.time()
        self.latency_samples: List[float] = []

        # Current conversation step
        self.step: RealEstateStep = RealEstateStep.INTRODUCTION

        # High-level intent & category
        # intent: 'sale' | 'lease' | None
        self.intent: Optional[str] = None
        # category: 'residential' | 'commercial' | None
        self.category: Optional[str] = None

        # Property detail slots (matching script 4.1 - 4.4)
        self.project_or_society: Optional[str] = None
        self.sector_or_location: Optional[str] = None
        self.unit_number: Optional[str] = None
        self.floor_number: Optional[str] = None
        self.bhk_config: Optional[str] = None
        self.commercial_type: Optional[str] = None
        self.approx_area_sqft: Optional[float] = None
        self.furnishing_status: Optional[str] = None
        self.expected_sale_price: Optional[str] = None
        self.expected_monthly_rent: Optional[str] = None
        self.is_currently_leased: Optional[bool] = None
        self.current_rent_received: Optional[str] = None
        self.immediate_occupancy: Optional[bool] = None

        # Details the customer said they don't know / can't share (never re-asked)
        self.skipped_fields: set = set()

        # Call outcome & tracking
        self.owner_name_confirmed: Optional[str] = None
        self.is_interested: Optional[bool] = None
        self.final_disposition: str = "Abruptly Disconnected Call"
        self.agent_summary: Optional[str] = None
        self.closing_spoken: bool = False
        # Set by a tool when the next spoken line is already known; llm_node speaks it directly
        # (skips the 2nd LLM call). Cleared at the start of every user turn.
        self.direct_reply: Optional[str] = None
        # Caller asked "what price/rate will I get?" -> closing = valuation line + short thank-you
        self.valuation_requested: bool = False
        self.hangup_started: bool = False
        self.outcome_posted: bool = False
        self.silence_count: int = 0

        # Objections, callbacks & handoff tracking
        self.callback_time_slot: Optional[str] = None
        self.whatsapp_number: Optional[str] = None
        self.is_dnc: bool = False
        self.advisor_handoff_reason: Optional[str] = None
        self.impatient_detected: bool = False

        # Transcript tracking
        self.transcript: List[Dict[str, Any]] = []

    def add_transcript(self, role: str, text: str):
        if text and text.strip():
            self.transcript.append({"role": role, "text": text.strip(), "time": time.time()})
            if role in ("customer", "user"):
                self.callee_connected = True
                self.last_activity_time = time.time()

    def update_reply_lang(self, text: Optional[str]) -> bool:
        """Detect and follow the customer's language (Hindi vs English)."""
        lang = detect_language(text)
        if lang and lang != self.reply_lang:
            self.reply_lang = lang
            return True
        return False

    def get_missing_fields(self) -> List[Dict[str, str]]:
        """
        Return the list of missing fields for the active branch in strict script order.
        Each item includes field id, descriptive label, and canonical question in EN & HI.
        """
        # Auto-correct step if category or property type indicates commercial vs residential mismatch
        if self.commercial_type or (self.category and self.category == "commercial"):
            self.category = "commercial"
            self.bhk_config = None  # Commercial units never have BHK
            if self.step == RealEstateStep.RESIDENTIAL_SALE:
                self.step = RealEstateStep.COMMERCIAL_SALE
            elif self.step == RealEstateStep.RESIDENTIAL_LEASE:
                self.step = RealEstateStep.COMMERCIAL_LEASE
        elif self.bhk_config or (self.category and self.category == "residential"):
            self.category = "residential"
            self.commercial_type = None  # Residential properties never have commercial type
            if self.step == RealEstateStep.COMMERCIAL_SALE:
                self.step = RealEstateStep.RESIDENTIAL_SALE
            elif self.step == RealEstateStep.COMMERCIAL_LEASE:
                self.step = RealEstateStep.RESIDENTIAL_LEASE

        missing: List[Dict[str, str]] = []

        if self.step == RealEstateStep.RESIDENTIAL_SALE:
            # 4.1 In case of Sale of Residential Premises
            if not self.sector_or_location:
                missing.append({
                    "id": "location",
                    "label": "Location or sector",
                    "question_en": "Which area or sector is the property located in?",
                    "question_hi": "Sir, ye property kis location ya sector mein hai?",
                })
            if not self.project_or_society:
                missing.append({
                    "id": "society_sector",
                    "label": "Society or project name",
                    "question_en": "And which society or project is it?",
                    "question_hi": "Aur sir, society ya project ka naam kya hai?",
                })
            if not (self.unit_number and self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "Could you share the unit number and which floor it's on?",
                    "question_hi": "Sir, main ye jaan sakti hoon unit number kya hai aur kaun se floor par hai ye?",
                })
            if not self.bhk_config:
                missing.append({
                    "id": "bhk_config",
                    "label": "2, 3 BHK, or another configuration",
                    "question_en": "Is it a 2 BHK, 3 BHK, or another configuration?",
                    "question_hi": "Sir, ye 2 BHK hai, 3 BHK hai, kuch configuration bata sakte hain aap?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "And roughly how much total area in square feet would that be?",
                    "question_hi": "Aur total square feet mein sir kitna area hoga ye?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "Is the property unfurnished, semi-furnished, or fully furnished?",
                    "question_hi": "Property unfurnished, semi-furnished, ya fully furnished hai?",
                })
            if not self.expected_sale_price:
                missing.append({
                    "id": "sale_price",
                    "label": "Expected sale price",
                    "question_en": "And what kind of price or rate are you expecting for it?",
                    "question_hi": "Aur sir kya expect kar rahe hain? Kitna price aap expect kar rahe hain?",
                })

        elif self.step == RealEstateStep.RESIDENTIAL_LEASE:
            # 4.2 In case of Lease of Residential Premises
            if not self.sector_or_location:
                missing.append({
                    "id": "location",
                    "label": "Location or sector",
                    "question_en": "Which area or sector is the property located in?",
                    "question_hi": "Sir, ye property kis location ya sector mein hai?",
                })
            if not self.project_or_society:
                missing.append({
                    "id": "society_sector",
                    "label": "Society or project name",
                    "question_en": "And which society or project is it?",
                    "question_hi": "Aur sir, society ya project ka naam kya hai?",
                })
            if not (self.unit_number and self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "Could you share the unit number and which floor it's on?",
                    "question_hi": "Sir, main ye jaan sakti hoon unit number kya hai aur kaun se floor par hai ye?",
                })
            if not self.bhk_config:
                missing.append({
                    "id": "bhk_config",
                    "label": "2, 3 BHK, or another configuration",
                    "question_en": "Is it a 2 BHK, 3 BHK, or another configuration?",
                    "question_hi": "Sir, ye 2 BHK hai, 3 BHK hai, kuch configuration bata sakte hain aap?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "And roughly how much total area in square feet would that be?",
                    "question_hi": "Aur total square feet mein sir kitna area hoga ye?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "Is the property unfurnished, semi-furnished, or fully furnished?",
                    "question_hi": "Property unfurnished, semi-furnished, ya fully furnished hai?",
                })
            if not self.expected_monthly_rent:
                missing.append({
                    "id": "monthly_rent",
                    "label": "Expected monthly rent",
                    "question_en": "And what monthly rent are you expecting for it?",
                    "question_hi": "Aur sir kitna monthly rent expect kar rahe hain aap iske liye?",
                })
            if self.immediate_occupancy is None:
                missing.append({
                    "id": "immediate_occupancy",
                    "label": "Available for immediate occupancy",
                    "question_en": "Is the property available for immediate occupancy, or is there a notice period?",
                    "question_hi": "Kya yeh property immediate occupancy ke liye available hai, ya notice period hai?",
                })

        elif self.step == RealEstateStep.COMMERCIAL_SALE:
            # 4.3 In case of Sale of Commercial Premises
            if not self.sector_or_location:
                missing.append({
                    "id": "location",
                    "label": "Location or sector",
                    "question_en": "Which area or sector is the property located in?",
                    "question_hi": "Sir, ye property kis location ya sector mein hai?",
                })
            if not self.project_or_society:
                missing.append({
                    "id": "project_sector",
                    "label": "Project or building name",
                    "question_en": "And which commercial project or building is it in?",
                    "question_hi": "Aur sir, kaun se project ya building mein hai?",
                })
            if not (self.unit_number and self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "Could you share the unit number and which floor it's on?",
                    "question_hi": "Sir, main ye jaan sakti hoon unit number kya hai aur kaun se floor par hai ye?",
                })
            if not self.commercial_type:
                missing.append({
                    "id": "commercial_type",
                    "label": "Office space, retail shop, or another commercial unit",
                    "question_en": "Is it an office space, retail shop, or another commercial unit?",
                    "question_hi": "Yeh office space hai, retail shop hai, ya koi doosra commercial unit hai?",
                })
            if self.is_currently_leased is None:
                missing.append({
                    "id": "leased_status",
                    "label": "Already leased out or vacant",
                    "question_en": "And is the property currently leased out, or vacant?",
                    "question_hi": "Aur sir kya ye property pehle se leased out hai ya vacant hai?",
                })
            elif self.is_currently_leased is True and not self.current_rent_received:
                missing.append({
                    "id": "current_rent",
                    "label": "Current rent received (if leased)",
                    "question_en": "Could you share what monthly rental you are currently receiving?",
                    "question_hi": "Agar lease par hai, toh abhi lagbhag kitna monthly rent mil raha hai?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "And roughly how much total area in square feet would that be?",
                    "question_hi": "Aur total square feet mein sir kitna area hoga ye?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "Is the property bare-shell, semi-furnished, or fully furnished?",
                    "question_hi": "Property bare-shell hai, semi-furnished, ya fully furnished hai?",
                })
            if not self.expected_sale_price:
                missing.append({
                    "id": "sale_price",
                    "label": "Expected sale price",
                    "question_en": "And what kind of price are you expecting for it?",
                    "question_hi": "Aur sir kya price expect kar rahe hain aap iske liye?",
                })

        elif self.step == RealEstateStep.COMMERCIAL_LEASE:
            # 4.4 In case of Lease of Commercial Premises
            if not self.sector_or_location:
                missing.append({
                    "id": "location",
                    "label": "Location or sector",
                    "question_en": "Which area or sector is the property located in?",
                    "question_hi": "Sir, ye property kis location ya sector mein hai?",
                })
            if not self.project_or_society:
                missing.append({
                    "id": "project_sector",
                    "label": "Project or building name",
                    "question_en": "And which commercial project or building is it in?",
                    "question_hi": "Aur sir, kaun se project ya building mein hai?",
                })
            if not (self.unit_number and self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "Could you share the unit number and which floor it's on?",
                    "question_hi": "Sir, main ye jaan sakti hoon unit number kya hai aur kaun se floor par hai ye?",
                })
            if not self.commercial_type:
                missing.append({
                    "id": "commercial_type",
                    "label": "Office space, retail shop, or another commercial unit",
                    "question_en": "Is it an office space, retail shop, or another commercial unit?",
                    "question_hi": "Yeh office space hai, retail shop hai, ya koi doosra commercial unit hai?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "And roughly how much total area in square feet would that be?",
                    "question_hi": "Aur total square feet mein sir kitna area hoga ye?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "Is the property bare-shell, semi-furnished, or fully furnished?",
                    "question_hi": "Property bare-shell hai, semi-furnished, ya fully furnished hai?",
                })
            if not self.expected_monthly_rent:
                missing.append({
                    "id": "monthly_rent",
                    "label": "Expected monthly rent",
                    "question_en": "And what monthly rent are you expecting for it?",
                    "question_hi": "Aur sir kitna monthly rent expect kar rahe hain aap iske liye?",
                })
            if self.immediate_occupancy is None:
                missing.append({
                    "id": "immediate_occupancy",
                    "label": "Available for immediate occupancy",
                    "question_en": "Is the property available for immediate occupancy, or is there a notice period?",
                    "question_hi": "Kya yeh property immediate occupancy ke liye available hai, ya notice period hai?",
                })

        return [m for m in missing if m["id"] not in self.skipped_fields]

    def is_branch_complete(self) -> bool:
        """Check if all essential fields for the current branch have been collected."""
        if self.step in (
            RealEstateStep.RESIDENTIAL_SALE,
            RealEstateStep.RESIDENTIAL_LEASE,
            RealEstateStep.COMMERCIAL_SALE,
            RealEstateStep.COMMERCIAL_LEASE,
        ):
            return len(self.get_missing_fields()) == 0
        return False
        