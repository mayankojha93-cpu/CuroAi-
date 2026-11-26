import re
import time
import json
import asyncio
import logging
from typing import Optional


class StopResponse(Exception):
    """Raised when a fast-reply or carrier drop ends the turn without calling the LLM."""
    pass


from . import config as _config  # noqa: F401  (side effect: puts the project root on sys.path so `src.` imports resolve)

try:
    from src.carrier_filter import classify_carrier_message
except Exception:  # pragma: no cover - module is not part of this repo snapshot
    logging.getLogger("real-estate-agent").warning(
        "src.carrier_filter not importable -> only the built-in IVR/voicemail regexes are active"
    )

    def classify_carrier_message(text: str):
        return None

from .prompts import get_step_instructions
from .state import RealEstateState, RealEstateStep, RealEstateStep as _Step
from .config import CHAT_CTX_MAX_ITEMS, FAST_TOOL_REPLY, TTS_SPEAKABLE
from .tools import (
    explicit_refusal,
    strip_broker_negation,
    _DONT_KNOW_RE,
    _DONT_KNOW_DEV,
    extract_question,
    say_cached,
)

# Extra IVR / voicemail phrases (English + Hinglish + Devanagari). Used IN ADDITION to src.carrier_filter so that
# menus / voicemail prompts the carrier filter misses are still caught instead of being answered by the LLM.
_IVR_EXTRA = re.compile(
    r"(after\s+the\s+(tone|beep)|at\s+the\s+tone|leave\s+(a\s+|your\s+)*(message|voicemail)(?!\s+(?:with|for|to|at)\b)|record\s+your\s+message|"
    r"(?:forwarded\s+to|reached|leave\s+a\s+message\s+in)\s+(?:the\s+)?(?:voice\s*mail|mail\s*box)|to\s+(repeat|go\s+back)\s+press|"
    r"(for\s+[a-z]+|men[uu])\s*press\s+(star|hash|pound|\d)|"
    r"the\s+(number|person|subscriber|customer)\s+(you\s+are\s+calling|you\s+have\s+dialed)?\s+is\s+(currently\s+)?(not\s+available|busy|unavailable|switched\s+off|not\s+reachable)|"
    r"(number|phone)\s+is\s+(switched\s+off|not\s+reachable|out\s+of\s+coverage)|"
    r"(jis\s+vyakti\s+ko\s+aap\s+call\s+kar\s+rahe\s+hain|dial\s+kiya\s+hua\s+number)\s+.*(vyast|switched\s*off|uplabdh\s*nahi)|"
    r"please\s+(stay|hold|wait)\s+on\s+the\s+line|(beep|tone)\s+ke\s+baad\s+(sandesh|message)|"
    r"\u092c\u0940\u092a|\u091f\u094b\u0928\s*\u0915\u0947\s*\u092c\u093e\u0926\s*(\u0938\u0902\u0926\u0947\u0931|\u092e\u0947\u0938\u0947\u091c)|"
    r"\u0921\u093e\u092f\u0932\s*\u0915\u093f\u092f\u093e\s*(\u0917\u092f\u093e|\u0939\u0941\u0906)\s*\u0928\u0902\u092c\u0930|"
    r"(?:\u0928\u0902\u092c\u0930|\u092b\u094b\u0928)\s+.*(?:\u0938\u094d\u0935\u093f\u091a\s*\u0911\u092b))",
    re.I,
)

# Markers that ONLY a machine says. They win even when the same sentence also has human-sounding words
# ("Hi, I'm not available right now, please leave a message after the beep" contains "I'm" and "my").
_STRONG_VM_RE = re.compile(
    r"(after\s+the\s+(tone|beep)|at\s+the\s+tone|leave\s+(a\s+|your\s+)*(message|voicemail)(?!\s+(?:with|for|to|at)\b)|record\s+your\s+(?:message|name)|"
    r"reason\s+for\s+(?:calling|your\s+call)|(?:i'?ll|we'?ll|let\s+me)\s+see\s+if\s+(?:the\s+)?person\s+is\s+available|"
    r"voice\s*mail|mail\s*box|press\s+(star|hash|pound|\d)|please\s+(stay|hold)\s+on\s+the\s+line|"
    r"(?:the|this)\s+(?:number|subscriber|customer|mobile|person)\b[^.]{0,80}(?:not\s+reachable|switched\s+off|out\s+of\s+coverage)|(beep|tone)\s+ke\s+baad|"
    r"(?:dial|dialled)\s+kiya\s+(?:gaya|hua)|uplabdh\s+nahi\s+hai|sampark\s+nahi\s+ho\s+pa\s*raha)",
    re.I,
)

