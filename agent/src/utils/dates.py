import re
from datetime import datetime, timedelta, date
from zoneinfo import ZoneInfo
from typing import Tuple, Optional

KOLKATA_TZ = ZoneInfo("Asia/Kolkata")

WEEKDAY_MAP = {
    "monday": 0, "somwar": 0, "somvaar": 0, "somvar": 0, "somwaar": 0, "सोमवार": 0, "सोम": 0,
    "tuesday": 1, "mangalwar": 1, "mangalvaar": 1, "mangalvar": 1, "mangalwaar": 1, "मंगलवार": 1, "मंगल": 1,
    "wednesday": 2, "budhwar": 2, "budhvaar": 2, "budhvar": 2, "budhwaar": 2, "बुधवार": 2, "बुध": 2,
    "thursday": 3, "guruwar": 3, "guruvaar": 3, "guruvar": 3, "veervaar": 3, "veerwar": 3,
    "brihaspatiwar": 3, "brihaspativar": 3, "गुरुवार": 3, "गुरूवार": 3, "बृहस्पतिवार": 3, "वीरवार": 3, "गुरु": 3,
    "friday": 4, "shukrawar": 4, "shukravaar": 4, "shukravar": 4, "shukrawaar": 4, "शुक्रवार": 4, "शुक्र": 4,
    "saturday": 5, "shaniwar": 5, "shanivaar": 5, "shanivar": 5, "shaniwaar": 5, "शनिवार": 5, "शनि": 5,
    "sunday": 6, "ravivar": 6, "ravivaar": 6, "raviwar": 6, "itwar": 6, "itvaar": 6, "इतवार": 6, "रविवार": 6, "रवि": 6,
    # common STT spellings
    "सोमबार": 0, "मंगलबार": 1, "बुधबार": 2, "गुरुबार": 3, "शुक्रबार": 4, "शनिबार": 5, "रविबार": 6,
    "mon": 0, "tue": 1, "tues": 1, "wed": 2, "thu": 3, "thur": 3, "thurs": 3, "fri": 4, "sat": 5, "sun": 6,
}

# Short forms ("शनि", "गुरु", "मंगल" ...) also appear in names / addresses ("गुरु नानक नगर", "शनि मंदिर").
# In strict mode (raw customer speech, not a value the LLM already extracted) they are NOT treated as a date.
SHORT_WEEKDAYS = {
    "सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि", "रवि", "mon", "tue", "tues", "wed", "thu", "thur", "thurs",
    "fri", "sat", "sun",
}

# Single-word relative days (matched as whole words, never as substrings)
RELATIVE_WORDS = {
    "aaj": 0, "today": 0, "आज": 0,
    "kal": 1, "tomorrow": 1, "कल": 1,
    "parso": 2, "parson": 2, "परसों": 2, "परसो": 2, "parsoon": 2,
    "tarso": 3, "tarson": 3, "narso": 3, "narson": 3, "तरसों": 3, "तरसो": 3, "नरसों": 3, "नरसो": 3,
}

MONTH_MAP = {
    "january": 1, "jan": 1, "जनवरी": 1,
    "february": 2, "feb": 2, "फरवरी": 2,
    "march": 3, "mar": 3, "मार्च": 3,
    "april": 4, "apr": 4, "अप्रैल": 4, "अप्रेल": 4,
    "may": 5, "मई": 5,
    "june": 6, "jun": 6, "जून": 6,
    "july": 7, "jul": 7, "जुलाई": 7,
    "august": 8, "aug": 8, "अगस्त": 8,
    "september": 9, "sep": 9, "sept": 9, "सितंबर": 9, "सितम्बर": 9,
    "october": 10, "oct": 10, "अक्टूबर": 10, "अक्तूबर": 10,
    "november": 11, "nov": 11, "नवंबर": 11, "नवम्बर": 11,
    "december": 12, "dec": 12, "दिसंबर": 12, "दिसम्बर": 12,
}

# Hindi / Hinglish number words 1..31 (used with "tarikh" / a month name, or with "din baad")
NUMBER_WORDS = {
    "ek": 1, "एक": 1, "do": 2, "दो": 2, "teen": 3, "तीन": 3, "char": 4, "chaar": 4, "चार": 4,
    "paanch": 5, "panch": 5, "पांच": 5, "पाँच": 5, "chhah": 6, "chhe": 6, "chah": 6, "cheh": 6,
    "छह": 6, "छः": 6, "छे": 6, "छ": 6, "saat": 7, "सात": 7, "aath": 8, "आठ": 8, "nau": 9, "नौ": 9,
    "das": 10, "दस": 10, "gyarah": 11, "ग्यारह": 11, "barah": 12, "बारह": 12, "terah": 13, "तेरह": 13,
    "chaudah": 14, "चौदह": 14, "pandrah": 15, "पंद्रह": 15, "पन्द्रह": 15, "solah": 16, "सोलह": 16,
    "satrah": 17, "सत्रह": 17, "atharah": 18, "अठारह": 18, "unnis": 19, "उन्नीस": 19, "bees": 20, "बीस": 20,
    "ikkis": 21, "इक्कीस": 21, "bais": 22, "बाईस": 22, "teis": 23, "तेईस": 23, "chaubis": 24, "चौबीस": 24,
    "pachchis": 25, "pacchis": 25, "pachis": 25, "पच्चीस": 25, "chhabbis": 26, "छब्बीस": 26,
    "sattais": 27, "सत्ताईस": 27, "atthais": 28, "अट्ठाईस": 28, "अठाईस": 28, "untis": 29, "उनतीस": 29,
    "tees": 30, "तीस": 30, "ikatis": 31, "इकतीस": 31,
}

