import re
import random
import logging
import asyncio
from typing import Optional, List, Dict, Any, Union
from livekit.agents import function_tool
from .state import RealEstateState, RealEstateStep
from .prompts import get_step_instructions, get_closing_text
from .config import FAST_TOOL_REPLY

logger = logging.getLogger("real-estate-tools")

COMMERCIAL_KEYWORDS = (
    "commercial", "कमर्शियल", "office", "ऑफिस", "shop", "दुकान", "dukan", "dukaan",
    "retail", "showroom", "शोरूम", "warehouse", "godown", "गोदाम", "godam",
    "industrial", "business park", "it park", "tech park", "office space",
    "commercial space", "commercial project", "commercial building", "sco", "booth", "workstation"
)
RESIDENTIAL_KEYWORDS = (
    "residential", "रेजिडेंशियल", "रेसिडेंशियल", "flat", "फ्लैट", "apartment", "अपार्टमेंट",
    "house", "makaan", "makan", "मकान", "ghar", "घर", "villa", "विला", "plot", "प्लॉट",
    "kothi", "कोठी", "bhk", "बीएचके", "studio", "penthouse", "builder floor", "duplex"
)


def _kw_in(text: str, keywords) -> bool:
    """Keyword match with letter boundaries for Latin words (so 'rent' does not match
    'current' / 'different', and 'house' does not match 'warehouse'). Devanagari uses substring."""
    for kw in keywords:
        if kw.isascii():
            if re.search(r"(?<![a-z])" + re.escape(kw) + r"(?![a-z])", text):
                return True
        elif kw in text:
            return True
    return False


def classify_category(val: Any) -> Optional[str]:
    if not val:
        return None
    val_low = str(val).lower().strip()
    has_comm = _kw_in(val_low, COMMERCIAL_KEYWORDS)
    has_res = _kw_in(val_low, RESIDENTIAL_KEYWORDS)
    if has_comm and not has_res:
        return "commercial"
    if has_res and not has_comm:
        return "residential"
    if has_comm and has_res:
        if any(neg in val_low for neg in ("not residential", "not res", "residential nahi")):
            return "commercial"
        if any(neg in val_low for neg in ("not commercial", "not comm", "commercial nahi")):
            return "residential"
        if _kw_in(val_low, ("office", "shop", "retail", "showroom", "warehouse", "godown")):
            return "commercial"
        return "commercial" if "commercial" in val_low else "residential"
    return None


_LEASE_WORDS = ("rent", "rented", "renting", "lease", "leasing", "kiraya", "kiraye", "kirayedar", "किराया", "किराए", "रेंट")
_SALE_WORDS = ("sell", "selling", "sale", "bechna", "bechni", "bechne", "bechu", "bech", "बेचना", "बेचनी", "सेल")


def classify_intent(val: Any) -> Optional[str]:
    if not val:
        return None
    val_low = str(val).lower().strip()
    if _kw_in(val_low, _LEASE_WORDS):
        return "lease"
    if _kw_in(val_low, _SALE_WORDS):
        return "sale"
    return None


_DONT_KNOW_RE = re.compile(
    r"(pata\s*nahi|pata\s*nhi|nahi\s*pata|yaad\s*nahi|yad\s*nahi|idea\s*nahi|nahi\s*(bata|bol)\s*(sakta|sakti|sakte)"
    r"|maloom\s*nahi|malum\s*nahi|don'?t\s*know|do\s*not\s*know|don'?t\s*remember|not\s*sure|no\s*idea|can'?t\s*say|cannot\s*share|nahi\s*batana)"
)
_DONT_KNOW_DEV = re.compile(r"(पता\s*नहीं|नहीं\s*पता|याद\s*नहीं|आइडिया\s*नहीं|मालूम\s*नहीं|नहीं\s*बता|नहीं\s*बताना)")


def _clean_str(val: Any) -> Optional[str]:
    if val is None:
        return None
    s = str(val).strip()
    if s.lower() in ("null", "none", "undefined", "n/a", "not provided", ""):
        return None
    return s


