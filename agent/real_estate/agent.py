import re
import time
import json
import asyncio
import logging
from typing import Optional
from livekit.agents import Agent, StopResponse
from src.carrier_filter import classify_carrier_message
from .prompts import get_step_instructions
from .state import RealEstateState, RealEstateStep, RealEstateStep as _Step
from .config import CHAT_CTX_MAX_ITEMS, FAST_TOOL_REPLY, FASTPATH_ENABLED
from .fastpath import extract as _fastpath_extract
from .tools import (
    classify_category,
    classify_intent,
    is_standalone_from_speech,
    commercial_type_from_speech,
    _DONT_KNOW_RE,
    _DONT_KNOW_DEV,
    extract_question,
    say_cached,
    sell_or_rent_question,
    other_property_question,
    ask_new_location_question,
)

# Extra IVR / voicemail phrases (English + Hinglish + Devanagari). Used IN ADDITION to src.carrier_filter so that
# menus / voicemail prompts the carrier filter misses are still caught instead of being answered by the LLM.
_IVR_EXTRA = re.compile(
    r"(after\s+the\s+(tone|beep)|at\s+the\s+tone|leave\s+(a\s+|your\s+)*(message|voicemail)|record\s+your\s+message|"
    r"(?:forwarded\s+to|reached|leave\s+a\s+message\s+in)\s+(?:the\s+)?(?:voice\s*mail|mail\s*box)|to\s+(repeat|go\s+back)\s+press|"
    r"(for\s+[a-z]+|men[uu])\s*press\s+(star|hash|pound|\d)|"
    r"the\s+(number|person|subscriber|customer)\s+(you\s+are\s+calling|you\s+have\s+dialed)?\s+is\s+(currently\s+)?(not\s+available|busy|unavailable|switched\s+off|reachable)|"
    r"(number|phone)\s+is\s+(switched\s+off|not\s+reachable|out\s+of\s+coverage)|"
    r"(jis\s+vyakti\s+ko\s+aap\s+call\s+kar\s+rahe\s+hain|dial\s+kiya\s+hua\s+number)\s+.*(vyast|switched\s*off|uplabdh\s*nahi)|"
    r"please\s+(stay|hold|wait)\s+on\s+the\s+line|(beep|tone)\s+ke\s+baad\s+(sandesh|message)|"
    r"\u092c\u0940\u092a|\u091f\u094b\u0928\s*\u0915\u0947\s*\u092c\u093e\u0926\s*(\u0938\u0902\u0926\u0947\u0931|\u092e\u0947\u0938\u0947\u091c)|"
    r"\u0921\u093e\u092f\u0932\s*\u0915\u093f\u092f\u093e\s*(\u0917\u092f\u093e|\u0939\u0941\u0906)\s*\u0928\u0902\u092c\u0930|"
    r"(?:\u0928\u0902\u092c\u0930|\u092b\u094b\u0928)\s+.*(?:\u0938\u094d\u0935\u093f\u091a\s*\u0911\u092b))",
    re.I,
)

# Human callback / third-party answering indicators (never an IVR/voicemail machine)
_HUMAN_CALLBACK_RE = re.compile(
    r"\b("
    r"sir|madam|bhaiya|uncle|aunty|papa|mummy|father|mother|brother|sister|husband|wife|boss|owner|"
    r"meeting|baad\s*mein|baad\s*me|call\s*(?:me\s*)?(?:back|later)|later|busy\s*hai|busy\s*hain|"
    r"shaam\s*ko|kal\s*call|subah|abhi\s*nahi|driving|drive\s*kar|office\s*mein|hospital|"
    r"main|maine|mujhe|mere\s*paas|meri|mera|hum|hamara|hamare|apna|apni|"
    r"i\s*am|i'?m|we\s*are|my|me\b|"
    r"kya\s*(?:kaam|baat|chahiye)|batao|bataiye|boliye|kaun\s*bol|sun\s*raha|bol\s*raha|bolo|"
    r"time\s*(?:nahi|nhi|kam)|samay\s*nahi"
    r")\b",
    re.I,
)
# A real person answering the greeting rarely speaks this many words twice in a row; a looping IVR menu does.
_IVR_LONG_WORDS = 30
# While the IVR drop timer is running, only a SHORT reply counts as a human (long text is more IVR).
_IVR_HUMAN_MAX_WORDS = 15


# All known real estate tool names for precise pattern matching and recovery
ALL_RE_TOOLS = {
    "customer_interested",
    "not_interested_in_this_location",
    "has_other_property",
    "set_new_property_location",
    "confirm_owner_name",
    "set_category_and_intent",
    "save_property_details",
    "customer_does_not_know",
    "finish_property_intake",
    "mark_not_interested",
    "schedule_callback",
    "book_advisor_handoff",
    "request_whatsapp_info",
    "suppress_contact_dnc",
    "mark_wrong_number",
}

_TOOL_NAMES_PATTERN = "|".join(sorted(ALL_RE_TOOLS, key=len, reverse=True))

# Leak patterns for tool-call text that the LLM sometimes types instead of calling the tool.
_LEAK_PATTERNS = [
    re.compile(r"<(?:function|tool_call|call)[^>]*>.*?(?:</(?:function|tool_call|call)>|$)", re.S | re.I),
    re.compile(r"</?(?:function|tool_call|call)[^>]*>?", re.I),
    re.compile(r"(?i)\bset\s+category\s+and\b.*$", re.S),
    # Tool call with arguments (parentheses, braces, >, :, or Python kwargs)
    re.compile(r"\b(?:" + _TOOL_NAMES_PATTERN + r"|[a-z]+(?:_[a-z0-9]+)+)\s*(?:[\(\{>:].*?[\)\}]|>[^\s]+)", re.S | re.I),
    # Lone tool names or snake_case identifiers
    re.compile(r"\b(?:" + _TOOL_NAMES_PATTERN + r")\b", re.I),
    re.compile(r"\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b"),
    # Any residual JSON or dictionary blobs or XML tags
    re.compile(r"[>:]?\s*\{[^{}]*\}", re.S),
    re.compile(r"^\s*\{.*$", re.S),
    re.compile(r"</?[a-zA-Z0-9_:-]+[^>]*>", re.S),
]


def _clean_leaks(s: str) -> str:
    for p in _LEAK_PATTERNS:
        s = p.sub('', s)
    return s.strip("` \n\t")


def _call_open(buf: str) -> bool:
    """True while a call-like region ((...), {...}, <function>..., <tool_call>...) is still unclosed."""
    if "<function" in buf and "</function>" not in buf:
        return True
    if "<tool_call" in buf and "</tool_call>" not in buf:
        return True
    return any(buf.count(a) > buf.count(b) for a, b in (("(", ")"), ("{", "}"), ("<", ">")))


def _soften_tts_phrase(s: str) -> str:
    """Soften abrupt single-word affirmations and mid-sentence period stops so the TTS engine speaks smoothly with natural human cadence."""
    # 1. Opening affirmations with trailing period -> comma pause
    s = re.sub(r'^(Achha|Theek hai|Haanji|Haan ji|Samajh gayi|Got it|Sure|Perfect|Noted|Understood|Alright|Right)\.\s*', r'\1, ', s, flags=re.I)
    # 2. Never allow '[Name] Sir' (e.g. 'Raja Sir' -> 'Raja')
    s = re.sub(r'\b(?!Hello\b|Yes\b|No\b|Thank\b|Thanks\b|Right\b|Sure\b|Sorry\b|Please\b|Okay\b|Alright\b)([A-Z][a-z]+)\s+[Ss]ir\b', r'\1', s)
    # 3. Mid-sentence honorific stops ("got it, Sir. And..." -> "got it, Sir... And...")
    s = re.sub(r'(,\s*Sir|\bSir|\bji)\.\s+([A-Z])', r'\1... \2', s)
    # 4. Exclamations to natural breathing pauses
    s = s.replace("!", "... ")
    # 5. Collapse accidental multiple spaces
    s = re.sub(r'[ \t]{2,}', ' ', s)
    return s.strip()


logger = logging.getLogger("real-estate-agent")

# ── Recovery for "tool call typed as plain text" ──────────────────────────────
# Llama sometimes prints {"name": "save_property_details", "parameters": {...}} or
# customer_interested>{"intent": "sale"} or not_interested_in_this_location as its reply instead
# of making a real tool call.
_TEXT_CALL_RE = re.compile(
    r"^\s*[`]*(?:\{|<function|<tool_call|<call:|"
    + r"(?:" + _TOOL_NAMES_PATTERN + r")\b|"
    + r"[a-z]+(?:_[a-z0-9]+)+\s*[\(\{>:~])",
    re.I
)

# get_missing_fields() ids -> save_property_details parameter names
_FIELD_TO_PARAMS = {
    "location": ("sector_or_location",),
    "society_sector": ("project_or_society",),
    "project_sector": ("project_or_society",),
    "unit_floor": ("unit_number", "floor_number"),
    "bhk_config": ("bhk_config",),
    "commercial_type": ("commercial_type",),
    "approx_area": ("approx_area_sqft",),
    "furnishing": ("furnishing_status",),
    "sale_price": ("expected_sale_price",),
    "monthly_rent": ("expected_monthly_rent",),
    "immediate_occupancy": ("immediate_occupancy",),
    "leased_status": ("is_currently_leased",),
    "current_rent": ("current_rent_received",),
}

# Short utterances that must NOT flip the reply language (e.g. 'Hello.' flipped Hindi -> English).
_NEUTRAL_UTTERANCES = {
    "hello", "hi", "hey", "helo", "hallo", "ok", "okay", "yes", "no", "hmm", "haan", "han", "ji",
    "haanji", "haan ji", "हेलो", "हैलो", "हेल्लो", "हाँ", "हां", "जी", "हम्म", "ओके",
    "ya", "yeah", "yep", "yup", "ha", "yes yes", "yes yes yes", "haan haan", "han han", "ji ji",
    "ok ok", "okay okay", "yes sir", "ji haan", "haan ji haan", "hmm hmm", "hello hello",
}