# Carrier / network announcements that ALSO contain a word from _HUMAN_CALLBACK_RE ("later", "main", "my"...). Each
# alternative needs machine-only wording ("the subscriber you are calling", "jis vyakti ...") so a person saying
# "try later" or "mera phone switched off tha" is NOT matched.
_MACHINE_ANNOUNCE_RE = re.compile(
    r"((?:person|subscriber|number|customer|mobile)\s+(?:that\s+)?you\s+(?:are|have|were)\s+(?:calling|dialed|dialled|trying|called)"
    r"|you(?:\s+ha)?ve\s+(?:dialed|dialled)"
    r"|(?:number|subscriber|customer)\b.{0,80}\b(?:try\s+(?:again\s+)?later|try\s+after\s+some\s+time)"
    r"|(?:jis|aapne\s+jis)\s+(?:vyakti|number|subscriber|grahak)"
    r"|(?:aapka|aapke)\s+dwara\s+(?:dial|call)"
    r"|(?:kripya|please)\s+(?:kuch\s+der\s+baad|baad\s+mein)\s+(?:punah\s+)?(?:try|prayas|sampark)"
    r"|available\s+nahi\s+hai\b.{0,60}\b(?:kripya|try\s+karein|baad\s+mein\s+(?:try|sampark))"
    r"|जिस\s+(?:व्यक्ति|नंबर)|कृपया\s+बाद\s+में\s+(?:प्रयास|संपर्क))",
    re.I,
)

