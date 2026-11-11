"""
fastpath.py - deterministic parsing of intake answers (NO LLM round trip).

When the caller gives a clean answer to the ONE question that is currently open (e.g. "3 BHK",
"semi furnished", "1200 sq ft", "50 lakh", "407, 4th floor"), the answer is parsed here with regexes and
handed to RealEstateTools.save_property_details(), which already speaks the next canonical question
(FAST_TOOL_REPLY).  The LLM call - the largest part of a turn - is skipped.

SAFETY RULES (so the flow never breaks):
  * Only the field that is currently open (missing[0]) can be filled.
  * If the utterance ALSO contains data for any other field, we return None -> the LLM splits it, so
    nothing the caller volunteered is lost or re-asked.
  * Objections, repeats, "don't know", price questions, long sentences -> None (LLM / existing handlers).
  * Anything ambiguous -> None.  Returning None always falls back to the normal LLM path.

Pure python, no livekit imports, so it can be unit-tested on its own.
"""
import re
from typing import Any, Dict, List, Optional

try:  # Sarvam STT often returns Devanagari; we also try a romanised copy
    from src.transliteration import romanize_hindi
except Exception:  # unit tests / package not on path
    def romanize_hindi(text):  # type: ignore
        return text

_DEV = re.compile(r"[\u0900-\u097F]")
_MAX_TOKENS = 14


def _variants(text: str) -> List[str]:
    t = (text or "").strip()
    out = [t.lower()]
    if _DEV.search(t):
        try:
            r = romanize_hindi(t)
            if r:
                out.append(r.lower())
        except Exception:
            pass
    return out


# Anything that is an objection / question / hand-off / "don't know" is NOT a plain slot answer.
_BLOCK = re.compile(
    r"(robot|\bai\b|\bbot\b|whats\s*app|call\s*mat|mat\s*karna|do\s*not\s*call|don'?t\s*call|\bdnd\b|\bdnc\b|"
    r"number\s*kahan|kahan\s*se|broker|commission|brokerage|baad\s*mein|baad\s*me|call\s*(me\s*)?(back|later)|"
    r"\blater\b|\bbusy\b|time\s*nahi|time\s*nhi|hurry|jaldi|wrong\s*number|repeat|dobara|dubara|phir\s*se|fir\s*se|"
    r"kya\s*(bola|bole|puch)|pata\s*nahi|pata\s*nhi|nahi\s*pata|yaad\s*nahi|don'?t\s*know|do\s*not\s*know|"
    r"not\s*sure|idea\s*nahi|no\s*idea|cannot\s*share|nahi\s*bata|rate\s*kya|price\s*kya|kitna\s*milega|"
    r"valuation|market|human|advisor|manager|not\s*interested|interested\s*nahi)"
)

_NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _to_float(s: str) -> Optional[float]:
    try:
        return float(s.replace(",", ""))
    except Exception:
        return None


def _bare_number(v: str, fill: set) -> Optional[str]:
    """'1200' / 'approx 1200 hoga' -> '1200'. None if anything else is in the sentence."""
    toks = [t.strip(".,") for t in re.findall(r"[a-z0-9\.,\u20b9]+", v)]
    left = [t for t in toks if t and t != "\u20b9" and t not in fill]
    if len(left) == 1 and re.fullmatch(r"\d[\d,]*(?:\.\d+)?", left[0]):
        return left[0]
    return None


# ── BHK ──────────────────────────────────────────────────────────────────────
_WORD_NUM = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
             "ek": "1", "do": "2", "teen": "3", "char": "4", "chaar": "4", "paanch": "5"}
_BHK = re.compile(
    r"\b(\d(?:\.5)?|one|two|three|four|five|ek|do|teen|char|chaar|paanch)\s*(?:\+\s*\d\s*)?"
    r"(?:bhk|b\.h\.k|bed\s*rooms?)"
)
_RK = re.compile(r"\b(\d)\s*rk\b")


def _x_bhk(v: str) -> Optional[Dict[str, Any]]:
    if re.search(r"\bstudio\b", v):
        return {"bhk_config": "Studio"}
    m = _BHK.search(v)
    if m:
        out = f"{_WORD_NUM.get(m.group(1), m.group(1))} BHK"
        if "servant" in v:
            out += " + Servant"
        return {"bhk_config": out}
    m = _RK.search(v)
    if m:
        return {"bhk_config": f"{m.group(1)} RK"}
    return None


