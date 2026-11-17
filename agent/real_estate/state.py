import time
from enum import Enum
from typing import Optional, List, Dict, Any
from src.lang import detect_language


class RealEstateStep(str, Enum):
    INTRODUCTION = "INTRODUCTION"
    CHECK_OTHER_PROPERTY = "CHECK_OTHER_PROPERTY"
    ASK_NEW_LOCATION = "ASK_NEW_LOCATION"
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
        preferred_language: str = "en",
        direction: str = "outbound",
        property_location: str = "",
        category: Optional[str] = None,
    ):
        self.call_id = call_id
        self.lead_id = lead_id
        self.owner_name = owner_name
        self.phone = phone
        self.preferred_language = preferred_language
        self.direction = direction

        # Property location received from frontend / metadata
        loc = (property_location or "").strip()
        if not loc or loc.lower() in ("delhi, 110011, burari, sant nagar", "none", "null", "undefined"):
            loc = None
        self.initial_property_location: Optional[str] = loc
        self.sector_or_location: Optional[str] = loc
        self.project_or_society: Optional[str] = loc

        # Genuine owner name if known; do NOT fake a default name
        clean_name = (owner_name or "").strip()
        if not clean_name or clean_name.lower() in ("property owner", "test subscriber", "test customer", "none", "null", "undefined", "customer"):
            clean_name = None
        self.owner_name: Optional[str] = clean_name
        self.owner_name_confirmed: Optional[str] = clean_name

        self.has_other_property: Optional[bool] = None

        # Selected language flow: English ('en') default, or Hinglish ('hi')
        clean_pref = "hi" if str(preferred_language or "").strip().lower() in ("hi", "hindi", "hi-in", "hinglish") else "en"
        self.initial_language: str = clean_pref
        self.reply_lang: str = clean_pref
        self.language_switched: bool = False
        self.callee_connected: bool = False
        self.answered_at: Optional[float] = None
        self.start_time: float = time.time()
        self.last_activity_time: float = time.time()
        self.latency_samples: List[float] = []

        # Current conversation step
        self.step: RealEstateStep = RealEstateStep.INTRODUCTION

        # High-level intent & category
        # intent: 'sale' | 'lease' | None
        self.intent: Optional[str] = None
        # Property detail slots (matching script 4.1 - 4.4)
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

        # category: 'residential' | 'commercial' | None (strictly from file or explicit caller confirmation)
        cat_clean = str(category).lower().strip() if category else None
        if cat_clean and cat_clean not in ("none", "null", "undefined", ""):
            if any(k in cat_clean for k in ("comm", "office", "shop", "retail", "showroom", "warehouse", "godown")):
                self.category = "commercial"
                for ct in ("office space", "office", "retail shop", "shop", "showroom", "warehouse", "godown"):
                    if ct in cat_clean:
                        self.commercial_type = ct.title()
                        break
            elif any(k in cat_clean for k in ("res", "flat", "apartment", "house", "villa", "plot", "kothi", "bhk", "studio")):
                self.category = "residential"
            else:
                self.category = cat_clean
        else:
            self.category = None

        # Details the customer said they don't know / can't share (never re-asked)
        self.skipped_fields: set = set()

        # Caller said the property is standalone / independent (own house, own building):
        # there is no separate unit number or floor to ask for, so 'unit_floor' is skipped.
        self.is_standalone: bool = False

        # Call outcome & tracking
        self.is_interested: Optional[bool] = None
        self.final_disposition: str = "Abruptly Disconnected Call"
        self.agent_summary: Optional[str] = None
        self.closing_spoken: bool = False
        # Set by a tool when the next spoken line is already known; llm_node speaks it directly
        # (skips the 2nd LLM call). Cleared at the start of every user turn.
        self.direct_reply: Optional[str] = None
        # Caller asked "what price/rate will I get?" -> closing = valuation line + short thank-you
        self.valuation_requested: bool = False
        # Raw text of the customer's latest turn (used by tools to reject hallucinated args)
        self.last_user_text: str = ""
        # The last question Priya actually spoke (for "repeat that" at any step)
        self.last_agent_question: str = ""
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

        # Pre-synthesised audio frames for fixed lines, keyed by the exact text (see worker.py / tools.say_cached)
        self.audio_cache: Dict[str, list] = {}

    def add_transcript(self, role: str, text: str):
        if text and text.strip():
            self.transcript.append({"role": role, "text": text.strip(), "time": time.time()})
            if role in ("customer", "user"):
                self.callee_connected = True
                self.last_activity_time = time.time()

    def update_reply_lang(self, text: Optional[str]) -> bool:
        """Detect and follow the customer's language (Hinglish vs English).
        Can switch only once:
        - If initial is English ('en') and customer speaks Hinglish ('hi'), switch to Hinglish once.
        - If initial is Hinglish ('hi') and customer speaks English ('en'), switch to English once.
        - Once switched, no further language switching is allowed.
        """
        if self.language_switched:
            return False

        lang = detect_language(text)
        if lang and lang != self.reply_lang:
            self.reply_lang = lang
            self.language_switched = True
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
        has_known_loc = bool(
            (self.initial_property_location and self.initial_property_location.strip())
            or (self.sector_or_location and self.sector_or_location.strip())
            or (self.project_or_society and self.project_or_society.strip())
        )

        if self.step == RealEstateStep.RESIDENTIAL_SALE:
            # 4.1 In case of Sale of Residential Premises
            if not has_known_loc:
                if not self.sector_or_location:
                    missing.append({
                        "id": "location",
                        "label": "Location or sector",
                        "question_en": "Which area or sector is the property located in?",
                        "question_hi": "Ye property kis area ya sector mein hai Sir?",
                    })
                if not self.project_or_society:
                    missing.append({
                        "id": "society_sector",
                        "label": "Society or project name",
                        "question_en": "And which society or project name is it?",
                        "question_hi": "Aur society ya project ka naam kya hai Sir?",
                    })
            if not (self.unit_number and self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "Could you share the unit number, and which floor it's on?",
                    "question_hi": "Unit number kya rahega Sir, aur kaun se floor par hai?",
                })
            if not self.bhk_config:
                missing.append({
                    "id": "bhk_config",
                    "label": "2, 3 BHK, or another configuration",
                    "question_en": "And is it a 2 BHK, 3 BHK, or another configuration?",
                    "question_hi": "Aur ye 2 BHK hai, 3 BHK... ya koi aur configuration?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "And roughly how much super area would that be, in square feet?",
                    "question_hi": "Aur lagbhag kitna area hoga Sir... square feet mein?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "And what about the furnishing... is it semi-furnished, or fully furnished?",
                    "question_hi": "Waise furnishing kaisi hai Sir... semi-furnished hai, ya fully furnished?",
                })
            if not self.expected_sale_price:
                missing.append({
                    "id": "sale_price",
                    "label": "Expected sale price",
                    "question_en": "Right, and what kind of price are you expecting for it?",
                    "question_hi": "Aur price ke baare mein Sir... kitna expect kar rahe hain aap?",
                })

        elif self.step == RealEstateStep.RESIDENTIAL_LEASE:
            # 4.2 In case of Lease of Residential Premises
            if not has_known_loc:
                if not self.sector_or_location:
                    missing.append({
                        "id": "location",
                        "label": "Location or sector",
                        "question_en": "Which area or sector is the property located in?",
                        "question_hi": "Ye property kis area ya sector mein hai Sir?",
                    })
                if not self.project_or_society:
                    missing.append({
                        "id": "society_sector",
                        "label": "Society or project name",
                        "question_en": "And which society or project name is it?",
                        "question_hi": "Aur society ya project ka naam kya hai Sir?",
                    })
            if not (self.unit_number and self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "Could you share the unit number, and which floor it's on?",
                    "question_hi": "Unit number kya rahega Sir, aur kaun se floor par hai?",
                })
            if not self.bhk_config:
                missing.append({
                    "id": "bhk_config",
                    "label": "2, 3 BHK, or another configuration",
                    "question_en": "And is it a 2 BHK, 3 BHK, or another configuration?",
                    "question_hi": "Aur ye 2 BHK hai, 3 BHK... ya koi aur configuration?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "And roughly how much super area would that be, in square feet?",
                    "question_hi": "Aur lagbhag kitna area hoga Sir... square feet mein?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "And what about the furnishing... is it semi-furnished, or fully furnished?",
                    "question_hi": "Waise furnishing kaisi hai Sir... semi-furnished hai, ya fully furnished?",
                })
            if not self.expected_monthly_rent:
                missing.append({
                    "id": "monthly_rent",
                    "label": "Expected monthly rent",
                    "question_en": "Right, and what monthly rent are you expecting for it?",
                    "question_hi": "Aur monthly rent kitna expect kar rahe hain aap?",
                })
            if self.immediate_occupancy is None:
                missing.append({
                    "id": "immediate_occupancy",
                    "label": "Available for immediate occupancy",
                    "question_en": "And is it available right away, or is there a notice period?",
                    "question_hi": "Aur property turant available hai Sir, ya koi notice period rahega?",
                })

        elif self.step == RealEstateStep.COMMERCIAL_SALE:
            # 4.3 In case of Sale of Commercial Premises
            if not has_known_loc:
                if not self.sector_or_location:
                    missing.append({
                        "id": "location",
                        "label": "Location or sector",
                        "question_en": "Which area or sector is the property located in?",
                        "question_hi": "Ye property kis area ya sector mein hai Sir?",
                    })
                if not self.project_or_society:
                    missing.append({
                        "id": "project_sector",
                        "label": "Project or building name",
                        "question_en": "And which commercial project or building name is it in?",
                        "question_hi": "Aur kaun se project ya building mein hai Sir?",
                    })
            # Asked right after the category, BEFORE unit/floor (never skipped, never assumed)
            if not self.commercial_type:
                missing.append({
                    "id": "commercial_type",
                    "label": "Office space, retail shop, or another commercial unit",
                    "question_en": "Is it an office space, retail shop, or another commercial unit?",
                    "question_hi": "Ye office space hai Sir, retail shop, ya koi aur commercial unit?",
                })
            if not (self.unit_number and self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "Could you share the unit number, and which floor it's on?",
                    "question_hi": "Unit number kya rahega Sir, aur kaun se floor par hai?",
                })
            if self.is_currently_leased is None:
                missing.append({
                    "id": "leased_status",
                    "label": "Already leased out or vacant",
                    "question_en": "And is the property currently leased out, or is it vacant?",
                    "question_hi": "Aur abhi property rented out hai Sir, ya vacant hai?",
                })
            elif self.is_currently_leased is True and not self.current_rent_received:
                missing.append({
                    "id": "current_rent",
                    "label": "Current rent received (if leased)",
                    "question_en": "And how much monthly rent is it generating currently?",
                    "question_hi": "Aur abhi isse lagbhag kitna monthly rent aa raha hai?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "And roughly how much super area would that be, in square feet?",
                    "question_hi": "Aur lagbhag kitna area hoga Sir... square feet mein?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "Is the property bare-shell, semi-fitted, or fully furnished?",
                    "question_hi": "Ye bare-shell hai Sir, semi-fitted, ya fully furnished?",
                })
            if not self.expected_sale_price:
                missing.append({
                    "id": "sale_price",
                    "label": "Expected sale price",
                    "question_en": "Right, and what price are you expecting for this commercial unit?",
                    "question_hi": "Aur price ke baare mein Sir... kitna expect kar rahe hain aap?",
                })

        elif self.step == RealEstateStep.COMMERCIAL_LEASE:
            # 4.4 In case of Lease of Commercial Premises
            if not has_known_loc:
                if not self.sector_or_location:
                    missing.append({
                        "id": "location",
                        "label": "Location or sector",
                        "question_en": "Which area or sector is the property located in?",
                        "question_hi": "Ye property kis area ya sector mein hai Sir?",
                    })
                if not self.project_or_society:
                    missing.append({
                        "id": "project_sector",
                        "label": "Project or building name",
                        "question_en": "And which commercial project or building name is it in?",
                        "question_hi": "Aur kaun se project ya building mein hai Sir?",
                    })
            # Asked right after the category, BEFORE unit/floor (never skipped, never assumed)
            if not self.commercial_type:
                missing.append({
                    "id": "commercial_type",
                    "label": "Office space, retail shop, or another commercial unit",
                    "question_en": "Is it an office space, retail shop, or another commercial unit?",
                    "question_hi": "Ye office space hai Sir, retail shop, ya koi aur commercial unit?",
                })
            if not (self.unit_number and self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "Could you share the unit number, and which floor it's on?",
                    "question_hi": "Unit number kya rahega Sir, aur kaun se floor par hai?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "And roughly how much super area would that be, in square feet?",
                    "question_hi": "Aur lagbhag kitna area hoga Sir... square feet mein?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "Is the property bare-shell, semi-fitted, or fully furnished?",
                    "question_hi": "Ye bare-shell hai Sir, semi-fitted, ya fully furnished?",
                })
            if not self.expected_monthly_rent:
                missing.append({
                    "id": "monthly_rent",
                    "label": "Expected monthly rent",
                    "question_en": "Right, and what monthly rent are you expecting for it?",
                    "question_hi": "Aur monthly rent kitna expect kar rahe hain aap?",
                })
            if self.immediate_occupancy is None:
                missing.append({
                    "id": "immediate_occupancy",
                    "label": "Available for immediate occupancy",
                    "question_en": "And is it available for immediate occupancy, or is there a notice period?",
                    "question_hi": "Aur ye turant available hai Sir, ya koi notice period rahega?",
                })

        return [
            m for m in missing
            if m["id"] not in self.skipped_fields
            and not (self.is_standalone and m["id"] == "unit_floor")
        ]

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
        