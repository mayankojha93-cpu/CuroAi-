"""Language helpers: detect whether the customer is speaking Hindi/Hinglish or English,
and pick the matching line.

reply_lang on ConversationState is "hi" or "en". It starts as "hi" (the greeting is Hindi) and follows the
customer after every turn.
"""
import re
from typing import Optional

_DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_DEV_TOKEN = re.compile(r"[ऀ-ॿ]+")
_LATIN_TOKEN = re.compile(r"[a-zA-Z']+")

# Romanised Hindi (Hinglish) markers. Words that are also common English words are left out on purpose.
_HINGLISH = {
    "haan", "han", "haa", "ha", "haji", "nahi", "nahin", "nhi", "kal", "parso", "parson", "aaj", "hai", "hain", "hoon",
    "hun", "ji", "theek", "thik", "accha", "achha", "acha", "kya", "kyun", "kyu", "kaun", "kab", "kahan",
    "mujhe", "mera", "meri", "mere", "aap", "aapka", "aapki", "mai", "hum", "humne", "karo",
    "kardo", "kijiye", "kijiyega", "dijiye", "bolo", "boliye", "baad", "abhi", "somwar", "somvar",
    "mangalwar", "budhwar", "guruwar", "shukrawar", "shaniwar", "ravivar", "itwar", "tarikh", "tareekh",
    "din", "baje", "wapas", "lekin", "aur", "bhi", "ko", "ka", "ki", "ke", "ne", "mein", "raha", "rahi",
    "rahe", "chahiye", "chahta", "chahte", "chahti", "sakta", "sakte", "sakti", "samajh", "bilkul",
    "sahi", "galat", "paise", "kar", "karna", "karenge", "kariye", "bhej", "lijiye", "namaste", "namaskar",
    "bataiye", "batao", "wala", "wali", "tha", "thi", "ghar", "pe", "par", "se", "nai", "mat",
    "bechna", "bechni", "kiraya", "kiraye", "dena", "deni", "bhai", "bhaiya", "sirji", "sahab", "apna", "apni", "apne",
}

# English markers. Words that are common in Hinglish too ("to", "do", "me", "a", "so", "main") are left out.
_ENGLISH = {
    "yes", "yeah", "yep", "yup", "sure", "please", "tomorrow", "today", "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday", "sunday", "next", "week", "what", "why", "who", "when", "where",
    "how", "i", "i'm", "im", "my", "you", "your", "is", "are", "am", "was", "can", "could", "will", "would",
    "not", "don't", "dont", "want", "need", "have", "has", "already", "returned", "give", "call", "later",
    "busy", "speaking", "thanks", "thank", "sorry", "this", "that", "it", "of", "in", "on", "at", "for",
    "with", "and", "or", "but", "if", "an", "no", "english", "pickup", "pick", "address", "recharged",
    "morning", "evening", "afternoon", "wrong", "number", "correct", "right", "the", "me", "tell", "day",
    "sell", "selling", "rent", "renting", "lease", "leasing", "residential", "commercial", "apartment",
    "flat", "property", "bhk", "office", "shop", "showroom", "plot", "land", "unfurnished", "furnished",
    "ready", "immediate", "sqft", "feet", "crore", "lakh", "hello", "hi", "hey", "interested",
}

# English words that Hindi STT sometimes writes in Devanagari
_DEV_ENGLISH = {
    "यस", "येस", "नो", "प्लीज", "टुमॉरो", "टुमारो", "टुमोरो", "टुडे", "मंडे", "ट्यूसडे", "ट्यूजडे",
    "वेडनेसडे", "थर्सडे", "फ्राइडे", "सैटरडे", "संडे", "इंग्लिश", "आई", "व्हाट", "नेक्स्ट", "वीक",
    "कॉल", "लेटर", "बिजी", "बिज़ी", "थैंक्स", "थैंक", "यू", "सॉरी", "ऑलरेडी", "रिटर्न्ड", "एड्रेस",
    "राइट", "करेक्ट", "स्पीकिंग", "वांट", "नॉट", "डोंट", "कैन", "आई'म",
    "सेल", "रेंट", "टू", "माय", "अपार्टमेंट", "फ्लैट", "रेजिडेंशियल", "कमर्शियल", "प्रॉपर्टी",
    "ऑफिस", "शॉप", "बीएचके", "नेम", "इज", "एम", "आर", "श्योर", "या", "इंटरेस्टेड",
}
_DEV_NEUTRAL = {"ओके", "हेलो", "हैलो", "हाय", "हे"}

_ASK_EN = ("in english", "english me", "english mein", "speak english", "english please",
           "talk in english", "इंग्लिश में", "अंग्रेजी में", "अंग्रेज़ी में", "इंग्लिश मे")
_ASK_HI = ("in hindi", "hindi me", "hindi mein", "speak hindi", "hindi bolo", "hindi", "हिंदी में", "हिन्दी में", "हिंदी मे", "हिंदी")


def detect_language(text: Optional[str]) -> Optional[str]:
    """Returns 'hi', 'en' or None (not enough evidence: keep the current language)."""
    if not text or not text.strip():
        return None
    low = text.lower()
    if any(p in low for p in _ASK_EN):
        return "en"
    if any(p in low for p in _ASK_HI):
        return "hi"

    if _DEVANAGARI.search(text):
        dev = _DEV_TOKEN.findall(text)
        has_latin = bool(_LATIN_TOKEN.findall(text))
        # If all tokens are neutral greetings (e.g. 'हेलो', 'ओके'), keep existing language
        if dev and not has_latin and all(t in _DEV_NEUTRAL for t in dev):
            return None
        if (
            dev and not has_latin
            and any(t in _DEV_ENGLISH for t in dev)
            and all(t in _DEV_ENGLISH or t in _DEV_NEUTRAL for t in dev)
        ):
            return "en"
        return "hi"

    tokens = [t.lower() for t in _LATIN_TOKEN.findall(text)]
    if not tokens:
        return None
    hi_hits = sum(1 for t in tokens if t in _HINGLISH)
    en_hits = sum(1 for t in tokens if t in _ENGLISH)
    if hi_hits > 0 and hi_hits >= en_hits:
        return "hi"
    if en_hits > 0:
        return "en"
    if len(tokens) >= 3:
        return "en"
    return None


def L(state, hi: str, en: str) -> str:
    """Pick the line in the language the customer is currently speaking."""
    return en if getattr(state, "reply_lang", "hi") == "en" else hi