def _is_neutral_utterance(text: str) -> bool:
    t = re.sub(r"[\s.,?!\u0964]+", " ", (text or "").lower()).strip()
    return t in _NEUTRAL_UTTERANCES


def _simplified_reask(en: bool, kind: str, n: int):
    """Never repeat the identical question word-for-word: a caller who answered 'yes, yes' to an either/or
    question needs it rephrased as a plain choice. n = 1 for the first re-ask, 2 for the second."""
    table = {
        ("intent", True): ("Just to confirm, is it for sale, or for rent?",
                           "Sorry Sir, would you like to sell it, or give it on rent?"),
        ("intent", False): ("Bas confirm karna tha, sale ke liye hai ya rent ke liye?",
                            "Maaf kijiye Sir, aap ise bechna chahte hain ya kiraye par dena?"),
        ("category", True): ("Just to confirm, is it a flat or house, or a shop or office?",
                             "Sorry Sir, is it a home, or a commercial place like a shop or office?"),
        ("category", False): ("Bas confirm karna tha, ye ghar ya flat hai, ya dukaan ya office?",
                              "Maaf kijiye Sir, ye rehne ki property hai, ya commercial jaise dukaan ya office?"),
    }
    opts = table.get((kind, en))
    if not opts:
        return None
    return opts[min(n, len(opts)) - 1]


def _bump_reask(state, key: str) -> int:
    """Count consecutive re-asks of the SAME open question (a different question resets the count)."""
    if state.reask_key == key:
        state.reask_count += 1
    else:
        state.reask_key, state.reask_count = key, 1
    return state.reask_count


def _intake_slot_nudge(en: bool, field_id: str, n: int) -> str:
    """Natural, progressive response to neutral backchannels ('haan', 'ji', 'hmm') during intake.
    n = 1: gentle micro-nudge ('Ji Sir, batayein?' / 'Yes Sir, please go ahead?')
    n = 2: concise reminder for that specific slot
    """
    if n <= 1:
        return "Yes Sir, please go ahead?" if en else "Ji Sir, batayein?"

    short_reminders = {
        ("bhk_config", True): "How many BHK would that be, Sir?",
        ("bhk_config", False): "Kitne BHK hai Sir?",
        ("approx_area", True): "Roughly how much square feet area, Sir?",
        ("approx_area", False): "Lagbhag kitna area hoga Sir, square feet mein?",
        ("unit_floor", True): "Which floor and unit number is it, Sir?",
        ("unit_floor", False): "Floor aur unit number kya hai Sir?",
        ("furnishing", True): "Is it semi-furnished, fully furnished, or unfurnished?",
        ("furnishing", False): "Semi-furnished hai Sir, fully furnished ya unfurnished?",
        ("sale_price", True): "Roughly what price are you expecting, Sir?",
        ("sale_price", False): "Lagbhag kitna expected price hai Sir?",
        ("monthly_rent", True): "Roughly what monthly rent are you expecting, Sir?",
        ("monthly_rent", False): "Lagbhag kitna monthly rent expect kar rahe hain?",
        ("commercial_type", True): "Is it an office space, retail shop, or another commercial unit?",
        ("commercial_type", False): "Office space hai Sir, retail shop, ya koi aur unit?",
    }
    return short_reminders.get((field_id, en)) or ("Could you share that detail, Sir?" if en else "Wo detail share kar sakte hain Sir?")


# ── Scenario B helpers (deterministic, no LLM) ────────────────────────────────
def _tokens(text: str):
    return [t for t in re.split(r"[\s.,?!;:\"'\u2018\u2019\u0964\-]+", (text or "").lower()) if t]


def _variants(text: str):
    """The text itself plus, for Devanagari (Sarvam STT often returns it), a romanised copy."""
    cands = [text or ""]
    if re.search(r"[\u0900-\u097F]", text or ""):
        try:
            from src.transliteration import romanize_hindi
            cands.append(romanize_hindi(text))
        except Exception:
            pass
    return cands


# Caller refuses THIS property/location ("us location pe nahi bechna", "wahan ka nahi", "not at that location").
# A plain "not interested" is NOT this: that closes the call.
_LOC_REJECT_LATIN = re.compile(
    r"((?<![a-z])(us|uss|is|iss|wo|woh|vo|wahan|waha|vahan|yahan|yaha)\s+(wali\s+|wala\s+)?"
    r"(location|jagah|jagha|property|address|place|flat|ghar|makaan|makan)\s*(pe|par|per|ko|ki|ka|ke|mein|me)?\s*(bhi\s+)?(nahi|nhi|nahin)"
    r"|(?<![a-z])(wahan|waha|vahan|yahan|yaha)\s*(ka|ki|ke|pe|par|per)?\s*(bhi\s+)?(nahi|nhi|nahin)"
    r"|(?<![a-z])(ye|yeh|woh|wo|vo)\s+wali\s+(nahi|nhi|nahin)"
    r"|\bnot\s+(at|on|for|in)\s+(that|this|the)\s+(location|property|address|place|one)"
    r"|\bnot\s+(that|this)\s+(location|property|address|place|one))"
)
_LOC_REJECT_DEV = re.compile(
    "((उस|इस|वो|वह)\\s*(वाली\\s*)?(लोकेशन|जगह|प्रॉपर्टी|प्रोपर्टी|एड्रेस|फ्लैट|घर|मकान)\\s*(पे|पर|को|की|का|के|में)?\\s*(भी\\s*)?(नहीं|नही)"
    "|(वहाँ|वहां|यहाँ|यहां)\\s*(का|की|के|पे|पर)?\\s*(भी\\s*)?(नहीं|नही)"
    "|(ये|यह|वो|वह)\\s*वाली\\s*(नहीं|नही))"
)


def _rejects_this_location(text: str) -> bool:
    if not text:
        return False
    for c in _variants(text):
        if _LOC_REJECT_DEV.search(c) or _LOC_REJECT_LATIN.search((c or "").lower()):
            return True
    return False


# Caller lives in the property himself ("hum khud rahte hain usmein", "we stay there", "apna ghar hai").
# That is neither sell nor rent: treated like refusing THIS property -> "any other property?".
_SELF_OCC_LATIN = re.compile(
    r"(khud\s+(hi\s+)?(reh|rah)\w*|(reh|rah)\w*\s*(hain|hai|hu|hoon)?\s*khud\b"
    r"|(hum|ham|main|mai)\s+(hi\s+)?(yahin|yahan|yaha|usi\s*mein|usmein|isi\s*mein|usme|isme)?\s*(reh|rah)\w*\s*(hain|hai|hu|hoon|hun)\b"
    r"|apna\s+(ghar|makaan|makan|flat)\b|own\s+use|self\s*[- ]?occup\w*"
    r"|we\s+(live|stay)\s+(in|there|here)|i\s+(live|stay)\s+(in|there|here))",
    re.I,
)
_SELF_OCC_DEV = re.compile(
    r"(खुद\s*(ही\s*)?रह|(हम|मैं)\s*(ही\s*)?(यहीं|यहाँ|यहां|उसमें|इसमें)?\s*रह\w*\s*(हैं|है|हूँ|हूं)|अपना\s*(घर|मकान|फ्लैट))"
)


def _is_self_occupied(text: str) -> bool:
    if not text:
        return False
    for c in _variants(text):
        if _SELF_OCC_DEV.search(c) or _SELF_OCC_LATIN.search((c or "").lower()):
            return True
    return False


_NEG_TOKENS = {"nahi", "nahin", "nhi", "nahii", "no", "nope", "nah", "not", "never", "nothing", "none",
               "नहीं", "नही", "नहि", "नो"}
_STRONG_AFF = {"haan", "han", "haa", "ha", "haanji", "hanji", "yes", "yeah", "yep", "yup", "bilkul", "zaroor", "sure",
               "हाँ", "हां", "हा", "हांजी", "हाँजी", "यस", "येस", "बिल्कुल", "ज़रूर", "जरूर"}
_HAI = {"hai", "hain", "है", "हैं"}
_OTHER_WORDS = {"doosri", "dusri", "doosra", "dusra", "another", "other", "दूसरी", "दूसरा"}
_BARE_NEG_FILL = {"ji", "jee", "sir", "toh", "to", "bhi", "abhi", "bas", "theek", "thik", "ok", "okay",
                  "जी", "सर", "तो", "भी", "अभी", "बस", "ठीक", "ओके"} | _HAI

_EXPLICIT_NO_OTHER = re.compile(
    r"\b(koi\s*(aur|bhi|dusri|doosri)?\s*(nahi|nhi|nahin)|aur\s*koi\s*(nahi|nhi|nahin)|aur\s*(nahi|nhi|nahin)"
    r"|(doosr[ia]|dusr[ia])\s*(wali\s*)?(nahi|nhi|nahin)"
    r"|no\s+other|nothing\s+else|no\s+more|none\s+other|don'?t\s+have\s+any(\s+other)?)\b"
    r"|\b(sirf|bas)\s*(ek|yehi|yahi|wohi|wahi)\s*(hi)?\s*(thi|tha|hai|hoga|property)?\b"
    r"|(कोई\s*और\s*(नहीं|नही)|और\s*कोई\s*(नहीं|नही)|और\s*(नहीं|नही)|दूसरी\s*(नहीं|नही)|सिर्फ\s*एक|बस\s*यही|बस\s*एक)",
    re.I,
)

_HAS_OTHER_PHRASE = re.compile(
    r"\b(ek\s+aur|doosr[ia]|dusr[ia]|another|one\s+more|one\s+other|aur\s+bhi|other\s+one)\b"
    r"|(एक\s*और|दूसर[ीा]|कोई\s*और\s*है|एक\s*और\s*है)",
    re.I,
)

_LOCATION_OR_SPECIFIC = re.compile(
    r"\b(sector|sec|phase|block|pocket|plot|flat|unit|floor|noida|gurgaon|delhi|faridabad|ghaziabad|societ|apart)\b"
    r"|(सेक्टर|फेज|ब्लॉक|पॉकेट|प्लॉट|फ्लैट|यूनिट|फ्लोर|नोएडा|गुड़गांव|गुड़गांव|दिल्ली|सोसायटी)",
    re.I,
)


