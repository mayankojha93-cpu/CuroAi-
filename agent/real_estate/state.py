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
        preferred_language: str = "en",
        direction: str = "outbound",
    ):
        self.call_id = call_id
        self.lead_id = lead_id
        self.owner_name = owner_name
        self.phone = phone
        self.preferred_language = preferred_language
        self.direction = direction

        self.reply_lang: str = "en" if preferred_language == "en" else "hi"
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

        # Call outcome & tracking
        self.owner_name_confirmed: Optional[str] = None
        self.is_interested: Optional[bool] = None
        self.final_disposition: str = "Abruptly Disconnected Call"
        self.agent_summary: Optional[str] = None
        self.closing_spoken: bool = False
        self.hangup_started: bool = False
        self.outcome_posted: bool = False
        self.silence_count: int = 0

        # Transcript tracking
        self.transcript: List[Dict[str, Any]] = []

    def add_transcript(self, role: str, text: str):
        if text and text.strip():
            self.transcript.append({"role": role, "text": text.strip(), "time": time.time()})

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
        missing: List[Dict[str, str]] = []

        if self.step == RealEstateStep.RESIDENTIAL_SALE:
            # 4.1 In case of Sale of Residential Premises
            if not self.project_or_society:
                missing.append({
                    "id": "society_sector",
                    "label": "Society name and sector",
                    "question_en": "Could you share the society name and sector?",
                    "question_hi": "क्या आप सोसाइटी का नाम और सेक्टर बता सकते हैं?",
                })
            if not (self.unit_number or self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "What are the unit number and floor?",
                    "question_hi": "यूनिट नंबर और फ्लोर कौन सा है?",
                })
            if not self.bhk_config:
                missing.append({
                    "id": "bhk_config",
                    "label": "2, 3 BHK, or another configuration",
                    "question_en": "Is it a 2, 3 BHK, or another configuration?",
                    "question_hi": "यह 2 बीएचके, 3 बीएचके या कोई और कॉन्फ़िगरेशन है?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "What is the approximate area in square feet?",
                    "question_hi": "इसका लगभग एरिया स्क्वायर फीट में कितना है?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "Is the property unfurnished, semi-furnished, or fully furnished?",
                    "question_hi": "प्रॉपर्टी अनफर्निश्ड, सेमी-फर्निश्ड या फुली फर्निश्ड है?",
                })
            if not self.expected_sale_price:
                missing.append({
                    "id": "sale_price",
                    "label": "Expected sale price",
                    "question_en": "What sale price are you expecting?",
                    "question_hi": "आप क्या सेलिंग प्राइस एक्सपेक्ट कर रहे हैं?",
                })

        elif self.step == RealEstateStep.RESIDENTIAL_LEASE:
            # 4.2 In case of Lease of Residential Premises
            if not self.project_or_society:
                missing.append({
                    "id": "society_sector",
                    "label": "Society name and sector",
                    "question_en": "Could you share the society name and sector?",
                    "question_hi": "क्या आप सोसाइटी का नाम और सेक्टर बता सकते हैं?",
                })
            if not (self.unit_number or self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "What are the unit number and floor?",
                    "question_hi": "यूनिट नंबर और फ्लोर कौन सा है?",
                })
            if not self.bhk_config:
                missing.append({
                    "id": "bhk_config",
                    "label": "2, 3 BHK, or another configuration",
                    "question_en": "Is it a 2, 3 BHK, or another configuration?",
                    "question_hi": "यह 2 बीएचके, 3 बीएचके या कोई और कॉन्फ़िगरेशन है?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "What is the approximate area in square feet?",
                    "question_hi": "इसका लगभग एरिया स्क्वायर फीट में कितना है?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "Is the property unfurnished, semi-furnished, or fully furnished?",
                    "question_hi": "प्रॉपर्टी अनफर्निश्ड, सेमी-फर्निश्ड या फुली फर्निश्ड है?",
                })
            if not self.expected_monthly_rent:
                missing.append({
                    "id": "monthly_rent",
                    "label": "Expected monthly rent",
                    "question_en": "What monthly rent are you expecting?",
                    "question_hi": "आप कितना मंथली रेंट एक्सपेक्ट कर रहे हैं?",
                })
            if self.immediate_occupancy is None:
                missing.append({
                    "id": "immediate_occupancy",
                    "label": "Available for immediate occupancy",
                    "question_en": "Is the property available for immediate occupancy?",
                    "question_hi": "क्या यह प्रॉपर्टी तुरंत रहने के लिए उपलब्ध है?",
                })

        elif self.step == RealEstateStep.COMMERCIAL_SALE:
            # 4.3 In case of Sale of Commercial Premises
            if not self.project_or_society:
                missing.append({
                    "id": "project_sector",
                    "label": "Project or building name and sector",
                    "question_en": "Could you share the project or building name and sector?",
                    "question_hi": "क्या आप प्रोजेक्ट या बिल्डिंग का नाम और सेक्टर बता सकते हैं?",
                })
            if not (self.unit_number or self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "What are the unit number and floor?",
                    "question_hi": "यूनिट नंबर और फ्लोर कौन सा है?",
                })
            if not self.commercial_type:
                missing.append({
                    "id": "commercial_type",
                    "label": "Office space, retail shop, or another commercial unit",
                    "question_en": "Is it an office space, retail shop or another commercial unit?",
                    "question_hi": "यह ऑफिस स्पेस, रिटेल शॉप या कोई अन्य कमर्शियल यूनिट है?",
                })
            if self.is_currently_leased is None:
                missing.append({
                    "id": "leased_status",
                    "label": "Already leased out or vacant",
                    "question_en": "Is the property already leased out or vacant?",
                    "question_hi": "क्या प्रॉपर्टी पहले से लीज पर दी हुई है या खाली है?",
                })
            elif self.is_currently_leased is True and not self.current_rent_received:
                missing.append({
                    "id": "current_rent",
                    "label": "Current rent received (if leased)",
                    "question_en": "Could you share what rent you are getting?",
                    "question_hi": "अगर लीज पर है, तो अभी आपको कितना रेंट मिल रहा है?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "What is the approximate area in square feet?",
                    "question_hi": "इसका लगभग एरिया स्क्वायर फीट में कितना है?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "Is the property unfurnished, semi-furnished, or fully furnished?",
                    "question_hi": "प्रॉपर्टी अनफर्निश्ड, सेमी-फर्निश्ड या फुली फर्निश्ड है?",
                })
            if not self.expected_sale_price:
                missing.append({
                    "id": "sale_price",
                    "label": "Expected sale price",
                    "question_en": "What sale price are you expecting?",
                    "question_hi": "आप क्या सेलिंग प्राइस एक्सपेक्ट कर रहे हैं?",
                })

        elif self.step == RealEstateStep.COMMERCIAL_LEASE:
            # 4.4 In case of Lease of Commercial Premises
            if not self.project_or_society:
                missing.append({
                    "id": "project_sector",
                    "label": "Project or building name and sector",
                    "question_en": "Could you share the project or building name and sector?",
                    "question_hi": "क्या आप प्रोजेक्ट या बिल्डिंग का नाम और सेक्टर बता सकते हैं?",
                })
            if not (self.unit_number or self.floor_number):
                missing.append({
                    "id": "unit_floor",
                    "label": "Unit number and floor",
                    "question_en": "What are the unit number and floor?",
                    "question_hi": "यूनिट नंबर और फ्लोर कौन सा है?",
                })
            if not self.commercial_type:
                missing.append({
                    "id": "commercial_type",
                    "label": "Office space, retail shop, or another commercial unit",
                    "question_en": "Is it an office space, retail shop or another commercial unit?",
                    "question_hi": "यह ऑफिस स्पेस, रिटेल शॉप या कोई अन्य कमर्शियल यूनिट है?",
                })
            if not self.approx_area_sqft:
                missing.append({
                    "id": "approx_area",
                    "label": "Approximate area in square feet",
                    "question_en": "What is the approximate area in square feet?",
                    "question_hi": "इसका लगभग एरिया स्क्वायर फीट में कितना है?",
                })
            if not self.furnishing_status:
                missing.append({
                    "id": "furnishing",
                    "label": "Unfurnished, semi-furnished, or fully furnished",
                    "question_en": "Is the property unfurnished, semi-furnished, or fully furnished?",
                    "question_hi": "प्रॉपर्टी अनफर्निश्ड, सेमी-फर्निश्ड या फुली फर्निश्ड है?",
                })
            if not self.expected_monthly_rent:
                missing.append({
                    "id": "monthly_rent",
                    "label": "Expected monthly rent",
                    "question_en": "What monthly rent are you expecting?",
                    "question_hi": "आप कितना मंथली रेंट एक्सपेक्ट कर रहे हैं?",
                })
            if self.immediate_occupancy is None:
                missing.append({
                    "id": "immediate_occupancy",
                    "label": "Available for immediate occupancy",
                    "question_en": "Is the property available for immediate occupancy?",
                    "question_hi": "क्या यह प्रॉपर्टी तुरंत ऑक्यूपेंसी के लिए उपलब्ध है?",
                })

        return missing

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
