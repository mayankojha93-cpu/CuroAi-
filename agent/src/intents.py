"""Deterministic (regex / token) intent classifiers for the Airtel router-pickup agent.

Rule of thumb used across the agent:
  * code owns anything CLOSED-SET, COMPLIANCE-CRITICAL or LATENCY-CRITICAL
    (plain yes/no, do-not-call, human request, fee/policy questions, dates, phone numbers);
  * the LLM owns OPEN-ENDED meaning (reasons, mixed intents, free-text details, odd questions).

Nothing here calls a tool or speaks. It only answers "does this utterance look like X?".

Devanagari note: Python's \\b is unreliable next to Devanagari matras, so Devanagari words are matched
as whole TOKENS (see tokens()) or with plain substring regexes, never with \\b.
"""
import re
from typing import List, Optional

_SPLIT_RE = re.compile(r"[\s,.;:!?।|/()\-\"']+")


def tokens(text: Optional[str]) -> List[str]:
    return [t for t in _SPLIT_RE.split(str(text or "").lower()) if t]


# ───────────────────────── yes / no ─────────────────────────

# Words that CAN carry a "yes" on their own.
_AFFIRM_CORE = {
    "हाँ", "हां", "हा", "हाँजी", "हांजी", "हंजी", "जी", "जीहां", "सही", "ठीक", "बिल्कुल", "यस", "येस",
    "स्पीकिंग", "करेक्ट", "राइट", "ओके", "हूँ", "हूं", "हु",
    "haan", "han", "ha", "haa", "haanji", "hanji", "haji", "ji", "jee", "yes", "yeah", "yep", "yup", "ok",
    "okay", "correct", "right", "sahi", "theek", "thik", "bilkul", "sure", "speaking", "hoon", "hun", "hu",
}
# Extra words that, for a generic-name identity question, also show "yes, I have the connection".
_AFFIRM_CONTEXT = {"वाईफाई", "वाई", "कनेक्शन", "एयरटेल", "wifi", "connection", "airtel"}

# Harmless words allowed AROUND an affirmation in a strict yes ("haan kar do", "ji bolo", "main hi bol raha hoon").
# A BARE "bolo"/"boliye" has no core word, so it is never a yes (it only means "go ahead").
_FILLER = {
    "hai", "hain", "है", "हैं", "main", "mai", "मैं", "मै", "hi", "ही", "bol", "bolo", "boliye", "बोल", "बोलो",
    "बोलिए", "बोलिये", "raha", "rahi", "रहा", "रही", "kar", "do", "karo", "kardo", "kijiye", "dijiye", "कर",
    "दो", "करो", "कीजिए", "दीजिए", "please", "plz", "प्लीज", "this", "is", "it", "the", "same", "sir", "madam",
    "mam", "sahab", "सर", "मैम",
}

_NEGATION = {
    "नहीं", "नही", "नहि", "ना", "गलत", "मत", "nahi", "nahin", "nhi", "nai", "no", "not", "wrong", "galat",
    "नो", "नॉट",
}
_QUESTION = {
    "kya", "क्या", "kaun", "कौन", "kyun", "kyu", "क्यों", "kab", "कब", "kahan", "कहाँ", "kaise", "कैसे",
    "who", "what", "why", "when", "where", "how", "kisne", "kitna", "कितना",
}
_DEFER = {"busy", "later", "बिजी", "बिज़ी", "व्यस्त", "baad", "बाद"}

_NO_CORE = {"nahi", "nahin", "nhi", "nai", "no", "nope", "नहीं", "नही", "नहि", "ना", "नो"}
_NO_FILLER = {"ji", "जी", "hai", "है", "bilkul", "बिल्कुल", "not", "thanks", "thank", "you", "sorry", "please"}


def is_clear_yes(text: Optional[str]) -> bool:
    """Loose check used as a GUARD on LLM tool arguments: the utterance contains an affirmative word and
    no negation / question / deferral. Never treats noise, off-topic words or "kaun bol raha hai" as consent."""
    toks = tokens(text)
    if not toks:
        return False
    if any(t in _NEGATION or t in _QUESTION or t in _DEFER for t in toks):
        return False
    return any(t in _AFFIRM_CORE or t in _AFFIRM_CONTEXT for t in toks)


