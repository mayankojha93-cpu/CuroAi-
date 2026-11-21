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
from .tools import is_standalone_from_speech

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
    r"valuation|market\s*(?:kya|kitn|bata|trend)|human|advisor|manager|not\s*interested|interested\s*nahi)"
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


def _x_bhk(v: str, open_field: str = "") -> Optional[Dict[str, Any]]:
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
    # If bhk_config is currently open, bare numbers (e.g. "3", "it's 3", "3 bed") map cleanly
    if open_field == "bhk_config":
        _BHK_FILL = {"it", "its", "is", "hai", "hoga", "hogi", "sir", "ji", "bedroom", "bedrooms", "bed", "beds", "yeah", "yes", "haan", "ka", "ke", "ki", "so", "bhi", "basically", "to"}
        bare = _bare_number(v, _BHK_FILL)
        if bare and bare in ("1", "2", "3", "4", "5", "6"):
            return {"bhk_config": f"{bare} BHK"}
    return None


# ── Area (sq ft & gaj) ───────────────────────────────────────────────────────
_GAJ = re.compile(
    r"(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*yards?|sq\.?\s*yd|square\s*yards?|gaj|yards?|yd)\b",
    re.IGNORECASE,
)
_AREA = re.compile(
    r"(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*(?:ft|feet|foot)|sqft|square\s*(?:feet|foot|ft)|feet|ft)\b",
    re.IGNORECASE,
)
_OTHER_UNIT = re.compile(r"\b(sqm|sq\s*m|meters?|metres?|marla|acre|bigha|kanal|biswa)\b", re.IGNORECASE)
_AREA_KEYWORDS = re.compile(r"\b(area|carpet|super|built|builtup|size|square)\b", re.IGNORECASE)
_AREA_FILL = {"approx", "approximately", "around", "about", "lagbhag", "kareeb", "karib", "total", "super",
              "area", "carpet", "built", "builtup", "hai", "hoga", "hogi", "sir", "ji", "will", "be", "is",
              "it", "its", "roughly", "the", "mein", "me", "ka", "ke", "ki", "of", "sqft", "sq", "ft", "feet",
              "gaj", "yard", "yards"}


def _x_area(v: str, open_field: str) -> Optional[Dict[str, Any]]:
    if _OTHER_UNIT.search(v):
        return None  # unhandled units (acre, bigha, sqm, etc.) -> let the LLM deal with it
    mg = _GAJ.search(v)
    if mg:
        val = _to_float(mg.group(1))
        if val is not None:
            sqft = round(val * 9.0, 2)
            if 50 <= sqft <= 1_000_000:
                return {"approx_area_sqft": sqft}
        return None
    m = _AREA.search(v)
    if m:
        val = _to_float(m.group(1))
        if val is not None and 50 <= val <= 1_000_000:
            return {"approx_area_sqft": val}
        return None

    # Bare number without explicit unit
    if open_field == "approx_area":
        raw = _bare_number(v, _AREA_FILL)
        val = _to_float(raw) if raw else None
        # Indian real estate: residential units are virtually never < 350 sq ft.
        # Numbers < 350 (e.g. 100, 200) are almost always gaj or flat/floor numbers.
        # Numbers >= 350 must be plausible areas (multiple of 10 or 25, or explicit area keywords).
        # Odd flat-like numbers without keywords (e.g. 407, 502) are left for LLM to clarify.
        if val is not None and 350 <= val <= 100_000:
            if val % 10 == 0 or val % 25 == 0 or _AREA_KEYWORDS.search(v):
                return {"approx_area_sqft": val}
    return None


