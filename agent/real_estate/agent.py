import re
import json
import asyncio
import logging
from typing import Optional
from livekit.agents import Agent, StopResponse
from src.carrier_filter import classify_carrier_message
from .prompts import get_step_instructions
from .state import RealEstateState, RealEstateStep as _Step, clean_spoken_location
from .config import CHAT_CTX_MAX_ITEMS, FAST_TOOL_REPLY, FASTPATH_ENABLED, AGENT_PERSONA_NAME
from .fastpath import extract as _fastpath_extract

# Extra IVR / voicemail phrases (English + Hinglish + Devanagari). Used IN ADDITION to src.carrier_filter so that
# menus / voicemail prompts the carrier filter misses are still caught instead of being answered by the LLM.
_IVR_EXTRA = re.compile(
    r"(after\s+the\s+(tone|beep)|at\s+the\s+tone|leave\s+(a\s+|your\s+)*(message|voicemail)|record\s+your\s+message|"
    r"voice\s*mail|mail\s*box|press\s+(star|hash|pound|\d)|to\s+(repeat|go\s+back)\s+press|"
    r"is\s+not\s+(available|reachable|answering)|not\s+reachable|switched\s+off|currently\s+(busy|unavailable)|"
    r"please\s+(stay|hold|wait)\s+on\s+the\s+line|(beep|tone)\s+ke\s+baad|sandesh\s+(chhod|record)|message\s+record|"
    r"(abhi|is\s*samay)\s+(vyast|uplabdh)|dabayein|dabaye|"
    r"\u092c\u0940\u092a|\u091f\u094b\u0928\s*\u0915\u0947\s*\u092c\u093e\u0926|"
    r"\u0909\u092a\u0932\u092c\u094d\u0927\s*\u0928\u0939\u0940\u0902|\u092a\u0939\u0941\u0902\u091a\s*\u0938\u0947\s*\u092c\u093e\u0939\u0930|\u0938\u094d\u0935\u093f\u091a\s*\u0911\u092b)",
    re.I,
)
# A real person answering the greeting rarely speaks this many words twice in a row; a looping IVR menu does.
_IVR_LONG_WORDS = 30
# While the IVR drop timer is running, only a SHORT reply counts as a human (long text is more IVR).
_IVR_HUMAN_MAX_WORDS = 15


# Leak patterns for tool-call text that the LLM sometimes types instead of calling the tool.
_LEAK_PATTERNS = [
    re.compile(r'<function[^>]*>.*?(?:</function>|$)', re.S),               # <function=x>{...}</function>
    re.compile(r'\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\s*[>\(\{][^)}]*[\)\}]?'),   # tool_name(...) / tool_name{...} / tool_name>{...}
    re.compile(r'\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\s*>\s*\{.*?\}?', re.S),     # tool_name>{...}
    re.compile(r'\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\s*>', re.S),                # tool_name>
    re.compile(r'\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b'),                        # lone snake_case identifiers
    re.compile(r'^\s*\{.*$', re.S),                                         # JSON blobs
]


def _clean_leaks(s: str) -> str:
    for p in _LEAK_PATTERNS:
        s = p.sub('', s)
    return s


def _call_open(buf: str) -> bool:
    """True while a call-like region ((...), {...}, <function>...) is still unclosed."""
    if "<function" in buf and "</function>" not in buf:
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
# Llama sometimes prints {"name": "save_property_details", "parameters": {...}} as its reply instead
# of making a real tool call. The tts_node guard strips it, so the caller heard NOTHING (dead air).
_TEXT_CALL_RE = re.compile(r'^\s*(?:\{|<function|[a-z]+(?:_[a-z0-9]+)+\s*[>\(\{])')

