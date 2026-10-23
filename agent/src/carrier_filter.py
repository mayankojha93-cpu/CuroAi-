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
    # Hindi / Marathi announcement forms
    r"कॉल को होल्ड",
    r"कॉल होल्ड",
    r"होल्ड (पे|पर) रखा",
    r"होल्डवर",
    r"लाईनवर रहा",
    r"लाइन पर बने रहें",
    r"कृपया लाइन पर",
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
    # Hindi
    r"पहुँच से बाहर",
    r"पहुंच से बाहर",
    r"स्विच(्ड)? ऑफ",
    r"नेटवर्क (क्षेत्र )?से बाहर",
    r"आपके द्वारा (डायल|संपर्क) किया गया",
    r"आपने जिस (व्यक्ति|नंबर)",
    r"संदेश छोड़",
    r"बीप के बाद",
    r"कृपया अपना संदेश",
]

_HOLD_RE = re.compile("|".join(f"(?:{p})" for p in _HOLD_PATTERNS), re.IGNORECASE)
_VOICEMAIL_RE = re.compile("|".join(f"(?:{p})" for p in _VOICEMAIL_PATTERNS), re.IGNORECASE)


def classify_carrier_message(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    t = " ".join(text.lower().split())
    if not t:
        return None
    # Voicemail first: it is the stronger signal ("...not reachable. Please stay on the line" etc.)
    if _VOICEMAIL_RE.search(t):
        return "voicemail"
    if _HOLD_RE.search(t):
        return "hold"
    return None