# ── Furnishing ───────────────────────────────────────────────────────────────
# STT phonetic variants observed on phone lines (Sarvam saaras:v4 / saaras:v3):
#   "semi-furnished"  -> "supar furnished", "simi furnished", "semi furnish"
#   "unfurnished"     -> "un furnishd", "berfurnish", "bare shell"
#   "fully furnished" -> "phully furnished", "fuli furnished", "fully furnishd"
#   "semi"            -> "sami", "seme", "semee"
#   "available"       -> "avlble", "avelable", "availeble" (in occupancy)
_SEMI = re.compile(r"semi[\s\-]*furnish|s[ae]mi[\s\-]*furnish|\bsemi\b|\bs[ae]mi\b|half[\s\-]*furnish")
_UNF = re.compile(r"un[\s\-]*furnish|bare[\s\-]*shell|\bbare\b|furnish\w*\s*(nahi|nhi|not)|not\s*furnish")
_FULL = re.compile(r"fully[\s\-]*furnish|full[\s\-]*furnish|ph+ul+[yi][\s\-]*furnish|\bfully\b|\bfurnished\b")


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


def _pick_unit_number(units: List[str]) -> Optional[str]:
    """Pick unit number from candidates, resolving natural spoken repetitions like 'D-17, 17 number'."""
    if not units:
        return None
    cleaned = [u.strip(".,;: -_") for u in units if u.strip(".,;: -_")]
    if not cleaned:
        return None
    if len(cleaned) == 1:
        return cleaned[0].upper()

    # Check if candidates are repetitions (e.g., ['d-17', '17'] or ['17', '17'])
    digits_map = {}
    for u in cleaned:
        d = re.sub(r"\D", "", u)
        if d:
            digits_map.setdefault(d, []).append(u)

    if len(digits_map) == 1:
        cands = list(digits_map.values())[0]
        # Prefer candidate with alphanumeric prefix (e.g. 'D-17' over '17')
        with_alpha = [c for c in cands if any(ch.isalpha() or ch in "-/" for ch in c)]
        if with_alpha:
            return with_alpha[0].upper()
        return cands[0].upper()

    # Also handle doubled numbers like '1717' when the caller repeated '17'
    if len(cleaned) == 1:
        return cleaned[0].upper()
    return None


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
    unit = _pick_unit_number(units)
    if not unit:
        return None
    return {"unit_number": unit, "floor_number": floor}


def _x_floor_only(v: str) -> Optional[Dict[str, Any]]:
    ms = list(_FLOOR.finditer(v))
    if len(ms) != 1:
        return None
    m = ms[0]
    if m.group(1):
        floor = _ordinal(int(m.group(1)))
    elif m.group(2):
        floor = _ordinal(int(m.group(2)))
    elif m.group(3):
        floor = _ordinal(_ORD[m.group(3)])
    else:
        floor = "Ground"
    return {"floor_number": floor}


def _x_unit_only(v: str) -> Optional[Dict[str, Any]]:
    # When floor is not present, look for unit number
    if _FLOOR.search(v):
        return None
    units = re.findall(r"\b(?:flat|unit|door|room|no\.?|number)?\s*([a-z]{0,2}[\-/]?\d{1,5}[a-z]?)\b", v, re.I)
    units = [u for u in units if re.search(r"\d", u)]
    unit = _pick_unit_number(units)
    if unit:
        return {"unit_number": unit}
    return None


# ── Price / rent ─────────────────────────────────────────────────────────────
_AMT = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|laakh|hazaar|hazar|thousand|k)\b", re.IGNORECASE)
_UNIT_CANON = {"crore": "crore", "crores": "crore", "cr": "crore", "lakh": "lakh", "lakhs": "lakh",
               "lac": "lakh", "lacs": "lakh", "laakh": "lakh", "hazaar": "thousand", "hazar": "thousand",
               "thousand": "thousand", "k": "thousand"}
_RENT_FILL = {"rs", "rupees", "rupaye", "rupay", "inr", "approx", "around", "about", "per", "month", "monthly",
              "mahina", "mahine", "ka", "ke", "lagbhag", "sir", "ji", "hai", "hoga", "expect", "expecting",
              "rent", "kiraya", "only"}