def strict_yes(text: Optional[str]) -> bool:
    """Short (1-5 words), purely affirmative utterance: safe to act on WITHOUT the LLM.
    Anything with extra words, a negation, a question or a deferral goes to the LLM instead."""
    toks = tokens(text)
    if not toks or len(toks) > 5:
        return False
    if any(t in _NEGATION or t in _QUESTION or t in _DEFER for t in toks):
        return False
    if not all(t in _AFFIRM_CORE or t in _FILLER for t in toks):
        return False
    return any(t in _AFFIRM_CORE for t in toks)


def strict_no(text: Optional[str]) -> bool:
    """Short (1-3 words), purely negative utterance ("nahi", "no", "नहीं जी")."""
    toks = tokens(text)
    if not toks or len(toks) > 3:
        return False
    if any(t in _QUESTION or t in _DEFER for t in toks):
        return False
    if not all(t in _NO_CORE or t in _NO_FILLER for t in toks):
        return False
    return any(t in _NO_CORE for t in toks)


_GREETING = {
    "hello", "hi", "hey", "helo", "hallo", "namaste", "namaskar", "हेलो", "हैलो", "हाय", "हे", "नमस्ते", "नमस्कार",
}
_GREETING_FILLER = {"ji", "जी", "sir", "madam", "mam", "sahab", "सर", "मैम"}


def is_greeting(text: Optional[str]) -> bool:
    """A bare "hello" / "hello hello" / "namaste ji" (1-3 words): the customer is just picking up."""
    toks = tokens(text)
    if not toks or len(toks) > 3:
        return False
    return all(t in _GREETING or t in _GREETING_FILLER for t in toks) and any(t in _GREETING for t in toks)


# ───────────────────────── do-not-call ─────────────────────────

_DND_LATIN = re.compile(
    r"(?:\bdo\s*not\s*call\b|\bdon'?t\s*call\b|\bdont\s*call\b|\bstop\s+calling\b|\bno\s+more\s+calls?\b"
    r"|\bdnd\b|\bd\.n\.d\b|\bremove\s+(?:my|this)\s+number\b|\bblock\s+(?:my|this)\s+number\b"
    r"|\b(?:call|phone|calling)\s+(?:mat|na|nahi|nahin|band)\s+(?:karo|kare|karna|karein|karen|kijiye|kijiyega|karte)\b"
    r"|\b(?:call|phone)\s+karna\s+band\b|\bmujhe\s+call\s+(?:mat|na)\b|\bnumber\s+(?:hata|delete|remove)\b"
    r"|\bdobara\s+(?:call|phone)\s+(?:mat|na)\b)",
    re.I,
)
_DND_DEV = re.compile(
    r"(?:(?:कॉल|फोन|फ़ोन|काल)\s*(?:मत|ना|न|नहीं)\s*(?:करो|करें|करना|कीजिए|कीजिये|करिए|करिये)"
    r"|डी\s*एन\s*डी|डीएनडी|नंबर\s*(?:हटा|डिलीट|रिमूव)|नम्बर\s*(?:हटा|डिलीट|रिमूव)"
    r"|दोबारा\s*(?:कॉल|फोन)\s*(?:मत|न|ना)|तंग\s*मत)"
)
# "abhi call mat karo" / "don't call me now, call later" is a CALLBACK request, not DND -> leave to the LLM.
_LATER_LATIN = re.compile(
    r"\b(?:abhi|baad\s*mein|baad\s*me|later|kal|parso|busy|subah|shaam|morning|evening|tomorrow|now|before|after)\b", re.I
)
_LATER_DEV = ("अभी", "बाद में", "बाद मे", "कल", "परसों", "बिजी", "बिज़ी", "व्यस्त", "सुबह", "शाम")


def is_dnd(text: Optional[str]) -> bool:
    t = str(text or "")
    if not (_DND_LATIN.search(t) or _DND_DEV.search(t)):
        return False
    if _LATER_LATIN.search(t) or any(w in t for w in _LATER_DEV):
        return False
    return True