def _other_property_answer(text: str):
    """Answer to "do you have any other property?": True / False when it is a clean yes / no,
    None when there is more in it (a location, a category...) -> the LLM + tool handle it."""
    if not text:
        return None
    for c in _variants(text):
        toks = _tokens(c)
        if not toks or len(toks) > 10:
            continue

        # If caller mentions a location or specific property detail, always delegate to LLM
        if _LOCATION_OR_SPECIFIC.search(c):
            return None

        has_neg = any(t in _NEG_TOKENS for t in toks)
        strong_aff = any(t in _STRONG_AFF for t in toks)
        has_other_phrase = bool(_HAS_OTHER_PHRASE.search(c))
        explicit_no = bool(_EXPLICIT_NO_OTHER.search(c))

        # Explicit refusal of another property (e.g. "koi aur nahi hai", "sirf ek hi thi", "doosri nahi hai")
        if explicit_no and not strong_aff and not (has_other_phrase and re.search(r"\b(ek\s+aur|one\s+more)\b", c, re.I)):
            return False

        # Bare negative: only neg tokens and simple fillers (e.g. "nahi", "no sir", "nahi ji", "nahi hai")
        if has_neg and not strong_aff and not has_other_phrase:
            if all(t in _NEG_TOKENS or t in _BARE_NEG_FILL for t in toks):
                return False

        # Positive: caller explicitly mentions having another property (e.g. "ek aur hai", "nahi, ek aur hai", "doosri hai")
        if has_other_phrase and not explicit_no:
            return True

        # Clean strong affirmation without negation (e.g. "haan", "yes", "haanji", "sure")
        if strong_aff and not has_neg:
            return True

    return None


_REFUSAL_FILL = {"toh", "to", "ji", "jee", "sir", "abhi", "bilkul", "bas", "kuch", "kuchh", "bhi", "yar", "yaar", "bhai", "तो", "जी", "सर", "अभी", "बिल्कुल", "कुछ"}
_DIRECT_NOT_INTERESTED = re.compile(
    r"\b(not\s+interested|nahi\s+bechna|nahi\s+dena|nahi\s+chahiye|nahi\s+karna|nahi\s+karne|kat\s+karo|kaat\s+do|kaato|kaat\s*karo|call\s+kaat[a-z]*|phone\s+kaat[a-z]*|cut\s+the\s+call|abhi\s+kuch\s+nahi|abhi\s+kuchh\s+nahi|kuch\s+nahi|kuchh\s+nahi|abhi\s+nahi)\b"
    r"|(नॉट\s*इंटरेस्टेड|नहीं\s*बेचना|नहीं\s*देना|नहीं\s*चाहिए|कॉल\s*काटो|काट\s*दो|कुछ\s*नहीं|अभी\s*नहीं)",
    re.I,
)


def _is_bare_refusal(text: str) -> bool:
    """A plain "nahi" / "nahi ji" / "toh nahi" / "no sir" with nothing else: general refusal to selling/renting,
    so mark_not_interested() is executed deterministically without an LLM round trip (~1.3s saved)."""
    for c in _variants(text):
        toks = _tokens(c)
        if not toks or len(toks) > 4:
            continue
        if any(t in _STRONG_AFF for t in toks):
            continue
        if any(t in _NEG_TOKENS for t in toks) and all(t in _NEG_TOKENS or t in _REFUSAL_FILL for t in toks):
            return True
    return False


def _starts_with_negation(text: str) -> bool:
    toks = _tokens(text)
    return bool(toks) and toks[0] in _NEG_TOKENS


_GREETING_ACK_RE = re.compile(
    r"^(yes|yeah|yep|yup|haan|han|haanji|hanji|haan\s*ji|ji\s*haan|ji|hello|hi|hey|"
    r"((haan|han|haanji|hanji|haan\s*ji|ji|yes)\s+)?(boliye|bataiye|kahiye|tell\s+me|speaking|sun\s*raha\s*hoon|sun\s*rahi\s*hoon)|"
    r"boliye|ji\s*boliye|bataiye|ji\s*bataiye|kahiye|ji\s*kahiye|tell\s+me|yes\s+tell\s+me|who\s+is\s+this|"
    r"who\s+are\s+you|who's\s+this|who's\s+calling|who\s+is\s+calling|who\s+is\s+speaking|"
    r"kaun|kaun\s+bol\s+rahe\s+ho|kaun\s+bol\s+raha\s+hai|kaun\s+hai|kahan\s+se\s+bol\s+rahe\s+ho|"
    r"speaking|yes\s+speaking|haan\s+sun\s+raha\s+hoon|sun\s+raha\s+hoon|kya\s+kaam\s+hai|"
    r"kya\s+baat\s+hai|kya\s+hua|ok|okay|alright|yes\s+please)[\s.?!,]*$",
    re.IGNORECASE
)
_GREETING_ACK_DEV = re.compile(
    r"^(हाँ|हां|हा|हाँजी|हांजी|जी|यस|येस|हेलो|हाय|बोलिए|जी\s*बोलिए|बताइए|जी\s*बताइए|कहिए|"
    r"कौन|कौन\s*बोल\s*रहा\s*है|कौन\s*हो|सुन\s*रहा\s*हूँ|सुन\s*रहा\s*हूं|क्या\s*काम\s*है|क्या\s*बात\s*है|ओके)[\s.?!,]*$"
)


def _is_greeting_ack(text: str) -> bool:
    if not text:
        return False
    t = text.strip()
    return bool(_GREETING_ACK_RE.match(t) or _GREETING_ACK_DEV.match(t))


_PICKUP_OR_IDENTITY_RE = re.compile(
    r"(who\s+(is\s+this|are\s+you|is\s+speaking|is\s+calling)|who's\s+(this|calling)|"
    r"where\s+are\s+you\s+calling\s+from|which\s+company|"
    r"what\s+(is\s+this\s+regarding|do\s+you\s+want|is\s+the\s+matter)|"
    r"kaun\s*(hai|bol\s*rahe|bol\s*raha|hai\s*ye|ho)|kisko\s*(lagaya|phone|call)|"
    r"kisse\s*baat|kahan\s*se\s*(bol|call)|konsi\s*company|"
    r"kya\s*(kaam|baat|mamla)\s*hai|kyun\s*phone\s*kiya|kis\s*baare\s*mein|"
    r"^\s*(hello|halo|hi|hey|haan\s*hello|yes\s*hello)[\s.?!,]*$)",
    re.IGNORECASE
)
_PICKUP_OR_IDENTITY_DEV = re.compile(
    r"(कौन\s*(है|बोल\s*रहे|हो)|किससे\s*बात|कहाँ\s*से|क्या\s*काम\s*है|क्यों\s*फोन|हेलो|हाय)"
)


def _is_pickup_or_identity_query(text: str) -> bool:
    if not text:
        return False
    t = text.strip()
    return bool(_PICKUP_OR_IDENTITY_RE.search(t) or _PICKUP_OR_IDENTITY_DEV.search(t))


# ── Caller asks US for the price/rate ("kya rate chal raha hai? kitne mein bech sakte hain?") ──
# Handled deterministically (no LLM): speak valuation line + short thank-you, then hang up.
_PRICE_Q_LATIN = re.compile(
    r"(kya\s+(rate|price|bhav|bhaav|value|daam|dam)\b"
    r"|\b(rate|price|bhav|bhaav|daam|dam|value)\s+(kya|kitna|kitni|chal\s*raha|chal\s*rha|chalega)"
    r"|(kya|kitna|kitni|batao|bataiye|what\s+(is|are|'s)(\s+the)?)\s+.*market\s+(rate|price|value)"
    r"|market\s+(rate|price|value)\s+(kya|kitna|kitni|chal\s*raha|batao|bataiye)"
    r"|kitn[ae]\s+(me|mein|main)\s+(bech|bik|sell)"
    r"|kitn[ae]\s+(milega|mil\s*sakta|mil\s*jayega|mil\s*jaayega)"
    r"|how\s+much\s+(can|will|would|do|should)"
    r"|what\s+(is|are|'s)\s+(the\s+)?(rate|price|value)"
    r"|what\s+price|valuation)",
    re.I,
)
_PRICE_Q_DEV = re.compile(
    r"(क्या\s*(रेट|प्राइस|भाव|कीमत|दाम|वैल्यू)"
    r"|(रेट|प्राइस|भाव|कीमत|दाम)\s*(क्या|कितना|कितनी|चल)"
    r"|(क्या|कितना|बताओ|बताइए)\s*.*मार्केट\s*(रेट|प्राइस|वैल्यू)"
    r"|मार्केट\s*(रेट|प्राइस|भाव|वैल्यू)\s*(क्या|कितना|कितनी|चल|बताओ|बताइए)"
    r"|कितने\s*में\s*(बेच|बिक)"
    r"|कितना\s*मिलेगा|वैल्यूएशन)"
)
_MARKET_RATE_ANSWER_LATIN = re.compile(
    r"\b(jo\s+(bhi\s+)?|as\s+per\s+|according\s+to\s+)?"
    r"market\s+(rate|price|value)"
    r"(\s+(pe|par|me|mein|main|hi|hai|hoga|chal\s*raha\s*hai|de\s*denge|chahiye|bik\s*jaye|mil\s*jaye))?\b",
    re.I,
)
_MARKET_RATE_ANSWER_DEV = re.compile(
    r"(जो\s*(भी\s*)?|के\s*अनुसार\s*)?"
    r"मार्केट\s*(रेट|प्राइस|भाव|वैल्यू)"
    r"(\s*(पे|पर|में|ही|है|होगा|चल\s*रहा\s*है|दे\s*देंगे|चाहिए))?",
    re.I,
)
_HAS_AMOUNT = re.compile(r"[0-9०-९]|lakh|lac\b|crore|cr\b|लाख|करोड़|करोड", re.I)