_SALE_FILL = {"rs", "rupees", "rupaye", "rupay", "inr", "approx", "around", "about",
              "lagbhag", "kareeb", "karib", "sir", "ji", "hai", "hoga", "expect", "expecting",
              "price", "only", "crore", "lakh", "me", "mein", "ka", "ke", "ki", "hogi",
              "demand", "rate", "cost", "total"}

_SPOKEN_SALE_NUMS = [
    (re.compile(r"\bone\s+point\s+five\b", re.IGNORECASE), "1.5"),
    (re.compile(r"\btwo\s+point\s+five\b", re.IGNORECASE), "2.5"),
    (re.compile(r"\bthree\s+point\s+five\b", re.IGNORECASE), "3.5"),
    (re.compile(r"\bdedh\b", re.IGNORECASE), "1.5"),
    (re.compile(r"\bdhai\b", re.IGNORECASE), "2.5"),
    (re.compile(r"\bfifty\b", re.IGNORECASE), "50"),
    (re.compile(r"\bsixty\b", re.IGNORECASE), "60"),
    (re.compile(r"\bseventy\b", re.IGNORECASE), "70"),
    (re.compile(r"\beighty\b", re.IGNORECASE), "80"),
    (re.compile(r"\bninety\b", re.IGNORECASE), "90"),
]


_MARKET_RATE_STMT = re.compile(
    r"\b(jo\s+(bhi\s+)?|as\s+per\s+|according\s+to\s+)?market\s+(rate|price|value)"
    r"(\s+(pe|par|me|mein|main|hi|hai|hoga|chal\s*raha\s*hai|de\s*denge|chahiye|bik\s*jaye|mil\s*jaye))?\b"
    r"|मार्केट\s*(रेट|प्राइस|भाव|वैल्यू)",
    re.IGNORECASE,
)
_Q_WORDS = re.compile(r"\b(kya|kitn[aei]|what|batao|bataiye)\b|क्या|कितना|बताओ|बताइए", re.IGNORECASE)


def _x_amount(v: str, open_field: str) -> Optional[str]:
    if open_field in ("sale_price", "monthly_rent"):
        if _MARKET_RATE_STMT.search(v) and not _Q_WORDS.search(v):
            return "Market Rate"

    v_norm = v
    if open_field == "sale_price":
        for pat, rep in _SPOKEN_SALE_NUMS:
            v_norm = pat.sub(rep, v_norm)

    raw_nums = _NUM.findall(v_norm)
    nums = [n.replace(',', '').rstrip('.') for n in raw_nums]
    # Allow single number OR repeated number (e.g. "40, 40k" or "40k, 40k" said for emphasis)
    if len(nums) > 1 and len(set(nums)) > 1:
        return None  # genuine range / compound amount (e.g. "1 crore 20 lakh") -> LLM

    m = _AMT.search(v_norm)
    if m:
        num_str = m.group(1).replace(',', '')
        unit = _UNIT_CANON.get(m.group(2).lower(), m.group(2).lower())
        return f"{num_str} {unit}"

    if open_field == "sale_price":
        raw = _bare_number(v_norm, _SALE_FILL)
        val = _to_float(raw) if raw else None
        if val is not None:
            if 0.25 <= val < 15:
                # 0.25 to 14.9 without unit in Indian sale context is Crore (e.g. 1.5, 2, 3.5, 10)
                clean_num = int(val) if float(val).is_integer() else val
                return f"{clean_num} crore"
            elif 15 <= val <= 999:
                # 15 to 999 without unit is Lakh (e.g. 50, 75, 80, 150)
                clean_num = int(val) if float(val).is_integer() else val
                return f"{clean_num} lakh"
            elif val >= 100_000:
                # Full rupees amount (e.g. 5000000)
                return str(int(val)) if float(val).is_integer() else str(val)

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
    # "available" STT variants on phone lines: "avelable", "availeble", "avlble", "avalabl" etc.
    _avail_phonetic = re.compile(r"\bav[ae]?[il]+[ae]?b?l?[ae]?\b", re.I)
    imm = re.search(
        r"immediate|turant|\babhi\b|right\s*(?:abhi|now)|ready\s*to\s*move"
        r"|available\s*now|any\s*time|jab\s*bhi",
        v,
    ) or _avail_phonetic.search(v)
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
    if open_field == "unit_floor" and is_standalone_from_speech(v):
        return {"unit_floor": {"unit_number": "Standalone", "floor_number": "Ground"}}
    for key, res in (
        ("bhk_config", _x_bhk(v, open_field)),
        ("approx_area", _x_area(v, open_field)),
        ("furnishing", _x_furnishing(v)),
        ("amount", _x_amount(v, open_field)),
    ):
        if res:
            found[key] = res
    if open_field == "unit_floor":
        uf = _x_unit_floor(v)
        if uf:
            found["unit_floor"] = uf
        else:
            fl = _x_floor_only(v)
            if fl:
                found["unit_floor"] = fl
            un = _x_unit_only(v)
            if un:
                found["unit_floor"] = un
    elif _x_unit_floor(v):
        found["unit_floor"] = _x_unit_floor(v)
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