# get_missing_fields() ids -> save_property_details parameter names
_FIELD_TO_PARAMS = {
    "location": ("sector_or_location",),
    "society_sector": ("project_or_society",),
    "project_sector": ("project_or_society",),
    "unit_floor": ("unit_number", "floor_number"),
    "unit_number": ("unit_number",),
    "floor_number": ("floor_number",),
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
_YES_FILL = {"ji", "jee", "sir", "hmm", "hm", "mm", "ok", "okay", "achha", "accha", "ek", "aur", "property", "one",
             "more", "i", "do", "have", "there", "is", "also", "bhi",
             "जी", "सर", "एक", "और", "प्रॉपर्टी", "भी", "अच्छा", "ओके", "हम्म"} | _HAI | _OTHER_WORDS
_NO_FILL = {"koi", "aur", "other", "another", "else", "anything", "property", "hi", "ji", "jee", "sir", "bas", "sirf",
            "ek", "wohi", "yehi", "thanks", "thank", "you", "thats", "all", "i", "dont", "do", "have", "there", "is",
            "are", "bhi", "hmm", "hm", "ok", "okay", "achha", "accha", "theek", "thik", "ab", "abhi", "mere", "paas",
            "pass", "ke", "ka", "ki", "liye", "thi", "tha", "hoon", "hu",
            "कोई", "और", "प्रॉपर्टी", "ही", "जी", "सर", "बस", "सिर्फ", "एक", "वही", "अब", "अभी", "मेरे", "पास",
            "के", "का", "की", "लिए", "थी", "था", "हूँ", "हूं", "अच्छा", "ठीक"} | _HAI


def _other_property_answer(text: str):
    """Answer to "do you have any other property?": True / False when it is a clean yes / no,
    None when there is more in it (a location, a category...) -> the LLM + tool handle it."""
    for c in _variants(text):
        toks = _tokens(c)
        if not toks or len(toks) > 8:
            continue
        has_neg = any(t in _NEG_TOKENS for t in toks)
        strong = any(t in _STRONG_AFF for t in toks)
        weak = any(t in _HAI for t in toks) and any(t in _OTHER_WORDS for t in toks)
        if has_neg and not strong:
            if all(t in _NEG_TOKENS or t in _NO_FILL for t in toks):
                return False
        elif (strong or weak) and not has_neg:
            if all(t in _STRONG_AFF or t in _YES_FILL for t in toks):
                return True
    return None


_REFUSAL_FILL = {"toh", "to", "ji", "jee", "sir", "abhi", "bilkul", "bas", "तो", "जी", "सर", "अभी", "बिल्कुल"}


def _is_bare_refusal(text: str) -> bool:
    """A plain "nahi" / "nahi ji" / "toh nahi" / "no sir" with nothing else: treated as refusing THIS property,
    so the deterministic "any other property?" line is spoken without an LLM round trip (~1.3s saved)."""
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


# ── Caller asks a QUESTION (why do you need this / who are you ...) ────────────
# The LLM answers it with plain speech and no tool call. That must NOT count as "not understood",
# otherwise 3 questions in a row ended the call with "I'm having trouble hearing you".
_Q_LATIN = re.compile(
    r"(\?|\b(why|who|what|which|how|where|when|kyun|kyu|kyon|kaun|kaunsi|kaise|kaisa|kisliye|kis\s*liye|kab|kahan|kitna|kitne)\b"
    r"|^\s*(ye\s+|yeh\s+)?kya\b)",
    re.I,
)
_Q_DEV = re.compile(r"(\?|क्यों|क्यूँ|क्यू|कौन|कैसे|किसलिए|किस\s*लिए|कब|कहाँ|कहां|कितना|कितने|^\s*क्या)")


def _is_caller_question(text: str) -> bool:
    if not text:
        return False
    if _Q_DEV.search(text):
        return True
    return any(_Q_LATIN.search((c or "").lower()) for c in _variants(text))


# ── Caller is busy / someone else answered (a LIVE person, not voicemail) ──────
# Carrier / voicemail announcements ("the number you have dialed is currently busy ...") carry these markers.
_CARRIER_MARKERS = re.compile(
    r"(number\s+you|you\s+have\s+dial+ed|you\s+are\s+(trying|calling)|subscriber|customer\s+you|person\s+you|"
    r"try\s+again|after\s+the\s+(tone|beep)|switched\s+off|not\s+reachable|out\s+of\s+(coverage|service)|"
    r"voice\s*mail|mail\s*box|press\s+(star|hash|pound|\d)|jis\s+number|aapne\s+jo|kripya|abhi\s+uplabdh|"
    r"please\s+hold|your\s+call)",
    re.I,
)
_CARRIER_MARKERS_DEV = re.compile(r"(सब्सक्राइबर|आपके\s*द्वारा|कृपया|बीप|वॉइसमेल|वॉयस\s*मेल)")
_NOT_BUSY = re.compile(r"(not\s+busy|busy\s+(nahi|nhi|nahin)|free\s+(hoon|hu|hun))", re.I)
_BUSY_LATIN = re.compile(
    r"((i\s*am|i'?m|im|main|mai)\s+(currently\s+|abhi\s+|right\s+now\s+|bahut\s+)?(busy|driving|in\s+(a\s+)?meeting)"
    r"|\b(busy|vyast)\s+(hoon|hun|hu|hai|hain|right\s+now|abhi)\b|\babhi\s+(busy|vyast)\b|\bcurrently\s+busy\b"
    r"|\bmeeting\s+(mein|me)\b|\bdriving\s+(kar|ho)|\bnot\s+a\s+good\s+time\b|\bbad\s+time\b"
    r"|\b(call|phone)\s+(me\s+)?(later|back)\b|\bcall\s+later\b|\bbaad\s+(mein|me)\s+(call|baat|phone)"
    r"|\bthodi\s+der\s+(baad|mein)|\b(kal|shaam|subah)\s+(ko\s+|me\s+|mein\s+)?call\s+kar)",
    re.I,
)
_BUSY_DEV = re.compile(r"(बिज़ी|बिजी|व्यस्त|मीटिंग|ड्राइव|बाद\s*में\s*(कॉल|बात|फोन|करना)|अभी\s*टाइम\s*नहीं|टाइम\s*नहीं\s*है)")
_OTHER_PERSON_LATIN = re.compile(
    r"(\b(he|she|owner|malik|papa|father|mummy|mother|bhaiya|bhai|uncle|aunty|saab|sahab|sahib)\b[\w\s,]{0,25}?"
    r"\b(not\s+(available|here|home|at\s+home|in\s+town)|out\s+of\s+(station|town)|outside|sleeping|busy|"
    r"nahi\s+(hain|hai|hein)|bahar|available\s+nahi|ghar\s+(pe|par)\s+nahi)\b"
    r"|\b(wo|woh|vo|ve|unki|unka|unke)\b[\w\s,]{0,25}?\b(nahi\s+(hain|hai|hein)|bahar|ghar\s+(pe|par)\s+nahi|available\s+nahi|busy)\b"
    r"|\bghar\s+(pe|par)\s+nahi\b|\bnot\s+(at\s+)?home\b|\bbahar\s+(gaye|gayi|gaya)\b"
    r"|\bi\s*am\s+(his|her)\s+\w+|\bmain\s+(unka|unki|unke)\s+\w+)",
    re.I,
)
_OTHER_PERSON_DEV = re.compile(r"((वो|वह|वे|उनकी|उनका|साहब|मालिक|पापा|मम्मी)[\s\S]{0,20}(नहीं\s*(हैं|है)|बाहर|घर\s*पर\s*नहीं)|मैं\s*उनका|मैं\s*उनकी)")


def is_human_unavailable(text: str) -> Optional[str]:
    """'busy' when the caller says they are busy / call later, 'third_party' when someone else answered and the
    owner is not available, else None. Always None for carrier / voicemail style announcements."""
    if not text or len(_tokens(text)) > 16:      # a long monologue is an IVR menu, not a person
        return None
    variants = _variants(text)
    for c in variants:
        if _CARRIER_MARKERS.search((c or "").lower()) or _CARRIER_MARKERS_DEV.search(c or ""):
            return None
    if _OTHER_PERSON_DEV.search(text):
        return "third_party"
    if _BUSY_DEV.search(text):
        return "busy"
    for c in variants:
        low = (c or "").lower()
        if _NOT_BUSY.search(low):
            continue
        if _OTHER_PERSON_LATIN.search(low):
            return "third_party"
        if _BUSY_LATIN.search(low):
            return "busy"
    return None


_TIME_HINT = re.compile(
    r"\b(today|tonight|tomorrow|morning|afternoon|evening|night|aaj|kal|parso|subah|dopahar|shaam|sham|raat|"
    r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|somvar|mangalvar|budhvar|guruvar|shukravar|"
    r"shanivar|ravivar|weekend|baje|\d{1,2}\s*(am|pm))\b",
    re.I,
)
_TIME_HINT_DEV = re.compile(r"(आज|कल|परसों|सुबह|दोपहर|शाम|रात|बजे)")


def _has_time_hint(text: str) -> bool:
    if not text:
        return False
    if _TIME_HINT_DEV.search(text):
        return True
    return any(_TIME_HINT.search((c or "").lower()) for c in _variants(text))


# ── Bare "yes / haan ji / bolo / hello" at the intro = "I'm listening", NOT "I want to sell" ──
_HELLO_WORDS = {"hello", "hi", "hey", "helo", "hallo", "hullo", "हेलो", "हैलो", "हेल्लो", "हलो"}
_LISTEN_WORDS = _HELLO_WORDS | {
    "haan", "han", "haa", "ha", "haanji", "hanji", "ji", "jee", "yes", "yeah", "yep", "yup", "ya", "ok", "okay",
    "hmm", "hm", "mm", "bolo", "boliye", "boliyeji", "bataiye", "batayiye", "batao", "kahiye", 
    "sunao", "suno", "sir", "go", "ahead", "tell", "me", "speak", "sure", "achha", "accha", "listening", "please",
    "haanjiji", "bol", "sunaiye",
    "हाँ", "हां", "हा", "जी", "हांजी", "हाँजी", "बोलो", "बोलिए", "बोलिये", "बताइए", "बताओ", "कहिए", "कहिये",
    "ओके", "यस", "येस", "सर", "हम्म", "ठीक", "अच्छा", "सुनाइए",
}


def _is_listening_backchannel(text: str) -> bool:
    for c in _variants(text):
        toks = _tokens(c)
        if toks and len(toks) <= 5 and all(t in _LISTEN_WORDS for t in toks):
            return True
    return False


def _is_hello_only(text: str) -> bool:
    for c in _variants(text):
        toks = _tokens(c)
        if toks and all(t in _HELLO_WORDS for t in toks):
            return True
    return False


def _spoken_loc(loc: str) -> str:
    return clean_spoken_location(loc)


# ── Caller asks US for the price/rate ("kya rate chal raha hai? kitne mein bech sakte hain?") ──
# Handled deterministically (no LLM): speak valuation line + short thank-you, then hang up.
_PRICE_Q_LATIN = re.compile(
    r"(kya\s+(rate|price|bhav|bhaav|value|daam|dam)\b"
    r"|\b(rate|price|bhav|bhaav|daam|dam|value)\s+(kya|kitna|kitni|chal\s*raha|chal\s*rha|chalega)"
    r"|market\s+(rate|price|value)"
    r"|kitn[ae]\s+(me|mein|main)\s+(bech|bik|sell)"
    r"|kitn[ae]\s+(milega|mil\s*sakta|mil\s*jayega|mil\s*jaayega)"
    r"|how\s+much\s+(can|will|would|do|should)"
    r"|what\s+(is|are|'s)\s+(the\s+)?(rate|price|value|market)"
    r"|what\s+price|valuation)",
    re.I,
)
_PRICE_Q_DEV = re.compile(
    r"(क्या\s*(रेट|प्राइस|भाव|कीमत|दाम|वैल्यू)"
    r"|(रेट|प्राइस|भाव|कीमत|दाम)\s*(क्या|कितना|कितनी|चल)"
    r"|मार्केट\s*(रेट|प्राइस|वैल्यू)"
    r"|कितने\s*में\s*(बेच|बिक)"
    r"|कितना\s*मिलेगा|वैल्यूएशन)"
)
_HAS_AMOUNT = re.compile(r"[0-9०-९]|lakh|lac\b|crore|cr\b|लाख|करोड़|करोड", re.I)


def _asks_agent_for_price(text: str) -> bool:
    """True when the caller is ASKING for a rate/valuation (not stating their own expected price)."""
    if not text or _HAS_AMOUNT.search(text):
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
    r"(which\s+(property|location|address|place|flat)|where\s+is\s+it|what\s+address|kahan\s+(pe|par|per|hai)|konsi\s+(property|jagah|location|address)|kaunsi\s+(property|jagah|location|address))",
    re.I,
)
_LOC_CLARIFY_DEV = re.compile(
    r"(कौनसी|कौन\s*सी|कहाँ|कहां|किस\s*(जगह|लोकेशन|एड्रेस|प्रॉपर्टी))"
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
_INLINE_CALL_RE = re.compile(
    r'<function[=\s>]'
    r'|"name"\s*:\s*"[a-z]+(?:_[a-z0-9]+)+"'
    r'|\b[a-z]+(?:_[a-z0-9]+)+\s*[>\(\{]'
)

_Q_LEAD_RE = re.compile(r"^(?:ji sir|sure sir|sorry sir|ji|sure|sorry|sir)\s*[,.]?\s+", re.I)


def _extract_question(spoken: str) -> str:
    """The question part of a spoken line: from the first sentence that ends with '?' to the end.
    Drops acks like 'Okay.' and re-ask leads like 'Ji Sir,' so a later 'repeat' sounds clean."""
    parts = re.split(r"(?<=[.!?।])\s+", (spoken or "").strip())
    for i, p in enumerate(parts):
        if p.rstrip().endswith("?"):
            q = " ".join(parts[i:]).strip()
            return _Q_LEAD_RE.sub("", q).strip()
    return ""


def _parse_text_tool_call(raw: str):
    """Best-effort parse of a text-typed tool call, tolerant of truncated JSON."""
    m = (
        re.search(r'"name"\s*:\s*"([A-Za-z_]\w*)"', raw)
        or re.match(r'\s*<function=([A-Za-z_]\w*)', raw)
        or re.match(r'\s*([a-z]+(?:_[a-z0-9]+)+)\s*[>\(\{]', raw)
        or re.search(r'\b([a-z]+(?:_[a-z0-9]+)+)\s*[>\(\{]', raw)
    )
    if not m:
        return None, {}
    name = m.group(1)
    pm = re.search(r'"(?:parameters|arguments)"\s*:\s*\{(.*)', raw, re.S)
    body = pm.group(1) if pm else raw
    args = {}
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
    return name, args


class RealEstateAgent(Agent):
    """Voice agent for My Estate Finder property intake (Priya)."""

    def __init__(self, state: RealEstateState, tools_instance):
        self._re_state = state
        self._re_tools = tools_instance
        self.on_language_change = None
        self._ivr_task: Optional[asyncio.Task] = None
        self._ivr_kind: Optional[str] = None
        self._ivr_long_turns = 0
        self._q_exempt = 0
        super().__init__(
            instructions=get_step_instructions(state),
            tools=tools_instance.tools_for_step(state.step),
        )

    async def _wait_and_drop_ivr(self, kind: str, text: str):
        try:
            logger.info(f"⏳ Waiting 5s before dropping call due to carrier IVR ({kind})...")
            await asyncio.sleep(5.0)
            if self._re_state.hangup_started:
                return
            logger.warning(f"⏰ 5s IVR wait completed for ({kind}). Dropping call now.")
            self._re_state.ivr_detected = True
            self._re_state.final_disposition = "Voicemail or IVR Detected"
            if kind == "hold":
                self._re_state.agent_summary = "Call placed on hold by callee; timed out after 5s waiting for human."
            else:
                self._re_state.agent_summary = f"Carrier announcement / voicemail detected: {text[:100]}"

            if self._re_tools.hangup_func:
                await self._re_tools.hangup_func()
        except asyncio.CancelledError:
            logger.info(f"IVR 5s drop timer cancelled for ({kind}).")
        except Exception as e:
            logger.warning(f"Error in IVR drop task: {e}")

    def _cancel_ivr_timer(self):
        """A live person spoke: stop the 'looks like voicemail, drop in 5s' timer."""
        if self._ivr_task and not self._ivr_task.done():
            self._ivr_task.cancel()
        self._ivr_task = None
        self._ivr_kind = None
        self._ivr_long_turns = 0
        self._re_state.ivr_detected = False

    def _question_exempt(self) -> bool:
        """True when the caller just asked us a question: the LLM's plain-speech answer is NOT a failed turn.
        Capped (6 per call) so endless questions cannot stall the call forever."""
        if _is_caller_question(self._re_state.last_user_text):
            self._q_exempt += 1
            return self._q_exempt <= 6
        return False

    async def sync_step(self):
        """Sync instructions and available tools when step changes."""
        await self.update_instructions(get_step_instructions(self._re_state))
        await self.update_tools(self._re_tools.tools_for_step(self._re_state.step))

    async def on_user_turn_completed(self, turn_ctx, new_message):
        # Update activity timestamp whenever the customer speaks
        self._re_state.last_activity_time = time.time()

        # LATENCY: a new customer turn invalidates any unspoken fast reply left over from an
        # interrupted previous turn.
        self._re_state.direct_reply = None

        # Closing line is already being spoken: ignore anything the customer says now
        # (e.g. 'haan haan theek hai') so it cannot trigger a second reply.
        if self._re_state.closing_spoken:
            raise StopResponse()
        text = (getattr(new_message, "text_content", None) or "").strip()

        # ── Caller is busy / someone else answered: offer a callback (a live person is NOT voicemail) ──
        _st = self._re_state
        if text and _st.step != _Step.CLOSING:
            _unavail = is_human_unavailable(text)
            if _st.awaiting_callback_time or _unavail:
                _st.last_user_text = text
                _has_time = _has_time_hint(text)
                _romanized = _variants(text)[-1].strip()
                if _unavail:
                    self._cancel_ivr_timer()
                    _st.third_party_answered = _st.third_party_answered or (_unavail == "third_party")
                from .tools import explicit_dnc_request as _dnc
                if _st.awaiting_callback_time:
                    # We just asked "what time should we call back?" -> this reply is the time slot
                    _st.awaiting_callback_time = False
                    _wants_out = _dnc(text) or _is_bare_refusal(text)
                    _short = len(_tokens(text)) <= 6 and not _asks_repeat(text) and not _is_caller_question(text)
                    if not _wants_out and (_has_time or _short or _unavail):
                        _slot = None if (_unavail and not _has_time) else _romanized
                        logger.info(f"📞 Callback time received -> scheduling (no LLM): slot={_slot!r}")
                        try:
                            await self._re_tools.schedule_callback(time_slot=_slot)
                        except Exception as e:
                            logger.warning(f"Callback scheduling failed, falling back to LLM: {e}")
                        else:
                            raise StopResponse()
                elif _has_time:
                    # "Busy, call me in the evening" -> time already given
                    logger.info(f"📞 Busy/unavailable ({_unavail}) with time given -> scheduling (no LLM): '{text}'")
                    try:
                        await self._re_tools.schedule_callback(time_slot=_romanized)
                    except Exception as e:
                        logger.warning(f"Callback scheduling failed, falling back to LLM: {e}")
                    else:
                        raise StopResponse()
                else:
                    _en = _st.reply_lang == "en"
                    if _unavail == "third_party":
                        _reply = (
                            "No problem... What time would be good for us to call back, so we can speak with the owner directly?"
                            if _en else
                            "Koi baat nahi ji... Kis time par call karun, taaki owner se direct baat ho sake?"
                        )
                    else:
                        _reply = (
                            "Sure Sir, no problem... What time would suit you for a callback, this evening or tomorrow morning?"
                            if _en else
                            "Ji bilkul Sir, koi baat nahi... Aapko kis time call karun, aaj shaam ya kal subah?"
                        )
                    logger.info(f"📞 Caller busy/unavailable ({_unavail}) -> asking callback time (no LLM): '{text}'")
                    _st.awaiting_callback_time = True
                    _st.last_agent_question = _reply
                    try:
                        self.session.say(_reply, allow_interruptions=True)
                    except Exception as e:
                        _st.awaiting_callback_time = False
                        logger.warning(f"Callback question failed, falling back to LLM: {e}")
                    else:
                        raise StopResponse()
        kind = classify_carrier_message(text)
        if not kind and _IVR_EXTRA.search(text):
            kind = "voicemail"
        if not kind:
            # Looping IVR menus / voicemail greetings: long speech turns back to back while still at the intro
            if len(text.split()) >= _IVR_LONG_WORDS and self._re_state.step == _Step.INTRODUCTION:
                self._ivr_long_turns += 1
            else:
                self._ivr_long_turns = 0
            if self._ivr_long_turns >= 2:
                kind = "voicemail"
        if kind:
            logger.warning(f"📵 Carrier announcement ({kind}) detected: '{text[:100]}'")
            self._re_state.ivr_detected = True
            if self._ivr_task is None or self._ivr_task.done():
                self._ivr_kind = kind
                self._ivr_task = asyncio.create_task(self._wait_and_drop_ivr(kind, text))
            raise StopResponse()

        if self._ivr_task and not self._ivr_task.done():
            if len(text.split()) > _IVR_HUMAN_MAX_WORDS:
                logger.info(f"📵 Long speech while IVR timer is running - treating as IVR, staying silent: '{text[:80]}'")
                raise StopResponse()
            logger.info("🗣️ Human speech detected; cancelling 5s IVR drop timer.")
            self._re_state.ivr_detected = False
            self._ivr_task.cancel()
            self._ivr_task = None
            self._ivr_kind = None

        state = self._re_state
        state.last_user_text = text
        low_text = text.lower()

        # ── Scenario B, deterministic (no LLM, exact scripted lines) ─────────────────────────
        from .tools import other_property_question, ask_new_location_question, say_cached
        tools_ = self._re_tools

        # B: caller refuses THIS location ("us location pe nahi bechna") -> "any other property?"
        if state.step == _Step.INTRODUCTION and (_rejects_this_location(text) or _is_bare_refusal(text)):
            logger.info(f"📍 Refused THIS location -> asking about another property (no LLM): '{text}'")
            ok = False
            try:
                await tools_.not_interested_in_this_location()
                reply = state.direct_reply or other_property_question(state.reply_lang)
                state.direct_reply = None
                say_cached(self.session, state, reply, True)
                ok = True
            except Exception as e:
                logger.warning(f"Location-refusal shortcut failed, falling back to LLM: {e}")
            if ok:
                raise StopResponse()

        # Bare "yes / haan ji / bolo / hello" at the opening line only means "I'm listening". The opening asks
        # "sell it, or rent it out?", so a plain yes answers nothing: re-ask it simply (no LLM) instead of
        # marking the lead interested. A SECOND bare yes falls through to the LLM, which then treats it as interest.
        if (
            state.step == _Step.INTRODUCTION
            and not state.is_interested
            and state.initial_property_location
            and _is_listening_backchannel(text)
        ):
            _bn = _bump_reask(state, "INTRO|listening")
            if _bn <= 1:
                _en = state.reply_lang == "en"
                _loc = _spoken_loc(state.initial_property_location)
                if _is_hello_only(text):
                    _rep = (
                        f"Hello Sir, this is {AGENT_PERSONA_NAME} from My Estate Finder, about your property in {_loc}. Are you looking to sell it, or rent it out?"
                        if _en else
                        f"Hello Sir, main {AGENT_PERSONA_NAME} My Estate Finder se, aapki {_loc} wali property ke baare mein. Aap ise sell karna chahte hain, ya rent par dena?"
                    )
                else:
                    _rep = (
                        "Sure Sir... Are you looking to sell it, or rent it out?"
                        if _en else
                        "Ji Sir... Aap ise sell karna chahte hain, ya rent par dena?"
                    )
                logger.info(f"👂 Bare yes/hello at intro -> re-asking sell-or-rent (no LLM, NOT marked interested): '{text}'")
                state.last_agent_question = _rep
                try:
                    self.session.say(_rep, allow_interruptions=True)
                except Exception as e:
                    logger.warning(f"Intro backchannel reply failed, falling back to LLM: {e}")
                else:
                    raise StopResponse()

        # B1 / B2: clean yes / no to "do you have any other property?"
        if state.step == _Step.CHECK_OTHER_PROPERTY:
            _ans = _other_property_answer(text)
            if _ans is not None:
                logger.info(f"🏘️ Other property answer = {_ans} (no LLM): '{text}'")
                ok = False
                try:
                    await tools_.has_other_property(has_other=_ans)
                    if _ans:
                        reply = state.direct_reply or ask_new_location_question(state.reply_lang)
                        state.direct_reply = None
                        say_cached(self.session, state, reply, True)
                    else:
                        from .prompts import get_closing_text
                        closing_text = get_closing_text(state)
                        state.closing_spoken = True
                        tools_._hangup_scheduled = True
                        speech = say_cached(self.session, state, closing_text, False)
                        if tools_.log_dialogue_func:
                            tools_.log_dialogue_func("assistant", closing_text)
                        else:
                            state.add_transcript("assistant", closing_text)
                            logger.info(f"🤖 [Agent]: \"{closing_text}\"")

                        if tools_.hangup_func:
                            async def _hangup_after_speech():
                                try:
                                    if hasattr(speech, "wait_for_playout"):
                                        await speech.wait_for_playout()
                                    else:
                                        await asyncio.sleep(4.0)
                                except Exception:
                                    await asyncio.sleep(3.5)
                                await asyncio.sleep(0.5)
                                await tools_.hangup_func()
                            asyncio.create_task(_hangup_after_speech())
                    ok = True
                except Exception as e:
                    logger.warning(f"Other-property shortcut failed, falling back to LLM: {e}")
                if ok:
                    raise StopResponse()

        # Caller says "standalone" / "independent" property -> no unit number or floor exists, so
        # get_missing_fields() stops asking for them. Checked on every pre-closing intake turn.
        from .tools import is_standalone_from_speech
        from .state import RealEstateStep as _SS
        standalone_changed = False
        if (
            not state.is_standalone
            and state.step in (
                _SS.INTRODUCTION, _SS.CATEGORY_SELECT, _SS.ASK_NEW_LOCATION,
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

        # Caller asks us to repeat / says "what did you ask?" -> re-ask the open question (no LLM,
        # no tool call, nothing skipped). Runs BEFORE category detection because the caller's
        # words often quote the question itself ("residential hai ya commercial hai na?").
        from .state import RealEstateStep as _S
        from .tools import classify_category, classify_intent
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
            elif state.step in _intake and _asks_repeat(text):
                _missing = state.get_missing_fields()
                if _missing:
                    _reask = _missing[0]["question_en"] if state.reply_lang == "en" else _missing[0]["question_hi"]
            _no_lead = False
            if _reask:
                _n = _bump_reask(state, f"{state.step.value}|{_reask}")
                if (state.is_interested or state.step in _intake) and _n >= 3:
                    logger.info(f"🤝 After 2 failed attempts on same question ({_n}) -> offering advisor callback and closing")
                    try:
                        await self._re_tools.book_advisor_handoff(reason="Could not understand caller after 2 failed attempts on same question")
                    except Exception as e:
                        logger.warning(f"Advisor handoff failed: {e}")
                    raise StopResponse()
                elif _n >= 3:
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
                try:
                    self.session.say(lead + _reask, allow_interruptions=True)
                except Exception as e:
                    logger.warning(f"Re-ask failed, falling back to LLM: {e}")
                else:
                    raise StopResponse()

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
            if state.is_interested and _n >= 3:
                logger.info("🤝 After 2 failed attempts on intro question -> offering advisor callback and closing")
                try:
                    await self._re_tools.book_advisor_handoff(reason="Could not understand caller after 2 failed attempts on same question")
                except Exception as e:
                    logger.warning(f"Advisor handoff failed: {e}")
                raise StopResponse()
            elif _n >= 3:
                logger.info("🔁 Intro clarification asked 3x -> letting the LLM handle it")
            else:
                logger.info(f"🔁 Repeat / location clarification at intro -> '{_rep}'")
                try:
                    self.session.say(lead + _rep, allow_interruptions=True)
                except Exception as e:
                    logger.warning(f"Intro repeat failed: {e}")
                else:
                    raise StopResponse()

        # Caller indicates they are thinking/considering at INTRODUCTION step (e.g. "Sochata rahun", "Soch raha hoon")
        if state.step == _S.INTRODUCTION and _is_considering(text):
            state.is_interested = True
            from .tools import classify_category, classify_intent
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
            state.last_agent_question = _rep
            logger.info(f"🤔 Considering/thinking at intro -> moving to category/intent: '{_rep}'")
            try:
                self.session.say(_rep, allow_interruptions=True)
            except Exception as e:
                logger.warning(f"Intro considering reply failed: {e}")
            else:
                raise StopResponse()

        # "Repeat" at ANY other step (other-property, new location, name): say the last question
        # we actually asked, verbatim. Repeating only happens when the caller asks for it.
        if state.step not in _intake and state.step != _S.CATEGORY_SELECT and state.step != _S.INTRODUCTION and state.step != _S.CLOSING \
                and _asks_repeat(text) and state.last_agent_question:
            lead = "Sure, " if state.reply_lang == "en" else "Ji, "
            logger.info(f"🔁 Repeat requested -> re-asking last question (no LLM): '{state.last_agent_question}'")
            try:
                self.session.say(lead + state.last_agent_question, allow_interruptions=True)
            except Exception as e:
                logger.warning(f"Re-ask failed, falling back to LLM: {e}")
            else:
                raise StopResponse()

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
            try:
                self.session.say(_rep, allow_interruptions=True)
            except Exception as e:
                logger.warning(f"Broker query reply failed: {e}")
            else:
                raise StopResponse()

        impatient_phrases = (
            "jaldi bolo", "jaldi batao", "time nahi", "time nhi", "bahut sawal", "kitna sawal",
            "kitne sawal", "hurry up", "don't have time", "dont have time", "wrap it up",
            "seedha point", "stop asking", "bakwas band", "short me bolo", "short mein",
        )
        if any(p in low_text for p in impatient_phrases):
            logger.info(f"⚠️ Impatience pattern detected in caller utterance: '{text}'")
            state.impatient_detected = True

        # Proactively detect category & intent directly from caller utterance
        from .tools import classify_category, classify_intent, commercial_type_from_speech
        from .state import RealEstateStep

        # A refusal ("nahi, us location pe nahi bechna") must not be read as an intent ('bechna' -> sale).
        _refusal = state.step in (RealEstateStep.INTRODUCTION, RealEstateStep.CHECK_OTHER_PROPERTY) and (
            _rejects_this_location(text) or _starts_with_negation(text)
        )
        detected_cat = None if _refusal else classify_category(text)
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

        if state.step in (RealEstateStep.CATEGORY_SELECT, RealEstateStep.ASK_NEW_LOCATION) and state.category and state.intent:
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

        # Caller asks "what rate / what price can I get?" during intake -> valuation line + closing,
        # spoken deterministically (no LLM round trip), then the call ends.
        if (
            state.step in (
                RealEstateStep.RESIDENTIAL_SALE, RealEstateStep.RESIDENTIAL_LEASE,
                RealEstateStep.COMMERCIAL_SALE, RealEstateStep.COMMERCIAL_LEASE,
            )
            and not state.closing_spoken
            and _asks_agent_for_price(text)
        ):
            logger.info(f"💰 Caller asked for price/valuation -> valuation closing (no LLM): '{text}'")
            state.valuation_requested = True
            try:
                await self._re_tools.book_advisor_handoff(reason="Price valuation requested")
            except Exception as e:
                logger.warning(f"Valuation closing failed, falling back to LLM: {e}")
                state.valuation_requested = False
            else:
                raise StopResponse()

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
                _has_rent_marker = bool(re.search(r"\b(per\s*month|par\s*manth|par\s*month|mahina|mahine|har\s*mahine|rent|kiraya|monthly)\b", text, re.I))
                _has_sale_marker = bool(re.search(r"\b(crore|crores|cr|bechna|bechni|sell|sale|total\s*price|full\s*price)\b", text, re.I))
                if _fp_field == "sale_price" and _has_rent_marker:
                    _fp_kw = _fastpath_extract("monthly_rent", text)
                elif _fp_field == "monthly_rent" and _has_sale_marker:
                    _fp_kw = _fastpath_extract("sale_price", text)
                elif _fp_field == "commercial_type":
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
                                self.session.say(_fp_reply, allow_interruptions=True)
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
            self._re_state.record_question_success()
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

        # The caller asked US something ("why do you need this?"): the LLM's spoken answer is a normal turn,
        # not a failed one. Speak it and keep going (no failure count, no advisor handoff).
        if self._question_exempt():
            logger.info("💬 Caller asked a question -> answered, NOT counted as 'not understood'")
            for c in held:
                yield c
            return

        # No tool was called: LLM is responding with speech because it did not understand / get the answer
        q_key = self._re_state.get_active_question_key()
        fail_count = self._re_state.record_question_failure(q_key)
        logger.info(f"❓ Question '{q_key}' not understood by LLM (failure count: {fail_count})")
        from .state import RealEstateStep
        if (self._re_state.is_interested or self._re_state.step in (
            RealEstateStep.RESIDENTIAL_SALE, RealEstateStep.RESIDENTIAL_LEASE,
            RealEstateStep.COMMERCIAL_SALE, RealEstateStep.COMMERCIAL_LEASE,
            RealEstateStep.CATEGORY_SELECT,
        )) and fail_count > 2:
            logger.info(f"🤝 After 2 failed attempts on '{q_key}' (count: {fail_count}) -> booking advisor callback handoff")
            await self._re_tools.book_advisor_handoff(reason="Could not understand caller after 2 failed attempts on same question")
            return

        for c in held:
            yield c

    async def _recover_text_tool_call(self, raw: str):
        """The LLM typed a tool call as text. Execute it safely and return the line to speak."""
        state = self._re_state
        name, args = _parse_text_tool_call(raw)
        logger.warning(f"🩹 Tool call typed as text -> recovering: name={name} args={args} raw={raw[:160]!r}")

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
        q_key = state.get_active_question_key()
        fail_count = 0 if self._question_exempt() else state.record_question_failure(q_key)
        from .state import RealEstateStep
        if (state.is_interested or state.step in (
            RealEstateStep.RESIDENTIAL_SALE, RealEstateStep.RESIDENTIAL_LEASE,
            RealEstateStep.COMMERCIAL_SALE, RealEstateStep.COMMERCIAL_LEASE,
            RealEstateStep.CATEGORY_SELECT,
        )) and fail_count > 2:
            logger.info(f"🤝 After 2 failed attempts on '{q_key}' in recovery -> booking advisor callback handoff")
            await self._re_tools.book_advisor_handoff(reason="Could not understand caller after 2 failed attempts on same question")
            return None

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
                        _q = _extract_question(out)
                        if _q:
                            self._re_state.last_agent_question = _q   # for "repeat that"
                        yield out
            out = _soften_tts_phrase(_clean_leaks(buf))
            if out.strip():
                _q = _extract_question(out)
                if _q:
                    self._re_state.last_agent_question = _q
                yield out

        return Agent.default.tts_node(self, guard(), model_settings)