# ── Area (sq ft) ─────────────────────────────────────────────────────────────
_AREA = re.compile(
    r"(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*(?:ft|feet|foot)|sqft|square\s*(?:feet|foot|ft)|feet|ft)\b"
)
_OTHER_UNIT = re.compile(r"\b(gaj|yards?|yd|sq\s*yd|sqm|sq\s*m|meters?|metres?|marla|acre|bigha|kanal|biswa)\b")
_AREA_FILL = {"approx", "approximately", "around", "about", "lagbhag", "kareeb", "karib", "total", "super",
              "area", "carpet", "built", "builtup", "hai", "hoga", "hogi", "sir", "ji", "will", "be", "is",
              "it", "its", "roughly", "the", "mein", "me", "ka", "ke", "ki", "of", "sqft", "sq", "ft", "feet"}


def _x_area(v: str, open_field: str) -> Optional[Dict[str, Any]]:
    if _OTHER_UNIT.search(v):
        return None  # not square feet -> let the LLM deal with it
    m = _AREA.search(v)
    raw = m.group(1) if m else (_bare_number(v, _AREA_FILL) if open_field == "approx_area" else None)
    val = _to_float(raw) if raw else None
    if val is not None and 50 <= val <= 1_000_000:
        return {"approx_area_sqft": val}
    return None


# ── Furnishing ───────────────────────────────────────────────────────────────
_SEMI = re.compile(r"semi[\s\-]*furnish|\bsemi\b|half[\s\-]*furnish")
_UNF = re.compile(r"un[\s\-]*furnish|bare[\s\-]*shell|\bbare\b|furnish\w*\s*(nahi|nhi|not)|not\s*furnish")
_FULL = re.compile(r"fully[\s\-]*furnish|full[\s\-]*furnish|\bfully\b|\bfurnished\b")


def _x_furnishing(v: str) -> Optional[Dict[str, Any]]:
    semi, unf, full = _SEMI.search(v), _UNF.search(v), _FULL.search(v)
    if semi and unf:
        return None
    if semi:
        return {"furnishing_status": "semi-furnished"}
    if unf:
        return {"furnishing_status": "bare-shell" if re.search(r"bare", v) else "unfurnished"}
    if full:
        return {"furnishing_status": "fully furnished"}
    return None


# ── Unit number + floor ──────────────────────────────────────────────────────
_ORD = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7,
        "eighth": 8, "ninth": 9, "tenth": 10}
_FLOOR = re.compile(
    r"(?:(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:floor|flr)\b)"
    r"|(?:\bfloor\s*(?:no\.?\s*|number\s*)?(\d{1,2})\b)"
    r"|\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*floor\b"
    r"|\b(ground)\s*floor\b"
)
_UNIT_PREFIX = {"flat", "unit", "no", "number", "house", "shop", "office", "plot", "door", "room"}


def _ordinal(n: int) -> str:
    if 10 <= n % 100 <= 20:
        suf = "th"
    else:
        suf = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def _x_unit_floor(v: str) -> Optional[Dict[str, Any]]:
    ms = list(_FLOOR.finditer(v))
    if len(ms) != 1:
        return None
    m = ms[0]
    if m.group(1):
        # "flat 12 floor 3" would read as floor 12 -> refuse when the number is a unit label
        before = re.findall(r"[a-z]+", v[:m.start()])
        if before and before[-1] in _UNIT_PREFIX:
            return None
        floor = _ordinal(int(m.group(1)))
    elif m.group(2):
        floor = _ordinal(int(m.group(2)))
    elif m.group(3):
        floor = _ordinal(_ORD[m.group(3)])
    else:
        floor = "Ground"
    rest = v[:m.start()] + " " + v[m.end():]
    units = re.findall(r"\b[a-z]{0,2}[\-/]?\d{1,5}[a-z]?\b", rest)
    units = [u for u in units if re.search(r"\d", u)]
    if len(units) != 1:
        return None
    return {"unit_number": units[0].upper(), "floor_number": floor}


# ── Price / rent ─────────────────────────────────────────────────────────────
_AMT = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|laakh|hazaar|hazar|thousand|k)\b")
_UNIT_CANON = {"crore": "crore", "crores": "crore", "cr": "crore", "lakh": "lakh", "lakhs": "lakh",
               "lac": "lakh", "lacs": "lakh", "laakh": "lakh", "hazaar": "thousand", "hazar": "thousand",
               "thousand": "thousand", "k": "thousand"}
