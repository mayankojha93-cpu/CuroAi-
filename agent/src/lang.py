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
    "dena", "deni", "bhai", "bhaiya", "sirji", "sahab", "apna", "apni", "apne",
    "diya", "kiya", "kiye", "liya", "gaya", "gayi", "gaye", "rakh", "wapas",
}

_HINGLISH_GRAMMAR = {
    "hai", "hain", "hoon", "hun", "tha", "thi", "the", "karna", "karni", "karenge", "kariye",
    "kardo", "kijiye", "chahiye", "chahta", "chahte", "chahti", "raha", "rahe", "rahi",
    "sakta", "sakte", "sakti", "dena", "deni", "diya", "kiya",
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
    "morning", "evening", "afternoon", "wrong", "number", "correct", "right", "the", "tell", "day",
    "did", "didn't", "were", "been", "from", "there", "here", "they", "he", "she", "we", "our", "us",
    "hello", "hi", "hey", "interested",
}

# Short replies that say NOTHING about the customer's language ("yes", "ok", "haan", "ji", "hello" ...).
# They never switch the language and never count as evidence, so "yes" first and Hindi afterwards
# cannot lock the call into English.
_AMBIGUOUS_LATIN = {
    "yes", "yeah", "yep", "yup", "ok", "okay", "no", "sure", "please", "hello", "hi", "hey", "thanks",
    "thank", "sorry", "right", "correct", "speaking", "haan", "han", "ha", "haa", "haji", "ji", "nahi",
    "nahin", "nhi", "theek", "thik", "accha", "achha", "acha", "bilkul", "hmm", "hm", "hello",
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
    # Confirmations, calendar & adjectives
    "यस", "येस", "नो", "श्योर", "प्लीज", "टुमॉरो", "टुमारो", "टुमोरो", "टुडे", "मंडे", "ट्यूसडे", "ट्यूजडे",
    "वेडनेसडे", "थर्सडे", "फ्राइडे", "सैटरडे", "संडे", "इंग्लिश", "व्हाट", "नेक्स्ट", "वीक",
    "लेटर", "बिजी", "बिज़ी", "थैंक्स", "थैंक", "सॉरी", "ऑलरेडी", "रिटर्न्ड", "एड्रेस",
    "राइट", "करेक्ट", "नॉट", "डोंट", "नेम", "इंटरेस्टेड", "रेडी", "अवेलेबल", "न्यू",
}

# Neutral greetings and affirmations that do NOT indicate language switch preference
_DEV_NEUTRAL = {
    "ओके", "हेलो", "हैलो", "हाय", "हे", "हाँ", "हां", "हाँजी", "हांजी", "हंजी", "जी", "ज़रूर", "जरूर", "श्योर", "यस", "येस", "प्लीज", "अच्छा",
    "ठीक", "सही", "बिल्कुल", "थैंक्स", "थैंक", "सॉरी", "नो", "हम्म",
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
    "चाहिए", "चाहता", "चाहते", "चाहती",
    "सकता", "सकते", "सकती",
    "रहा", "रहे", "रही",
    "बताओ", "बताइए", "बोलिए", "बोलो", "सुनो", "सुनिए", "समझ",
    "भाई", "भैया", "साहब", "घर",
}

_ASK_EN = ("in english", "english me", "english mein", "speak english", "english please",
           "talk in english", "इंग्लिश में", "अंग्रेजी में", "अंग्रेज़ी में", "इंग्लिश मे")
_ASK_HI = ("in hindi", "hindi me", "hindi mein", "speak hindi", "hindi bolo", "hindi please", "हिंदी में", "हिन्दी में",
           "हिंदी मे", "हिंदी बोल", "हिन्दी बोल")


def _evidence_ok(evidence: int, n_tokens: int) -> bool:
    """One lone word is not enough to flip the language of the whole call."""
    return evidence >= 2 or (evidence >= 1 and n_tokens >= 4)


def detect_language(text: Optional[str]) -> Optional[str]:
    """Returns 'hi', 'en' or None (not enough evidence: keep the current language).

    Conservative on purpose: state.update_reply_lang() can switch only ONCE, so a wrong early switch on
    "yes" / "ok" / "haan" / "hello" would lock the whole call into the wrong language.
    Explicit requests ("English please", "हिंदी में बोलिए") always win."""
    if not text or not text.strip():
        return None
    low = text.lower()
    if any(p in low for p in _ASK_EN):
        return "en"
    if any(p in low for p in _ASK_HI):
        return "hi"

    if _DEVANAGARI.search(text):
        dev = _DEV_TOKEN.findall(text)
        latin_tokens = [t.lower() for t in _LATIN_TOKEN.findall(text)]

        # Neutral greetings / affirmations ("हेलो", "ओके", "हाँ, ज़रूर") never switch the language.
        if dev and not latin_tokens and all(t in _DEV_NEUTRAL for t in dev):
            return None

        content_dev = [t for t in dev if t not in _DEV_NEUTRAL]
        content_lat = [t for t in latin_tokens if t not in _AMBIGUOUS_LATIN]
        total_en = sum(1 for t in content_dev if t in _DEV_ENGLISH) + sum(1 for t in content_lat if t in _ENGLISH)
        total_hi = sum(1 for t in content_dev if t in _DEV_HINDI_MARKERS) + sum(1 for t in content_lat if t in _HINGLISH)

        if not _evidence_ok(total_en + total_hi, len(dev) + len(latin_tokens)):
            return None
        if total_en > 0 and total_hi == 0:
            return "en"
        if total_hi > 0 and total_hi >= total_en:
            return "hi"
        if total_en > total_hi:
            return "en"
        return None

    tokens = [t.lower() for t in _LATIN_TOKEN.findall(text)]
    if not tokens:
        return None
    content = [t for t in tokens if t not in _AMBIGUOUS_LATIN]
    if not content:
        return None
    hi_hits = sum(1 for t in content if t in _HINGLISH)
    en_hits = sum(1 for t in content if t in _ENGLISH)
    has_hi_grammar = any(t in _HINGLISH_GRAMMAR for t in content)

    # Hindi grammar words ("kar diya hai", "nahi chahiye") make a sentence Hinglish even with English nouns.
    if has_hi_grammar and hi_hits >= 2:
        return "hi"
    if not _evidence_ok(hi_hits + en_hits, len(tokens)):
        return None
    if hi_hits > 0 and hi_hits >= en_hits:
        return "hi"
    if en_hits > 0:
        return "en"
    return None


def L(state, hi: str, en: str) -> str:
    """Pick the line in the language the customer is currently speaking."""
    return en if getattr(state, "reply_lang", "hi") == "en" else hi