import re
import random
import logging
import asyncio
from typing import Optional, List, Dict, Any, Union, Tuple
from livekit.agents import function_tool
from .state import RealEstateState, RealEstateStep
from .prompts import get_step_instructions, get_closing_text
from .config import FAST_TOOL_REPLY, AGENT_PERSONA_NAME

logger = logging.getLogger("real-estate-tools")

COMMERCIAL_KEYWORDS = (
    "commercial", "कमर्शियल", "office", "ऑफिस", "shop", "दुकान", "dukan", "dukaan",
    "retail", "showroom", "शोरूम", "warehouse", "godown", "गोदाम", "godam",
    "industrial", "business park", "it park", "tech park", "office space",
    "commercial space", "commercial project", "commercial building", "sco", "booth", "workstation"
)
# STT phonetic aliases for "residential" — Sarvam often returns these garbled forms over phone lines.
# Examples heard in real calls: "ritenshiyal", "rejidenshiyal", "rezidential", "rejidential",
# "reziential", "resiential", "aavasiy", "aavasiiy", "aavasiya" (Hindi transliteration of आवासीय).
_RESIDENTIAL_PHONETIC = re.compile(
    r"\b("
    # -nshiyal / -nshi?y?a?l ending (phone garble of 'resi-den-tial'):
    # ritenshiyal, rezenshiyal, rejenshiyal, ritenshial
    r"r[a-z]*nshi?y?a?l"
    # -idenshiyal (with 'id' syllable): rejidenshiyal, rezidenshiyal
    r"|r[a-z]+idenshiyal?"
    # -idential: rejidential, rezidential, rezidental
    r"|r[ae][jz]id[ae]nti[ae]?l"
    # Standard spelling (already in RESIDENTIAL_KEYWORDS, harmless here): rezidential
    r"|r[ei][sz]id[ae]nti[ae]?l"
    # Hindi STT: aavasiy, aavasiiy, aavasiya (आवासीय)
    r"|aav?[aá]s[iy]+[yaá]?"
    r")\b",
    re.I,
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
    # Also check phonetic STT variants of "residential" (phone-line garbling by Sarvam STT)
    has_res = _kw_in(val_low, RESIDENTIAL_KEYWORDS) or bool(_RESIDENTIAL_PHONETIC.search(val_low))
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


_LEASE_WORDS = (
    "rent", "rented", "renting", "rent out", "to rent", "for rent", "rental", "rentals",
    "lease", "leasing", "leased", "lease out", "to lease", "for lease", "look to lease", "looking to lease",
    "let out", "to let", "letting",
    "kiraya", "kiraye", "kirayedar", "kiraye pe", "kiraye par", "kiraya pe", "kiraya par",
    "bhada", "bhaada", "bhade", "bhade pe", "bhade par",
    "किराया", "किराए", "किराये", "रेंट", "लीज", "भाड़ा", "भाड़े", "किराए पर", "लीज पर"
)
_SALE_WORDS = (
    "sell", "selling", "sale", "sales", "sell out", "to sell", "for sale", "looking to sell",
    "bechna", "bechni", "bechne", "bechu", "bech", "bech rahe", "bechna chahte",
    "bikau", "bikaau",
    "बेचना", "बेचनी", "बेचने", "सेल", "बिकाऊ"
)


# Phone-line STT often turns "lease out" into "leave out" / "please out" / "lees out".
_LEASE_STT = re.compile(
    r"(?<![a-z])(?:leave|leaf|lees|leece|leas|liz|lis|please|pleas)\s*(?:it\s*)?out(?![a-z])"
    r"|(?<![a-z])(?:lees|leece|leaze)(?![a-z])"
)


_RHETORICAL_OR_NEG_INTENT_RE = re.compile(
    r"\b(kyun|kyon|why|nahi|nahin|mat|kahan|kaise|nhi)\b.*(bech|sell|sale|rent|kiray|lease)|(bech|sell|sale|rent|kiray|lease).*\b(kyun|kyon|why|nahi|nahin|mat|nhi)\b",
    re.I,
)


def classify_intent(val: Any) -> Optional[str]:
    if not val:
        return None
    val_low = str(val).lower().strip()
    if _RHETORICAL_OR_NEG_INTENT_RE.search(val_low):
        return None
    is_lease = _kw_in(val_low, _LEASE_WORDS) or bool(_LEASE_STT.search(val_low))
    is_sale = _kw_in(val_low, _SALE_WORDS)
    if is_lease and is_sale:
        return None  # ambiguous (e.g. the caller echoing "sell or rent") -> never guess
    if is_lease:
        return "lease"
    if is_sale:
        return "sale"
    return None


# ── Explicitness guards: a tool that ENDS the call must be backed by the caller's own words ──
_DNC_LATIN = re.compile(
    r"(call\s*mat|mat\s*call|call\s*(na|nahi|nhi)\s*(karo|karna|kijiye|karein)|do\s*not\s*call|don'?t\s*call"
    r"|stop\s*call|no\s*more\s*calls?|never\s*call|\bdn[dc]\b|remove\s*(my|this|the)?\s*(number|name|contact)"
    r"|number\s*(remove|hata|delete)|list\s*(se|me|mein)\s*(nikal|hata|remove)|take\s*me\s*off|unsubscribe"
    r"|phone\s*mat|dobara\s*call\s*mat)",
    re.I,
)
_DNC_DEV = re.compile(r"(कॉल\s*मत|मत\s*कॉल|कॉल\s*न\s*कर|नंबर\s*(हटा|रिमूव|डिलीट)|रिमूव|डू\s*नॉट\s*कॉल|डीएनडी|परेशान\s*मत)")

# 1. Phrases indicating positive intent to sell / rent, property answers, or conversational idioms (cannot be a refusal)
_POSITIVE_OR_ANSWER_RE = re.compile(
    r"\b("
    r"(?:main\s+)?(?:sell|bechn[aei]|sale|rent|kiray[ae]|lease)\s*(?:karn[aei]|den[aei]|chahit[aei]|hai|hoga|chahta|chahti)"
    r"|(?:interested|intrested)\s*(?:hoon|hu|hain|hai)"
    r"|want\s+to\s+(?:sell|rent|lease|proceed)"
    r"|looking\s+to\s+(?:sell|rent|lease)"
    r"|no\s+(?:problem|issue|worries?)|don'?t\s+worry"
    r"|\d+\s*(?:bhk|bedroom|bed)|flat\s*(?:no\.?|#)?\s*\d+|\d+\s*floor|\d+\s*(?:sq\s*ft|sqft|gaj|yards)"
    r"|\d+\s*(?:crore|cr|lakh|lac|thousand|k)\b"
    r")\b",
    re.IGNORECASE,
)

# 2. Explicit negative intent phrases (clearly refusing to sell / rent / talk)
_EXPLICIT_REFUSAL_PHRASES = re.compile(
    r"\b("
    r"not\s+(?:interested|looking|selling|renting|leasing|wanting|planning|for\s+sale|at\s+all)"
    r"|(?:un|not\s+)interested"
    r"|don'?t\s+want\s+to\s+(?:sell|rent|lease|talk|proceed)"
    r"|no\s+thanks?|no\s+thank\s+you"
    r"|already\s+(?:sold|rented|showed|given|let\s*out|disposed)"
    r"|don'?t\s+have\s+(?:any\s+)?(?:other\s+)?property(?:\s+to\s+(?:sell|rent|lease))?"
    r"|no\s+property(?:\s+to\s+(?:sell|rent|lease))?"
    r"|(?:bech|de)\s*(?:diya|di|chuke|chuki|hain)|bik\s*gay[aei]"
    r"|koi\s*(?:bhi\s*)?property\s*(?:nahi|nhi)"
    r"|(?:nahi|nhi|nahin|na)\s+(?:bechn[aei]|den[aei]|karn[aei]|chahiye|hoga|bataunga|batana|lena)"
    r"|(?:bechn[aei]|den[aei]|sell\s*karn[aei]|rent\s*pe\s*den[aei])\s*(?:bhi\s*)?(?:nahi|nhi|nahin)"
    r"|(?:interested|intrested|interest)\s*(?:nahi|nhi|nahin)"
    r"|(?:nahi|nhi|nahin)\s*(?:interested|intrested)"
    r"|kuch\s*(?:bhi\s*)?(?:nahi|nhi)\s*(?:bechn[aei]|den[aei]|karn[aei])"
    r"|(?:koi|kuch)\s*(?:property\s*)?(?:nahi|nhi)\s*(?:bechn[aei]|den[aei])"
    r"|(?:call|phone)\s*(?:mat|nahi|na)\s*(?:karn[aei]|karo|kijiye|karein|karna)"
    r"|mat\s*(?:karo|kijiye|karna|karein)?\s*(?:call|phone)"
    r"|kripya\s*call\s*na\s*kar(?:ein|na)?"
    r"|(?:kat|kaat)\s*(?:karo|do|kijiye|kar\s*do)|call\s*(?:kaat|kat)\s*(?:do|karo)|cut\s*the\s*call|phone\s*(?:rakho|kaato|kaat\s*do)"
    r"|(?:kyun|kyon|why)\s*(?:bechn[aei]|den[aei]|chahenge|chahein)"
    r"|abhi\s*(?:kuch|kuchh)?\s*(?:nahi|nhi)"
    r"|kuch\s*(?:nahi|nhi)"
    r"|never\s*call|stop\s*calling"
    r")\b",
    re.IGNORECASE,
)

_EXPLICIT_REFUSAL_DEV = re.compile(
    r"(नहीं\s*(बेचना|देना|करना|चाहिए|बताना)|(बेचना|देना)\s*नहीं|इंटरेस्टेड\s*नहीं|रुचि\s*नहीं|कॉल\s*मत\s*करो|फोन\s*मत|कॉल\s*काटो|काट\s*दो|कुछ\s*नहीं|अभी\s*नहीं)"
)

# 3. Clean bare refusal tokens: when the entire utterance is just "no", "nahi ji", "no thanks"
_BARE_REFUSAL_WORDS = {
    "no", "nope", "nah", "nahi", "nahin", "nhi", "nahii", "nai", "na",
    "नहीं", "नही", "नहि", "नो"
}
_REFUSAL_FILL_WORDS = {
    "ji", "jee", "sir", "madam", "bhai", "bhaiya", "thanks", "thank", "you",
    "shukriya", "dhanyawad", "re", "baba", "ab", "abhi", "kuch", "kuchh",
    "bas", "toh", "to", "bhi", "yar", "yaar", "जी", "सर", "मैडम", "भैया", "भाई", "बस", "तो", "भी"
}


def explicit_dnc_request(text: Any) -> bool:
    t = str(text or "")
    return bool(_DNC_LATIN.search(t) or _DNC_DEV.search(t))


def explicit_refusal(text: Any) -> bool:
    t = str(text or "").strip()
    if not t:
        return False

    low = t.lower()

    # If sentence contains positive intent (e.g. "Nahi, main sell karna chahta hoon")
    # or property details ("Nahi, 3 BHK hai", "No problem"), it is NOT a refusal.
    if _POSITIVE_OR_ANSWER_RE.search(low):
        # Unless it also explicitly says "not interested" or "nahi bechna"
        if not (_EXPLICIT_REFUSAL_PHRASES.search(low) or _EXPLICIT_REFUSAL_DEV.search(t)):
            return False

    # 1. Matches explicit refusal phrases (e.g. "not interested", "nahi bechna", "don't want to sell")
    if _EXPLICIT_REFUSAL_PHRASES.search(low) or _EXPLICIT_REFUSAL_DEV.search(t):
        return True

    # 2. Bare refusal: words in utterance consist entirely of refusal words + polite fillers
    tokens = [w.strip(".,?!;:-_") for w in re.split(r"[\s,]+", low) if w.strip(".,?!;:-_")]
    if tokens:
        has_refusal_word = any(tok in _BARE_REFUSAL_WORDS for tok in tokens)
        all_filler_or_refusal = all(tok in (_BARE_REFUSAL_WORDS | _REFUSAL_FILL_WORDS) for tok in tokens)
        if has_refusal_word and all_filler_or_refusal:
            return True

    return False


_QUOTE_STOP = _BARE_REFUSAL_WORDS | _REFUSAL_FILL_WORDS | {
    "haan", "yes", "yeah", "ji", "hai", "hain", "ho", "the", "a", "is", "i", "main", "mai", "mujhe", "hum", "ok", "okay",
}


def _quote_grounded(quote: Any, heard: Any) -> bool:
    """GROUNDING check (not a meaning check). Tools that END the call or SKIP a field used to be vetoed by a
    keyword regex, which blocked the LLM whenever a caller refused / said "don't know" in words the regex
    had never seen. Now the LLM passes `caller_words` (the caller's own words that justify the action) and
    code only verifies they were REALLY said: >= 2 distinct words, >= 80% of them present in the caller's
    latest utterance, and at least one content word (so a bare "nahi nahi" can never justify ending a call).
    The LLM still decides what the words mean; this only stops it from inventing a reason."""
    def _w(x):
        return re.findall(r"[a-z0-9\u0900-\u097F]+", str(x or "").lower())
    q, h = _w(quote), set(_w(heard))
    if len(set(q)) < 2 or not h:
        return False
    if sum(1 for t in q if t in h) / len(q) < 0.8:
        return False
    return any(t not in _QUOTE_STOP for t in q)


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
_EXPLICIT_UNIT_RE = re.compile(
    r"\b(?:flat|unit|apartment|apt|door|room|फ्लैट|यूनिट)\s*(?:no\.?|num(?:ber)?|#)?\s*(?:is\s*)?([a-z]?-?\d{1,5}[a-z]?)\b"
    r"|\b[a-z]{1,2}[\-/]\d{1,5}\b",
    re.IGNORECASE,
)
_EXPLICIT_FLOOR_RE = re.compile(
    r"\b("
    r"\d{1,3}(?:st|nd|rd|th)?\s*(?:floor|flr|manzil|फ्लोर|मंजिल)"
    r"|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|top|upper|lower)\s+(?:floor|flr|manzil)"
    r"|(?:floor|flr|manzil|फ्लोर|मंजिल)\s*(?:no\.?|num(?:ber)?|#)?\s*\d{1,3}"
    r"|(\d{1,2}|ground|top)\s+(?:pe|par)\b"
    r")\b",
    re.IGNORECASE,
)
_VILLA_COMMUNITY_RE = re.compile(
    r"\b(villa|kothi|bungalow|bunglow|विला|कोठी|बंगला)\s+"
    r"(community|society|heights|enclave|apartments?|apts?|towers?|residency|floors?|greens|view|city|estate|park|phase|block|sector|colony|सोसाइटी|कम्युनिटी)\b"
    r"|\b(community|society|heights|enclave|apartments?|apts?|towers?|residency|floors?|greens|view|city|estate|park|phase|block|sector|colony|सोसाइटी|कम्युनिटी)\s+"
    r"(villa|kothi|bungalow|bunglow|विला|कोठी|बंगला)\b",
    re.IGNORECASE,
)
_NO_UNIT_BUT_HAS_NUM_RE = re.compile(
    r"\b(?:no|nahi|nhi|नहीं|नही)\W+(?:unit|flat|floor|फ्लैट|यूनिट|फ्लोर)\s*(?:no\.?|num(?:ber)?|#)?\s*(?:is|hai|=|:)?\s*([a-z0-9\-]*\d+[a-z0-9\-]*)",
    re.IGNORECASE,
)

_STANDALONE_RE = re.compile(
    r"(?<![a-z])("
    r"stand[\s\-]?alone|standard[\s\-]?alone|free[\s\-]?standing|"
    r"independent\s+(house|villa|building|property|kothi|bungalow|bunglow|home|duplex)|"
    r"(entire|whole|poora|pura|puri|poori)\s+(building|property|house|office|kothi|bungalow|villa)|"
    r"(single|individual)\s+(house|building|kothi|bungalow|property)|"
    r"\b(row\s*house|duplex|triplex|farm\s*house|farmhouse)\b|"
    r"(?:it'?s\s+a\s+|yeh\s+|ye\s+|meri\s+|mera\s+|hamara\s+|apna\s+|is\s+a\s+)\b(villa|kothi|bungalow|bunglow)\b|"
    r"(unit|flat|floor)\s*(number)?\s*(hai\s*hi\s*nahi|hota\s*hi\s*nahi|nahi\s*hota|nahi\s*hai|nhi\s*hai)\b|"
    r"(?:there\s+is\s+)?no\s+(?:separate\s+)?(?:unit|flat|floor)\s*(?:number)?\s*(?:hota|hai)?\b|"
    r"(?:koi\s+)?(?:unit|flat|floor)\s*(?:number)?\s*(?:nahi|nhi)\s*(?:hota|hai)?\b"
    r")(?![a-z])",
    re.IGNORECASE,
)
_STANDALONE_DEV = re.compile(r"(स्टैंड\s?अलोन|स्टैंडअलोन|स्टैंडर्ड\s?अलोन|इंडिपेंडेंट\s*(हाउस|विला|कोठी|बिल्डिंग)|(पूरा|पूरी)\s*(मकान|बिल्डिंग|कोठी|बंगला))")
_STANDALONE_NEG_RE = re.compile(
    r"(not\s+(a\s+|an\s+)?(stand[\s\-]?alone|free[\s\-]?standing|independent)"
    r"|(stand[\s\-]?alone|free[\s\-]?standing|independent)\s+(nahi|nahin|nhi)"
    r"|(stand[\s\-]?alone|free[\s\-]?standing|independent|builder)\s+(floor|builder)"
    r"|floor\s+in\s+(a\s+)?(villa|kothi|bungalow|building))",
    re.IGNORECASE,
)


def is_standalone_from_speech(text: Any) -> bool:
    """True when the caller said the property is standalone / independent (e.g. 'independent house',
    'standalone building'). Used to skip the unit-number / floor question."""
    low = str(text or "").lower().strip()
    if not low:
        return False
    # If caller says they do not know / do not remember, that is NOT a standalone property
    if _DONT_KNOW_RE.search(low) or _DONT_KNOW_DEV.search(low):
        return False
    if _STANDALONE_NEG_RE.search(low):
        return False
    # If caller gave an explicit unit number or floor, the property is NOT standalone
    if _EXPLICIT_UNIT_RE.search(low) or _EXPLICIT_FLOOR_RE.search(low):
        return False
    # If "no unit" was just conversational negation before stating the unit number (e.g. "no, unit number is 402")
    if _NO_UNIT_BUT_HAS_NUM_RE.search(low):
        return False
    # If "villa" / "kothi" / "bungalow" is part of a society / community name (e.g. "Villa community", "Villa heights")
    if _VILLA_COMMUNITY_RE.search(low):
        return False
    return bool(_STANDALONE_RE.search(low) or _STANDALONE_DEV.search(low))


def other_property_question(lang: str) -> str:
    """Scenario B: asked right after the caller refuses the property at the given location."""
    return (
        "Understood, Sir... Do you have any other property in mind that you might want to sell or rent out?"
        if lang == "en"
        else "Samajh gayi Sir... Kya aapki koi doosri property hai, jise aap sell ya rent out karna chahte hain?"
    )


def sell_or_rent_question(lang: str, has_loc: bool = True, loc: Optional[str] = None, full_context: bool = False) -> str:
    """Qualification question asked in turn 2 after opening greeting acknowledgment.
    If full_context is True (e.g. caller interrupted intro or asked who/what/hello),
    provides full persona, company, and location context so the caller is never confused."""
    if full_context:
        clean_loc = loc.split(";")[0].strip() if loc else ""
        if clean_loc:
            return (
                f"Hello Sir, this is {AGENT_PERSONA_NAME} from My Estate Finder. I'm calling regarding your property in {clean_loc} — were you looking to sell or rent it out?"
                if lang == "en"
                else f"Ji, main {AGENT_PERSONA_NAME} baat kar rahi hoon My Estate Finder se. Aapki {clean_loc} wali property ke silsile mein call kiya tha — kya aap use sell karne ka plan kar rahe hain ya rent out?"
            )
        else:
            return (
                f"Hello Sir, this is {AGENT_PERSONA_NAME} from My Estate Finder. Were you looking to sell or rent out any property?"
                if lang == "en"
                else f"Ji, main {AGENT_PERSONA_NAME} baat kar rahi hoon My Estate Finder se. Main yeh pooch rahi thi ki kya aap apni koi property sell ya rent karne ka plan kar rahe hain?"
            )

    if has_loc:
        return (
            "Were you looking to sell or rent it out?"
            if lang == "en"
            else "Kya aap use sell karne ka plan kar rahe hain ya rent out?"
        )
    return (
        "Do you own any property that you'd like to sell or rent out?"
        if lang == "en"
        else "Kya aap apni koi property sell ya rent karne ka plan kar rahe hain?"
    )


def ask_new_location_question(lang: str) -> str:
    """Scenario B2: asked when the caller says they have another property."""
    return (
        "Great, Sir! Which area or sector is that property in?"
        if lang == "en"
        else "Achha ji... wo property kis area ya sector mein hai?"
    )


_Q_LEAD_RE = re.compile(r"^(?:ji sir|sure sir|sorry sir|ji|sure|sorry|sir)\s*[,.]?\s+", re.I)


def extract_question(spoken: str) -> str:
    """The question part of a spoken line: from the first sentence that ends with '?' to the end.
    Drops acks like 'Okay.' and re-ask leads like 'Ji Sir,' so a later 'repeat' sounds clean."""
    parts = re.split(r"(?<=[.!?।])\s+", (spoken or "").strip())
    for i, p in enumerate(parts):
        if p.rstrip().endswith("?"):
            q = " ".join(parts[i:]).strip()
            return _Q_LEAD_RE.sub("", q).strip()
    return ""


async def _replay(frames):
    for f in frames:
        yield f


def say_cached(session, state, text: str, allow_interruptions: bool = True):
    """session.say(), but plays pre-rendered audio when this exact line was synthesised during the ring."""
    q = extract_question(text)
    if q and hasattr(state, "last_agent_question"):
        state.last_agent_question = q

    frames = getattr(state, "audio_cache", {}).get(text)
    if frames:
        try:
            return session.say(text, audio=_replay(frames), allow_interruptions=allow_interruptions)
        except Exception as e:
            logger.debug(f"cached audio failed, synthesising normally: {e}")
    return session.say(text, allow_interruptions=allow_interruptions)


_NEUTRAL_WORDS = {
    "hello", "hi", "hey", "helo", "hallo", "ok", "okay", "yes", "no", "hmm", "haan", "han", "ji",
    "haanji", "haan ji", "हेलो", "हैलो", "हेल्लो", "हाँ", "हां", "जी", "हम्म", "ओके",
    "ya", "yeah", "yep", "yup", "ha", "yes yes", "yes yes yes", "haan haan", "han han", "ji ji",
    "ok ok", "okay okay", "yes sir", "ji haan", "haan ji haan", "hmm hmm", "hello hello",
    "theek hai", "thik hai", "theek", "thik", "theek h", "achha", "accha", "acha", "sahi hai",
    "theek hai ji", "accha ji", "achha ji",
}


def _is_bare_ack(text: str) -> bool:
    clean = re.sub(r"[\s.,?!\u0964]+", " ", (text or "").lower()).strip()
    return clean in _NEUTRAL_WORDS or not clean


def _grounded(category: Optional[str], intent: Optional[str], heard: Any) -> Tuple[Optional[str], Optional[str]]:
    """Category / intent validation.
    Prevents hallucinating category/intent when customer only gave a bare acknowledgement ('haan ji').
    When the customer spoke substantive natural speech, trusts the LLM's contextual comprehension."""
    if isinstance(heard, (list, tuple)):
        heard_text = " ".join(str(t) for t in heard if t).strip()
    else:
        heard_text = str(heard or "").strip()

    c = classify_category(heard_text) if heard_text else None
    i = classify_intent(heard_text) if heard_text else None
    is_bare = _is_bare_ack(heard_text)

    cat_out = None
    if c:
        cat_out = c
    elif category:
        cand_c = classify_category(category) or (category.lower().strip() if category.lower().strip() in ("residential", "commercial") else None)
        if cand_c and not is_bare:
            cat_out = cand_c

    int_out = None
    if i:
        int_out = i
    elif intent:
        cand_i = classify_intent(intent) or (intent.lower().strip() if intent.lower().strip() in ("sale", "lease") else None)
        if cand_i and not is_bare:
            int_out = cand_i

    # Fallback if no transcript is available
    if not heard_text:
        cat_out = classify_category(category) or (category.lower().strip() if category and category.lower().strip() in ("residential", "commercial") else None)
        int_out = classify_intent(intent) or (intent.lower().strip() if intent and intent.lower().strip() in ("sale", "lease") else None)

    return cat_out, int_out


def _estimate_speech_duration(text: str) -> float:
    """Estimated duration of spoken text in seconds: ~2.8 words per second + 1.5s buffer."""
    words = len((text or "").split())
    return max(4.0, (words / 2.8) + 1.5)


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
    # Human feel: natural Indian sales affirmations with breathing pauses (commas/ellipses)
    # Never ends with a blunt period, so TTS doesn't drop pitch mechanically.
    _ACK_HI = (
        "Achha ji, ",
        "Haanji Sir... ",
        "Theek hai ji, ",
        "Samajh gayi Sir... ",
        "Ji noted Sir, ",
        "Bilkul Sir, ",
        "Achha, theek hai ji... ",
        "Right Sir, noted... ",
        "Perfect Sir, ",
    )
    _ACK_EN = (
        "Got it, Sir... ",
        "Sure Sir, ",
        "Alright, Sir... ",
        "Understood, Sir... ",
        "Great, Sir... ",
        "Right, noted Sir... ",
        "Perfect, Sir... ",
        "Okay, great... ",
    )
    _SHORT_ACK_HI = ("achha ji", "theek hai ji", "perfect Sir", "noted ji", "great Sir", "bilkul Sir")
    _SHORT_ACK_EN = ("got it, Sir", "perfect, Sir", "noted, Sir", "great, Sir", "alright, Sir")

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
            # Natural conversational flow: acknowledgement first, then confirmed detail
            # e.g. "Noted Sir, Semi-furnished." or "Theek hai ji, 3 BHK."
            short = self._pick(self._SHORT_ACK_EN if en else self._SHORT_ACK_HI)
            clean_short = short.replace(",", "").strip().rstrip(".")
            ack = f"{clean_short.capitalize()}, {echo}."
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
        if not heard and hasattr(self.state, "get_recent_speech_context"):
            heard = self.state.get_recent_speech_context(max_turns=3).lower()
        if not heard or value is None:
            return False
        v = str(value).lower()
        digits = re.findall(r"\d+(?:\.\d+)?", v)
        if digits:
            heard_clean = re.sub(r"(?<=\d),(?=\d)", "", heard)
            for d in digits:
                d_norm = d[:-2] if d.endswith(".0") else d
                if re.search(r"(?<![\d.])" + re.escape(d_norm) + r"(?!\d)", heard_clean):
                    return True
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

    def _speak_closing_and_hangup(self, explicit_text: Optional[str] = None):
        """Say the closing line ourselves (uninterruptible, so a 'haan haan' backchannel cannot cut it
        off), then hang up only after playout finishes."""
        if self.state.closing_spoken or self._hangup_scheduled:
            return
        self.state.closing_spoken = True
        self._hangup_scheduled = True  # we own the hangup; skip any duplicate or delayed hangup
        text = explicit_text or get_closing_text(self.state)
        if self.log_dialogue_func:
            self.log_dialogue_func("assistant", text)
        else:
            self.state.add_transcript("assistant", text)
            print(f"\n\033[1;36m🤖 [Agent ({AGENT_PERSONA_NAME})]:\033[0m {text}\n", flush=True)
            logger.info(f"🤖 [Agent]: \"{text}\"")

        session = getattr(self.agent, "session", None)
        if not session:
            logger.warning("No agent session available for closing speech; triggering hangup directly.")
            if self.hangup_func:
                asyncio.create_task(self.hangup_func())
            return

        async def _run():
            try:
                handle = say_cached(session, self.state, text, allow_interruptions=False)
                if hasattr(handle, "wait_for_playout"):
                    await handle.wait_for_playout()
                else:
                    await asyncio.sleep(_estimate_speech_duration(text))
            except Exception as e:
                logger.warning(f"Closing speech failed: {e}")
                await asyncio.sleep(_estimate_speech_duration(text))
            await asyncio.sleep(0.5)
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
        """Call when customer confirms interest OR indicates they are thinking about / considering selling, renting, or leasing out (e.g. 'looking to lease out', 'lease out', 'lease', 'rent out', 'sell', 'soch raha hoon', 'sochata rahun', 'thinking about it', 'considering it', 'plan hai').
        Optionally accepts category ('residential'/'commercial') or intent ('sale'/'lease'/'rent') if mentioned."""
        self.state.is_interested = True
        self._apply_standalone()

        # Both customer name and property location are already provided from data/records.
        # It is STRICTLY FORBIDDEN to ask customer name or property location.
        if not self.state.owner_name_confirmed:
            self.state.owner_name_confirmed = (self.state.owner_name or "").strip() or "Sir"

        context_speech = self.state.get_recent_speech_context(max_turns=3)
        detected_cat, detected_int = _grounded(category, intent, context_speech)

        if detected_cat:
            self.state.category = detected_cat
        if detected_int:
            self.state.intent = detected_int

        if not self.state.category:
            self.state.category = "residential"

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
            self.state.has_other_property = False
            self.state.is_interested = False
            self.state.final_disposition = "Not Interested"
            if not self.state.agent_summary:
                self.state.agent_summary = "Customer has no other property to sell or rent"
            await self._go(RealEstateStep.CLOSING)
            return "Customer has no other property. Speak polite closing and thank them for their time."

        self.state.has_other_property = True
        self.state.is_standalone = False  # new property: decide again from what the caller says
        self._apply_standalone()

        if new_location:
            clean_loc = _clean_str(new_location)
            if clean_loc:
                self.state.sector_or_location = clean_loc
                self.state.project_or_society = clean_loc

        context_speech = self.state.get_recent_speech_context(max_turns=3)
        classified_cat, classified_int = _grounded(category, intent, context_speech)
        if classified_cat:
            self.state.category = classified_cat
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
            if self.state.category and not self.state.intent:
                q = (
                    "Are you looking to sell or rent it out?"
                    if self.state.reply_lang == "en"
                    else "Aap ise sell karna chahte hain, ya rent par dena?"
                )
            elif self.state.intent and not self.state.category:
                q = (
                    "Is it a residential or commercial property?"
                    if self.state.reply_lang == "en"
                    else "Ye residential property hai ya commercial?"
                )
            else:
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

        context_speech = self.state.get_recent_speech_context(max_turns=3)
        classified_cat, classified_int = _grounded(category, intent, context_speech)
        if classified_cat:
            self.state.category = classified_cat
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
        if self.state.category and not self.state.intent:
            int_q = "Are you looking to sell or rent it out?" if self.state.reply_lang == "en" else "Aap ise sell karna chahte hain, ya rent par dena?"
            return self._fast(int_q, f"Recorded owner name: {self.state.owner_name_confirmed}. Property category is {self.state.category}. Now ask intent: '{int_q}'", ack="auto")
        if self.state.intent and not self.state.category:
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
        context_speech = self.state.get_recent_speech_context(max_turns=3)
        classified_cat, classified_int = _grounded(category, intent, context_speech)
        if classified_cat:
            self.state.category = classified_cat
        if classified_int:
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
        intent: Optional[str] = None,
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
        said (office, shop, showroom...); never assume it.
        approx_area_sqft: Super area in sq ft. If customer states area in gaj or square yards,
        convert to sq ft (1 gaj = 9 sq ft, e.g. 200 gaj = 1800 sq ft)."""
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
        clean_comm = _clean_str(commercial_type)
        if clean_comm:
            # NEVER assume the unit type: keep only what the caller actually said in their latest words.
            heard = (self.state.last_user_text or "").strip()
            if heard:
                said = commercial_type_from_speech(heard)
                if said:
                    clean_comm = said
                elif clean_comm.lower() in heard.lower():
                    # Caller explicitly mentioned this commercial type in natural speech
                    pass
                else:
                    logger.info(f"Ignoring commercial_type='{clean_comm}' from LLM: caller did not say it ('{heard[:80]}')")
                    clean_comm = None

        clean_intent = classify_intent(intent) if intent else None
        if clean_intent:
            self.state.intent = clean_intent

        # Dynamic category switching and step realignment.
        # If BHK is explicitly mentioned by customer, it is ALWAYS residential
        allow_cat_switch = (not self.state.category) or (self.state.step in (
            RealEstateStep.CATEGORY_SELECT, RealEstateStep.INTRODUCTION,
            RealEstateStep.CHECK_OTHER_PROPERTY, RealEstateStep.ASK_NEW_LOCATION
        ))
        cat_hint = classify_category(category) or (classify_category(clean_comm) if clean_comm else None)
        # If customer or agent explicitly specifies category different from state, allow category switch
        if cat_hint and cat_hint != self.state.category:
            allow_cat_switch = True
        if clean_bhk:
            self.state.category = "residential"
            self.state.commercial_type = None
            self.state.bhk_config = clean_bhk
            if self.state.step in (RealEstateStep.COMMERCIAL_SALE, RealEstateStep.COMMERCIAL_LEASE, RealEstateStep.CATEGORY_SELECT):
                target_step = RealEstateStep.RESIDENTIAL_LEASE if (self.state.intent == "lease") else RealEstateStep.RESIDENTIAL_SALE
                await self._go(target_step)
        elif allow_cat_switch:
            cat_hint = classify_category(category) or (classify_category(clean_comm) if clean_comm else None)
            if clean_comm or cat_hint == "commercial":
                self.state.category = "commercial"
                self.state.bhk_config = None  # Commercial properties never have BHK
                self.state.commercial_type = clean_comm
                if self.state.step in (RealEstateStep.RESIDENTIAL_SALE, RealEstateStep.CATEGORY_SELECT):
                    target_step = RealEstateStep.COMMERCIAL_LEASE if (self.state.intent == "lease") else RealEstateStep.COMMERCIAL_SALE
                    await self._go(target_step)
                elif self.state.step == RealEstateStep.RESIDENTIAL_LEASE:
                    await self._go(RealEstateStep.COMMERCIAL_LEASE)
            elif cat_hint == "residential":
                self.state.category = "residential"
                self.state.commercial_type = None  # Residential properties never have commercial type
                if self.state.step in (RealEstateStep.COMMERCIAL_SALE, RealEstateStep.CATEGORY_SELECT):
                    target_step = RealEstateStep.RESIDENTIAL_LEASE if (self.state.intent == "lease") else RealEstateStep.RESIDENTIAL_SALE
                    await self._go(target_step)
                elif self.state.step == RealEstateStep.COMMERCIAL_LEASE:
                    await self._go(RealEstateStep.RESIDENTIAL_LEASE)
        else:
            # Category is locked during intake branches! Strictly enforce matching slot types.
            if self.state.category == "commercial":
                if not self.state.bhk_config:
                    self.state.bhk_config = None  # Commercial properties never have BHK
                if clean_comm:
                    self.state.commercial_type = clean_comm
            elif self.state.category == "residential":
                self.state.commercial_type = None  # Residential properties never have commercial type
                if clean_bhk:
                    self.state.bhk_config = clean_bhk

        if clean_intent:
            if self.state.category == "residential":
                target_step = RealEstateStep.RESIDENTIAL_LEASE if clean_intent == "lease" else RealEstateStep.RESIDENTIAL_SALE
                if self.state.step in (RealEstateStep.RESIDENTIAL_SALE, RealEstateStep.RESIDENTIAL_LEASE) and self.state.step != target_step:
                    await self._go(target_step)
            elif self.state.category == "commercial":
                target_step = RealEstateStep.COMMERCIAL_LEASE if clean_intent == "lease" else RealEstateStep.COMMERCIAL_SALE
                if self.state.step in (RealEstateStep.COMMERCIAL_SALE, RealEstateStep.COMMERCIAL_LEASE) and self.state.step != target_step:
                    await self._go(target_step)

        if approx_area_sqft is not None:
            try:
                if isinstance(approx_area_sqft, (int, float)):
                    self.state.approx_area_sqft = float(approx_area_sqft)
                else:
                    raw_str = str(approx_area_sqft).replace(',', '').strip()
                    m = re.search(r'([0-9]+(?:\.[0-9]+)?)', raw_str)
                    if m:
                        val = float(m.group(1))
                        # If passed in gaj or square yards, convert to sq ft (1 gaj = 9 sq ft)
                        if re.search(r'\b(gaj|sq\.?\s*yards?|sq\.?\s*yd|square\s*yards?|yards?|yd)\b', raw_str, re.IGNORECASE):
                            val = round(val * 9.0, 2)
                        self.state.approx_area_sqft = val
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
    async def customer_does_not_know(self, field_id: Optional[str] = None, caller_words: Optional[str] = None) -> str:
        """Call when the customer says, in ANY words, that they do not know, do not remember, or cannot/will not
        share the detail that was just asked (e.g. 'pata nahi', 'yaad nahi aa raha', 'iska andaza nahi hai', 'wo
        papers mein dekhna padega'). Do NOT call it when they asked you to repeat or asked a question.
        caller_words: the caller's own words (copied from what they said) that show they don't know."""
        missing = self.state.get_missing_fields()
        heard = (self.state.last_user_text or "").strip()
        if (
            heard and missing
            and not _DONT_KNOW_RE.search(heard.lower()) and not _DONT_KNOW_DEV.search(heard)
            and not _quote_grounded(caller_words, heard)
        ):
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

    def _build_property_summary(self) -> str:
        """Builds a structured summary of all property details captured so far."""
        details = []
        if self.state.category or self.state.intent:
            cat = (self.state.category or "Residential").title()
            intn = "Sale" if self.state.intent == "sale" else "Lease" if self.state.intent == "lease" else ""
            summary_type = f"{cat} {intn}".strip()
            if summary_type:
                details.append(summary_type)
        if self.state.project_or_society:
            loc = f", {self.state.sector_or_location}" if self.state.sector_or_location else ""
            details.append(f"{self.state.project_or_society}{loc}")
        elif self.state.sector_or_location:
            details.append(self.state.sector_or_location)
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
        return "; ".join(details)

    @function_tool
    async def finish_property_intake(self) -> str:
        """Call when all property details have been collected to wrap up."""
        missing = self.state.get_missing_fields()
        if len(missing) > 0 and not getattr(self.state, "impatient_detected", False):
            next_field = missing[0]
            q = next_field["question_en"] if self.state.reply_lang == "en" else next_field["question_hi"]
            return self._fast(q, f"Not all details are collected yet. Smoothly ask: '{q}'")

        self.state.final_disposition = "Qualified Lead"
        prop_summary = self._build_property_summary()
        self.state.agent_summary = prop_summary or "All property details captured successfully"
        await self._go(RealEstateStep.CLOSING)
        return "All details captured! Speak the official closing statement now."

    @function_tool
    async def mark_not_interested(self, caller_words: Optional[str] = None) -> str:
        """Call ONLY when the customer clearly says, in ANY words, that they will not sell/rent (e.g. 'nahi bechna', 'not interested', 'isme mujhe koi interest nahi', 'property pehle hi bik chuki hai', 'mere paas koi property nahi'). NEVER call this if the customer says they are thinking about it, considering, undecided, want a callback, or are merely answering 'no' to a detail question.
        caller_words: the caller's own words (copied from what they said) that show they refuse."""
        heard = (self.state.last_user_text or "").strip()
        grounded = _quote_grounded(caller_words, heard)
        # If caller already confirmed interest to sell/rent, a bare "nahi" / "no" is an answer to a question, not a refusal of service
        if self.state.is_interested or (self.state.intent in ("sell", "rent", "lease")):
            if not ((_EXPLICIT_REFUSAL_PHRASES.search(heard.lower()) if heard else False) or grounded):
                logger.warning(f"🛑 mark_not_interested rejected: caller already confirmed intent ({self.state.intent}), utterance '{heard}' is not an explicit refusal to sell/rent")
                return (
                    "REJECTED: The customer previously confirmed interest to sell/rent. A bare 'no' or 'nahi' is an answer to the current property question, not a refusal to sell. "
                    "Do NOT end the call. Clarify property details or confirm if the property is residential."
                )
        if heard and not (explicit_refusal(heard) or grounded):
            logger.warning(f"🛑 mark_not_interested rejected (no explicit refusal in caller words): '{heard}'")
            return (
                "REJECTED: the caller did NOT clearly refuse. Do NOT end the call. "
                "Re-ask the current open question in simple words."
            )
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
        prop_summary = self._build_property_summary()
        base = f"Callback scheduled for: {slot}"
        self.state.agent_summary = f"{base} | Details: {prop_summary}" if prop_summary else base
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
        prop_summary = self._build_property_summary()
        base = f"Advisor handoff booked: {reason}"
        self.state.agent_summary = f"{base} | Details: {prop_summary}" if prop_summary else base
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
        prop_summary = self._build_property_summary()
        base = f"WhatsApp info requested on: {self.state.whatsapp_number}"
        self.state.agent_summary = f"{base} | Details: {prop_summary}" if prop_summary else base
        await self._go(RealEstateStep.CLOSING)
        return f"WhatsApp info requested for {self.state.whatsapp_number}. Acknowledge and speak closing."

    @function_tool
    async def suppress_contact_dnc(
        self,
        reason: Optional[str] = None,
        caller_words: Optional[str] = None,
    ) -> str:
        """Call ONLY when the customer's own words, in ANY phrasing, ask you to stop calling or remove their number (e.g. 'mujhe call mat karna', 'do not call me', 'meri number list se hata do', 'dobara phone mat karna'). NEVER call it just because the caller is confused, busy or frustrated.
        caller_words: the caller's own words (copied from what they said) that ask to stop the calls."""
        heard = (self.state.last_user_text or "").strip()
        if not (explicit_dnc_request(heard) or _quote_grounded(caller_words, heard)):
            logger.warning(f"🛑 DNC tool call rejected (caller did not ask for it): '{heard}'")
            return (
                "REJECTED: the caller did NOT ask to stop calls or remove their number. Do NOT end the call. "
                "Re-ask the current open question in simple words."
            )
        self.state.is_dnc = True
        self.state.final_disposition = "Do Not Call"
        self.state.agent_summary = f"Customer added to DNC list ({reason or 'Customer requested no further calls'})"
        await self._go(RealEstateStep.CLOSING)
        return "Customer added to Do Not Call (DNC) list. Apologize sincerely and speak closing."

    @function_tool
    async def mark_wrong_number(self) -> str:
        """Call ONLY when the customer explicitly states this is a wrong number, wrong person, or that they are not the named person. NEVER call this when the customer asks to repeat the address or asks which property/location."""
        self.state.final_disposition = "Wrong Number"
        if not self.state.agent_summary:
            self.state.agent_summary = "Wrong number identified by caller"
        await self._go(RealEstateStep.CLOSING)
        return "Wrong number identified. Apologize politely and conclude."

    async def _delayed_hangup(self, agent_text: Optional[str] = None):
        """Wait for closing speech playout through TTS to the caller phone, then disconnect cleanly."""
        if self._hangup_scheduled or self.state.closing_spoken:
            return
        logger.info("Executing closing speech and playout-backed hangup...")
        self._speak_closing_and_hangup(explicit_text=agent_text)

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
        