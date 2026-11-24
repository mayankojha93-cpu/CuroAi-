"""Detects automated carrier / IVR / voicemail / answering machine announcements
that STT transcribes as if the CUSTOMER had spoken them.

These must never reach the LLM: they trigger unwanted tool executions or confused replies.

Every pattern is either
  STRONG  - only a machine says this. Safe to hang up on the first hit.
  WEAK    - a machine says it, but a real customer or a relative who picked up could say it too
            ("I'm not available at the moment", "the address is incorrect", "nobody is available at home").
            Weak hits are only trusted on LONG utterances (announcements are long, customers are short),
            and the caller (AirtelTurnHandler) needs two of them in a row before hanging up.
  HOLD    - call-waiting / "has put you on hold". Never a reason to hang up: ignore the turn and wait.

classify_carrier(text) -> CarrierHit(kind, strong, words) | None
classify_carrier_message(text) -> kind | None   (legacy helper, strong OR weak)
kind: "ivr" | "voicemail" | "answering_machine" | "automated_system" | "hold"
"""
import re
from typing import List, NamedTuple, Optional


class CarrierHit(NamedTuple):
    kind: str
    strong: bool
    words: int


# ───────────────────────── STRONG ─────────────────────────

_IVR_STRONG = [
    r"welcome to (our|the)?\s*service",
    r"welcome to\s+(airtel|jio|vi|vodafone|bsnl|customer\s*care|our\s*(customer\s*)?service)\b",
    r"please listen carefully",
    r"please select an option",
    r"(kindly|please)\s+choose\s+(from\s+)?(the\s+following\s+options|an\s+option)",
    r"for english[, ]+press\s*(1|one|\b)",
    r"for hindi[, ]+press\s*(2|two|\b)",
    r"press\s*(1|one)\s*to continue",
    r"press\s*(2|two)\s*for (more|other) options",
    r"press\s*(0|zero)\s*to speak (to|with) (an?\s*)?(operator|representative|agent)?",
    r"press (the\s*)?star key",
    r"press (the\s*)?(hash|pound) key",
    r"\bpress\s*(star|hash|pound|zero|one|two|three|four|five|six|seven|eight|nine|\d)\b",
    r"please enter your (10|ten)[ -]digit (mobile\s+)?number",
    r"please enter your customer (id|number)",
    r"please enter your pin\b",
    r"your call is (being\s+)?(transferred|forwarded|connected)",
    r"your call is (very\s+)?important to us",
    r"(all\s+)?(our\s+)?(agents|executives|representatives|customer care|lines) are (currently\s+)?(busy|unavailable|engaged)",
    r"(we are\s+)?experiencing higher than (normal|usual) call volumes?",
    r"your estimated wait time is",
    r"you are in a queue",
    r"to repeat (this\s+)?(message|menu)?,?\s*press",
    r"to go back (to the previous menu)?,?\s*press",
    r"to speak (with|to) (customer support|an agent|an operator)?,?\s*press",
    r"to know more,?\s*press",
    r"(your\s+)?call may be recorded for (quality|training)",
    r"this call (may be|is being) (monitored|recorded)",
    r"connecting you to the next available (representative|agent)",
]

_VOICEMAIL_STRONG = [
    r"please leave a message after the (beep|tone)",
    r"leave (a\s+|your\s+)?message after the (tone|beep)",
    r"please record your message",
    r"at the tone,?\s*please record your message",
    r"start recording after the beep",
    r"you may hang up after recording your message",
    r"when you (have\s+)?finished recording,?\s*(you may\s+)?hang up",
    r"you may hang up (when|after) you (have\s+)?finish(ed)? recording",
    r"press\s*(pound|hash)\s*when you are finished",
    r"please leave your name and (contact\s+|phone\s+)?number",
    r"the person you are trying to reach is (currently\s+)?(unavailable|not available)",
    r"\b(at|after)\s+the\s+tone\b",
    r"\bafter\s+the\s+beep\b",
    r"the person you are calling cannot answer (right now)?",
    r"your call has been forwarded to voice\s*mail",
    r"you('ve| have) reached (the\s+)?voice\s*mail",
    r"you('ve| have) reached (the\s+)?(answering machine|mail\s*box)",
    r"nobody is available to take your call",
    r"the subscriber is (currently\s+)?(not available|busy)",
    r"(the\s+|this\s+)?mail\s*box is full",
    r"this mail\s*box cannot accept any more messages",
    r"(the\s+)?voice\s*mail( box)? is not set up",
    r"sorry,?\s*(the\s+)?person you are trying to reach",
    r"please try your call again later",
    r"(forwarded\s+to|reached|leave\s+a\s+message\s+in)\s+(the\s+)?voice\s*mail",
    r"(forwarded\s+to|reached|leave\s+a\s+message\s+in)\s+(the\s+)?mail\s*box",
]

_ANSWERING_MACHINE_STRONG = [
    r"hello,?\s*you have reached",
    r"sorry i (can\s*not|can't) take your call",
    r"you have reached the answering machine",
    r"please speak after the beep",
    r"thank you for calling,?\s*goodbye",
]

