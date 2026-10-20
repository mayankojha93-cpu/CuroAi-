import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Tuple, Optional

KOLKATA_TZ = ZoneInfo("Asia/Kolkata")

WEEKDAY_MAP = {
    "monday": 0, "somwar": 0, "somvaar": 0, "peer": 0,
    "tuesday": 1, "mangalwar": 1, "mangalvaar": 1,
    "wednesday": 2, "budhwar": 2, "budhvaar": 2,
    "thursday": 3, "guruwar": 3, "guruvaar": 3, "veervaar": 3, "brihaspatiwar": 3,
    "friday": 4, "shukrawar": 4, "shukravaar": 4, "jummah": 4, "juma": 4,
    "saturday": 5, "shaniwar": 5, "shanivaar": 5, "hafte": 5,
    "sunday": 6, "ravivar": 6, "ravivaar": 6, "itwar": 6, "itvaar": 6
}

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

def resolve_relative_date(date_text: str, reference_time: Optional[datetime] = None) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Parses Hindi/Hinglish relative date string to (iso_date, spoken_text, error).
    - iso_date: 'YYYY-MM-DD'
    - spoken_text: 'मंगलवार, 20 अक्टूबर'
    - error: None or descriptive string (e.g. 'past_date', 'unparseable')
    """
    if not date_text or not date_text.strip():
        return None, None, "empty_input"

    now = reference_time or get_current_ist_time()
    today = now.date()
    text = date_text.lower().strip()

    target_date = None

    # 1. Direct relative words
    if any(w in text for w in ["aaj", "today", "आज"]):
        target_date = today
    elif any(w in text for w in ["parso", "parson", "day after tomorrow", "परसों"]):
        target_date = today + timedelta(days=2)
    elif any(w in text for w in ["tarso", "tarson", "नरसों", "तरसों"]):
        target_date = today + timedelta(days=3)
    elif any(w in text for w in ["kal", "tomorrow", "कल"]):
        target_date = today + timedelta(days=1)

    # 2. Check for weekdays
    if not target_date:
        for name, target_weekday in WEEKDAY_MAP.items():
            if name in text:
                current_weekday = today.weekday()
                days_ahead = (target_weekday - current_weekday) % 7
                if days_ahead == 0:
                    days_ahead = 7  # If current day mentioned, default to next week's
                target_date = today + timedelta(days=days_ahead)
                break

    # 3. Check for numeric day (e.g., '22 tarikh', '22 तारीख', '22nd', 'October 25')
    if not target_date:
        match = re.search(r'\b([0-3]?[0-9])\b', text)
        if match:
            day_num = int(match.group(1))
            if 1 <= day_num <= 31:
                # Try in current month
                try:
                    candidate = today.replace(day=day_num)
                    if candidate < today:
                        # Roll forward to next month
                        month = today.month + 1 if today.month < 12 else 1
                        year = today.year if today.month < 12 else today.year + 1
                        candidate = candidate.replace(year=year, month=month)
                    target_date = candidate
                except ValueError:
                    pass

    if not target_date:
        return None, None, "unparseable_date"

    if target_date < today:
        return None, None, "past_date"

    target_dt = datetime(target_date.year, target_date.month, target_date.day, 10, 0, tzinfo=KOLKATA_TZ)
    iso_date = target_date.isoformat()
    spoken = format_spoken_hindi_date(target_dt)

    return iso_date, spoken, None