# Human callback / third-party answering indicators (never an IVR/voicemail machine)
_HUMAN_CALLBACK_RE = re.compile(
    r"\b("
    r"sir|madam|bhaiya|uncle|aunty|papa|mummy|father|mother|brother|sister|husband|wife|boss|owner|"
    r"meeting|baad\s*mein|baad\s*me|call\s*(?:me\s*)?(?:back|later)|later|busy\s*hai|busy\s*hain|"
    r"shaam\s*ko|kal\s*call|subah|abhi\s*nahi|driving|drive\s*kar|office\s*mein|hospital|"
    r"main|maine|mujhe|mere\s*paas|meri|mera|hum|hamara|hamare|apna|apni|"
    r"he|she|they|him|his|her|unka|unki|unke|inka|inki|woh|wo|vo|available\s+nahi|abhi\s+available|bahar\s+gaye|bahar\s+gaya|ghar\s+par\s+nahi|"
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


# Soniox / Sarvam STT often return Hindi in Devanagari, but the busy / hold / third-party regexes are Latin.
# Append Latin equivalents of the key words so those checks work for both scripts.
_DEV_WORD_HINTS = {
    "रुको": "ruko", "रुकिए": "ruko", "रुकिये": "ruko", "रुकना": "rukna", "होल्ड": "hold", "वेट": "wait",
    "मीटिंग": "meeting", "ड्राइविंग": "driving", "व्यस्त": "busy", "बिज़ी": "busy", "बिजी": "busy",
    "शाम": "shaam", "सुबह": "subah", "कल": "kal", "पापा": "papa", "पिताजी": "father", "मम्मी": "mummy",
    "भैया": "bhaiya", "साहब": "sir", "सर": "sir", "मैडम": "madam", "मैं": "main", "मैंने": "maine",
    "मुझे": "mujhe", "मेरा": "mera", "मेरी": "meri", "हम": "hum", "वो": "wo", "वह": "wo", "उनका": "unka",
    "उनकी": "unki", "उनके": "unke", "अस्पताल": "hospital", "ऑफिस": "office", "बाद": "baad",
}
_DEV_PHRASE_HINTS = {
    "एक मिनट": "ek minute", "एक सेकंड": "ek second", "एक सेकेंड": "ek second", "थोड़ा रुको": "thoda ruko",
    "देख रहा हूँ": "dekh raha hoon", "देख रहा हूं": "dekh raha hoon", "देख रही हूँ": "dekh rahi hoon",
    "देखता हूँ": "dekhta hoon", "देखता हूं": "dekhta hoon", "देखती हूँ": "dekhti hoon", "देखने दो": "dekhne do",
    "बाद में": "baad mein", "बाद मे": "baad me", "अभी नहीं": "abhi nahi", "उपलब्ध नहीं": "available nahi",
    "अवेलेबल नहीं": "available nahi", "बाहर गए": "bahar gaye", "बाहर गये": "bahar gaye", "घर पर नहीं": "ghar par nahi",
    "कॉल बैक": "call back", "बाद में कॉल": "baad mein call",
}


def _augment_devanagari(text: str) -> str:
    """Returns text unchanged for Latin input; for Devanagari appends a romanised copy + keyword hints."""
    if not text or not re.search(r"[\u0900-\u097F]", text):
        return text
    extra = []
    try:
        from src.transliteration import romanize_hindi
        extra.append(romanize_hindi(text))
    except Exception:
        pass
    for k, v in _DEV_PHRASE_HINTS.items():
        if k in text:
            extra.append(v)
    toks = set(re.split(r"[\s,.?!\u0964]+", text))
    for k, v in _DEV_WORD_HINTS.items():
        if k in toks:
            extra.append(v)
    return (text + " " + " ".join(e for e in extra if e)).strip()


def _ivr_long_turn_counts(text: str) -> bool:
    """A long turn counts toward the 'looping IVR menu' rule only if it is long AND has no question in it.
    A person who rambles about the property usually asks something ('?', kya, kaise, what, how ...); a menu never does."""
    t = text or ""
    if len(t.split()) < _IVR_LONG_WORDS:
        return False
    if "?" in t or re.search(r"\b(kya|kyun|kyon|kaise|kaun|kahan|what|why|how|who|where|can\s+you|could\s+you)\b", t, re.I):
        return False
    return True


# All known real estate tool names for precise pattern matching and recovery
ALL_RE_TOOLS = {
    "customer_interested",
    "not_interested_in_this_location",
    "has_other_property",
    "set_new_property_location",
    "confirm_owner_name",
    "set_category_and_intent",
    "confirm_share_details_now",
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
    s = re.sub(r'\b(?!Hello\b|Yes\b|No\b|Thank\b|Thanks\b|Right\b|Sure\b|Sorry\b|Please\b|Okay\b|Alright\b|Perfect\b|Noted\b|Understood\b|Great\b|Bilkul\b|Achha\b|Haanji\b|Haan\b|Ji\b|Theek\b|Samajh\b|Certainly\b|Absolutely\b|Good\b|Hi\b|Fine\b|Waise\b|Chaliye\b|Toh\b)([A-Z][a-z]+)\s+[Ss]ir\b', r'\1', s)
    # 3. Mid-sentence honorific stops ("got it, Sir. And..." -> "got it, Sir... And...")
    s = re.sub(r'(,\s*Sir|\bSir|\bji)\.\s+([A-Z])', r'\1... \2', s)
    # 4. Exclamations to natural breathing pauses
    s = s.replace("!", "... ")
    # 5. Collapse accidental multiple spaces
    s = re.sub(r'[ \t]{2,}', ' ', s)
    if TTS_SPEAKABLE:
        s = _speakable(s)
    return s.strip()


def _speakable(s: str) -> str:
    """TTS reads "407" as "four hundred seven" and may mangle "BHK". Flat numbers are spoken digit by digit."""
    s = re.sub(r"\bBHK\b", "B H K", s)
    s = re.sub(r"\b(unit|flat|house|shop|office|plot|number)(\s+)(\d{3,5})\b",
               lambda m: f"{m.group(1)}{m.group(2)}{' '.join(m.group(3))}", s, flags=re.I)
    s = re.sub(r"(?<![\d.])(\d{3,5})(?=\s+on\s+\d)", lambda m: " ".join(m.group(1)), s)   # "407 on 4th floor"
    return s


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


_NEG_TOKENS = {"nahi", "nahin", "nhi", "nahii", "no", "nope", "nah", "not", "never", "nothing", "none",
               "नहीं", "नही", "नहि", "नो"}
_STRONG_AFF = {"haan", "han", "haa", "ha", "haanji", "hanji", "yes", "yeah", "yep", "yup", "bilkul", "zaroor", "sure",
               "हाँ", "हां", "हा", "हांजी", "हाँजी", "यस", "येस", "बिल्कुल", "ज़रूर", "जरूर"}
_HAI = {"hai", "hain", "है", "हैं"}
_OTHER_WORDS = {"doosri", "dusri", "doosra", "dusra", "another", "other", "दूसरी", "दूसरा"}
_BARE_NEG_FILL = {"ji", "jee", "sir", "toh", "to", "bhi", "abhi", "bas", "theek", "thik", "ok", "okay",
                  "जी", "सर", "तो", "भी", "अभी", "बस", "ठीक", "ओके"} | _HAI

def _other_property_answer(text: str):
    """Answer to "do you have any other property?": True / False ONLY when the whole utterance is a bare
    yes or a bare no (plus polite filler such as "ji", "sir", "hai"). Anything else - "nahi, ek aur hai",
    "haan Sector 62 mein", "koi aur nahi", "sirf ek thi" - is a sentence whose meaning the LLM must read."""
    if not text:
        return None
    for c in _variants(text):
        toks = _tokens(c)
        if not toks or len(toks) > 5:
            continue
        has_neg = any(t in _NEG_TOKENS for t in toks)
        has_aff = any(t in _STRONG_AFF for t in toks)
        if has_neg and not has_aff and all(t in _NEG_TOKENS or t in _BARE_NEG_FILL for t in toks):
            return False
        if has_aff and not has_neg and all(t in _STRONG_AFF or t in _BARE_NEG_FILL for t in toks):
            return True
    return None


# NOTE: "abhi" / "kuch" are deliberately NOT filler: "abhi nahi" means "not right now" (a callback), and "kuch
# nahi" is "nothing" - both need the LLM to read them in context before a call is ended.
_REFUSAL_FILL = {"toh", "to", "ji", "jee", "sir", "bilkul", "bas", "bhi", "yar", "yaar", "bhai", "तो", "जी", "सर", "बिल्कुल"}
_DIRECT_NOT_INTERESTED = re.compile(
    r"\b("
    r"not\s+interested|nahi\s+bechna|nahi\s+dena|nahi\s+chahiye|nahi\s+karna|nahi\s+karne|"
    r"(?:bechna|dena|rent\s*(?:karna|pe\s*dena)|sell\s*karna)\s+(?:nahi|nhi)(?:\s+(?:chaht[aei]|hai|h))?|"
    r"already\s+(?:sold|rented|showed|given|let\s*out|disposed)|"
    r"don'?t\s+have\s+(?:any\s+)?(?:other\s+)?property(?:\s+to\s+(?:sell|rent|lease))?|"
    r"no\s+property(?:\s+to\s+(?:sell|rent|lease))?|"
    r"(?:bech|de)\s*(?:diya|di|chuke|chuki|hain)|bik\s*gay[aei]|"
    r"koi\s*(?:bhi\s*)?property\s*(?:nahi|nhi)|"
    r"kat\s+karo|kaat\s+do|kaato|kaat\s*karo|call\s+kaat[a-z]*|phone\s+kaat[a-z]*|cut\s+the\s+call"
    r")\b"
    r"|(नॉट\s*इंटरेस्टेड|नहीं\s*बेचना|नहीं\s*देना|नहीं\s*चाहिए|कॉल\s*काटो|काट\s*दो)",
    re.I,
)


class _BrokerAwareRegex:
    """Same .search/.match API as a compiled regex, but 'broker nahi chahiye' style phrases are removed first,
    so refusing brokers never reads as refusing the property conversation."""

    def __init__(self, rx):
        self._rx = rx

    def search(self, text, *a, **k):
        return self._rx.search(strip_broker_negation(text), *a, **k)

    def match(self, text, *a, **k):
        return self._rx.match(strip_broker_negation(text), *a, **k)

    def __getattr__(self, name):
        return getattr(self._rx, name)


_DIRECT_NOT_INTERESTED = _BrokerAwareRegex(_DIRECT_NOT_INTERESTED)

# SOFT refusals are NOT refusals: "nothing", "no plans right now", "not right now", "kuch nahi", "abhi nahi" ...
# The caller may still be reachable later, so the prompt's objection guide says: offer ONE callback, and only close
# if they decline that too. That is a decision about meaning -> LLM. These phrases are therefore kept OUT of every
# regex that closes the call (_DIRECT_NOT_INTERESTED, _CLEAR_REFUSAL_SHORT, tools.explicit_refusal) and are only
# DETECTED here so the shortcuts can step aside explicitly.
_SOFT_REFUSAL = re.compile(
    r"\b("
    r"nothing(?:\s+(?:at\s+the\s+moment|right\s+now|as\s+of\s+now|currently))?|"
    r"no\s+plans?(?:\s+(?:right\s+now|at\s+the\s+moment|as\s+of\s+now|currently))?|"
    r"not\s+(?:planning|looking|selling|renting|leasing)(?:\s+\w+){0,3}?\s+(?:right\s+now|at\s+the\s+moment|at\s+present|currently|as\s+of\s+now|for\s+now)|"
    r"not\s+(?:right\s+now|at\s+the\s+moment|at\s+present|currently)|"
    r"abhi\s+(?:kuch|kuchh)\s+nahi|kuch\s+nahi|kuchh\s+nahi|abhi\s+nahi|abhi\s+koi\s+plan\s+nahi"
    r")\b"
    r"|(कुछ\s*नहीं|अभी\s*नहीं)",
    re.I,
)


def _is_soft_refusal(text: str) -> bool:
    """'Not now / nothing at the moment' style answers: the LLM reads them (callback offer), no regex closes the call."""
    if not text:
        return False
    return bool(_SOFT_REFUSAL.search(text)) and not _DIRECT_NOT_INTERESTED.search(text)


# Clear short refusals closed without an LLM round trip
_CLEAR_REFUSAL_SHORT = re.compile(
    r"^\W*(?:(?:mujhe|hum|mai|main|uh|um|umm)[\s,]+)?(?:"
    r"not\s+interested|interested\s+nahi|nahi\s+bechna|nahi\s+dena|"
    r"nahi\s+chahiye|no\s+thanks?|no\s+thank\s+you|not\s+planning"
    r")(?:[\s,]+(?:hai|hain|sir|ji|thanks?))*\W*$",
    re.I,
)


def _is_bare_refusal(text: str) -> bool:
    """A plain "nahi" / "nahi ji" / "toh nahi" / "no sir" with nothing else: general refusal to selling/renting,
    so mark_not_interested() is executed deterministically without an LLM round trip (~1.3s saved).
    Soft answers ("nothing", "not right now", "kuch nahi") are NOT bare refusals: the LLM offers a callback first."""
    if _is_soft_refusal(text):
        return False
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


_AI_AUTOMATED_Q_LATIN = re.compile(
    r"\b("
    r"(is\s+this\s+(an?\s+)?(automotive|automated|auto|computer|recorded|bot|robot|ai)\s*call)"
    r"|(are\s+you\s+(an?\s+)?(ai\s*(agent|bot)?|robot|bot|computer|machine|automotive|automated))"
    r"|(is\s+this\s+(ai|a\s+robot|a\s+bot|automated|automotive))"
    r"|(you\s+are\s+(an?\s+)?(ai|robot|bot))"
    r"|(ai\s*(agent|bot)?\s+ho\s+kya|robot\s+ho\s+kya|automated\s+call\s+hai|automotive\s+call\s+hai)"
    r"|(kya\s+(yeh|ye|aap)\s+(ai|robot|automated|automotive|computer))"
    r"|(robot\s+bol\s+raha\s+hai|ai\s+bol\s+rahi\s+hai)"
    r")\b",
    re.I,
)
_AI_AUTOMATED_Q_DEV = re.compile(
    r"(क्या\s*(आप|ये|यह)\s*(एआई|रोबोट|कंप्यूटर|ऑटोमेटेड|ऑटोमोटिव|ऑटोमैटिक)|(रोबोट|एआई)\s*(हो|बोल\s*रहा|है)"
    r"|(ऑटोमोटिव|ऑटोमेटेड|ऑटोमैटिक)\s*कॉल)"
)
_AUTOMOTIVE_WORD = re.compile(r"\bautomotive\b|ऑटोमोटिव", re.I)
_AUTOMATED_CALL_WORD = re.compile(r"\b(automated|automatic|auto|recorded|computer)\b|ऑटोमेटेड|ऑटोमैटिक", re.I)


def ai_disclosure_reply(text: str, lang: str) -> str:
    """Honest answer to 'Is this an automotive call?' / 'Are you an AI agent?'. Deterministic wording that MIRRORS the
    caller's own word, so the caller hears exactly what they asked about:
      "automotive call"      -> Yes, it is an automotive call and I'm an AI agent calling on behalf of My Estate Finder.
      "automated/auto call"  -> Yes, it is an automated call and I'm an AI agent calling on behalf of My Estate Finder.
      "AI agent / robot/bot" -> Yes, I'm an AI agent calling on behalf of My Estate Finder."""
    t = text or ""
    if lang == "en":
        if _AUTOMOTIVE_WORD.search(t):
            return "Yes, it is an automotive call and I'm an AI agent calling on behalf of My Estate Finder."
        if _AUTOMATED_CALL_WORD.search(t) and re.search(r"\bcall\b|कॉल", t, re.I):
            return "Yes, it is an automated call and I'm an AI agent calling on behalf of My Estate Finder."
        return "Yes, I'm an AI agent calling on behalf of My Estate Finder."
    if _AUTOMOTIVE_WORD.search(t):
        return "Haanji, ye ek automotive call hai aur main My Estate Finder ki taraf se AI agent baat kar rahi hoon."
    if _AUTOMATED_CALL_WORD.search(t) and re.search(r"\bcall\b|कॉल", t, re.I):
        return "Haanji, ye ek automated call hai aur main My Estate Finder ki taraf se AI agent baat kar rahi hoon."
    return "Haanji, main My Estate Finder ki taraf se AI agent baat kar rahi hoon."


def _asks_if_ai_or_automated(text: str) -> bool:
    if not text:
        return False
    if _AI_AUTOMATED_Q_DEV.search(text):
        return True
    cands = [text]
    try:
        from src.transliteration import romanize_hindi
        cands.append(romanize_hindi(text))
    except Exception:
        pass
    return any(_AI_AUTOMATED_Q_LATIN.search((c or "").lower()) for c in cands)


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
        name = m.group(1).lower()
    if not name:
        m = (
            re.search(r'<function[=\s]([A-Za-z_]\w*)', raw_clean, re.I)
            or re.search(r'<call:([A-Za-z_]\w*)', raw_clean, re.I)
            or re.search(r'\b(' + _TOOL_NAMES_PATTERN + r')\b', raw_clean, re.I)
            or re.match(r'\s*([a-zA-Z]+(?:_[a-zA-Z0-9]+)+)\b', raw_clean)
            or re.search(r'([A-Za-z_]\w+)\s*\(', raw_clean)
        )
        if m:
            name = m.group(1).lower()

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


class RealEstateTurnHandler:
    """Deterministic per-turn logic for My Estate Finder property intake (Pipecat edition).

    Runs on the COMPLETE user turn, after the user aggregator and before the LLM. Any shortcut raises
    StopResponse (via speak_and_stop) which makes the TurnGate drop the LLM run for that turn.
    `session` is a PipecatSession (update_instructions / update_tools / say / interrupt).
    """

    def __init__(self, state: RealEstateState, tools_instance, session):
        self._re_state = state
        self._re_tools = tools_instance
        self.session = session
        self.on_language_change = None
        self._ivr_task: Optional[asyncio.Task] = None
        self._ivr_kind: Optional[str] = None
        self._ivr_long_turns = 0

    async def _drop_ivr_immediately(self, kind: str, text: str):
        try:
            if self._re_state.hangup_started:
                return
            logger.warning(f"📵 IVR / Voicemail detected ({kind}): '{text[:100]}'. Dropping call immediately.")
            self._re_state.ivr_detected = True
            self._re_state.final_disposition = "Voicemail or IVR Detected"
            self._re_state.agent_summary = f"Voicemail or IVR Detected: {text[:100]}"
            try:
                await self.session.interrupt()
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
        await self.session.update_instructions(get_step_instructions(self._re_state))
        await self.session.update_tools(self._re_tools.tools_for_step(self._re_state.step))

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

            sess = self.session
            if sess:
                if use_cached:
                    say_cached(sess, self._re_state, clean, allow_interruptions=allow_interruptions)
                else:
                    sess.say(clean, allow_interruptions=allow_interruptions)

        raise StopResponse()

    async def on_user_turn_completed(self, text: str):
        # LATENCY: a new customer turn invalidates any unspoken fast reply left over from an
        # interrupted previous turn.
        self._re_state.direct_reply = None
        self._re_state.pending_preface = None

        # Closing line is already being spoken: ignore anything the customer says now
        # (e.g. 'haan haan theek hai') so it cannot trigger a second reply.
        if self._re_state.closing_spoken:
            raise StopResponse()
        text = (text or "").strip()
        text_x = _augment_devanagari(text)   # Latin hints for Devanagari speech (regex checks below)
        kind = None
        # Strong machine-only markers win even if the greeting also has human-sounding words.
        if text and not self._re_state.is_interested and (_STRONG_VM_RE.search(text) or _MACHINE_ANNOUNCE_RE.search(text_x)):
            kind = "voicemail"
        # Safety override: carrier detection runs before property qualification or human engagement
        if kind is None and not _HUMAN_CALLBACK_RE.search(text_x) and not self._re_state.is_interested:
            kind = classify_carrier_message(text)
            if not kind and self._re_state.step == _Step.INTRODUCTION and _IVR_EXTRA.search(text):
                kind = "voicemail"
        elif kind is None and _HUMAN_CALLBACK_RE.search(text_x):
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
            r"paper[s]?\s*dekh[a-z]*|document[s]?\s*dekh[a-z]*|registry\s*dekh[a-z]*|check\s*kar[a-z]*"
            r")\b",
            re.IGNORECASE,
        )
        # Only a SHORT utterance counts as a hold request; a long sentence containing 'check kar' / 'wait' is an answer.
        if len(_tokens(text)) <= 10 and _HOLD_RE.search(text_x.lower()):
            logger.info(f"⏳ Hold requested by customer: '{text}'. Granting grace period.")
            state.hold_until = time.time() + 45.0
            state.last_activity_time = time.time()
        else:
            state.hold_until = 0.0

        # Pure LLM pipeline: regex is used strictly for IVR / voicemail / carrier detection above
        # and hold-timer grace period. All human conversational turns proceed directly to the LLM.
        lang_switched = False if _is_neutral_utterance(text) else state.update_reply_lang(text)
        if lang_switched:
            lang = state.reply_lang
            logger.info(f"🌐 Customer switched language -> {lang}")
            if self.on_language_change:
                try:
                    self.on_language_change(lang)
                except Exception as e:
                    logger.warning(f"Language switch callback failed: {e}")

        # Ensure session instructions and tools match the current step before LLM generates
        if self.session:
            try:
                await self.session.update_instructions(get_step_instructions(state))
                await self.session.update_tools(self._re_tools.tools_for_step(state.step))
            except Exception as e:
                logger.warning(f"Failed to refresh instructions/tools: {e}")

        # Hand turn over to the LLM (no StopResponse raised)
        return

    async def handle_turn(self, text: str) -> bool:
        """Returns True when the turn was fully handled deterministically (LLM must NOT run)."""
        try:
            await self.on_user_turn_completed(text)
        except StopResponse:
            return True
        return False


    _QUESTION_WORDS_RE = re.compile(r"\b(kya|kitn[aei]|kaun|kahan|kyun|kyon|kaise|who|what|where|why|which|how|is|are|do|does|can)\b|\?")

    def _answer_preface(self, text: str):
        """When the LLM answered a caller QUESTION and also called a tool, the tool speaks the next canonical
        question; keep the LLM's (short) answer so the question is not ignored. Never keeps a second question,
        leaked tool text, or an acknowledgement when the caller did not ask anything."""
        heard = (self._re_state.last_user_text or "").lower()
        if not self._QUESTION_WORDS_RE.search(heard):
            return None
        t = _clean_leaks(text).strip()
        if not t or "?" in t or _TEXT_CALL_RE.match(t):
            return None
        sents = re.split(r"(?<=[.!\u0964])\s+", t)
        out = " ".join(sents[:2]).strip()
        if len(out.split()) > 30:
            out = sents[0].strip()
        return out if 0 < len(out.split()) <= 30 else None

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
                    missing = state.get_missing_fields()
                    missing_ids = {m["id"] for m in missing} if missing else set()
                    keep = set(_FIELD_TO_PARAMS.get(missing[0]["id"], ())) if missing else set()

                    # Also include any fields from missing that args has values for,
                    # or that are backed by user speech (current turn or recent turns)
                    recent_speech = f"{state.get_recent_speech_context(max_turns=3)} {state.last_user_text or ''}".lower()
                    speech_clean = re.sub(r"[,']", "", recent_speech)
                    speech_digits = re.findall(r"\d+(?:\.\d+)?", speech_clean)

                    for k, v in args.items():
                        if v is None:
                            continue
                        v_str = str(v).lower()
                        v_nums = re.findall(r"\d+(?:\.\d+)?", v_str)
                        v_clean = re.sub(r"[^a-z0-9]", "", v_str)

                        # Grounded check: digits match or word matches in caller's speech
                        _w_map = {
                            "1": ("one", "first", "ek", "1st"), "2": ("two", "second", "do", "2nd"),
                            "3": ("three", "third", "teen", "3rd"), "4": ("four", "fourth", "char", "chaar", "4th"),
                            "5": ("five", "fifth", "paanch", "5th"), "6": ("six", "sixth", "chhe", "6th"),
                            "7": ("seven", "seventh", "saat", "7th"), "8": ("eight", "eighth", "aath", "8th"),
                            "9": ("nine", "ninth", "nau", "9th"), "10": ("ten", "tenth", "das", "10th"),
                        }
                        digits_in_speech = any(
                            n in speech_digits or (n.endswith('.0') and n[:-2] in speech_digits)
                            or any(n in s for s in speech_digits)
                            or any(w in recent_speech for w in _w_map.get(n.rstrip('.0'), ()))
                            for n in v_nums
                        )
                        words_in_speech = (len(v_clean) >= 3 and v_clean in re.sub(r"[^a-z0-9]", "", recent_speech))

                        if digits_in_speech or words_in_speech:
                            keep.add(k)
                        elif any(k in _FIELD_TO_PARAMS.get(mid, ()) for mid in missing_ids):
                            keep.add(k)

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

        # Nothing usable -> re-ask the open question, but NEVER loop repeatedly on the same question
        missing = state.get_missing_fields()
        en = state.reply_lang == "en"
        if missing:
            field_id = missing[0]["id"]
            n = _bump_reask(state, f"{state.step.value}|{field_id}")
            if n == 1:
                q = missing[0]["question_en"] if en else missing[0]["question_hi"]
                lead = "Sorry, I missed that. " if en else "Sorry, main sun nahi payi. "
                return lead + q
            elif n == 2:
                # Ask once more in simpler/gentler words
                alt = _intake_slot_nudge(en, field_id, 2)
                return alt if alt else (missing[0]["question_en"] if en else missing[0]["question_hi"])
            else:
                # Already asked multiple times -> skip this field to avoid annoying the caller
                logger.info(f"⏭️ Skipping slot '{field_id}' after {n} failed re-asks to prevent loop")
                state.skipped_fields.add(field_id)
                missing_after = state.get_missing_fields()
                if missing_after:
                    next_q = missing_after[0]["question_en"] if en else missing_after[0]["question_hi"]
                    lead = "No problem Sir. " if en else "Koi baat nahi Sir. "
                    return lead + next_q
                else:
                    return await self._re_tools.finish_property_intake()
        return "Sorry, could you please repeat that?" if en else "Sorry, kya aap dobara bata sakte hain?"
        