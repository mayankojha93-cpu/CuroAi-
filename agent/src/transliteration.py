"""Transliteration utility: converts Devanagari script (Hindi vernacular) into natural Romanized Hindi (Hinglish)
and maps phonetic English-in-Devanagari words into clean English.
"""
import re
from typing import Optional

_DEV_PATTERN = re.compile(r"[\u0900-\u097F]")

# English words frequently written phonetically in Devanagari by Indian STT models (e.g. Sarvam Saaras)
DEV_TO_ENGLISH = {
    # Pronouns & determiners
    "दिस": "this", "दैट": "that", "दीज": "these", "दोज": "those", "इट": "it", "इट्स": "its",
    "आई": "I", "यू": "you", "माय": "my", "मी": "me", "वी": "we", "दे": "they", "योर": "your",
    "ही": "he", "शी": "she", "हिम": "him", "हर": "her",
    # Copulas & auxiliary verbs
    "इज": "is", "एम": "am", "आर": "are", "वाज": "was", "वर": "were", "विल": "will",
    "कैन": "can", "कुड": "could", "वुड": "would", "शुड": "should",
    "हैव": "have", "हैज": "has", "हैड": "had", "डू": "do", "डज": "does", "डिड": "did",
    # Prepositions & conjunctions
    "एंड": "and", "ऑर": "or", "बट": "but", "सो": "so", "फॉर": "for", "इन": "in", "ऑन": "on",
    "एट": "at", "टू": "to", "विद": "with", "ऑफ": "of", "बाय": "by", "फ्रॉम": "from",
    # Common verbs
    "वांट": "want", "वांट्स": "wants", "वांटेड": "wanted", "नीड": "need", "नीड्स": "needs",
    "लुकिंग": "looking", "लुक": "look", "सेल": "sell", "सेलिंग": "selling",
    "रेंट": "rent", "रेंटिंग": "renting", "लीज": "lease", "कॉल": "call", "गिव": "give",
    "टेल": "tell", "स्पीकिंग": "speaking", "थैंक": "thank", "थैंक्स": "thanks",
    "सॉरी": "sorry", "हेल्प": "help", "कम": "come", "गो": "go",
    # Real estate & commercial vocabulary
    "रेसिडेंशियल": "residential", "कमर्शियल": "commercial",
    "प्रॉपर्टी": "property", "अपार्टमेंट": "apartment", "फ्लैट": "flat", "हाउस": "house",
    "प्लॉट": "plot", "ऑफिस": "office", "स्पेस": "space", "शॉप": "shop", "शोरूम": "showroom",
    "वेयरहाउस": "warehouse", "गोडाउन": "godown", "गोदाम": "godown", "बीएचके": "BHK",
    "यूनिट": "unit", "फ्लोर": "floor", "सेक्टर": "sector", "सोसाइटी": "society", "प्रोजेक्ट": "project",
    "बिल्डिंग": "building", "प्राइस": "price", "रेट": "rate", "कॉस्ट": "cost", "एरिया": "area",
    "साइज": "size", "स्क्वायर": "square", "फीट": "feet", "करोड़": "crore", "लाख": "lakh",
    "लोकेशन": "location", "नंबर": "number", "डिटेल्स": "details", "पर्सन": "person",
    "एड्रेस": "address", "फर्निश्ड": "furnished", "अनफर्निश्ड": "unfurnished", "सेमी": "semi",
    "रेडी": "ready", "अवेलेबल": "available", "न्यू": "new", "ओल्ड": "old",
    # Ordinals
    "फर्स्ट": "first", "सेकंड": "second", "थर्ड": "third", "फोर्थ": "fourth", "फिफ्थ": "fifth",
    "सिक्स्थ": "sixth", "सेवंथ": "seventh", "एइथ": "eighth", "नाइंथ": "ninth", "टेंथ": "tenth",
    "ग्राउंड": "ground", "बेसमेंट": "basement",
    # General confirmations & calendar
    "यस": "yes", "येस": "yes", "नो": "no", "श्योर": "sure", "प्लीज": "please",
    "टुमॉरो": "tomorrow", "टुमारो": "tomorrow", "टुडे": "today", "मंडे": "monday",
    "ट्यूसडे": "tuesday", "वेडनेसडे": "wednesday", "थर्सडे": "thursday", "फ्राइडे": "friday",
    "सैटरडे": "saturday", "संडे": "sunday", "इंग्लिश": "English", "व्हाट": "what",
    "नेक्स्ट": "next", "वीक": "week", "लेटर": "later", "बिजी": "busy", "बिज़ी": "busy",
    "ऑलरेडी": "already", "रिटर्न्ड": "returned", "राइट": "right", "करेक्ट": "correct",
    "नॉट": "not", "डोंट": "dont", "नेम": "name", "इंटरेस्टेड": "interested", "ओके": "okay",
    "हेलो": "hello", "हैलो": "hello", "हाय": "hi", "हे": "hey",
}