# Commercial unit types the caller can name. The type is stored AS THE CALLER SAID IT, never assumed.
_COMM_TYPE_TERMS = (
    "office space", "office", "ऑफिस", "retail shop", "retail", "shop", "दुकान", "dukan", "dukaan",
    "showroom", "शोरूम", "warehouse", "godown", "गोदाम", "godam", "coworking", "co-working", "cowork",
    "workstation", "booth", "sco", "factory", "industrial",
)
_COMM_OTHER_TERMS = ("other", "something else", "doosra", "dusra", "doosri", "koi aur", "kuch aur")


def commercial_type_from_speech(text: Any) -> Optional[str]:
    """The commercial unit type the caller actually named in `text`, in their own words
    ('office', 'shop', ...). 'Other' when they say it is something else. None if they named nothing."""
    low = str(text or "").lower().strip()
    if not low:
        return None
    for term in _COMM_TYPE_TERMS:
        if _kw_in(low, (term,)):
            return term
    if _kw_in(low, _COMM_OTHER_TERMS):
        return "Other"
    return None


# Standalone / independent property: no separate unit number or floor exists, so we never ask for them.
# "independent floor" / "builder floor" are NOT standalone (one floor of a building -> floor matters).
_STANDALONE_RE = re.compile(r"(?<![a-z])(stand[\s\-]?alone|free[\s\-]?standing|independent)(?![a-z])")
_STANDALONE_DEV = re.compile(r"(स्टैंड\s?अलोन|स्टैंडअलोन|इंडिपेंडेंट|इंडिपेंडेन्ट|फ्री\s?स्टैंडिंग)")
_STANDALONE_NEG_RE = re.compile(
    r"(not\s+(a\s+|an\s+)?(stand[\s\-]?alone|free[\s\-]?standing|independent)"
    r"|(stand[\s\-]?alone|free[\s\-]?standing|independent)\s+(nahi|nahin|nhi)"
    r"|(stand[\s\-]?alone|free[\s\-]?standing|independent)\s+(floor|builder))"
)


def is_standalone_from_speech(text: Any) -> bool:
    """True when the caller said the property is standalone / independent (e.g. 'independent house',
    'standalone building'). Used to skip the unit-number / floor question."""
    low = str(text or "").lower().strip()
    if not low:
        return False
    if _STANDALONE_NEG_RE.search(low):
        return False
    return bool(_STANDALONE_RE.search(low) or _STANDALONE_DEV.search(low))


def other_property_question(lang: str) -> str:
    """Scenario B: asked right after the caller refuses the property at the given location."""
    return (
        "Understood. Do you have any other property you would like to sell or rent?"
        if lang == "en"
        else "Ji, samajh gayi. Kya aapki koi doosri property hai, jise aap sell ya rent karna chahte hain?"
    )


def ask_new_location_question(lang: str) -> str:
    """Scenario B2: asked when the caller says they have another property."""
    return (
        "Great! Which area or sector is that property in?"
        if lang == "en"
        else "Achha, wo property kis area ya sector mein hai?"
    )


