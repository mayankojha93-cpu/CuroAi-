import re
from datetime import datetime, timedelta
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
}

# Single-word relative days (matched as whole words, never as substrings)
RELATIVE_WORDS = {
    "aaj": 0, "today": 0, "आज": 0,
    "kal": 1, "tomorrow": 1, "कल": 1,
    "parso": 2, "parson": 2, "परसों": 2, "परसो": 2,
    "tarso": 3, "tarson": 3, "narso": 3, "narson": 3, "तरसों": 3, "तरसो": 3, "नरसों": 3, "नरसो": 3,
}

NEGATION_WORDS = {"nahi", "nahin", "nahi.", "no", "not", "नहीं", "नही", "ना", "mat", "मत"}
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

def get_current_ist_time() -> datetime:
    """Returns current datetime in Asia/Kolkata timezone."""
    return datetime.now(KOLKATA_TZ)

def format_spoken_hindi_date(dt: datetime) -> str:
    """Formats datetime into spoken Hindi text, e.g., 'मंगलवार, 20 अक्टूबर'."""
    weekday = HINDI_WEEKDAYS[dt.weekday()]
    month = HINDI_MONTHS[dt.month]
    return f"{weekday}, {dt.day} {month}"

def _tokenize(text: str):
    """Lower-case, normalise Devanagari digits, split into whole-word tokens."""
    text = text.lower().translate(_DEVANAGARI_DIGITS)
    text = text.replace("day after tomorrow", "parso")
    return re.findall(r"[^\s,.;:!?।|/()\-]+", text)


def resolve_relative_date(date_text: str, reference_time: Optional[datetime] = None) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Parses Hindi/Hinglish/Devanagari date text to (iso_date, spoken_text, error).
    - iso_date: 'YYYY-MM-DD'
    - spoken_text: 'मंगलवार, 20 अक्टूबर'
    - error: None or 'empty_input' / 'past_date' / 'unparseable_date'

    Rules:
      * Whole-word matching only (no substring false positives).
      * A date followed by a negation ("kal nahi") is ignored.
      * If several dates are mentioned ("kal nahi, somwar"), the LAST valid one wins.
      * Vague words like "agle hafte" / "next week" are NOT a date -> unparseable (the agent asks for a day).
    """
    if not date_text or not date_text.strip():
        return None, None, "empty_input"

    now = reference_time or get_current_ist_time()
    today = now.date()
    tokens = _tokenize(date_text)

    candidates = []  # (token_index, date)
    for i, tok in enumerate(tokens):
        nxt = tokens[i + 1:i + 3]
        if any(n in NEGATION_WORDS for n in nxt):
            continue  # "kal nahi" -> customer rejected this one

        if tok in RELATIVE_WORDS:
            candidates.append((i, today + timedelta(days=RELATIVE_WORDS[tok])))
        elif tok in WEEKDAY_MAP:
            days_ahead = (WEEKDAY_MAP[tok] - today.weekday()) % 7
            if days_ahead == 0:
                days_ahead = 7  # today's weekday named -> next week's
            candidates.append((i, today + timedelta(days=days_ahead)))
        else:
            m = re.fullmatch(r"([0-3]?[0-9])(?:st|nd|rd|th|वीं|को)?", tok)
            if m and not (nxt and nxt[0] in TIME_MARKERS):
                day_num = int(m.group(1))
                if 1 <= day_num <= 31:
                    try:
                        cand = today.replace(day=day_num)
                        if cand < today:  # roll forward to next month
                            month = today.month + 1 if today.month < 12 else 1
                            year = today.year if today.month < 12 else today.year + 1
                            cand = cand.replace(year=year, month=month)
                        candidates.append((i, cand))
                    except ValueError:
                        pass

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
    Returns (iso_date, spoken_text) for the next eligible pickup date.
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