DAY_MARKERS = {"tarikh", "tareekh", "tarik", "date", "तारीख", "तारिख", "तारीक", "तारिक"}
DAY_WORDS = {"din", "दिन", "days", "day", "dino"}
AFTER_WORDS = {"baad", "bad", "बाद", "later", "after"}

NEGATION_WORDS = {"nahi", "nahin", "nahi.", "no", "not", "नहीं", "नही", "ना", "mat", "मत", "nhi"}
TIME_MARKERS = {"baje", "bje", "बजे", "am", "pm", "o'clock", "oclock", "बजकर"}
_DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")

HINDI_MONTHS = {
    1: "जनवरी", 2: "फ़रवरी", 3: "मार्च", 4: "अप्रैल",
    5: "मई", 6: "जून", 7: "जुलाई", 8: "अगस्त",
    9: "सितंबर", 10: "अक्टूबर", 11: "नवंबर", 12: "दिसंबर"
}

HINDI_WEEKDAYS = {
    0: "सोमवार", 1: "मंगलवार", 2: "बुधवार", 3: "गुरुवार",
    4: "शुक्रवार", 5: "शनिवार", 6: "रविवार"
}

ENGLISH_MONTHS = {
    1: "January", 2: "February", 3: "March", 4: "April", 5: "May", 6: "June",
    7: "July", 8: "August", 9: "September", 10: "October", 11: "November", 12: "December",
}
ENGLISH_WEEKDAYS = {
    0: "Monday", 1: "Tuesday", 2: "Wednesday", 3: "Thursday", 4: "Friday", 5: "Saturday", 6: "Sunday",
}


def get_current_ist_time() -> datetime:
    """Returns current datetime in Asia/Kolkata timezone."""
    return datetime.now(KOLKATA_TZ)


def format_spoken_hindi_date(dt: datetime) -> str:
    """Formats datetime into spoken Hindi text, e.g., 'मंगलवार, 20 अक्टूबर'."""
    weekday = HINDI_WEEKDAYS[dt.weekday()]
    month = HINDI_MONTHS[dt.month]
    return f"{weekday}, {dt.day} {month}"


def format_spoken_english_date(dt) -> str:
    """e.g. 'Tuesday, 20 October'."""
    return f"{ENGLISH_WEEKDAYS[dt.weekday()]}, {dt.day} {ENGLISH_MONTHS[dt.month]}"


def spoken_date(iso: Optional[str], lang: str = "hi", reference_time: Optional[datetime] = None) -> str:
    """ISO date -> what the agent says, in the customer's language ('कल' / 'tomorrow' for the next day)."""
    en = lang == "en"
    if not iso:
        return "tomorrow" if en else "कल"
    try:
        d = date.fromisoformat(iso)
    except ValueError:
        return "tomorrow" if en else "कल"
    today = (reference_time or get_current_ist_time()).date()
    if (d - today).days == 1:
        return "tomorrow" if en else "कल"
    if en:
        return format_spoken_english_date(d)
    return format_spoken_hindi_date(datetime(d.year, d.month, d.day, 10, 0, tzinfo=KOLKATA_TZ))


def _tokenize(text: str):
    """Lower-case, normalise Devanagari digits and nukta, split into whole-word tokens."""
    text = text.lower().translate(_DEVANAGARI_DIGITS).replace("़", "")
    text = text.replace("day after tomorrow", "parso")
    text = text.replace("din baad", " din baad ")
    return re.findall(r"[^\s,.;:!?।|/()\-]+", text)


def _number_value(tok: str) -> Optional[int]:
    if tok.isdigit():
        return int(tok)
    return NUMBER_WORDS.get(tok)


def _resolve_day(today: date, day: int, month: Optional[int] = None) -> Optional[date]:
    """Next valid occurrence of 'day' (optionally in a given month), never in the past."""
    if not 1 <= day <= 31:
        return None
    if month:
        for year in (today.year, today.year + 1):
            try:
                cand = date(year, month, day)
            except ValueError:
                return None
            if cand >= today:
                return cand
        return None
    year, mon = today.year, today.month
    for _ in range(13):
        try:
            cand = date(year, mon, day)
            if cand >= today:
                return cand
        except ValueError:
            pass
        mon += 1
        if mon > 12:
            mon, year = 1, year + 1
    return None