# High-frequency conversational Hindi words mapped to natural Romanized Hindi (Hinglish)
DEV_TO_HINGLISH = {
    # Affirmations & greetings
    "हाँ": "haan", "हां": "haan", "हाँजी": "haanji", "हांजी": "haanji", "जी": "ji", "हंजी": "hanji",
    "नहीं": "nahi", "नही": "nahi", "ना": "na", "मत": "mat",
    "नमस्ते": "namaste", "नमस्कार": "namaskar",
    # Pronouns
    "मेरा": "mera", "मेरी": "meri", "मेरे": "mere", "मुझे": "mujhe", "मुझको": "mujhko",
    "आपका": "aapka", "आपकी": "aapki", "आपके": "aapke", "आपको": "aapko", "आप": "aap",
    "हम": "hum", "हमारा": "hamara", "हमारी": "hamari", "हमारे": "hamare", "हमें": "humein",
    "मैं": "main", "मै": "main", "यह": "yeh", "ये": "ye", "वह": "woh", "वो": "wo",
    "इसका": "iska", "इसकी": "iski", "इसके": "iske", "उसका": "uska", "उसकी": "uski", "उसके": "uske",
    "अपना": "apna", "अपनी": "apni", "अपने": "apne",
    # Question words
    "क्या": "kya", "क्यों": "kyun", "क्यूँ": "kyun", "कहाँ": "kahan", "कहा": "kahan",
    "कब": "kab", "कैसे": "kaise", "कौन": "kaun", "कितना": "kitna", "कितनी": "kitni", "कितने": "kitne",
    # Copulas & auxiliary verbs
    "है": "hai", "हैं": "hain", "हूँ": "hoon", "हु": "hoon", "था": "tha", "थी": "thi", "थे": "the",
    "हो": "ho", "होगा": "hoga", "होगी": "hogi", "होंगे": "honge",
    # Postpositions & case markers
    "का": "ka", "की": "ki", "के": "ke", "को": "ko", "से": "se", "में": "mein", "पे": "pe", "पर": "par", "ने": "ne", "तक": "tak",
    # Connectives & discourse markers
    "और": "aur", "भी": "bhi", "तो": "toh", "या": "ya", "लेकिन": "lekin", "मगर": "magar", "क्योंकि": "kyunki",
    "अच्छा": "achha", "अच्छी": "achhi", "अच्छे": "achhe", "ठीक": "theek", "सही": "sahi", "गलत": "galat",
    "bilkul": "bilkul", "बिल्कुल": "bilkul", "ज़रूर": "zaroor", "जरूर": "zaroor",
    # Core verbs
    "बेचना": "bechna", "बेचनी": "bechni", "बेचने": "bechne", "बेच": "bech",
    "देना": "dena", "देनी": "deni", "देने": "dene", "दो": "do", "दीजिए": "dijiye",
    "लेना": "lena", "लेनी": "leni", "लेने": "lene", "लो": "lo", "लीजिए": "lijiye",
    "करना": "karna", "करनी": "karni", "करने": "karne", "करो": "karo", "कीजिए": "kijiye", "कर": "kar", "करेंगे": "karenge",
    "रहा": "raha", "रही": "rahi", "रहे": "rahe",
    "सकता": "sakta", "सकती": "sakti", "सकते": "sakte",
    "चाहता": "chahta", "चाहती": "chahti", "चाहते": "chahte", "चाहिए": "chahiye",
    "बताना": "batana", "बताओ": "batao", "बताइए": "bataiye", "बताएं": "batayein",
    "बोलना": "bolna", "बोलो": "bolo", "बोलिए": "boliye", "बोल": "bol",
    "समझ": "samajh", "गया": "gaya", "गई": "gayi", "गए": "gaye",
    "खाली": "khaali", "किराया": "kiraya", "किराये": "kiraye",
    "दुकान": "dukan", "मकान": "makaan", "घर": "ghar", "कमरा": "kamra",
    "नाम": "naam", "काम": "kaam", "बात": "baat", "समय": "samay",
    "बाद": "baad", "पहले": "pehle", "अभी": "abhi", "आज": "aaj", "कल": "kal",
}