def _is_market_rate_statement(text: str) -> bool:
    """True when caller is stating 'market rate' as their expectation (not asking what it is)."""
    if not text:
        return False
    low = text.lower().strip()
    if re.search(r"\b(kya|kitn[aei]|what\s+is|batao|bataiye)\b", low):
        return False
    if re.search(r"(क्या|कितना|कितनी|कितने|बताओ|बताइए)", text):
        return False
    return bool(_MARKET_RATE_ANSWER_LATIN.search(low) or _MARKET_RATE_ANSWER_DEV.search(text))


def _asks_agent_for_price(text: str) -> bool:
    """True when the caller is ASKING for a rate/valuation (not stating their own expected price)."""
    if not text or _HAS_AMOUNT.search(text):
        return False
    if _is_market_rate_statement(text):
        return False
    if _PRICE_Q_DEV.search(text):
        return True
    cands = [text]
    try:
        from src.transliteration import romanize_hindi
        cands.append(romanize_hindi(text))
    except Exception:
        pass
    return any(_PRICE_Q_LATIN.search((c or "").lower()) for c in cands)


# ── Caller asks us to REPEAT the last question ("aapne pichhle kya puchha tha?") ──
# Previously the LLM treated this as "don't know" and silently skipped the open field.
# Handled deterministically: re-ask the currently open question, no tool call.
_REPEAT_LATIN = re.compile(
    r"(kya\s+(pu|poo)\w*"
    r"|kya\s+(bola|bole|kaha|kaho)\b"
    r"|pich\w*\s+kya"
    r"|pehle\s+kya"
    r"|phir\s+se|fir\s+se|dobara|dubara|ek\s+baar\s+(aur|phir)"
    r"|samajh\s+nahi|samjha\s+nahi|sun\s+nahi|suna\s+nahi"
    r"|\brepeat\b|say\s+again|\bpardon\b|what\s+did\s+you\s+(say|ask)|what\s+was\s+the\s+question"
    # STT often garbles "repeat" on phone lines ("Parali, please" in a real call), and callers say these too
    r"|\bre+p[ei]+a?t\w*|\bri+p[ei]+a?t\w*|\bpa+r[ae]li\b"
    r"|once\s+more|one\s+more\s+time|come\s+again|again\s+please|phir\s+bolo|fir\s+bolo|dobara\s+bolo)",
    re.I,
)
_REPEAT_DEV = re.compile(
    r"(क्या\s*(पूछ|पुछ|बोल|कहा)|पिछले\s*क्या|पहले\s*क्या|दोबारा|फिर\s*से|रिपीट|समझ\s*नहीं|सुन\s*नहीं)"
)


def _asks_repeat(text: str) -> bool:
    if not text:
        return False
    if _REPEAT_DEV.search(text):
        return True
    cands = [text]
    try:
        from src.transliteration import romanize_hindi
        cands.append(romanize_hindi(text))
    except Exception:
        pass
    return any(_REPEAT_LATIN.search((c or "").lower()) for c in cands)


_LOC_CLARIFY_LATIN = re.compile(
    r"(which\s+(property|location|address|place|flat)|where\s+is\s+it|what\s+address|"
    r"tell\s+me\s+(the\s+)?property|property\s+details?|kahan\s+(pe|par|per|hai)|"
    r"(konsi|kaunsi|kounsi|kisi)\s+(property|jagah|location|address|flat)|"
    r"konsa\s+flat|kaun\s+sa\s+flat|kiski\s+baat)",
    re.I,
)
_LOC_CLARIFY_DEV = re.compile(
    r"(कौनसी|कौन\s*सी|कहाँ|कहां|किस\s*(जगह|लोकेशन|एड्रेस|प्रॉपर्टी|फ्लैट)|प्रॉपर्टी\s*डिटेल्स)"
)


def _asks_location_clarification(text: str) -> bool:
    if not text:
        return False
    if _LOC_CLARIFY_DEV.search(text):
        return True
    cands = [text]
    try:
        from src.transliteration import romanize_hindi
        cands.append(romanize_hindi(text))
    except Exception:
        pass
    return any(_LOC_CLARIFY_LATIN.search((c or "").lower()) for c in cands)


_NUMBER_SOURCE_RE = re.compile(
    r"(number\s+(kahan|kidhar|kaise|kisne)|kahan\s+se\s+mila|kisne\s+diya|"
    r"where\s+did\s+you\s+get\s+(my\s+)?number|how\s+did\s+you\s+get\s+(my\s+)?number|"
    r"who\s+gave\s+(you\s+)?(my\s+)?number)",
    re.I,
)
_NUMBER_SOURCE_DEV = re.compile(
    r"(नंबर\s*(कहाँ|कहां|किसने|कैसे)|कहाँ\s*से\s*मिला|किसने\s*दिया)"
)


def _asks_number_source(text: str) -> bool:
    if not text:
        return False
    if _NUMBER_SOURCE_DEV.search(text):
        return True
    cands = [text]
    try:
        from src.transliteration import romanize_hindi
        cands.append(romanize_hindi(text))
    except Exception:
        pass
    return any(_NUMBER_SOURCE_RE.search((c or "").lower()) for c in cands)


_BROKER_Q_LATIN = re.compile(
    r"(are\s+you\s+(a\s+)?(broker|dealer|agent|property\s+dealer)"
    r"|(broker|dealer|agent|property\s+dealer)\s+(ho|hai|hain|kya)"
    r"|kya\s+aap\s+(broker|dealer|agent|property\s+dealer)"
    r"|aap\s+(broker|dealer|agent|property\s+dealer)"
    r"|broker\s+ho\s+ya"
    r"|are\s+you\s+(direct\s+)?buyers?\s+or\s+brokers?)",
    re.I,
)
_BROKER_Q_DEV = re.compile(
    r"(क्या\s*आप\s*(ब्रोकर|दलाल|डीलर|एजेंट)|(ब्रोकर|दलाल|डीलर|एजेंट)\s*(हो|हैं|है|क्या))"
)


def _asks_if_broker(text: str) -> bool:
    if not text:
        return False
    if _BROKER_Q_DEV.search(text):
        return True
    cands = [text]
    try:
        from src.transliteration import romanize_hindi
        cands.append(romanize_hindi(text))
    except Exception:
        pass
    return any(_BROKER_Q_LATIN.search((c or "").lower()) for c in cands)


_CONSIDERING_LATIN = re.compile(
    r"\b(soch\s*(raha|rahe|rahi|ta|te|ti|at[ae]|na|un)|thinking|considering|plan\s*(hai|kar)|dekh\s*(raha|rahe|te))\b",
    re.I,
)
_CONSIDERING_DEV = re.compile(
    r"(सोच\s*(रहा|रहे|रही|ता|ते|ना)|प्लान|देख\s*(रहे|रहा))"
)


def _is_considering(text: str) -> bool:
    if not text:
        return False
    if _CONSIDERING_DEV.search(text):
        return True
    cands = [text]
    try:
        from src.transliteration import romanize_hindi
        cands.append(romanize_hindi(text))
    except Exception:
        pass
    return any(_CONSIDERING_LATIN.search((c or "").lower()) for c in cands)


def _chunk_text(chunk):
    """Text carried by an llm_node chunk (str or ChatChunk); None for tool-call/empty chunks."""
    if isinstance(chunk, str):
        return chunk
    delta = getattr(chunk, "delta", None)
    return getattr(delta, "content", None) if delta else None


def _chunk_has_tool_call(chunk) -> bool:
    """True for a genuine (structured) tool-call chunk."""
    if isinstance(chunk, str):
        return False
    delta = getattr(chunk, "delta", None)
    return bool(delta and getattr(delta, "tool_calls", None))


# A tool call typed as text ANYWHERE in the reply (not just at the start), e.g.
# "Third floor, noted Sir. <function=save_property_details>{...}</function> Is the property leased?"
# or "customer_interested>{\"intent\": \"sale\"}" or "mark_not_interested"
_INLINE_CALL_RE = re.compile(
    r"<function[=\s>]"
    r"|<tool_call"
    r"|<call:[a-z_]+"
    r"|\"name\"\s*:\s*\"[a-z]+(?:_[a-z0-9]+)+\""
    r"|\b(?:" + _TOOL_NAMES_PATTERN + r")\b"
    r"|\b[a-z]+(?:_[a-z0-9]+)+\s*[\(\{>:]",
    re.I
)


def _parse_text_tool_call(raw: str):
    """Best-effort parse of a text-typed tool call, tolerant of truncated JSON or python kwargs."""
    raw_clean = (raw or "").strip("` \n\t")
    name = None
    # 1. JSON name
    m = re.search(r'"name"\s*:\s*"([A-Za-z_]\w*)"', raw_clean)
    if m:
        name = m.group(1)
    if not name:
        m = (
            re.search(r'<function[=\s]([A-Za-z_]\w*)', raw_clean)
            or re.search(r'<call:([A-Za-z_]\w*)', raw_clean)
            or re.search(r'\b(' + _TOOL_NAMES_PATTERN + r')\b', raw_clean)
            or re.match(r'\s*([a-z]+(?:_[a-z0-9]+)+)\b', raw_clean)
        )
        if m:
            name = m.group(1)

    if not name:
        return None, {}

    args = {}
    # 2. Try JSON object in raw
    json_match = re.search(r'\{[^{}]*\}', raw_clean, re.DOTALL)
    if json_match:
        j_str = json_match.group(0)
        try:
            parsed = json.loads(j_str)
            if isinstance(parsed, dict):
                args.update(parsed)
        except Exception:
            try:
                import ast
                parsed = ast.literal_eval(j_str)
                if isinstance(parsed, dict):
                    args.update(parsed)
            except Exception:
                pass

    # 3. Try python kwarg style key=val or key="val" or key='val'
    if not args:
        matches = re.findall(
            r'(\w+)\s*=\s*(?:["\'](.*?)["\']|([0-9]+(?:\.[0-9]+)?)|(True|False|None))',
            raw_clean
        )
        for k, s_val, num_val, bool_val in matches:
            if s_val:
                args[k] = s_val
            elif num_val:
                args[k] = float(num_val) if "." in num_val else int(num_val)
            elif bool_val:
                args[k] = True if bool_val == "True" else (False if bool_val == "False" else None)

    # 4. Fallback regex for "key": "value"
    if not args:
        pm = re.search(r'"(?:parameters|arguments)"\s*:\s*\{(.*)', raw_clean, re.S)
        body = pm.group(1) if pm else raw_clean
        for k, v in re.findall(r'"(\w+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)', body):
            if k == "name" or v == "null":
                continue
            if v.startswith('"'):
                try:
                    val = json.loads(v)
                except Exception:
                    val = v.strip('"')
            elif v in ("true", "false"):
                val = v == "true"
            else:
                val = float(v) if "." in v else int(v)
            args[k] = val

    args.pop("name", None)
    return name, args