class RealEstateTools:
    def __init__(self, state: RealEstateState, post_outcome_func, hangup_func):
        self.state = state
        self.agent = None  # Bound by worker
        self.post_outcome_func = post_outcome_func
        self.hangup_func = hangup_func
        self.log_dialogue_func = None  # Bound by worker
        self._hangup_scheduled = False
        self._ack_i = 0
        self._last_ack = ""

    # ── Fast reply helper (skips the 2nd LLM call after a tool) ─────────────
    # Human feel: a wider pool, picked at random but never the same word twice in a row.
    _ACK_HI = ("Achha.", "Theek hai.", "Okay.", "Haan ji.", "Samajh gayi.", "Got it.", "Ji, noted.", "Bilkul.", "Achha, theek hai.")
    _ACK_EN = ("Got it.", "Sure.", "Okay.", "Alright.", "Understood.", "Great.", "Okay, noted.", "Right.", "Thanks.")
    _SHORT_ACK_HI = ("achha", "theek hai", "perfect", "noted", "great", "bilkul")
    _SHORT_ACK_EN = ("got it", "perfect", "noted", "great", "okay", "alright")

    def _pick(self, pool):
        """Random choice that never repeats the previous acknowledgement (same opening word every turn
        is the most robotic thing a caller hears)."""
        key = lambda s: s.lower().strip(" .,")
        choices = [p for p in pool if key(p) != self._last_ack] or list(pool)
        pick = random.choice(choices)
        self._last_ack = key(pick)
        return pick

    def _fast(self, question: str, fallback: str, ack: Optional[str] = "auto", echo: Optional[str] = None) -> str:
        """If FAST_TOOL_REPLY is on, store the exact line to speak in state.direct_reply and
        return a neutral tool result. llm_node then speaks it without calling the LLM again.
        Otherwise return `fallback` (the original instruction string) = old behaviour."""
        if not FAST_TOOL_REPLY or not question:
            return fallback
        en = self.state.reply_lang == "en"
        if echo:
            # "3 BHK, achha." / "704 on 7th floor, perfect."  -> sounds like someone actually listened
            short = self._pick(self._SHORT_ACK_EN if en else self._SHORT_ACK_HI)
            ack = f"{echo[:1].upper()}{echo[1:]}, {short}."
        elif ack == "auto":
            ack = self._pick(self._ACK_EN if en else self._ACK_HI)
        text = f"{ack} {question}".strip() if ack else question
        self.state.direct_reply = text
        return f"Reply already spoken to the customer: '{text}'. Do not repeat it."

    # ── Echo of what the caller just said (only ever a value that is really in their words) ──
    _ECHO_FIELDS = (
        "unit_number", "floor_number", "bhk_config", "commercial_type",
        "approx_area_sqft", "furnishing_status", "expected_sale_price", "expected_monthly_rent",
    )

    def _snap(self) -> Dict[str, Any]:
        return {k: getattr(self.state, k, None) for k in self._ECHO_FIELDS}

    def _in_heard(self, value: Any) -> bool:
        """True only if `value` is backed by the caller's latest words (digits, or a 3+ letter word).
        Guarantees we never read back a detail the LLM invented."""
        heard = (self.state.last_user_text or "").lower()
        if not heard or value is None:
            return False
        v = str(value).lower()
        digits = re.findall(r"\d+(?:\.\d+)?", v)
        if digits:
            return any(re.search(r"(?<![\d.])" + re.escape(d) + r"(?!\d)", heard) for d in digits)
        return any(w in heard for w in re.findall(r"[a-z]{3,}", v))

    def _echo_from_changes(self, before: Dict[str, Any]) -> Optional[str]:
        """2-4 word echo of ONE newly saved detail, or None."""
        try:
            s = self.state

            def new(k):
                v = getattr(s, k, None)
                return v if v not in (None, "") and v != before.get(k) else None

            unit, floor = new("unit_number"), new("floor_number")
            if unit and floor and self._in_heard(unit):
                fl = str(floor)
                fl = fl if "floor" in fl.lower() else f"{fl} floor"
                return f"{unit} on {fl}"
            bhk = new("bhk_config")
            if bhk and self._in_heard(bhk):
                return str(bhk) if re.search(r"bhk", str(bhk), re.I) else f"{bhk} BHK"
            ctype = new("commercial_type")
            if ctype and ctype != "Other" and self._in_heard(ctype):
                return str(ctype).capitalize()
            area = new("approx_area_sqft")
            if area:
                a = int(area) if float(area).is_integer() else area
                if self._in_heard(a):
                    return f"{a} square feet"
            fur = new("furnishing_status")
            if fur and self._in_heard(fur):
                return str(fur).capitalize()
            for k in ("expected_sale_price", "expected_monthly_rent"):
                p = new(k)
                if p and self._in_heard(p):
                    return str(p)
        except Exception:
            pass
        return None

    def _apply_standalone(self):
        """'independent house' / 'standalone' / 'freestanding building' said in the caller's latest words
        -> no unit number or floor exists, so get_missing_fields() must stop asking for them. Called before
        every tool that computes the next question, so it also works when it is said at the very first reply."""
        if not self.state.is_standalone and is_standalone_from_speech(self.state.last_user_text):
            self.state.is_standalone = True
            logger.info("Standalone/independent property -> unit number & floor will be skipped")

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
        if next_step == RealEstateStep.CLOSING:
            self._speak_closing_and_hangup()

    def _speak_closing_and_hangup(self):
        """Say the closing line ourselves (uninterruptible, so a 'haan haan' backchannel cannot cut it
        off), then hang up only after playout finishes."""
        if self.state.closing_spoken or not self.agent:
            return
        self.state.closing_spoken = True
        self._hangup_scheduled = True  # we own the hangup; skip the fixed-delay fallback
        text = get_closing_text(self.state)
        if self.log_dialogue_func:
            self.log_dialogue_func("assistant", text)
        else:
            self.state.add_transcript("assistant", text)
            print(f"\n\033[1;36m🤖 [Agent (Priya)]:\033[0m {text}\n", flush=True)
            logger.info(f"🤖 [Agent]: \"{text}\"")

        async def _run():
            try:
                handle = self.agent.session.say(text, allow_interruptions=False)
                await handle.wait_for_playout()
            except Exception as e:
                logger.warning(f"Closing speech failed: {e}")
                await asyncio.sleep(3.5)
            await asyncio.sleep(0.4)
            if self.hangup_func:
                await self.hangup_func()

        asyncio.create_task(_run())

    # ── Tool Definitions ──────────────────────────────────────────

    @function_tool
    async def customer_interested(
        self,
        category: Optional[str] = None,
        intent: Optional[str] = None,
    ) -> str:
        """Call when customer confirms they are interested in selling or renting their property.
        Optionally accepts category ('residential'/'commercial') or intent ('sale'/'lease'/'rent') if mentioned."""
        self.state.is_interested = True
        self._apply_standalone()

        # Both customer name and property location are already provided from data/records.
        # It is STRICTLY FORBIDDEN to ask customer name or property location.
        if not self.state.owner_name_confirmed:
            self.state.owner_name_confirmed = (self.state.owner_name or "").strip() or "Sir"

        heard = (self.state.last_user_text or "").strip()
        detected_cat = classify_category(category) or classify_category(heard)
        detected_int = classify_intent(intent) or classify_intent(heard)

        if detected_cat:
            self.state.category = detected_cat
        if detected_int:
            self.state.intent = detected_int

        # If both category and intent are already known from the utterance:
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
            return self._fast(
                first_q,
                f"Customer confirmed interest ({cat.title()} {intn.title()}). Smoothly ask: '{first_q}'",
                ack="auto",
            )

        # Transition to CATEGORY_SELECT
        await self._go(RealEstateStep.CATEGORY_SELECT)
        if self.state.intent:
            cat_q = (
                "Is it a residential or commercial property?"
                if self.state.reply_lang == "en"
                else "Ye residential property hai ya commercial?"
            )
            return self._fast(cat_q, f"Ask category: '{cat_q}'", ack="auto")
        elif self.state.category:
            int_q = (
                "Are you looking to sell or rent it out?"
                if self.state.reply_lang == "en"
                else "Aap ise sell karna chahte hain, ya rent par dena?"
            )
            return self._fast(int_q, f"Ask intent: '{int_q}'", ack="auto")
        else:
            cat_int_q = (
                "Is it a residential or commercial property? And are you looking to sell or rent it out?"
                if self.state.reply_lang == "en"
                else "Ye residential property hai ya commercial? Aur aap ise sell karna chahte hain ya rent par dena chahte hain?"
            )
            return self._fast(cat_int_q, f"Ask category and intent: '{cat_int_q}'", ack="auto")

    @function_tool
    async def not_interested_in_this_location(self) -> str:
        """Call when customer says they are not looking to sell or rent the property at the currently mentioned location, but may consider other properties."""
        # The refused property is discarded. Words from this sentence ("us location pe nahi BECHNA") must
        # never leak into the NEXT property's category / intent, or the B2 question would be cut short.
        s = self.state
        s.category = None
        s.intent = None
        s.commercial_type = None
        s.bhk_config = None
        s.is_standalone = False
        await self._go(RealEstateStep.CHECK_OTHER_PROPERTY)
        q = other_property_question(s.reply_lang)
        return self._fast(q, f"Ask if they have another property to sell or rent: '{q}'", ack=None)

    @function_tool
    async def has_other_property(
        self,
        has_other: bool,
        new_location: Optional[str] = None,
        category: Optional[str] = None,
        intent: Optional[str] = None,
    ) -> str:
        """Call when customer answers whether they have another property location to sell or rent.
        If customer states the new location in the same sentence, pass it in new_location.
        If they also state category (residential/commercial) or intent (sale/rent), pass them."""
        if not has_other:
            return await self.mark_not_interested()

        self.state.has_other_property = True
        self.state.is_standalone = False  # new property: decide again from what the caller says
        self._apply_standalone()

        if new_location:
            clean_loc = _clean_str(new_location)
            if clean_loc:
                self.state.sector_or_location = clean_loc
                self.state.project_or_society = clean_loc

        classified_cat = classify_category(category)
        if classified_cat:
            self.state.category = classified_cat

        classified_int = classify_intent(intent)
        if classified_int:
            self.state.intent = classified_int

        # If location is not yet known, ask for the new property's location
        if not self.state.sector_or_location or self.state.sector_or_location == getattr(self.state, "initial_property_location", None):
            await self._go(RealEstateStep.ASK_NEW_LOCATION)
            q = (
                "Great! Which area or sector is that property in?"
                if self.state.reply_lang == "en"
                else "Achha, wo property kis area ya sector mein hai?"
            )
            return self._fast(q, f"Ask for new property location: '{q}'", ack=None)

        # Location is known! Check if category and intent are established
        if not (self.state.category and self.state.intent):
            await self._go(RealEstateStep.CATEGORY_SELECT)
            q = (
                "Is it a residential or commercial property? And are you looking to sell or rent it out?"
                if self.state.reply_lang == "en"
                else "Ye residential property hai ya commercial? Aur aap ise sell karna chahte hain ya rent par dena chahte hain?"
            )
            return self._fast(q, f"Ask category and intent: '{q}'", ack=None)

        # Location, category, and intent are all established -> Proceed to intake branch and ask unit/floor
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
        return self._fast(first_q, f"Setup complete. Ask for unit number and floor: '{first_q}'")

    @function_tool
    async def set_new_property_location(
        self,
        location: str,
        category: Optional[str] = None,
        intent: Optional[str] = None,
    ) -> str:
        """Call when customer provides the location/sector of their new property to sell or rent."""
        if self.state.step == RealEstateStep.CHECK_OTHER_PROPERTY:
            self.state.is_standalone = False  # straight from "any other property?": this is a new property
        self._apply_standalone()
        clean_loc = _clean_str(location)
        if clean_loc:
            self.state.sector_or_location = clean_loc
            self.state.project_or_society = clean_loc

        classified_cat = classify_category(category)
        if classified_cat:
            self.state.category = classified_cat

        classified_int = classify_intent(intent)
        if classified_int:
            self.state.intent = classified_int

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
            return self._fast(first_q, f"Setup complete. Ask for unit number and floor: '{first_q}'")

        await self._go(RealEstateStep.CATEGORY_SELECT)
        if self.state.intent:
            q = (
                "Is it a residential or commercial property?"
                if self.state.reply_lang == "en"
                else "Ye residential property hai ya commercial?"
            )
        elif self.state.category:
            q = (
                "Are you looking to sell or rent it out?"
                if self.state.reply_lang == "en"
                else "Aap ise sell karna chahte hain, ya rent par dena?"
            )
        else:
            q = (
                "Is it a residential or commercial property? And are you looking to sell or rent it out?"
                if self.state.reply_lang == "en"
                else "Ye residential property hai ya commercial? Aur aap ise sell karna chahte hain ya rent par dena chahte hain?"
            )
        return self._fast(q, f"Ask category and intent: '{q}'", ack="auto")

    @function_tool
    async def confirm_owner_name(self, name: str) -> str:
        """Confirm owner name for records."""
        cleaned = name.strip() if name else ""
        self.state.owner_name_confirmed = cleaned if cleaned else self.state.owner_name
        # If category and intent are already known from earlier turns, jump directly to intake branch
        if self.state.category and self.state.intent:
            if self.state.category == "residential" and self.state.intent == "sale":
                await self._go(RealEstateStep.RESIDENTIAL_SALE)
            elif self.state.category == "residential" and self.state.intent == "lease":
                await self._go(RealEstateStep.RESIDENTIAL_LEASE)
            elif self.state.category == "commercial" and self.state.intent == "sale":
                await self._go(RealEstateStep.COMMERCIAL_SALE)
            elif self.state.category == "commercial" and self.state.intent == "lease":
                await self._go(RealEstateStep.COMMERCIAL_LEASE)
            missing = self.state.get_missing_fields()
            next_q = missing[0]["question_en"] if self.state.reply_lang == "en" else missing[0]["question_hi"]
            return self._fast(
                next_q,
                f"Recorded owner name: {self.state.owner_name_confirmed}. Property is {self.state.category} for {self.state.intent}. Smoothly follow up with: '{next_q}'",
            )

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
        self._apply_standalone()
        # The LLM sometimes invents category='residential', intent='sale' after a bare "haan".
        # Accept an argument only if the caller's latest words actually support it.
        heard = (self.state.last_user_text or "").strip()
        classified_cat = classify_category(category)
        if classified_cat and (not heard or classify_category(heard) == classified_cat):
            self.state.category = classified_cat

        classified_int = classify_intent(intent)
        if classified_int and (not heard or classify_intent(heard) == classified_int):
            self.state.intent = classified_int

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
            return self._fast(
                first_q,
                f"Setup complete ({cat.title()} {intn.title()}). Acknowledge and smoothly ask: '{first_q}'",
            )

        if not self.state.category:
            q = (
                "Is it a residential or commercial property?"
                if self.state.reply_lang == "en"
                else "Ye residential property hai ya commercial?"
            )
            return self._fast(q, f"Ask category: '{q}'", ack=None)

        q = (
            "Are you looking to sell or rent it out?"
            if self.state.reply_lang == "en"
            else "Aap ise sell karna chahte hain, ya rent par dena?"
        )
        return self._fast(q, f"Ask intent: '{q}'", ack=None)

    @function_tool
    async def save_property_details(
        self,
        category: Optional[str] = None,
        project_or_society: Optional[str] = None,
        sector_or_location: Optional[str] = None,
        unit_number: Optional[str] = None,
        floor_number: Optional[str] = None,
        bhk_config: Optional[str] = None,
        commercial_type: Optional[str] = None,
        # Number / boolean fields also accept str: the LLM often sends the literal string "null" for fields it
        # was told to omit, which made livekit reject the WHOLE call (nothing saved, 2nd LLM call, ~3.5s turn).
        # The body below already parses str values and ignores "null".
        approx_area_sqft: Optional[Union[float, str]] = None,
        furnishing_status: Optional[str] = None,
        expected_sale_price: Optional[str] = None,
        expected_monthly_rent: Optional[str] = None,
        is_currently_leased: Optional[Union[bool, str]] = None,
        current_rent_received: Optional[str] = None,
        immediate_occupancy: Optional[Union[bool, str]] = None,
    ) -> str:
        """Save ONLY the property details the customer explicitly stated in their latest message.
        Pass just those parameters and OMIT every other parameter. Never pass null and never guess
        or reuse values from earlier turns. commercial_type must be exactly the unit type the caller
        said (office, shop, showroom...); never assume it."""
        before = self._snap()
        clean_society = _clean_str(project_or_society)
        if clean_society:
            self.state.project_or_society = clean_society

        clean_sector = _clean_str(sector_or_location)
        if clean_sector:
            self.state.sector_or_location = clean_sector

        clean_unit = _clean_str(unit_number)
        if clean_unit:
            self.state.unit_number = clean_unit

        clean_floor = _clean_str(floor_number)
        if clean_floor:
            self.state.floor_number = clean_floor

        clean_bhk = _clean_str(bhk_config)
        if clean_bhk:
            self.state.bhk_config = clean_bhk

        clean_comm = _clean_str(commercial_type)
        if clean_comm:
            # NEVER assume the unit type: keep only what the caller actually said in their latest words.
            heard = (self.state.last_user_text or "").strip()
            if heard:
                said = commercial_type_from_speech(heard)
                if said:
                    clean_comm = said
                else:
                    logger.info(f"Ignoring commercial_type='{clean_comm}' from LLM: caller did not say it ('{heard[:80]}')")
                    clean_comm = None
        if clean_comm:
            self.state.commercial_type = clean_comm

        # Dynamic category switching and step realignment
        cat_hint = classify_category(category) or (classify_category(clean_comm) if clean_comm else None)
        if clean_comm or cat_hint == "commercial":
            self.state.category = "commercial"
            self.state.bhk_config = None  # Commercial properties never have BHK
            if self.state.step in (RealEstateStep.RESIDENTIAL_SALE, RealEstateStep.CATEGORY_SELECT):
                target_step = RealEstateStep.COMMERCIAL_LEASE if (self.state.intent == "lease") else RealEstateStep.COMMERCIAL_SALE
                await self._go(target_step)
            elif self.state.step == RealEstateStep.RESIDENTIAL_LEASE:
                await self._go(RealEstateStep.COMMERCIAL_LEASE)
        elif clean_bhk or cat_hint == "residential":
            self.state.category = "residential"
            self.state.commercial_type = None  # Residential properties never have commercial type
            if self.state.step in (RealEstateStep.COMMERCIAL_SALE, RealEstateStep.CATEGORY_SELECT):
                target_step = RealEstateStep.RESIDENTIAL_LEASE if (self.state.intent == "lease") else RealEstateStep.RESIDENTIAL_SALE
                await self._go(target_step)
            elif self.state.step == RealEstateStep.COMMERCIAL_LEASE:
                await self._go(RealEstateStep.RESIDENTIAL_LEASE)

        if approx_area_sqft is not None:
            try:
                if isinstance(approx_area_sqft, (int, float)):
                    self.state.approx_area_sqft = float(approx_area_sqft)
                else:
                    m = re.search(r'([0-9]+(?:\.[0-9]+)?)', str(approx_area_sqft).replace(',', ''))
                    if m:
                        self.state.approx_area_sqft = float(m.group(1))
            except (ValueError, TypeError):
                pass

        clean_furnishing = _clean_str(furnishing_status)
        if clean_furnishing:
            self.state.furnishing_status = clean_furnishing

        clean_price = _clean_str(expected_sale_price)
        if clean_price:
            self.state.expected_sale_price = clean_price

        clean_rent = _clean_str(expected_monthly_rent)
        if clean_rent:
            self.state.expected_monthly_rent = clean_rent

        if is_currently_leased is not None:
            if isinstance(is_currently_leased, bool):
                self.state.is_currently_leased = is_currently_leased
            else:
                s = str(is_currently_leased).lower().strip()
                if s not in ("null", "none"):
                    self.state.is_currently_leased = s in ("true", "yes", "1", "leased", "rented")

        clean_curr_rent = _clean_str(current_rent_received)
        if clean_curr_rent:
            self.state.current_rent_received = clean_curr_rent

        if immediate_occupancy is not None:
            if isinstance(immediate_occupancy, bool):
                self.state.immediate_occupancy = immediate_occupancy
            else:
                s = str(immediate_occupancy).lower().strip()
                if s not in ("null", "none"):
                    self.state.immediate_occupancy = s in ("true", "yes", "1", "immediate", "ready")

        logger.info(
            f"Updated slots: society={self.state.project_or_society}, "
            f"unit={self.state.unit_number}, floor={self.state.floor_number}, "
            f"bhk={self.state.bhk_config}, type={self.state.commercial_type}, "
            f"area={self.state.approx_area_sqft}, furnishing={self.state.furnishing_status}, "
            f"price={self.state.expected_sale_price}, rent={self.state.expected_monthly_rent}, "
            f"leased={self.state.is_currently_leased}, imm_occ={self.state.immediate_occupancy}"
        )

        # Caller called it standalone / independent -> unit number & floor are not applicable.
        if not self.state.is_standalone and is_standalone_from_speech(self.state.last_user_text):
            self.state.is_standalone = True
            logger.info("Standalone/independent property detected -> skipping unit number & floor")

        missing = self.state.get_missing_fields()
        if len(missing) == 0:
            # All details for this branch are captured!
            return await self.finish_property_intake()

        next_field = missing[0]
        q = next_field["question_en"] if self.state.reply_lang == "en" else next_field["question_hi"]
        return self._fast(q, f"Details saved. Echo what the caller mentioned, and naturally ask: '{q}'",
                          echo=self._echo_from_changes(before))

    @function_tool
    async def customer_does_not_know(self, field_id: Optional[str] = None) -> str:
        """Call when the customer says they do not know, do not remember, or cannot share the detail that was just asked."""
        missing = self.state.get_missing_fields()
        heard = (self.state.last_user_text or "").strip()
        if heard and missing and not _DONT_KNOW_RE.search(heard.lower()) and not _DONT_KNOW_DEV.search(heard):
            # Caller did NOT say they don't know (e.g. asked us to repeat) -> never skip the field.
            q = missing[0]["question_en"] if self.state.reply_lang == "en" else missing[0]["question_hi"]
            return self._fast(q, f"Do not skip. Ask again: '{q}'", ack=None)
        ids = {m["id"] for m in missing}
        target = field_id if field_id in ids else (missing[0]["id"] if missing else None)
        if target:
            self.state.skipped_fields.add(target)
        missing = self.state.get_missing_fields()
        if not missing:
            return await self.finish_property_intake()
        q = missing[0]["question_en"] if self.state.reply_lang == "en" else missing[0]["question_hi"]
        no_prob = "No problem." if self.state.reply_lang == "en" else "Koi baat nahi."
        return self._fast(q, f"No problem, that detail is skipped. Acknowledge in 2-3 words and ask only: '{q}'", ack=no_prob)

    @function_tool
    async def finish_property_intake(self) -> str:
        """Call when all property details have been collected to wrap up."""
        missing = self.state.get_missing_fields()
        if len(missing) > 0 and not getattr(self.state, "impatient_detected", False):
            next_field = missing[0]
            q = next_field["question_en"] if self.state.reply_lang == "en" else next_field["question_hi"]
            return self._fast(q, f"Not all details are collected yet. Smoothly ask: '{q}'")

        cat = (self.state.category or "Residential").title()
        intn = "Sale" if self.state.intent == "sale" else "Lease"
        self.state.final_disposition = "Qualified Lead"

        details = [f"{cat} {intn}"]
        if self.state.project_or_society:
            loc = f", {self.state.sector_or_location}" if self.state.sector_or_location else ""
            details.append(f"{self.state.project_or_society}{loc}")
        if self.state.is_standalone:
            details.append("Standalone/Independent property")
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
        self.state.final_disposition = "Schedule Callback"
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
        if re.search(r"price|pricing|valuation|rate|market", reason or "", re.I):
            self.state.valuation_requested = True
        self.state.advisor_handoff_reason = reason.strip()
        self.state.callback_time_slot = preferred_time
        self.state.final_disposition = "Advisor Callback Booked"
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
        self.state.final_disposition = "Do Not Call"
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
        """Wait for closing speech playout through TTS to the caller phone, then disconnect cleanly.
        Closing line is ~2s of audio; 3.5s gives a comfortable 1.5s buffer without dead air.
        """
        if self._hangup_scheduled:
            return
        self._hangup_scheduled = True
        logger.info("Delayed hangup scheduled: waiting 3.5s for TTS speech playout...")
        await asyncio.sleep(3.5)  # LATENCY: was 6.5s — closing line is ~2s; 3.5s is enough buffer
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
            return [self.customer_interested, self.not_interested_in_this_location] + self._objection_tools()
        elif step == RealEstateStep.CHECK_OTHER_PROPERTY:
            return [self.has_other_property, self.set_new_property_location, self.mark_not_interested] + self._objection_tools()
        elif step == RealEstateStep.ASK_NEW_LOCATION:
            return [self.set_new_property_location, self.set_category_and_intent] + self._objection_tools()
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
            return [self.save_property_details, self.customer_does_not_know, self.finish_property_intake] + self._objection_tools()
        elif step == RealEstateStep.CLOSING:
            # No tools in closing step: prevents LLM tool hallucinations completely
            return []
        return []
        