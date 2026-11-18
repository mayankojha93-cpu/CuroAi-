"""
Detects automated carrier / voicemail announcements that Sarvam STT transcribes as if the
CUSTOMER had spoken them (e.g. call-waiting: "The person you are speaking with has put your
call on hold. Please stay on the line.").

These must never reach the LLM: it treats them as a customer answer and fires tools such as
confirm_identity / schedule_callback.

classify_carrier_message(text) -> "hold" | "voicemail" | None
  "hold"      : call-waiting / hold announcement. Ignore it and keep waiting for the real customer.
  "voicemail" : voicemail greeting / not reachable / switched off. No human will answer:
                end the call as VOICEMAIL (the backend schedules a retry).
"""
import re
from typing import Optional

# Patterns are matched against lower-cased text. Keep them multi-word / announcement-style so a real
# customer saying "ek minute hold karo" or "main busy hoon" is NOT filtered.
_HOLD_PATTERNS = [
    r"put (your|you|the) call on hold",
    r"has put you on hold",
    r"call (has been )?(put )?on hold",
    r"please (stay|remain|hold) on the line",
    r"stay on the line",
    r"please hold the line",
    # Hindi / Marathi announcement forms (Devanagari and Latin script)
    r"कॉल को होल्ड",
    r"कॉल होल्ड",
    r"होल्ड (पे|पर) रखा",
    r"होल्डवर",
    r"लाईनवर रहा",
    r"लाइन पर बने रहें",
    r"कृपया लाइन पर",
    r"line par bane rahe",
    r"kripya line par",
    r"call (ko )?hold par",
    r"hold (pe|par) rakha",
]

_VOICEMAIL_PATTERNS = [
    r"voice ?mail",
    r"leave (a|your) message",
    r"after the (tone|beep)",
    r"not reachable",
    r"can ?not be reached",
    r"switched off",
    r"out of (the )?(network|coverage)",
    r"number you (have )?(dialed|dialled|called)",
    r"person you (are|have) (calling|called|dialed|dialled)",
    r"is currently (unavailable|not available)",
    r"temporarily (unavailable|disconnected|out of service)",
    # Hindi / Regional (Devanagari and Latin script)
    r"पहुँच से बाहर",
    r"पहुंच से बाहर",
    r"स्विच(्ड)? ऑफ",
    r"नेटवर्क (क्षेत्र )?से बाहर",
    r"आपके द्वारा (डायल|संपर्क) किया गया",
    r"आपने जिस (व्यक्ति|नंबर)",
    r"संदेश छोड़",
    r"बीप के बाद",
    r"कृपया अपना संदेश",
    r"network (kshetra|area) se bahar",
    r"pahunch se bahar",
    r"beep ke baad",
    r"sandesh chhod",
]

# IVR menus / auto-attendants and recorded voicemail greetings. A human never says these, so they are
# classified as "voicemail" (no human will answer -> end the call, backend schedules a retry).
# Deliberately NOT included: first-person phrases a real person might say ("I can't take your call now",
# "main busy hoon", "I'm not available").
_IVR_PATTERNS = [
    r"press (star|hash|pound|zero|one|two|three|four|five|\d)\b",
    r"\bdial (star|hash|pound|zero|\d)\b",
    r"to (repeat|go back)( this)?( menu| message)?,? press",
    r"for (english|hindi)[, ]+press",
    r"(all|our) (agents|executives|representatives|customer care|lines) are (busy|engaged)",
    r"(is|are) (busy|engaged) on (another|an?other) call",
    r"your call is (important|being (transferred|forwarded|connected))",
    r"this call (may be|is being) recorded",
    r"(thank you for|welcome to) (calling|contacting)",
    r"you('ve| have) reached",
    r"(is|are) (currently )?(not available|unable) to (take|answer) your call",
    r"(mail ?box|voice ?mail box) is (full|not (set up|available))",
    r"record your message",
    r"number you (have )?(dialed|dialled|called) (is|does|doesn't|does not)",
    r"(number|call) (does not|doesn't) exist",
    r"(is|has been) (incorrect|invalid|not in service|barred)",
    # Hindi / Hinglish (Devanagari and Latin script)
    r"दबाएं",
    r"दबाइए",
    r"कृपया प्रतीक्षा",
    r"आपका कॉल (महत्वपूर्ण|हमारे)",
    r"यह नंबर (मौजूद|उपलब्ध) नहीं",
    r"व्यस्त (हैं|है) कृपया",
    r"dabayein",
    r"dabaiye",
    r"kripya (pratiksha|intezaar|intezar)",
    r"aapka call (mahatvapurn|important)",
    r"(abhi|is samay) (vyast|uplabdh nahi)",
    r"yeh number (maujood|uplabdh) nahi",
]

_HOLD_RE = re.compile("|".join(f"(?:{p})" for p in _HOLD_PATTERNS), re.IGNORECASE)
_VOICEMAIL_RE = re.compile("|".join(f"(?:{p})" for p in _VOICEMAIL_PATTERNS), re.IGNORECASE)
_IVR_RE = re.compile("|".join(f"(?:{p})" for p in _IVR_PATTERNS), re.IGNORECASE)


def classify_carrier_message(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    t = " ".join(text.lower().split())
    if not t:
        return None
    # Voicemail first: it is the stronger signal ("...not reachable. Please stay on the line" etc.)
    if _VOICEMAIL_RE.search(t):
        return "voicemail"
    if _IVR_RE.search(t):
        return "voicemail"
    if _HOLD_RE.search(t):
        return "hold"
    return None