_AUTOMATED_STRONG = [
    r"this is an automated message",
    r"this is a pre-recorded message",
    r"you are receiving an automated call",
    r"this is an auto-generated notification",
    r"please respond using your keypad",
    r"voice recognition is not available",
    r"invalid selection",
    r"incorrect input",
    r"(?:invalid\s*selection|incorrect\s*input|call\s*cannot\s*be\s*completed).*(?:please\s+)?try\s+again",
    r"your session has expired",
    r"you have entered an invalid option",
    # "The number you have dialed / are calling is currently switched off / not reachable / ..."
    r"number you (?:have\s+)?(?:are\s+)?(?:dialed|dialled|called|calling)\s+(?:is|does|doesn't|does not|has)\s+"
    r"(?:currently\s+|temporarily\s+)?(?:switched\s*off|not\s+reachable|unavailable|not\s+in\s+service|invalid|incorrect|out\s+of|busy|no\s+longer|not\s+exist|exist)",
    r"number is temporarily unavailable",
    r"subscriber is currently busy",
    r"call cannot be completed as dialed",
    r"please check the number and try again",
    r"number\s+(?:is|has been)\s+(?:invalid|not in service|barred)",
    r"pahunch se bahar",
    r"पहुंच से बाहर",
    r"पहुँच से बाहर",
    r"yeh number (maujood|uplabdh)\s+nahi",
    r"यह नंबर (मौजूद|उपलब्ध)\s+नहीं",
]

_INDIAN_IVR_STRONG = [
    r"kripya line par bane rahein",
    r"line par bane rahe",
    r"kripya line par",
    r"कृपया लाइन पर",
    r"लाइन पर बने रहें",
    r"kripya (kuch der\s+)?(pratiksha|intezaar|intezar) karein?",
    r"कृपया (कुछ देर\s+)?प्रतीक्षा करें",
    r"aapka call transfer kiya ja raha hai",
    r"आपका कॉल ट्रांसफर",
    r"aapka call (hamare liye\s+)?(mahatvapurn|important)",
    r"आपका कॉल (हमारे लिए\s+)?महत्वपूर्ण",
    r"(sabhi|all)\s+agents?\s+(abhi\s+)?(vyast|busy)\s+hain?",
    r"सभी (एजेंट|एजेंट्स) अभी व्यस्त हैं",
    r"kripya apna vikalp chunein?",
    r"कृपया अपना विकल्प चुनें",
    r"hindi ke liye\s*(1|ek|\b)\s*dabayein?",
    r"english ke liye\s*(2|do|\b)\s*dabayein?",
    r"हिंदी के लिए\s*(1|एक|\b)\s*दबाएं",
    r"इंग्लिश के लिए\s*(2|दो|\b)\s*दबाएं",
    r"grahak seva ke liye\s*(\d|\b)\s*dabayein?",
    r"ग्राहक सेवा के लिए",
    r"kripya apna (mobile\s+)?number (darj|dalein|enter)",
    r"kripya apna (das|10)\s+ankon ka mobile number",
    r"apna customer id darj karein?",
    r"aapki call record ki ja sakti hai",
    r"आपकी कॉल रिकॉर्ड",
    r"aapko agle uplabdh pratinidhi se joda ja raha hai",
    r"आपको अगले उपलब्ध प्रतिनिधि",
    r"kripya phone disconnect na karein?",
    r"कृपया फोन डिस्कनेक्ट",
    r"dobara sunne ke liye\s*(\d|\b)\s*dabayein?",
    r"दोबारा सुनने के लिए",
    r"pichhle menu mein jaane ke liye\s*(\d|\b)\s*dabayein?",
    r"पिछले मेनू में जाने के लिए",
    r"aapka intezar karne ke liye dhanyavaad",
    r"आपका इंतज़ार करने के लिए धन्यवाद",
    r"aapki call jodi ja rahi hai",
    r"आपकी कॉल जोड़ी जा रही है",
    r"(?:ke\s*liye|options?|vikalp|\d)\s*(?:ko)?\s*(?:dabayein|dabaiye|दबाएं|दबाइए)",
]

_INDIAN_VOICEMAIL_STRONG = [
    r"kripya beep ke baad (apna\s+)?(message|sandesh)",
    r"beep ke baad (apna\s+)?(sandesh|message)",
    r"beep ke baad boliye",
    r"बीप के बाद",
    r"jis vyakti se aap baat karna chahte hain",
    r"जिस व्यक्ति से आप बात",
    r"abhi aapki call receive nahi ki ja sakti",
    r"kripya apna naam aur number chhod",
    r"aapka message record kiya ja raha hai",
    r"kripya tone ke baad bolna shuru karein",
    r"\btone ke baad",
    r"vyakti abhi phone nahi utha sakta",
    r"aap voice\s*mail par pahunch gaye hain",
    r"filhaal koi call receive karne ke liye uplabdh nahi hai",
    r"kripya apna sandesh chhod",
    r"aapka sandesh record hone ke baad",
]

# ───────────────────────── WEAK ─────────────────────────

