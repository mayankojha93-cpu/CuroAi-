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

_HINGLISH_GRAMMAR = {
    "hai", "hain", "hoon", "hun", "tha", "thi", "the", "karna", "karni", "karenge", "kariye",
    "kardo", "kijiye", "chahiye", "chahta", "chahte", "chahti", "raha", "rahe", "rahi",
    "sakta", "sakte", "sakti", "bechna", "bechni", "kiraya", "kiraye", "dena", "deni",
    "batao", "bataiye", "boliye", "bolo", "haji", "nahi", "nahin", "nhi"
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
    # Common pronouns, determiners & demonstratives
    "दिस", "दैट", "दीज", "दोज", "इट", "इट्स", "आई", "यू", "माय", "मी", "वी", "दे", "योर", "ही", "शी",
    # Copulas & auxiliary verbs
    "इज", "एम", "आर", "वाज", "वर", "विल", "कैन", "कुड", "वुड", "शुड", "हैव", "हैज", "हैड", "डू", "डज", "डिड",
    # Prepositions & conjunctions
    "एंड", "ऑर", "बट", "सो", "फॉर", "इन", "ऑन", "एट", "टू", "विद", "ऑफ", "बाय", "फ्रॉम",
    # Common verbs
    "वांट", "वांट्स", "वांटेड", "नीड", "नीड्स", "लुकिंग", "लुक", "सेल", "सेलिंग", "रेंट", "रेंटिंग", "बाय", "लीज", "कॉल", "गिव", "टेल", "स्पीकिंग",
    # Real estate terms
    "रेसिडेंशियल", "कमर्शियल", "प्रॉपर्टी", "अपार्टमेंट", "फ्लैट", "हाउस", "प्लॉट", "लैंड", "ऑफिस", "शॉप", "शोरूम",
    "बीएचके", "यूनिट", "फ्लोर", "सेक्टर", "सोसाइटी", "बिल्डिंग", "प्राइस", "रेट", "कॉस्ट", "एरिया", "साइज", "स्क्वायर", "फीट", "करोड़", "लाख",
    # Confirmations, calendar & adjectives
    "यस", "येस", "नो", "श्योर", "प्लीज", "टुमॉरो", "टुमारो", "टुमोरो", "टुडे", "मंडे", "ट्यूसडे", "ट्यूजडे",
    "वेडनेसडे", "थर्सडे", "फ्राइडे", "सैटरडे", "संडे", "इंग्लिश", "व्हाट", "नेक्स्ट", "वीक",
    "लेटर", "बिजी", "बिज़ी", "थैंक्स", "थैंक", "सॉरी", "ऑलरेडी", "रिटर्न्ड", "एड्रेस",
    "राइट", "करेक्ट", "नॉट", "डोंट", "नेम", "या", "इंटरेस्टेड", "रेडी", "अवेलेबल", "फर्निश्ड", "अनफर्निश्ड", "सेमी", "न्यू",
}

# Neutral greetings and affirmations that do NOT indicate language switch preference
_DEV_NEUTRAL = {
    "ओके", "हेलो", "हैलो", "हाय", "हे", "हाँ", "हां", "हाँजी", "जी", "ज़रूर", "जरूर", "श्योर", "यस", "प्लीज", "अच्छा", "ठीक",
}

# Hindi-specific grammar markers in Devanagari (postpositions, auxiliary verbs, pronouns)
_DEV_HINDI_MARKERS = {
    # Auxiliary verbs & copulas
    "है", "हैं", "हूँ", "हु", "था", "थी", "थे", "हो", "गा", "गे", "गी",
    # Postpositions
    "का", "के", "की", "को", "से", "में", "पे", "पर", "ने", "तक",
    # Conjunctions & discourse particles
    "और", "लेकिन", "मगर", "परन्तु", "भी", "तो", "ही", "ना",
    # Negation
    "नहीं", "नही", "मत",
    # Pronouns
    "मुझे", "मुझको", "मेरा", "मेरी", "मेरे", "मैं", "मै",
    "आप", "आपको", "आपका", "आपकी", "आपके",
    "हम", "हमें", "हमको", "हमारा", "हमारी", "हमारे",
    "वह", "वो", "उसे", "उसको", "उसका", "उसकी", "उसके",
    "यह", "ये", "इसे", "इसको", "इसका", "इसकी", "इसके",
    # Interrogatives
    "क्या", "क्यों", "कहाँ", "कहा", "कब", "कैसे", "कितना", "कितने", "कितनी", "कौन",
    # Common verbs in Hindi
    "करना", "करनी", "करो", "करें", "करेंगे", "कीजिए", "किए", "किया",
    "देना", "देनी", "दो", "दें", "देंगे", "दीजिए", "दिया",
    "लेना", "लेनी", "लो", "लें", "लेंगे", "लीजिए", "लिया",
    "बेचना", "बेचनी", "बेचेंगे", "बेच",
    "किराया", "किराए",
    "चाहिए", "चाहता", "चाहते", "चाहती",
    "सकता", "सकते", "सकती",
    "रहा", "रहे", "रही",
    "बताओ", "बताइए", "बोलिए", "बोलो", "सुनो", "सुनिए", "समझ",
    "भाई", "भैया", "साहब", "घर", "मकान", "दुकान",
}

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

        # 1. If all tokens are neutral greetings or affirmations (e.g. 'हेलो', 'ओके', 'हाँ, ज़रूर'), preserve current language
        if dev and not has_latin and all(t in _DEV_NEUTRAL for t in dev):
            return None

        # 2. Count Devanagari English transliterations vs Hindi markers
        dev_en_hits = sum(1 for t in dev if t in _DEV_ENGLISH)
        dev_hi_hits = sum(1 for t in dev if t in _DEV_HINDI_MARKERS)

        latin_tokens = [t.lower() for t in _LATIN_TOKEN.findall(text)]
        lat_en_hits = sum(1 for t in latin_tokens if t in _ENGLISH)
        lat_hi_hits = sum(1 for t in latin_tokens if t in _HINGLISH)

        total_en = dev_en_hits + lat_en_hits
        total_hi = dev_hi_hits + lat_hi_hits

        if total_en > 0 and total_hi == 0:
            return "en"
        if total_hi > 0 and total_hi >= total_en:
            return "hi"
        if total_en > total_hi:
            return "en"

        # If indeterminate, do not jump to Hindi automatically; preserve current language
        return None

    tokens = [t.lower() for t in _LATIN_TOKEN.findall(text)]
    if not tokens:
        return None
    hi_hits = sum(1 for t in tokens if t in _HINGLISH)
    en_hits = sum(1 for t in tokens if t in _ENGLISH)
    has_hi_grammar = any(t in _HINGLISH_GRAMMAR for t in tokens)

    # If sentence uses Hindi grammar verbs (e.g. "3 BHK flat sell karna hai"), it is Hinglish
    if has_hi_grammar and hi_hits >= 2:
        return "hi"
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