class RealEstateAgent(Agent):
    """Voice agent for My Estate Finder property intake."""

    def __init__(self, state: RealEstateState, tools_instance):
        self._re_state = state
        self._re_tools = tools_instance
        self.on_language_change = None
        self._ivr_task: Optional[asyncio.Task] = None
        self._ivr_kind: Optional[str] = None
        self._ivr_long_turns = 0
        super().__init__(
            instructions=get_step_instructions(state),
            tools=tools_instance.tools_for_step(state.step),
        )

    async def _drop_ivr_immediately(self, kind: str, text: str):
        try:
            if self._re_state.hangup_started:
                return
            logger.warning(f"📵 IVR / Voicemail detected ({kind}): '{text[:100]}'. Dropping call immediately.")
            self._re_state.ivr_detected = True
            self._re_state.final_disposition = "Voicemail or IVR Detected"
            self._re_state.agent_summary = f"Voicemail or IVR Detected: {text[:100]}"
            try:
                self.session.interrupt(force=True)
            except Exception:
                pass
            if self._re_tools.hangup_func:
                await self._re_tools.hangup_func()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"Error in IVR drop task: {e}")

    async def sync_step(self):
        """Sync instructions and available tools when step changes."""
        await self.update_instructions(get_step_instructions(self._re_state))
        await self.update_tools(self._re_tools.tools_for_step(self._re_state.step))

    def speak_and_stop(self, text: str, allow_interruptions: bool = True, use_cached: bool = True):
        """Speaks the agent line (via say_cached or session.say), logs it to the
        transcript and database, updates last_agent_question, and raises StopResponse().
        Ensures deterministic shortcuts never cause missing agent turns in the transcript.
        """
        clean = (text or "").strip()
        if clean:
            self._re_state.last_agent_question = extract_question(clean) or clean
            log_fn = getattr(self._re_tools, "log_dialogue_func", None)
            if log_fn:
                log_fn("assistant", clean)
            else:
                self._re_state.add_transcript("assistant", clean)
                logger.info(f"🤖 [Agent]: \"{clean}\"")

            try:
                sess = self.session
            except Exception:
                sess = None

            if sess:
                if use_cached:
                    say_cached(sess, self._re_state, clean, allow_interruptions=allow_interruptions)
                else:
                    sess.say(clean, allow_interruptions=allow_interruptions)

        raise StopResponse()

    async def on_user_turn_completed(self, turn_ctx, new_message):
        # LATENCY: a new customer turn invalidates any unspoken fast reply left over from an
        # interrupted previous turn.
        self._re_state.direct_reply = None

        # Closing line is already being spoken: ignore anything the customer says now
        # (e.g. 'haan haan theek hai') so it cannot trigger a second reply.
        if self._re_state.closing_spoken:
            raise StopResponse()
        text = (getattr(new_message, "text_content", None) or "").strip()
        kind = None
        # Safety override: carrier detection runs before property qualification or human engagement
        if not _HUMAN_CALLBACK_RE.search(text) and not self._re_state.is_interested:
            kind = classify_carrier_message(text)
            if not kind and self._re_state.step == _Step.INTRODUCTION:
                if _IVR_EXTRA.search(text):
                    kind = "voicemail"
                elif len(text.split()) >= _IVR_LONG_WORDS:
                    self._ivr_long_turns += 1
                    if self._ivr_long_turns >= 2:
                        kind = "voicemail"
                else:
                    self._ivr_long_turns = 0
        elif _HUMAN_CALLBACK_RE.search(text):
            logger.info(f"🗣️ Human callback / personal busy pattern in customer utterance: '{text}' -> bypassing IVR filter")
        if kind:
            logger.warning(f"📵 Carrier announcement ({kind}) detected: '{text[:100]}'. Dropping call.")
            self._re_state.ivr_detected = True
            self._re_state.final_disposition = "Voicemail or IVR Detected"
            self._re_state.agent_summary = f"Voicemail or IVR Detected: {text[:100]}"
            if self._ivr_task is None or self._ivr_task.done():
                self._ivr_kind = kind
                self._ivr_task = asyncio.create_task(self._drop_ivr_immediately(kind, text))
            raise StopResponse()

        state = self._re_state
        state.push_user_text(text)
        low_text = text.lower()

        # Hold / wait / check documents request from customer
        _HOLD_RE = re.compile(
            r"\b("
            r"ek\s*(?:min|minute|sec|second)|wait(?:\s+a\s+min(?:ute)?)?|hold(?:\s*on)?|hang\s*on|"
            r"ruko|rukna|ruk\s*jao|zara\s*ruko|thoda\s*(?:ruko|wait|time|samay)|2\s*min|do\s*minute|"
            r"let\s*me\s*(?:check|see|find)|just\s*(?:checking|a\s*(?:moment|sec(?:ond)?|min(?:ute)?))|give\s*me\s*a\s*moment|"
            r"dekh(?:ta|te|ti)\s*(?:hoon|hu|hain)?|dekh\s*ke\s*(?:bata(?:ta|te|ti)|bol(?:ta|te|ti))|dekhne\s*do|dekh\s*raha\s*hoon|"
            r"paper[s]?\s*dekh[a-z]*|document[s]?\s*dekh[a-z]*|registry\s*dekh[a-z]*|check\s*kar[a-z]*|"
            r"bata\s*(?:raha|rahi|rahe)\s*hoon"
            r")\b",
            re.IGNORECASE,
        )
        if _HOLD_RE.search(low_text):
            logger.info(f"⏳ Hold requested by customer: '{text}'. Granting grace period.")
            state.hold_until = time.time() + 35.0
            state.last_activity_time = time.time()
        else:
            state.hold_until = 0.0

        # Check for pricing, market rate, or valuation inquiries
        _PRICE_QUERY_RE = re.compile(
            r"\b(price|pricing|rate|rates|average\s*price|selling\s*price|valuation|bhav|kitna\s*milega|market\s*rate|market\s*trend|market\s*price)\b",
            re.IGNORECASE,
        )
        if _PRICE_QUERY_RE.search(low_text):
            state.valuation_requested = True
            if not state.advisor_handoff_reason:
                state.advisor_handoff_reason = "Customer inquired about property pricing/valuation"
            logger.info(f"💰 Customer asked about property pricing/valuation: '{text}' -> marking valuation_requested = True")

        # ── Deterministic intake shortcuts (no LLM round trip, instant playout) ──────────
        tools_ = self._re_tools

        # Proactive intent check for INTRODUCTION step
        _intro_refusal = _rejects_this_location(text) or _starts_with_negation(text)
        _intro_int = None if _intro_refusal else classify_intent(text)

        # A0: caller lives in the property himself -> not a sale/rent lead for THIS property. Never re-ask
        # sell-or-rent; acknowledge and ask the standard "any other property?" question (no LLM).
        if state.step in (_Step.INTRODUCTION, _Step.CATEGORY_SELECT) and not _intro_int and _is_self_occupied(text):
            logger.info(f"🏠 Owner-occupied ('we live there ourselves') -> asking about another property (no LLM): '{text}'")
            try:
                await tools_.not_interested_in_this_location()
                _q = state.direct_reply or other_property_question(state.reply_lang)
                state.direct_reply = None
                _lead = "Understood Sir, you live there yourself. " if state.reply_lang == "en" else "Ji samajh gayi Sir, aap khud rehte hain wahan. "
                self.speak_and_stop(_lead + _q, allow_interruptions=True)
            except Exception as e:
                logger.warning(f"Owner-occupied shortcut failed, falling back to LLM: {e}")

        # A: caller acknowledges or interrupts opening greeting -> ask qualification question
        if state.step == _Step.INTRODUCTION and _is_greeting_ack(text) and not state.greeting_acknowledged:
            state.greeting_acknowledged = True
            # The caller answered the greeting in Hindi ("haan boliye") but the first reply would still go out in the
            # stale default language (language detection only runs after these shortcuts). Follow the caller now.
            if (
                state.reply_lang == "en"
                and not state.language_switched
                and (re.search(r"[\u0900-\u097F]", text) or re.search(r"\b(boliye|bataiye|kahiye|haan|haanji|hanji|kaun|kya)\b", low_text))
            ):
                state.reply_lang = "hi"
                logger.info(f"🌐 Caller answered greeting in Hindi -> reply language set to hi: '{text}'")
                if self.on_language_change:
                    try:
                        self.on_language_change("hi")
                    except Exception as e:
                        logger.warning(f"Language switch callback failed: {e}")
            loc = state.initial_property_location or state.sector_or_location
            has_loc = bool(loc)
            was_interrupted = getattr(state, "opening_speech_interrupted", False) or _is_pickup_or_identity_query(text)
            reply = sell_or_rent_question(state.reply_lang, has_loc=has_loc, loc=loc, full_context=was_interrupted)
            logger.info(f"👋 Greeting acknowledged (full_context={was_interrupted}) -> asking qualification: '{reply}'")
            self.speak_and_stop(reply, allow_interruptions=True)

        # A1: caller answered "Sell" or "Rent" directly at INTRODUCTION step -> capture intent and move to intake
        if state.step == _Step.INTRODUCTION and _intro_int:
            state.greeting_acknowledged = True
            state.intent = _intro_int
            state.is_interested = True
            cat = state.category or "residential"
            state.category = cat
            if cat == "commercial":
                state.step = _Step.COMMERCIAL_LEASE if _intro_int == "lease" else _Step.COMMERCIAL_SALE
            else:
                state.step = _Step.RESIDENTIAL_LEASE if _intro_int == "lease" else _Step.RESIDENTIAL_SALE
            await self.sync_step()
            missing = state.get_missing_fields()
            if missing:
                first_q = missing[0]["question_en"] if state.reply_lang == "en" else missing[0]["question_hi"]
                ack = "Great, Sir! " if state.reply_lang == "en" else "Ji bilkul Sir! "
                reply = ack + first_q
                logger.info(f"🎯 Intent '{_intro_int}' recognized from '{text}' at intro -> transitioning to {state.step.value}: '{reply}'")
                self.speak_and_stop(reply, allow_interruptions=True)

        # A2: caller answered ambiguous "Haan" / "Yes" AFTER greeting was already acknowledged -> prompt to choose
        if state.step == _Step.INTRODUCTION and state.greeting_acknowledged and _is_greeting_ack(text) and not _intro_int:
            en = state.reply_lang == "en"
            clarify = (
                "Could you please tell me if you'd like to sell it, or put it on rent?"
                if en else
                "Ji, aap ise sell karna chahte hain ya rent par dena? Please batayein."
            )
            if re.fullmatch(r"\W*(hello|hi|hey|helo|हेलो|हैलो)\W*", text.strip().lower()):
                clarify = (
                    "Yes Sir, I can hear you. I was asking, would you like to sell your property, or give it on rent?"
                    if en else
                    "Ji Sir, main sun rahi hoon. Main pooch rahi thi, aap property sell karna chahte hain ya rent par dena?"
                )
            logger.info(f"🤔 Caller gave ambiguous 'yes' to sell-or-rent -> asking to choose: '{clarify}'")
            self.speak_and_stop(clarify, allow_interruptions=True)

        # A3: caller asks "Number kahan se mila?" / "How did you get my number?"
        if state.step == _Step.INTRODUCTION and _asks_number_source(text):
            en = state.reply_lang == "en"
            _rep = (
                "Your number was listed in our verified property database, Sir. Were you looking to sell or rent out your property?"
                if en else
                "Actually Sir, aapka number hamare verified property database mein listed tha. Kya aap apni property sell ya rent karne ka plan kar rahe hain?"
            )
            logger.info(f"📱 'How did you get my number?' query -> explaining source: '{_rep}'")
            self.speak_and_stop(_rep, allow_interruptions=True)

        # B: caller refuses THIS SPECIFIC location ("us location pe nahi bechna", "wahan ka nahi") -> "any other property?"
        if state.step == _Step.INTRODUCTION and _rejects_this_location(text):
            logger.info(f"📍 Refused THIS location -> asking about another property (no LLM): '{text}'")
            try:
                await tools_.not_interested_in_this_location()
                reply = state.direct_reply or other_property_question(state.reply_lang)
                state.direct_reply = None
                self.speak_and_stop(reply, allow_interruptions=True)
            except Exception as e:
                logger.warning(f"Location-refusal shortcut failed, falling back to LLM: {e}")

        # B-alt: caller gives general refusal ("nahi", "no sir", "nahi bechna", "not interested", "kat karo") to selling/renting -> clean polite close & hangup
        if state.step in (_Step.INTRODUCTION, _Step.CATEGORY_SELECT) and (_is_bare_refusal(text) or _DIRECT_NOT_INTERESTED.search(text)):
            logger.info(f"🛑 General refusal at {state.step.value} -> mark_not_interested & closing (no LLM): '{text}'")
            try:
                await tools_.mark_not_interested()
                tools_._speak_closing_and_hangup()
            except Exception as e:
                logger.warning(f"mark_not_interested shortcut failed, falling back to LLM: {e}")
            raise StopResponse()

        # B1 / B2: clean yes / no to "do you have any other property?"
        if state.step == _Step.CHECK_OTHER_PROPERTY:
            _ans = _other_property_answer(text)
            if _ans is not None:
                logger.info(f"🏘️ Other property answer = {_ans} (no LLM): '{text}'")
                try:
                    await tools_.has_other_property(has_other=_ans)
                    if _ans:
                        reply = state.direct_reply or ask_new_location_question(state.reply_lang)
                        state.direct_reply = None
                        self.speak_and_stop(reply, allow_interruptions=True)
                    else:
                        tools_._speak_closing_and_hangup()
                        raise StopResponse()
                except Exception as e:
                    logger.warning(f"Other-property shortcut failed, falling back to LLM: {e}")

        # Caller says "standalone" / "independent" property -> no unit number or floor exists, so
        # get_missing_fields() stops asking for them. Checked on every pre-closing intake turn.
        from .state import RealEstateStep as _SS
        standalone_changed = False
        if (
            not state.is_standalone
            and state.step in (
                _SS.CATEGORY_SELECT, _SS.ASK_NEW_LOCATION,
                _SS.RESIDENTIAL_SALE, _SS.RESIDENTIAL_LEASE,
                _SS.COMMERCIAL_SALE, _SS.COMMERCIAL_LEASE,
            )
            and is_standalone_from_speech(text)
        ):
            state.is_standalone = True
            if not state.unit_number:
                state.unit_number = "Standalone"
            if not state.floor_number:
                state.floor_number = "Ground"
            standalone_changed = True
            logger.info(f"🏠 Standalone/independent property -> unit & floor set to Standalone: '{text}'")

        # Caller says "don't know" / "nahi pata" / "yaad nahi" to the currently asked intake field:
        # Skip the field cleanly without corrupting data (e.g. unit_floor will NOT be marked standalone).
        _intake_steps = (_SS.RESIDENTIAL_SALE, _SS.RESIDENTIAL_LEASE, _SS.COMMERCIAL_SALE, _SS.COMMERCIAL_LEASE)
        if state.step in _intake_steps and (_DONT_KNOW_RE.search(low_text) or _DONT_KNOW_DEV.search(text)):
            missing = state.get_missing_fields()
            if missing:
                skipped_id = missing[0]["id"]
                state.skipped_fields.add(skipped_id)
                logger.info(f"⏭️ Caller doesn't know {skipped_id} ('{text}') -> skipped without corrupting data")
                missing_after = state.get_missing_fields()
                if missing_after:
                    next_q = missing_after[0]["question_en"] if state.reply_lang == "en" else missing_after[0]["question_hi"]
                    lead = "No problem Sir. " if state.reply_lang == "en" else "Koi baat nahi Sir. "
                    reply = lead + next_q
                    self.speak_and_stop(reply, allow_interruptions=True)
                else:
                    tools_._speak_closing_and_hangup()
                    raise StopResponse()

        # Caller states "market rate" / "jo market rate chal raha hai" as expected price:
        if state.step in _intake_steps and _is_market_rate_statement(text):
            missing = state.get_missing_fields()
            if missing and missing[0]["id"] in ("sale_price", "monthly_rent"):
                field_id = missing[0]["id"]
                if field_id == "sale_price":
                    state.expected_sale_price = "Market Rate"
                else:
                    state.expected_monthly_rent = "Market Rate"
                logger.info(f"💰 Caller stated price as Market Rate ('{text}') -> saved {field_id}='Market Rate'")
                missing_after = state.get_missing_fields()
                if missing_after:
                    next_q = missing_after[0]["question_en"] if state.reply_lang == "en" else missing_after[0]["question_hi"]
                    lead = "Market rate, noted Sir. " if state.reply_lang == "en" else "Market rate, note kar liya Sir. "
                    reply = lead + next_q
                    self.speak_and_stop(reply, allow_interruptions=True)
                else:
                    tools_._speak_closing_and_hangup()
                    raise StopResponse()

        # Caller asks us to repeat / says "what did you ask?" -> re-ask the open question (no LLM,
        # no tool call, nothing skipped). Runs BEFORE category detection because the caller's
        # words often quote the question itself ("residential hai ya commercial hai na?").
        from .state import RealEstateStep as _S
        _intake = (_S.RESIDENTIAL_SALE, _S.RESIDENTIAL_LEASE, _S.COMMERCIAL_SALE, _S.COMMERCIAL_LEASE)
        if state.step in _intake or state.step == _S.CATEGORY_SELECT:
            _neutral = _is_neutral_utterance(text)
            _reask = None
            _kind = None
            if state.step == _S.CATEGORY_SELECT and (_asks_repeat(text) or _neutral):
                # A bare "haan"/"ji" does not answer "residential or commercial? sell or rent?"
                # (often it is just a backchannel that interrupted the question).
                _cat, _int = classify_category(text), classify_intent(text)
                if _asks_repeat(text) or not (_cat or _int):
                    en = state.reply_lang == "en"
                    # Only re-ask what is STILL missing — never re-ask an already-collected field
                    if state.category and state.intent:
                        # Both known → nothing to re-ask here; fall through to LLM
                        pass
                    elif state.category and not state.intent:
                        _reask = "Are you looking to sell or rent it out?" if en else "Aap ise sell karna chahte hain, ya rent par dena?"
                        _kind = "intent"
                    elif state.intent and not state.category:
                        _reask = "Is it a residential or commercial property?" if en else "Ye residential property hai ya commercial?"
                        _kind = "category"
                    else:
                        _reask = (
                            "Is it a residential or commercial property? And are you looking to sell or rent it out?"
                            if en else
                            "Ye residential property hai ya commercial? Aur aap ise sell karna chahte hain ya rent par dena chahte hain?"
                        )
                        _kind = "category"
            elif state.step in _intake:
                if _asks_repeat(text):
                    _missing = state.get_missing_fields()
                    if _missing:
                        _reask = _missing[0]["question_en"] if state.reply_lang == "en" else _missing[0]["question_hi"]
                        _kind = _missing[0]["id"]
                elif _neutral:
                    _missing = state.get_missing_fields()
                    if _missing:
                        _kind = _missing[0]["id"]
                        _n = _bump_reask(state, f"{state.step.value}|{_kind}")
                        if _n >= 3:
                            logger.info(f"🔁 Neutral backchannel heard {_n}x -> handing turn to LLM instead of looping")
                            _reask = None
                        else:
                            _reask = _intake_slot_nudge(state.reply_lang == "en", _kind, _n)
                            _no_lead = True
            _no_lead = _no_lead if '_no_lead' in locals() else False
            if _reask and not _no_lead:
                _n = _bump_reask(state, f"{state.step.value}|{_reask}")
                if _n >= 3:
                    logger.info(f"🔁 Same question re-asked {_n}x -> handing this turn to the LLM instead of looping")
                    _reask = None
                elif _kind and not (_asks_repeat(text) and not _neutral):
                    # the caller did not ask us to repeat; they gave an unusable answer -> ask it in simpler words
                    _alt = _simplified_reask(state.reply_lang == "en", _kind, _n)
                    if _alt:
                        _reask, _no_lead = _alt, True
            if _reask:
                lead = "" if _no_lead else ("Sure, " if state.reply_lang == "en" else "Ji, ")
                logger.info(f"🔁 Repeat/backchannel -> re-asking open question (no LLM): '{_reask}'")
                self.speak_and_stop(lead + _reask, allow_interruptions=True)

        # Caller asks to repeat or clarify location at INTRODUCTION step
        if state.step == _S.INTRODUCTION and (_asks_repeat(text) or _asks_location_clarification(text)):
            loc = state.initial_property_location or state.sector_or_location
            en = state.reply_lang == "en"
            if loc:
                _rep = f"The property is at {loc}. Are you considering selling or renting it out?" if en else f"{loc} par jo aapki property hai. Kya aap use sell ya rent karne ka soch rahe hain?"
            else:
                # No address on record: say so honestly instead of re-reading the same question.
                _rep = (
                    "I don't have a specific address on my side, Sir. I'm just checking whether you own any property "
                    "you'd like to sell or rent out. Do you?"
                    if en else
                    "Sir, mere paas koi specific address nahi hai. Main bas yeh pooch rahi hoon ki kya aapki koi property hai "
                    "jise aap sell ya rent karna chahte hain?"
                )
            lead = "" if not loc else ("Sure, " if en else "Ji, ")
            _n = _bump_reask(state, f"INTRO|{'loc' if loc else 'noloc'}")
            if _n >= 3:
                logger.info("🔁 Intro clarification asked 3x -> letting the LLM handle it")
            else:
                logger.info(f"🔁 Repeat / location clarification at intro -> '{_rep}'")
                self.speak_and_stop(lead + _rep, allow_interruptions=True)

        # Caller indicates they are thinking/considering at INTRODUCTION step (e.g. "Sochata rahun", "Soch raha hoon")
        if state.step == _S.INTRODUCTION and _is_considering(text):
            state.is_interested = True
            _cat = classify_category(text)
            _int = classify_intent(text)
            if _cat:
                state.category = _cat
            if _int:
                state.intent = _int
            en = state.reply_lang == "en"
            state.step = _S.CATEGORY_SELECT
            if state.intent and not state.category:
                _rep = "Got it! Is it a residential or commercial property?" if en else "Ji samajh gayi. Ye residential property hai ya commercial?"
            elif state.category and not state.intent:
                _rep = "Understood! Are you looking to sell or rent it out?" if en else "Ji samajh gayi. Aap ise sell karne ka soch rahe hain ya rent par dene ka?"
            else:
                _rep = "Understood! Are you looking to sell or rent it out?" if en else "Ji samajh gayi. Aap ise sell karne ka soch rahe hain ya rent par dene ka?"
            logger.info(f"🤔 Considering/thinking at intro -> moving to category/intent: '{_rep}'")
            self.speak_and_stop(_rep, allow_interruptions=True)

        # "Repeat" at ANY other step (other-property, new location, name): say the last question
        # we actually asked, verbatim. Repeating only happens when the caller asks for it.
        if state.step not in _intake and state.step != _S.CATEGORY_SELECT and state.step != _S.INTRODUCTION and state.step != _S.CLOSING \
                and _asks_repeat(text):
            q_to_repeat = state.last_agent_question
            if not q_to_repeat:
                if state.step == _S.CHECK_OTHER_PROPERTY:
                    q_to_repeat = other_property_question(state.reply_lang)
                elif state.step == _S.ASK_NEW_LOCATION:
                    q_to_repeat = ask_new_location_question(state.reply_lang)
            if q_to_repeat:
                lead = "Sure, " if state.reply_lang == "en" else "Ji, "
                logger.info(f"🔁 Repeat requested -> re-asking last question (no LLM): '{q_to_repeat}'")
                self.speak_and_stop(lead + q_to_repeat, allow_interruptions=True)

        # Caller asks "Are you a broker?" / "Kya aap broker ho?"
        if _asks_if_broker(text) and state.step != _S.CLOSING:
            en = state.reply_lang == "en"
            if state.step in _intake:
                _missing = state.get_missing_fields()
                _follow = (" " + (_missing[0]["question_en"] if en else _missing[0]["question_hi"])) if _missing else ""
                _rep = (
                    f"We are from My Estate Finder. We connect property owners directly with verified buyers and tenants.{_follow}"
                    if en else
                    f"Ji, hum My Estate Finder se hain. Hum property owners ko verified buyers aur tenants se directly connect karte hain.{_follow}"
                )
            else:
                _rep = (
                    "We are from My Estate Finder, a verified property platform connecting property owners directly with genuine buyers and tenants. Are you looking to sell or rent out your property?"
                    if en else
                    "Ji, hum My Estate Finder se hain. Hum property owners ko direct verified buyers aur tenants se connect karte hain. Kya aap apni property sell ya rent karne ka soch rahe hain?"
                )
            logger.info(f"🏢 'Are you a broker?' query -> explaining platform: '{_rep}'")
            self.speak_and_stop(_rep, allow_interruptions=True)

        impatient_phrases = (
            "jaldi bolo", "jaldi batao", "time nahi", "time nhi", "bahut sawal", "kitna sawal",
            "kitne sawal", "hurry up", "don't have time", "dont have time", "wrap it up",
            "seedha point", "stop asking", "bakwas band", "short me bolo", "short mein",
        )
        if any(p in low_text for p in impatient_phrases):
            logger.info(f"⚠️ Impatience pattern detected in caller utterance: '{text}'")
            state.impatient_detected = True

        # Proactively detect category & intent directly from caller utterance
        from .state import RealEstateStep

        # A refusal ("nahi, us location pe nahi bechna") must not be read as an intent ('bechna' -> sale).
        _refusal = state.step in (RealEstateStep.INTRODUCTION, RealEstateStep.CHECK_OTHER_PROPERTY) and (
            _rejects_this_location(text) or _starts_with_negation(text)
        )
        # Category is strictly locked once intake begins (or if provided from audience file/db).
        # Only re-detect in early turns (INTRODUCTION, CATEGORY_SELECT, new location) or if category is unknown.
        _allow_cat_detect = (not state.category) or (state.step in (
            RealEstateStep.INTRODUCTION, RealEstateStep.CATEGORY_SELECT,
            RealEstateStep.CHECK_OTHER_PROPERTY, RealEstateStep.ASK_NEW_LOCATION
        ))
        detected_cat = None if (_refusal or not _allow_cat_detect) else classify_category(text)
        detected_int = None if _refusal else classify_intent(text)
        step_changed = False

        if detected_cat:
            old_cat = state.category
            state.category = detected_cat
            if detected_cat == "commercial":
                state.bhk_config = None
                # Keep exactly what the caller said as the unit type ("office", "shop"...). Never assumed:
                # if they only said "commercial", the type stays empty and is asked next.
                _said = commercial_type_from_speech(text)
                if _said and _said != "Other" and not state.commercial_type:
                    state.commercial_type = _said
                    logger.info(f"🏢 Commercial unit type from caller's words: '{_said}'")
                if state.step == RealEstateStep.RESIDENTIAL_SALE:
                    state.step = RealEstateStep.COMMERCIAL_SALE
                    step_changed = True
                elif state.step == RealEstateStep.RESIDENTIAL_LEASE:
                    state.step = RealEstateStep.COMMERCIAL_LEASE
                    step_changed = True
            elif detected_cat == "residential":
                state.commercial_type = None
                if state.step == RealEstateStep.COMMERCIAL_SALE:
                    state.step = RealEstateStep.RESIDENTIAL_SALE
                    step_changed = True
                elif state.step == RealEstateStep.COMMERCIAL_LEASE:
                    state.step = RealEstateStep.RESIDENTIAL_LEASE
                    step_changed = True
            if old_cat != detected_cat:
                logger.info(f"🏷️ Proactively recognized property category: '{detected_cat}' from utterance: '{text}'")

        if detected_int and not state.intent:
            state.intent = detected_int
            logger.info(f"🎯 Proactively recognized intent: '{detected_int}' from utterance: '{text}'")

        if state.step in (RealEstateStep.INTRODUCTION, RealEstateStep.CATEGORY_SELECT, RealEstateStep.ASK_NEW_LOCATION) and state.category and state.intent:
            if state.category == "commercial":
                state.step = RealEstateStep.COMMERCIAL_LEASE if state.intent == "lease" else RealEstateStep.COMMERCIAL_SALE
            else:
                state.step = RealEstateStep.RESIDENTIAL_LEASE if state.intent == "lease" else RealEstateStep.RESIDENTIAL_SALE
            step_changed = True

        if standalone_changed and not step_changed:
            # MUST be synchronous: otherwise the LLM could still see the old "ask unit & floor" instruction.
            try:
                await self.update_instructions(get_step_instructions(state))
            except Exception as e:
                logger.warning(f"Failed to refresh instructions after standalone detection: {e}")

        # Greetings / backchannels like "Hello." must not flip the reply language.
        lang_switched = False if _is_neutral_utterance(text) else state.update_reply_lang(text)
        if lang_switched or state.impatient_detected or step_changed:
            lang = state.reply_lang
            if lang_switched:
                logger.info(f"🌐 Customer switched language -> {lang}")
                if self.on_language_change:
                    try:
                        self.on_language_change(lang)
                    except Exception as e:
                        logger.warning(f"Language switch callback failed: {e}")

            if step_changed:
                # MUST be synchronous: the tool set changes, so the LLM must see the correct
                # tools *before* it starts generating. Running this as a background task causes
                # the LLM to run with stale tools, which leads to wrong step transitions and
                # premature closings (issues #1 and #2).
                try:
                    await self.update_instructions(get_step_instructions(state))
                    await self.update_tools(self._re_tools.tools_for_step(state.step))
                    logger.info(f"Step sync'd ({state.step.value}): instructions + tools updated.")
                except Exception as e:
                    logger.warning(f"Failed to refresh instructions/tools on step change: {e}")
            else:
                # Instruction-only refresh (language switch / impatience): tool set stays the same,
                # so it is safe to run as a background task without delaying LLM dispatch.
                _agent = self
                async def _refresh_lang_instructions():
                    try:
                        await _agent.update_instructions(get_step_instructions(state))
                    except Exception as e:
                        logger.warning(f"Failed to refresh instructions: {e}")
                asyncio.create_task(_refresh_lang_instructions())

        # Caller states "market rate" / "jo market rate chal raha hai" anywhere during intake:
        # Save it into state immediately so it is never re-asked later.
        if (
            state.step in (
                RealEstateStep.RESIDENTIAL_SALE, RealEstateStep.RESIDENTIAL_LEASE,
                RealEstateStep.COMMERCIAL_SALE, RealEstateStep.COMMERCIAL_LEASE,
            )
            and not state.closing_spoken
            and _is_market_rate_statement(text)
        ):
            if state.intent == "lease":
                if not state.expected_monthly_rent:
                    state.expected_monthly_rent = "Market Rate"
                    logger.info(f"Recorded market rate expectation for rent: '{text}'")
            else:
                if not state.expected_sale_price:
                    state.expected_sale_price = "Market Rate"
                    logger.info(f"Recorded market rate expectation for price: '{text}'")

        # ── FAST PATH: a clean answer to the ONE open intake question needs no LLM call ─────────────
        # Parsed with regex (fastpath.py) -> save_property_details() -> the tool speaks the next canonical
        # question (FAST_TOOL_REPLY). Anything unclear / multi-field / objection returns None and the
        # normal LLM path below handles it exactly as before.
        if (
            FASTPATH_ENABLED
            and FAST_TOOL_REPLY
            and text
            and state.step in (
                RealEstateStep.RESIDENTIAL_SALE, RealEstateStep.RESIDENTIAL_LEASE,
                RealEstateStep.COMMERCIAL_SALE, RealEstateStep.COMMERCIAL_LEASE,
            )
            and not state.closing_spoken
            and not state.impatient_detected
        ):
            _fp_missing = state.get_missing_fields()
            if _fp_missing:
                _fp_field = _fp_missing[0]["id"]
                if _fp_field == "commercial_type":
                    _ct = commercial_type_from_speech(text)
                    _fp_kw = {"commercial_type": _ct} if (_ct and _ct != "Other" and len(_tokens(text)) <= 4) else None
                else:
                    _fp_kw = _fastpath_extract(_fp_field, text)
                if _fp_kw:
                    try:
                        await self._re_tools.save_property_details(**_fp_kw)
                    except Exception as e:
                        logger.warning(f"Fast path failed, falling back to LLM: {e}")
                    else:
                        logger.info(f"⚡ FASTPATH (LLM skipped) field={_fp_field} saved={_fp_kw} heard='{text[:80]}'")
                        if not state.closing_spoken:   # closing is spoken by the tool itself
                            _fp_reply, state.direct_reply = state.direct_reply, None
                            if not _fp_reply:          # never leave dead air
                                _m = state.get_missing_fields()
                                if _m:
                                    _fp_reply = _m[0]["question_en"] if state.reply_lang == "en" else _m[0]["question_hi"]
                            if _fp_reply:
                                self.speak_and_stop(_fp_reply, allow_interruptions=True)
                        raise StopResponse()

    async def llm_node(self, chat_ctx, tools, model_settings):
        """Prevent hallucinated second tool call when last item was tool output.

        LATENCY: when the tool already decided the exact next line (state.direct_reply), speak it
        directly instead of making a second LLM round trip just to read it out."""
        if self._re_state.closing_spoken:
            return  # closing is spoken deterministically via session.say
        items = getattr(chat_ctx, "items", None) or []
        if items and getattr(items[-1], "type", None) == "function_call_output":
            reply = self._re_state.direct_reply
            if reply:
                self._re_state.direct_reply = None
                logger.info(f"⚡ FAST_REPLY (2nd LLM call skipped): '{reply}'")
                yield reply
                return
            tools = []

        # LATENCY: cap history sent to the LLM (fewer prompt tokens -> faster TTFT). The system
        # instructions are preserved by truncate(); step instructions already hold the open question.
        if CHAT_CTX_MAX_ITEMS > 0 and len(items) > CHAT_CTX_MAX_ITEMS:
            try:
                chat_ctx = chat_ctx.copy()
                chat_ctx.truncate(max_items=CHAT_CTX_MAX_ITEMS)
            except Exception as e:
                logger.debug(f"chat_ctx truncate skipped: {e}")

        # Stream the LLM, but HOLD its text until the generation ends. Why: Llama often says a sentence
        # AND calls a tool in the same turn. The tool then speaks the canonical next question (FAST_REPLY),
        # so the caller heard two questions (the LLM's own, frequently for the wrong field, plus ours) and
        # questions got repeated. Tool-call chunks are still forwarded immediately, so tool turns lose no time
        # (the call has to finish before the tool can run anyway); only text-only turns wait for the short
        # reply to finish.
        #   - real tool call in this generation -> drop the LLM text; the tool's reply is the only thing spoken
        #   - tool call typed as text (anywhere in the reply) -> recover it, speak the canonical reply
        #   - plain speech -> flush as-is
        held = []
        saw_tool = False
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            if _chunk_has_tool_call(chunk):
                saw_tool = True
                yield chunk
                continue
            if not _chunk_text(chunk):
                yield chunk                      # empty / metadata chunk
                continue
            held.append(chunk)

        full = "".join(_chunk_text(c) or "" for c in held)
        if saw_tool:
            if full.strip():
                logger.info(f"🔇 Dropped LLM text that came with a tool call (avoids double question): {full.strip()[:140]!r}")
            return
        m = _INLINE_CALL_RE.search(full)
        if m or _TEXT_CALL_RE.match(full):
            start = m.start() if m else 0
            if m and m.group(0).startswith('"name"'):
                brace = full.rfind("{", 0, m.start())
                start = brace if brace >= 0 else m.start()
            recovered = await self._recover_text_tool_call(full[start:])
            if recovered:
                yield recovered
            return

        # No tool was called: LLM is speaking naturally (answering question, objection, or clarifying)
        for c in held:
            yield c

    async def _recover_text_tool_call(self, raw: str):
        """The LLM typed a tool call as text. Execute it safely and return the line to speak."""
        state = self._re_state
        name, args = _parse_text_tool_call(raw)
        logger.warning(f"🩹 Tool call typed as text -> recovering: name={name} args={args} raw={raw[:160]!r}")

        # Step-tool aliases for model tolerance
        if name == "set_category_and_intent" and state.step == RealEstateStep.INTRODUCTION:
            name = "customer_interested"
        elif name == "customer_interested" and state.step == RealEstateStep.CATEGORY_SELECT:
            name = "set_category_and_intent"

        allowed = set()
        for t in self._re_tools.tools_for_step(state.step):
            n = getattr(getattr(t, "info", None), "name", None) or getattr(t, "__name__", None)
            if n:
                allowed.add(n)

        try:
            if name in allowed:
                fn = getattr(self._re_tools, name, None)
                if name == "save_property_details":
                    # Trust ONLY the field we just asked about; the text-typed JSON often contains
                    # invented values for every other field.
                    missing = state.get_missing_fields()
                    keep = _FIELD_TO_PARAMS.get(missing[0]["id"], ()) if missing else ()
                    safe = {k: v for k, v in args.items() if k in keep}
                    if safe:
                        await fn(**safe)
                elif fn is not None:
                    try:
                        await fn(**args)
                    except TypeError:
                        await fn()
        except Exception as e:
            logger.warning(f"Recovered tool call failed: {e}")

        if state.closing_spoken:
            return None                      # closing line is spoken via session.say
        reply, state.direct_reply = state.direct_reply, None
        if reply:
            logger.info(f"⚡ RECOVERED reply: '{reply}'")
            return reply

        # Nothing usable -> never stay silent: re-ask the question that is currently open.
        missing = state.get_missing_fields()
        en = state.reply_lang == "en"
        if missing:
            q = missing[0]["question_en"] if en else missing[0]["question_hi"]
            lead = "Sorry, I missed that. " if en else "Sorry, main sun nahi payi. "
            return lead + q
        return "Sorry, could you please repeat that?" if en else "Sorry, kya aap dobara bata sakte hain?"

    def tts_node(self, text, model_settings):
        """Safety net. LLM output arrives as tiny token fragments, so we buffer until a full
        sentence is complete and only then strip leaked tool-call text. Whitespace between
        tokens is preserved (never strip() individual chunks)."""
        async def guard():
            buf = ""
            async for chunk in text:
                buf += chunk
                if not _call_open(buf) and buf.rstrip().endswith((".", "?", "!", "\u0964")):
                    out, buf = _soften_tts_phrase(_clean_leaks(buf)), ""
                    if out.strip():
                        _q = extract_question(out)
                        if _q:
                            self._re_state.last_agent_question = _q   # for "repeat that"
                        yield out
            out = _soften_tts_phrase(_clean_leaks(buf))
            if out.strip():
                _q = extract_question(out)
                if _q:
                    self._re_state.last_agent_question = _q
                yield out

        return Agent.default.tts_node(self, guard(), model_settings)