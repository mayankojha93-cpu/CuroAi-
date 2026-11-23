"""Detects automated carrier / IVR / voicemail / answering machine announcements
that STT transcribes as if the CUSTOMER had spoken them.

These must never reach the LLM: they trigger unwanted tool executions or confused replies.
When detected, the call is dropped immediately and marked as 'Voicemail or IVR Detected' (completed).

classify_carrier_message(text) -> "ivr" | "voicemail" | "answering_machine" | "automated_system" | "hold" | None
"""
import re
from typing import Optional

# 1. IVR Detection Phrases (English)
_IVR_ENGLISH_PATTERNS = [
    r"thank you for calling\s+(our\s+customer\s+service|airtel|jio|vi|vodafone|bsnl|customer\s*care|,\s*goodbye\b)",
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
    r"press\s*(star|hash|pound|zero|one|two|three|four|five|six|seven|eight|nine|\d)\b",
    r"\bdial\s*(star|hash|pound|zero|\d)\b",
    r"please enter your (10|ten)[ -]digit (mobile\s+)?number",
    r"please enter your customer (id|number)",
    r"please enter your pin\b",
    r"please hold (while we connect|the line)",
    r"please (stay|remain|hold) on the line",
    r"stay on the line",
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
    r"thank you for your patience",
    r"please do not disconnect (the call)?",
    r"connecting you to the next available (representative|agent)",
]

# 2. Voicemail Detection Phrases (English)
_VOICEMAIL_ENGLISH_PATTERNS = [
    r"please leave a message after the (beep|tone)",
    r"leave (a\s+|your\s+)?message after the (tone|beep)",
    r"please record your message",
    r"at the tone,?\s*please record your message",
    r"record your message",
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
    r"the person is currently unavailable",
    r"please leave a message and (they|we) will get back",
    r"(the\s+|this\s+)?mail\s*box is full",
    r"this mail\s*box cannot accept any more messages",
    r"(the\s+)?voice\s*mail( box)? is not set up",
    r"sorry,?\s*(the\s+)?person you are trying to reach",
    r"please try your call again later",
    r"(forwarded\s+to|reached|leave\s+a\s+message\s+in)\s+(the\s+)?voice\s*mail",
    r"(forwarded\s+to|reached|leave\s+a\s+message\s+in)\s+(the\s+)?mail\s*box",
]

# 3. Answering Machine Detection Phrases (English)
_ANSWERING_MACHINE_PATTERNS = [
    r"hello,?\s*you have reached",
    r"sorry i (can\s*not|can't) take your call",
    r"i('m| am) not available at the moment",
    r"i am (currently\s+)?unable to answer your call",
    r"please leave a (detailed\s+)?message",
    r"i('ll| will) get back to you as soon as possible",
    r"leave your name and (contact\s+)?number",
    r"please leave a detailed message",
    r"i will return your call",
    r"thank you for calling,?\s*goodbye",
    r"you have reached the answering machine",
    r"nobody is available (right now|at the moment)",
    r"please speak after the beep",
]