# ───────────────────────── human representative ─────────────────────────

_WANTS_HUMAN_LATIN = re.compile(
    r"\b(?:(?:talk|speak|connect|transfer)\s+(?:me\s+)?(?:to|with)\s+(?:a\s+|an\s+|the\s+)?"
    r"(?:human|person|agent|representative|executive|operator|supervisor|manager|live\s+(?:person|agent)|real\s+person|customer\s*care)"
    r"|kisi\s+insaan\s+se\s+baat|insaan\s+se\s+baat"
    r"|(?:executive|agent|human|manager|supervisor|customer\s*care)\s+se\s+baat"
    r"|i\s+want\s+(?:a\s+|an\s+)?(?:human|real\s+person|live\s+agent|representative))\b",
    re.I,
)
_WANTS_HUMAN_DEV = re.compile(
    r"(?:इंसान|इन्सान|व्यक्ति|एजेंट|एग्जीक्यूटिव|एक्जीक्यूटिव|एक्ज़ीक्यूटिव|ऑपरेटर|सुपरवाइज़र|सुपरवाइजर|मैनेजर|प्रतिनिधि|कस्टमर\s*केयर)\s*से\s*बात"
)


def wants_human(text: Optional[str]) -> bool:
    t = str(text or "")
    return bool(_WANTS_HUMAN_LATIN.search(t) or _WANTS_HUMAN_DEV.search(t))


# ───────────────────────── fees / policy / complaints ─────────────────────────
# Safety net for "never invent fees, refunds or policy": these go straight to escalate_to_121.
# A plain refund DEMAND ("mujhe refund chahiye") is NOT matched: record_refusal handles that.

_FEE_LATIN = re.compile(
    r"\b(?:fees?|charges?|charged|penalt(?:y|ies)|deposit|polic(?:y|ies)|compensation|cost|price|pricing"
    r"|how\s+much|refund\s+(?:amount|policy|status|kitna|kab|how\s+much)|amount\s+(?:of\s+)?refund"
    r"|kitn[aei]\s+(?:paisa|paise|rupa?ye|rupees|dena|dene|lagega|lagenge|charge|charges)|kitna\s+(?:lagega|dena)"
    r"|complain(?:t|ts|ing)?|escalat(?:e|ion))\b",
    re.I,
)
_FEE_DEV_TOKENS = {
    "चार्ज", "चार्जेस", "चार्जेज", "फीस", "जुर्माना", "पेनल्टी", "डिपॉजिट", "डिपाजिट", "डिपोजिट", "कीमत",
    "कॉस्ट", "प्राइस", "शिकायत", "कम्प्लेंट", "कंप्लेंट", "कम्पलेंट", "पॉलिसी", "मुआवजा", "मुआवज़ा",
}
_FEE_DEV_PHRASE = re.compile(
    r"(?:कितना|कितने|कितनी)\s*(?:पैसा|पैसे|रुपये|रुपए|लगेगा|देना|चार्ज)|रिफंड\s*(?:कितना|कब|अमाउंट|पॉलिसी)|पैसे\s*वापस\s*(?:कब|कितने)"
)


def is_fee_or_policy_question(text: Optional[str]) -> bool:
    t = str(text or "")
    if _FEE_LATIN.search(t) or _FEE_DEV_PHRASE.search(t):
        return True
    return any(tok in _FEE_DEV_TOKENS for tok in tokens(t))


# ───────────────────────── dates ─────────────────────────