_RENT_FILL = {"rs", "rupees", "rupaye", "rupay", "inr", "approx", "around", "about", "per", "month", "monthly",
              "mahina", "mahine", "ka", "ke", "lagbhag", "sir", "ji", "hai", "hoga", "expect", "expecting",
              "rent", "kiraya", "only"}


def _x_amount(v: str, open_field: str) -> Optional[str]:
    if len(_NUM.findall(v)) != 1:          # ranges / "1 crore 20 lakh" -> LLM
        return None
    m = _AMT.search(v)
    if m:
        return f"{m.group(1).replace(',', '')} {_UNIT_CANON[m.group(2)]}"
    if open_field in ("monthly_rent", "current_rent"):
        raw = _bare_number(v, _RENT_FILL)
        val = _to_float(raw) if raw else None
        if val is not None and 1000 <= val <= 99_999_999:
            return str(int(val)) if float(val).is_integer() else str(val)
    return None


# ── Open-field only: leased / occupancy ──────────────────────────────────────
_NEG = re.compile(r"\b(nahi|nhi|nahin|no|not|never)\b")


def _x_leased(v: str) -> Optional[Dict[str, Any]]:
    if _NUM.search(v):   # "leased, 50000 rent" - the amount belongs to the NEXT field; let the LLM split it
        return None
    neg_leased = re.search(
        r"(not|nahi|nhi|nahin|no)\s*(leased|rented|kiraye|tenant|lease)|"
        r"(leased|rented|kiraye\s*par|lease)\s*(nahi|nhi|nahin|not)", v)
    vacant = re.search(r"\b(vacant|khaali|khali|empty)\b", v)
    leased = re.search(r"\b(leased|rented|rent\s*par|kiraye|kirayedar|tenant|lease\s*par|occupied)\b", v)
    if neg_leased:
        return {"is_currently_leased": False}
    if vacant and not leased:
        return {"is_currently_leased": False}
    if leased and not vacant:
        return {"is_currently_leased": True}
    return None


def _x_occupancy(v: str) -> Optional[Dict[str, Any]]:
    neg = _NEG.search(v)
    imm = re.search(r"immediate|turant|\babhi\b|ready\s*to\s*move|right\s*now|available\s*now|any\s*time|jab\s*bhi", v)
    notice = re.search(r"notice|\d+\s*(month|months|mahine|mahina|din|days|day|week)|(one|two|three)\s*months?", v)
    if imm and not notice:
        return {"immediate_occupancy": not neg}
    if notice and not imm:
        return {"immediate_occupancy": bool(neg)}
    return None


# ── Orchestration ────────────────────────────────────────────────────────────
_OPEN_TO_KEY = {
    "unit_floor": "unit_floor", "bhk_config": "bhk_config", "approx_area": "approx_area",
    "furnishing": "furnishing", "sale_price": "amount", "monthly_rent": "amount", "current_rent": "amount",
    "leased_status": "leased_status", "immediate_occupancy": "immediate_occupancy",
}
_AMOUNT_PARAM = {"sale_price": "expected_sale_price", "monthly_rent": "expected_monthly_rent",
                 "current_rent": "current_rent_received"}


def _scan(v: str, open_field: str) -> Dict[str, Any]:
    found: Dict[str, Any] = {}
    for key, res in (
        ("bhk_config", _x_bhk(v)),
        ("approx_area", _x_area(v, open_field)),
        ("furnishing", _x_furnishing(v)),
        ("unit_floor", _x_unit_floor(v)),
        ("amount", _x_amount(v, open_field)),
    ):
        if res:
            found[key] = res
    if open_field == "leased_status":
        r = _x_leased(v)
        if r:
            found["leased_status"] = r
    if open_field == "immediate_occupancy":
        r = _x_occupancy(v)
        if r:
            found["immediate_occupancy"] = r
    return found


def extract(open_field: str, text: str) -> Optional[Dict[str, Any]]:
    """kwargs for save_property_details() when `text` cleanly answers `open_field`, else None."""
    key = _OPEN_TO_KEY.get(open_field)
    if not key or not (text or "").strip():
        return None
    variants = _variants(text)
    for v in variants:
        if _BLOCK.search(v) or len(re.findall(r"[a-z0-9\u0900-\u097F.]+", v)) > _MAX_TOKENS:
            return None
    for v in variants:
        found = _scan(v, open_field)
        if set(found) == {key}:
            kw = found[key]
            return {_AMOUNT_PARAM[open_field]: kw} if key == "amount" else kw
        if found:
            return None   # caller said more than the open field (or something else) -> LLM splits it
    return None