# Character-level phonetics for Devanagari transliteration fallback
_CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "v",
    "श": "sh", "ष": "sh", "स": "s", "ह": "h",
    "क्ष": "ksh", "त्र": "tr", "ज्ञ": "gya",
    "क़": "q", "ख़": "kh", "ग़": "gh", "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f",
}

_VOWELS = {
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri",
    "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
}

_MATRAS = {
    "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri",
    "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
}

_MODIFIERS = {
    "ं": "n", "ँ": "n", "ः": "h", "़": "",
}

_DIGITS = {
    "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
    "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
}

_HALANT = "्"


def _transliterate_devanagari_word(word: str) -> str:
    """Phonetically transliterates an individual Devanagari token into natural Roman script."""
    # Strip common Hindi punctuation attached to word
    clean_w = word.replace("।", "").replace("॥", "").strip()
    if not clean_w:
        return ""

    # Check direct dictionary overrides
    if clean_w in DEV_TO_ENGLISH:
        return DEV_TO_ENGLISH[clean_w]
    if clean_w in DEV_TO_HINGLISH:
        return DEV_TO_HINGLISH[clean_w]

    res = []
    chars = list(clean_w)
    n = len(chars)

    for i in range(n):
        c = chars[i]
        next_c = chars[i + 1] if i + 1 < n else None

        if c in _DIGITS:
            res.append(_DIGITS[c])
        elif c in _VOWELS:
            res.append(_VOWELS[c])
        elif c in _CONSONANTS:
            base = _CONSONANTS[c]
            if next_c == _HALANT:
                res.append(base)
            elif next_c in _MATRAS:
                res.append(base)
            elif next_c in _MODIFIERS and (i + 2 >= n or chars[i + 2] not in _MATRAS):
                res.append(base + "a")
            elif next_c is None:
                # Terminal consonant drops inherent schwa in spoken Hindi
                res.append(base)
            else:
                res.append(base + "a")
        elif c in _MATRAS:
            res.append(_MATRAS[c])
        elif c in _MODIFIERS:
            res.append(_MODIFIERS[c])
        elif c == _HALANT:
            pass
        else:
            res.append(c)

    return "".join(res)


def romanize_hindi(text: Optional[str]) -> str:
    """
    Converts Hindi vernacular text (Devanagari script) into clean Romanized Hindi (Hinglish).
    Leaves English and Latin characters intact.
    """
    if not text:
        return ""

    if not _DEV_PATTERN.search(text):
        return text.strip()

    # Normalize Devanagari full stop (Danda) to standard period
    normalized = text.replace("।", ".").replace("॥", ".").strip()

    # Split into words and tokens preserving spacing and punctuation
    tokens = re.split(r"(\s+|[.,!?;:\"'()]+)", normalized)
    output = []

    for token in tokens:
        if not token:
            continue
        if _DEV_PATTERN.search(token):
            output.append(_transliterate_devanagari_word(token))
        else:
            output.append(token)

    result = "".join(output).strip()
    # Normalize multiple spaces
    result = re.sub(r"\s+", " ", result)
    # Capitalize first letter of sentence for polished readability
    if result:
        result = result[0].upper() + result[1:]

    return result