# 4. Indian IVR Detection Phrases (Hindi / Hinglish – Roman Script & Devanagari)
_INDIAN_IVR_PATTERNS = [
    r"kripya line par bane rahein",
    r"line par bane rahe",
    r"kripya line par",
    r"कृपया लाइन पर",
    r"लाइन पर बने रहें",
    r"aapka swagat hai",
    r"आपका स्वागत है",
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
    r"customer care se baat karne ke liye",
    r"कस्टमर केयर से बात",
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

# 5. Indian Voicemail Detection Phrases (Hindi / Hinglish – Roman Script & Devanagari)
_INDIAN_VOICEMAIL_PATTERNS = [
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
    r"tone ke baad",
    r"vyakti abhi phone nahi utha sakta",
    r"kripya baad mein dobara call karein",
    r"aap voice\s*mail par pahunch gaye hain",
    r"filhaal koi call receive karne ke liye uplabdh nahi hai",
    r"kripya apna sandesh chhod",
    r"aapka sandesh record hone ke baad",
    r"sandesh chhod",
    r"संदेश छोड़",
    r"(?:subscriber|grahak|number|vyakti|customer|sewa|call\s*receive\s*karne)\s+.*(?:uplabdh\s*nahi|उपलब्ध\s*नहीं)",
    r"(?:uplabdh\s*nahi|उपलब्ध\s*नहीं)\s+(?:hai|hain|है|हैं)\s*(?:kripya|baad\s*mein|kuch\s*der)",
]

# 6. Additional Automated System Phrases
_AUTOMATED_SYSTEM_PATTERNS = [
    r"this is an automated message",
    r"this is a pre-recorded message",
    r"you are receiving an automated call",
    r"this is an auto-generated notification",
    r"please respond using your keypad",
    r"voice recognition is not available",
    r"sorry,?\s*i didn't get that",
    r"invalid selection",
    r"incorrect input",
    r"(?:invalid\s*selection|incorrect\s*input|call\s*cannot\s*be\s*completed).*(?:please\s+)?try\s+again",
    r"your session has expired",
    r"you have entered an invalid option",
    r"number you have dialed is currently switched off",
    r"number you are calling is not reachable",
    r"number is temporarily unavailable",
    r"subscriber is currently busy",
    r"number you have dialed does not exist",
    r"call cannot be completed as dialed",
    r"please check the number and try again",
    r"(?:number|phone|mobile|subscriber|grahak)\s+.*(?:is\s+)?(?:currently\s+)?(?:switched\s*off|स्विच(?:्ड)?\s*ऑफ)",
    r"(?:switched\s*off|स्विच(?:्ड)?\s*ऑफ)\s*(?:hai|aa\s*raha|bata\s*raha)",
    r"(number|subscriber|customer|phone|mobile|grahak)\b[^.]{0,50}\b(not\s+reachable|can\s*not\s+be\s+reached|cannot\s+be\s+reached)",
    r"pahunch se bahar",
    r"पहुंच से बाहर",
    r"पहुँच से बाहर",
    r"network (kshetra|area)?\s*se bahar",
    r"नेटवर्क (क्षेत्र\s*)?से बाहर",
    r"out of (the\s+)?(network|coverage)",
    r"temporarily (unavailable|disconnected|out of service)",
    r"number you (have\s+)?(dialed|dialled|called)\s+(is|does|doesn't|does not)",
    r"(number|call)\s+(does not|doesn't)\s+exist",
    r"(is|has been)\s+(incorrect|invalid|not in service|barred)",
    r"yeh number (maujood|uplabdh)\s+nahi",
    r"यह नंबर (मौजूद|उपलब्ध)\s+नहीं",
]

# Legacy hold announcements
_HOLD_PATTERNS = [
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

_IVR_ENGLISH_RE = re.compile("|".join(f"(?:{p})" for p in _IVR_ENGLISH_PATTERNS), re.IGNORECASE)
_VOICEMAIL_ENGLISH_RE = re.compile("|".join(f"(?:{p})" for p in _VOICEMAIL_ENGLISH_PATTERNS), re.IGNORECASE)
_ANSWERING_MACHINE_RE = re.compile("|".join(f"(?:{p})" for p in _ANSWERING_MACHINE_PATTERNS), re.IGNORECASE)
_INDIAN_IVR_RE = re.compile("|".join(f"(?:{p})" for p in _INDIAN_IVR_PATTERNS), re.IGNORECASE)
_INDIAN_VOICEMAIL_RE = re.compile("|".join(f"(?:{p})" for p in _INDIAN_VOICEMAIL_PATTERNS), re.IGNORECASE)
_AUTOMATED_SYSTEM_RE = re.compile("|".join(f"(?:{p})" for p in _AUTOMATED_SYSTEM_PATTERNS), re.IGNORECASE)
_HOLD_RE = re.compile("|".join(f"(?:{p})" for p in _HOLD_PATTERNS), re.IGNORECASE)


def classify_carrier_message(text: Optional[str]) -> Optional[str]:
    """Classifies incoming text against IVR, Voicemail, Answering Machine, and Automated System patterns.
    Returns: 'ivr' | 'voicemail' | 'answering_machine' | 'automated_system' | 'hold' | None
    """
    if not text:
        return None
    t = " ".join(text.lower().split())
    if not t:
        return None

    if _VOICEMAIL_ENGLISH_RE.search(t):
        return "voicemail"
    if _INDIAN_VOICEMAIL_RE.search(t):
        return "voicemail"
    if _ANSWERING_MACHINE_RE.search(t):
        return "answering_machine"
    if _IVR_ENGLISH_RE.search(t):
        return "ivr"
    if _INDIAN_IVR_RE.search(t):
        return "ivr"
    if _AUTOMATED_SYSTEM_RE.search(t):
        return "automated_system"
    if _HOLD_RE.search(t):
        return "hold"

    return None


def is_ivr_or_voicemail(text: Optional[str]) -> bool:
    """Returns True if the text represents any IVR, Voicemail, Answering Machine, or Automated carrier message."""
    return classify_carrier_message(text) is not None
    