def extract_all_slots(text: str) -> Dict[str, Any]:
    """Proactively extract all recognizable real estate slots mentioned anywhere in `text`.
    Used on every caller turn so multi-slot answers (e.g. 'house, 3 BHK, for rent, fully furnished')
    are completely captured in one turn and never re-asked.
    """
    slots: Dict[str, Any] = {}
    if not text or not text.strip():
        return slots

    from .tools import (
        classify_category,
        classify_intent,
        commercial_type_from_speech,
        explicit_refusal,
        explicit_dnc_request,
    )

    t = text.strip()
    if explicit_refusal(t) or explicit_dnc_request(t):
        return slots

    low = t.lower()

    # Category & Intent
    cat = classify_category(t)
    if cat:
        slots["category"] = cat

    intn = classify_intent(t)
    if intn:
        slots["intent"] = intn

    # Standalone check
    if is_standalone_from_speech(t):
        slots["is_standalone"] = True
        slots["unit_number"] = "Standalone"
        slots["floor_number"] = "Ground"

    # BHK configuration
    bhk = _x_bhk(low, open_field="bhk_config")
    if bhk and "bhk_config" in bhk:
        slots["bhk_config"] = bhk["bhk_config"]
        # Explicit BHK always confirms residential
        slots["category"] = "residential"

    # Commercial unit type
    comm_type = commercial_type_from_speech(t)
    if comm_type and comm_type != "Other":
        slots["commercial_type"] = comm_type
        slots["category"] = "commercial"

    # Area in sqft / gaj
    area = _x_area(low, open_field="approx_area")
    if area and "approx_area_sqft" in area:
        slots["approx_area_sqft"] = area["approx_area_sqft"]

    # Furnishing
    fur = _x_furnishing(low)
    if fur and "furnishing_status" in fur:
        slots["furnishing_status"] = fur["furnishing_status"]

    # Unit and Floor
    if not slots.get("is_standalone"):
        uf = _x_unit_floor(low)
        if uf:
            slots.update(uf)
        else:
            fl = _x_floor_only(low)
            if fl:
                slots.update(fl)
            un = _x_unit_only(low)
            if un:
                slots.update(un)

    # Occupancy
    occ = _x_occupancy(low)
    if occ and "immediate_occupancy" in occ:
        slots["immediate_occupancy"] = occ["immediate_occupancy"]

    # Leased status
    ls = _x_leased(low)
    if ls and "is_currently_leased" in ls:
        slots["is_currently_leased"] = ls["is_currently_leased"]

    # Price / Rent
    rent = _x_amount(low, open_field="monthly_rent")
    if rent:
        slots["expected_monthly_rent"] = rent
    price = _x_amount(low, open_field="sale_price")
    if price:
        slots["expected_sale_price"] = price

    return slots