_DATE_LATIN = re.compile(
    r"\b(?:kal|parso|parson|aaj|tomorrow|today|day\s+after|monday|tuesday|wednesday|thursday|friday|saturday|sunday"
    r"|somwar|somvar|mangalwar|budhwar|guruwar|guruvar|shukrawar|shaniwar|ravivar|itwar|tarikh|tareekh|date"
    r"|din\s+baad|days?|week|agle|agla|next|january|february|march|april|june|july|august|september|october"
    r"|november|december)\b"
    r"|\b\d{1,2}\s*(?:st|nd|rd|th)?\s*(?:ko|tarikh|tareekh|of\s+may|may)\b",
    re.I,
)
_DATE_DEV_TOKENS = {
    "कल", "परसों", "परसो", "आज", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "बृहस्पतिवार", "शुक्रवार", "शनिवार",
    "रविवार", "इतवार", "अगले", "अगला", "हफ्ते", "सप्ताह", "तारीख", "तारिख", "टुमॉरो", "टुमारो", "टुमोरो",
    "टुडे", "मंडे", "ट्यूसडे", "ट्यूजडे", "वेडनेसडे", "थर्सडे", "फ्राइडे", "सैटरडे", "संडे", "नेक्स्ट",
}
_DATE_DEV_PHRASE = re.compile(r"दिन\s*बाद|[0-9०-९]{1,2}\s*(?:को|तारीख|तारिख)")


def has_date_cue(text: Optional[str]) -> bool:
    """Cheap pre-check: does the utterance contain a word that can name a day/date at all?
    An address like "flat 25, sector 14" has none, so it can never be read as a pickup date."""
    t = str(text or "")
    if _DATE_LATIN.search(t) or _DATE_DEV_PHRASE.search(t):
        return True
    return any(tok in _DATE_DEV_TOKENS for tok in tokens(t))


# When the customer is answering a DETAIL question (when did you recharge, where is the router, ...),
# a date in the reply is NOT a pickup date: leave it to the LLM + the matching tool.
DETAIL_TOPIC_RE = re.compile(
    r"recharg|रिचार्ज|रीचार्ज|shift|शिफ्ट|शिफ़्ट|damage|damaged|टूट|खराब|ख़राब|lost|खो गया|खो गई|खोया|"
    r"refund|रिफंड|वापस पैसे|picked|already|पहले ही|ले गए|ले लिया|return(ed)? it|जमा कर|"
    r"complain|शिकायत|charge|penalt|जुर्माना|fee\b|dnd|do not call|मत करो कॉल|कॉल मत",
    re.IGNORECASE,
)


# ───────────────────────── phone numbers ─────────────────────────

_DIGIT_TRANS = str.maketrans("०१२३४५६७८९", "0123456789")
_SPOKEN_DIGITS = {
    "zero": "0", "oh": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6",
    "seven": "7", "eight": "8", "nine": "9",
    "shunya": "0", "ek": "1", "do": "2", "teen": "3", "char": "4", "chaar": "4", "paanch": "5", "panch": "5",
    "chhe": "6", "chhah": "6", "che": "6", "saat": "7", "aath": "8", "nau": "9",
    "शून्य": "0", "जीरो": "0", "ज़ीरो": "0", "एक": "1", "दो": "2", "तीन": "3", "चार": "4", "पांच": "5",
    "पाँच": "5", "छह": "6", "छः": "6", "छे": "6", "सात": "7", "आठ": "8", "नौ": "9",
}
_REPEATERS = {"double": 2, "dabal": 2, "डबल": 2, "triple": 3, "tripal": 3, "ट्रिपल": 3}
_PHONE_RE = re.compile(r"(?:\+?91|0)?([6-9]\d{9})")


def extract_phone(text: Optional[str]) -> str:
    """Return a 10-digit Indian mobile number found in the utterance (digits or spoken digits), else ''.
    Only a RUN of consecutive digit words counts, so "do din baad" or a house number is never a phone."""
    runs: List[str] = []
    cur = ""
    repeat = 1
    for tok in tokens(str(text or "").translate(_DIGIT_TRANS)):
        if tok in _REPEATERS:
            repeat = _REPEATERS[tok]
            continue
        digits = ""
        if tok.isdigit():
            digits = tok
        elif tok in _SPOKEN_DIGITS:
            digits = _SPOKEN_DIGITS[tok] * repeat
        if digits:
            cur += digits
        else:
            if cur:
                runs.append(cur)
            cur = ""
        repeat = 1
    if cur:
        runs.append(cur)
    for run in runs:
        m = _PHONE_RE.fullmatch(run)
        if m:
            return m.group(1)
    return ""