_IVR_WEAK = [
    r"thank you for calling\s+(?:our\s+customer\s+service|airtel|jio|vi|vodafone|bsnl|customer\s*care)\b",
    r"\bdial\s*(star|hash|pound|zero|\d)\b",
    r"please hold (while we connect)",
    r"please (stay|remain|hold) on the line",
    r"stay on the line",
    r"thank you for your patience",
    r"please do not disconnect (the call)?",
    r"aapka swagat hai",
    r"आपका स्वागत है",
    r"customer care se baat karne ke liye",
    r"कस्टमर केयर से बात",
    r"kripya baad mein dobara call karein",
]

_VOICEMAIL_WEAK = [
    r"the person is currently unavailable",
    r"please leave a message and (they|we) will get back",
    r"kripya baad mein dobara call karein",
    r"sandesh chhod",
    r"संदेश छोड़",
    r"(?:subscriber|grahak|number|vyakti|customer|sewa|call\s*receive\s*karne)\s+.*(?:uplabdh\s*nahi|उपलब्ध\s*नहीं)",
    r"(?:uplabdh\s*nahi|उपलब्ध\s*नहीं)\s+(?:hai|hain|है|हैं)\s*(?:kripya|baad\s*mein|kuch\s*der)",
]

_ANSWERING_MACHINE_WEAK = [
    r"i('m| am) not available at the moment",
    r"i am (currently\s+)?unable to answer your call",
    r"please leave a (detailed\s+)?message",
    r"i('ll| will) get back to you as soon as possible",
    r"leave your name and (contact\s+)?number",
    r"i will return your call",
    r"nobody is available (right now|at the moment)",
]

_AUTOMATED_WEAK = [
    r"sorry,?\s*i didn't get that",
    r"temporarily (unavailable|disconnected|out of service)",
    r"(number|call)\s+(does not|doesn't)\s+exist",
    r"(?:number|phone|mobile|subscriber|grahak)\s+.*(?:is\s+)?(?:currently\s+)?(?:switched\s*off|स्विच(?:्ड)?\s*ऑफ)",
    r"(?:switched\s*off|स्विच(?:्ड)?\s*ऑफ)\s*(?:hai|aa\s*raha|bata\s*raha)",
    r"(number|subscriber|customer|phone|mobile|grahak)\b[^.]{0,50}\b(not\s+reachable|can\s*not\s+be\s+reached|cannot\s+be\s+reached)",
    r"network (kshetra|area)?\s*se bahar",
    r"नेटवर्क (क्षेत्र\s*)?से बाहर",
    r"out of (the\s+)?(network|coverage)",
]

# ───────────────────────── HOLD (ignore the turn, keep the call) ─────────────────────────

_HOLD = [
    r"put (your|you|the) call on hold",
    r"has put you on hold",
    r"call (has been )?(put )?on hold",
    r"please hold the line",
    r"कॉल को होल्ड",
    r"कॉल होल्ड",
    r"होल्ड (पे|पर) रखा",
    r"होल्डवर",
    r"लाईनवर रहा",
    r"call (ko )?hold par",
    r"hold (pe|par) rakha",
]


def _compile(patterns: List[str]) -> "re.Pattern[str]":
    return re.compile("|".join(f"(?:{p})" for p in patterns), re.IGNORECASE)


# Priority order matters: voicemail beats IVR beats automated.
_STRONG_RES = [
    ("voicemail", _compile(_VOICEMAIL_STRONG)),
    ("voicemail", _compile(_INDIAN_VOICEMAIL_STRONG)),
    ("answering_machine", _compile(_ANSWERING_MACHINE_STRONG)),
    ("ivr", _compile(_IVR_STRONG)),
    ("ivr", _compile(_INDIAN_IVR_STRONG)),
    ("automated_system", _compile(_AUTOMATED_STRONG)),
]
_WEAK_RES = [
    ("voicemail", _compile(_VOICEMAIL_WEAK)),
    ("answering_machine", _compile(_ANSWERING_MACHINE_WEAK)),
    ("ivr", _compile(_IVR_WEAK)),
    ("automated_system", _compile(_AUTOMATED_WEAK)),
]
_HOLD_RE = _compile(_HOLD)


def classify_carrier(text: Optional[str]) -> Optional[CarrierHit]:
    """Returns a CarrierHit, or None when the text looks like a normal customer utterance."""
    if not text:
        return None
    t = " ".join(text.lower().split())
    if not t:
        return None
    words = len(t.split())

    for kind, rx in _STRONG_RES:
        if rx.search(t):
            return CarrierHit(kind, True, words)
    if _HOLD_RE.search(t):
        return CarrierHit("hold", True, words)
    for kind, rx in _WEAK_RES:
        if rx.search(t):
            return CarrierHit(kind, False, words)
    return None


def classify_carrier_message(text: Optional[str]) -> Optional[str]:
    """Legacy helper: kind of ANY hit (strong, weak or hold), or None."""
    hit = classify_carrier(text)
    return hit.kind if hit else None


def is_ivr_or_voicemail(text: Optional[str]) -> bool:
    """True only for a STRONG machine announcement (hold and weak matches do not count)."""
    hit = classify_carrier(text)
    return bool(hit and hit.strong and hit.kind != "hold")