def resolve_relative_date(
    date_text: str,
    reference_time: Optional[datetime] = None,
    strict: bool = False,
) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Parses Hindi/Hinglish/Devanagari/English date text to (iso_date, spoken_hindi_text, error).
    - iso_date: 'YYYY-MM-DD'
    - spoken_text: 'मंगलवार, 20 अक्टूबर' (use spoken_date(iso, lang) for the customer's language)
    - error: None or 'empty_input' / 'past_date' / 'unparseable_date'

    Understands: aaj/kal/parso/narso, weekday names (somwar, Monday ...), "25 tarikh", "25 अक्टूबर",
    "28 october", "पच्चीस तारीख", "teen din baad", "in 3 days".

    Rules:
      * Whole-word matching only (no substring false positives).
      * A date followed by a negation ("kal nahi") is ignored.
      * If several dates are mentioned ("kal nahi, somwar"), the LAST valid one wins.
      * Vague words like "agle hafte" / "next week" are NOT a date -> unparseable (the agent asks for a day).
      * strict=True is for RAW customer speech: bare numbers need "tarikh"/a month name next to them, and short
        weekday forms (शनि, गुरु ...) are ignored, so addresses / phone numbers are never read as a date.
    """
    if not date_text or not date_text.strip():
        return None, None, "empty_input"

    now = reference_time or get_current_ist_time()
    today = now.date()
    tokens = _tokenize(date_text)
    n = len(tokens)

    def negated(i: int, span: int = 3) -> bool:
        return any(t in NEGATION_WORDS for t in tokens[i + 1:i + 1 + span])

    candidates = []  # (token_index, date)
    consumed = set()

    for i, tok in enumerate(tokens):
        if i in consumed:
            continue

        # "teen din baad" / "3 din baad" / "in 3 days"
        val = _number_value(tok)
        if val is not None and i + 1 < n and tokens[i + 1] in DAY_WORDS:
            after = (i + 2 < n and tokens[i + 2] in AFTER_WORDS) or (i > 0 and tokens[i - 1] in ("in", "after"))
            if after and 1 <= val <= 60:
                consumed.update({i, i + 1, i + 2})
                if not negated(i + 2, 2):
                    candidates.append((i, today + timedelta(days=val)))
                continue

        if tok in RELATIVE_WORDS:
            if not negated(i, 2):
                candidates.append((i, today + timedelta(days=RELATIVE_WORDS[tok])))
            continue

        if tok in WEEKDAY_MAP:
            if strict and tok in SHORT_WEEKDAYS:
                continue
            if negated(i, 2):
                continue
            days_ahead = (WEEKDAY_MAP[tok] - today.weekday()) % 7
            if days_ahead == 0:
                days_ahead = 7  # today's weekday named -> next week's
            candidates.append((i, today + timedelta(days=days_ahead)))
            continue

        # day-of-month: "25", "25 tarikh", "25 october", "october 25", "पच्चीस तारीख"
        if val is None:
            m = re.fullmatch(r"([0-3]?[0-9])(?:st|nd|rd|th|वीं|को)?", tok)
            val = int(m.group(1)) if m else None
            is_word = False
        else:
            is_word = not tok.isdigit()
        if val is None or not 1 <= val <= 31:
            continue

        nxt = tokens[i + 1] if i + 1 < n else ""
        nxt2 = tokens[i + 2] if i + 2 < n else ""
        prv = tokens[i - 1] if i > 0 else ""
        if nxt in TIME_MARKERS:
            continue

        month = None
        if prv in MONTH_MAP:
            month = MONTH_MAP[prv]
        elif nxt in MONTH_MAP:
            month = MONTH_MAP[nxt]
        elif nxt in ("को", "of") and nxt2 in MONTH_MAP:
            month = MONTH_MAP[nxt2]
        has_marker = nxt in DAY_MARKERS or (nxt in ("को", "ko") and nxt2 in DAY_MARKERS)

        # Number words ("do", "ek", "saat") and, in strict mode, bare digits need a marker.
        if (is_word or strict) and not (month or has_marker):
            continue
        if negated(i, 3):
            continue

        cand = _resolve_day(today, val, month)
        if cand:
            candidates.append((i, cand))

    if not candidates:
        return None, None, "unparseable_date"

    target_date = candidates[-1][1]
    if target_date < today:
        return None, None, "past_date"

    target_dt = datetime(target_date.year, target_date.month, target_date.day, 10, 0, tzinfo=KOLKATA_TZ)
    return target_date.isoformat(), format_spoken_hindi_date(target_dt), None


def get_next_available_pickup_date(
    skip_sundays: bool = True,
    reference_time: Optional[datetime] = None
) -> Tuple[str, str]:
    """
    Returns (iso_date, spoken_hindi_text) for the next eligible pickup date.
    By default skips Sundays (field pickup teams unavailable) and rolls forward to Monday.
    """
    now = reference_time or get_current_ist_time()
    candidate = now.date() + timedelta(days=1)
    if skip_sundays and candidate.weekday() == 6:  # Sunday
        candidate += timedelta(days=1)

    target_dt = datetime(candidate.year, candidate.month, candidate.day, 10, 0, tzinfo=KOLKATA_TZ)
    iso_date = candidate.isoformat()
    spoken = "कल" if (candidate - now.date()).days == 1 else format_spoken_hindi_date(target_dt)
    return iso_date, spoken