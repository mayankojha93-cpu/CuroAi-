"""
fastpath.py - deterministic parsing of *clean slot values* (NO LLM round trip).

WHAT REGEX IS ALLOWED TO DO HERE
    Read a VALUE (a number with a unit, "3 BHK", "semi furnished", "407 on 4th floor", "50 lakh") from a
    sentence that contains NOTHING ELSE.  Values have a small, closed vocabulary, so regex is reliable there.

WHAT REGEX IS NOT ALLOWED TO DO
    Decide what the caller MEANT: refusals, objections, questions, "don't know", negations, callbacks,
    "that's not what I asked", several facts in one sentence...  Callers can phrase those in unlimited ways,
    so all of that belongs to the LLM.

HOW THE BOUNDARY IS ENFORCED  (whole-sentence accounting)
    1. Only the ONE field that is currently open (missing[0]) can be filled.
    2. After the value is found, every remaining word must be harmless filler ("sir", "ji", "approx",
       "hai", "hoga", the unit word ...).  If even ONE unknown word is left over ("nahi", "lekin", "broker",
       "negotiable", a second number ...) the caller said more than a value -> return None -> the LLM handles it.
    3. Anything ambiguous returns None.  Returning None is always safe: it just costs one LLM call.

Pure python, no livekit imports, so it can be unit-tested on its own.
"""
import re
from typing import Any, Dict, List, Optional, Pattern, Set

from .tools import is_standalone_from_speech

try:  # Sarvam STT often returns Devanagari; we also try a romanised copy
    from src.transliteration import romanize_hindi
except Exception:  # unit tests / package not on path
    def romanize_hindi(text):  # type: ignore
        return text

_DEV = re.compile(r"[\u0900-\u097F]")
_MAX_TOKENS = 8  # a slot answer is short; anything longer is a conversation -> LLM
# numbers ("1,200", "1.5") OR words (latin / devanagari)
_TOK = re.compile(r"\d[\d,]*(?:\.\d+)?|[a-z\u0900-\u097F]+")


def _variants(text: str) -> List[str]:
    t = (text or "").strip().replace("\u2019", "'")
    base = t.lower().replace("'", "")   # it's -> its, don't -> dont
    out = [base]
    # Normalize spoken decimal/fraction configurations (e.g. "three point five" -> "3.5")
    norm = base
    for pat, rep in [
        (r"\bthree\s*(?:point|\.)\s*five\b", "3.5"),
        (r"\btwo\s*(?:point|\.)\s*five\b", "2.5"),
        (r"\bone\s*(?:point|\.)\s*five\b", "1.5"),
        (r"\bfour\s*(?:point|\.)\s*five\b", "4.5"),
        (r"\bthree\s*and\s*a\s*half\b", "3.5"),
        (r"\btwo\s*and\s*a\s*half\b", "2.5"),
        (r"\bone\s*and\s*a\s*half\b", "1.5"),
        (r"\b(?:saadhe|sadhe)\s*teen\b", "3.5"),
        (r"\b(?:saadhe|sadhe)\s*cha?ar\b", "4.5"),
        (r"\b(?:dhaai|dhai)\b", "2.5"),
        (r"\bdedh\b", "1.5"),
    ]:
        norm = re.sub(pat, rep, norm)
    if norm != base:
        out.append(norm)

    if _DEV.search(t):
        try:
            r = romanize_hindi(t)
            if r:
                out.append(r.lower())
        except Exception:
            pass
    return out


# Words that carry NO meaning of their own in a slot answer. Deliberately tiny and "meaning-free":
# negations (nahi/not/no), conjunctions that start a 2nd thought (lekin/but/par), questions, names of other
# fields etc. are NOT in this set, so they always push the turn to the LLM.
_FILL: Set[str] = {
    "sir", "madam", "ji", "jee", "haan", "han", "haanji", "hanji", "yes", "yeah", "yep", "ok", "okay",
    "hai", "hain", "hoga", "hogi", "hoon", "ho", "h", "it", "its", "is", "the", "a", "an", "will", "be",
    "approx", "approximately", "around", "about", "roughly", "lagbhag", "kareeb", "karib", "basically",
    "so", "toh", "to", "bhi", "ka", "ke", "ki", "ko", "me", "mein", "main", "pe", "par", "per", "wala", "wali",
    "and", "aur", "please", "only", "bas", "just", "that", "this", "ye", "yeh", "woh", "wo", "um", "uh", "umm", "hmm",
    "i", "think", "guess", "say", "saying", "would", "maybe", "lagta", "lagti",
}


def _leftover(v: str, consumed: List[Pattern], vocab: Set[str]) -> List[str]:
    """Words of `v` that are NOT part of the value (`consumed` patterns removed) and NOT harmless filler."""
    s = v
    for pat in consumed:
        s = pat.sub(" ", s)
    return [t for t in _TOK.findall(s) if t not in _FILL and t not in vocab]


def _to_float(s: str) -> Optional[float]:
    try:
        return float(s.replace(",", ""))
    except Exception:
        return None


def _bare_number(v: str, vocab: Set[str]) -> Optional[str]:
    """'1200' / 'approx 1200 hoga' -> '1200'. None if anything else is in the sentence."""
    toks = [t.strip(".,") for t in re.findall(r"[a-z0-9\.,\u20b9]+", v)]
    left = [t for t in toks if t and t != "\u20b9" and t not in _FILL and t not in vocab]
    if len(left) == 1 and re.fullmatch(r"\d[\d,]*(?:\.\d+)?", left[0]):
        return left[0]
    return None


# ── BHK ──────────────────────────────────────────────────────────────────────
_WORD_NUM = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6",
    "ek": "1", "do": "2", "teen": "3", "char": "4", "chaar": "4", "paanch": "5", "chhe": "6",
    "one point five": "1.5", "two point five": "2.5", "three point five": "3.5", "four point five": "4.5",
    "one and a half": "1.5", "two and a half": "2.5", "three and a half": "3.5",
    "dedh": "1.5", "dhai": "2.5", "dhaai": "2.5", "sadhe teen": "3.5", "saadhe teen": "3.5", "sadhe char": "4.5",
}
_BHK = re.compile(
    r"\b(\d(?:\.5)?|one|two|three|four|five|six|ek|do|teen|char|chaar|paanch|chhe)\s*(?:\+\s*\d\s*)?"
    r"(?:bhk|b\.h\.k|bed\s*rooms?)"
)
_RK = re.compile(r"\b(\d)\s*rk\b")
_STUDIO = re.compile(r"\bstudio\b")
_BHK_VOCAB = {"bhk", "bed", "beds", "bedroom", "bedrooms", "room", "rooms", "flat", "apartment",
              "plus", "with", "servant", "rk", "studio"}
_BHK_BARE_VOCAB = {"bedroom", "bedrooms", "bed", "beds", "flat", "apartment"}


def _x_bhk(v: str) -> Optional[Dict[str, Any]]:
    if _STUDIO.search(v):
        return {"bhk_config": "Studio"} if not _leftover(v, [_STUDIO], _BHK_VOCAB) else None
    m = _BHK.search(v)
    if m:
        if _leftover(v, [_BHK], _BHK_VOCAB):
            return None
        out = f"{_WORD_NUM.get(m.group(1), m.group(1))} BHK"
        if "servant" in v:
            out += " + Servant"
        return {"bhk_config": out}
    m = _RK.search(v)
    if m:
        return {"bhk_config": f"{m.group(1)} RK"} if not _leftover(v, [_RK], _BHK_VOCAB) else None
    # bhk_config is the open question, so a bare digit/decimal ("3", "it's 3", "3.5", "3 bed") is unambiguous
    bare = _bare_number(v, _BHK_BARE_VOCAB)
    if bare:
        val = _WORD_NUM.get(bare, bare)
        if re.fullmatch(r"[1-6](?:\.5)?", val):
            return {"bhk_config": f"{val} BHK"}
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
_AREA_VOCAB = {"total", "super", "area", "carpet", "built", "builtup", "size", "sq", "ft", "sqft", "feet",
               "foot", "square", "gaj", "yard", "yards", "yd", "of", "expected", "expect"}


def _x_area(v: str) -> Optional[Dict[str, Any]]:
    if _OTHER_UNIT.search(v):
        return None  # sqm / acre / bigha ... -> LLM converts
    mg = _GAJ.search(v)
    if mg:
        if _leftover(v, [_GAJ], _AREA_VOCAB):
            return None
        val = _to_float(mg.group(1))
        sqft = round(val * 9.0, 2) if val is not None else None
        return {"approx_area_sqft": sqft} if sqft is not None and 50 <= sqft <= 1_000_000 else None
    m = _AREA.search(v)
    if m:
        if _leftover(v, [_AREA], _AREA_VOCAB):
            return None
        val = _to_float(m.group(1))
        return {"approx_area_sqft": val} if val is not None and 50 <= val <= 1_000_000 else None

    # Bare number, no unit. Residential units are virtually never < 350 sq ft; small numbers are gaj /
    # flat numbers -> ask the LLM to clarify. Odd flat-like numbers (407, 502) without an area word likewise.
    raw = _bare_number(v, _AREA_VOCAB)
    val = _to_float(raw) if raw else None
    if val is not None and 350 <= val <= 100_000:
        if val % 10 == 0 or val % 25 == 0 or _AREA_KEYWORDS.search(v):
            return {"approx_area_sqft": val}
    return None


# ── Furnishing ───────────────────────────────────────────────────────────────
# Only the closed set of real spoken options. Garbled STT ("supar furnished", "simi") and bare "furnished"
# (semi or full?) are NOT guessed here - the LLM resolves them from context.
_SEMI = re.compile(r"semi[\s\-]*(?:furnish\w*|fitted)|s[ae]mi[\s\-]*furnish\w*|\bsemi\b|\bs[ae]mi\b|half[\s\-]*furnish\w*")
_UNF = re.compile(r"un[\s\-]*furnish\w*|bare[\s\-]*shell|\bbare\b|furnish\w*\s*(?:nahi|nhi|not)|not\s*furnish\w*")
_FULL = re.compile(r"fully[\s\-]*furnish\w*|full[\s\-]*furnish\w*|ph+ul+[yi][\s\-]*furnish\w*|\bfully\b")
_FURN_VOCAB = {"furnished", "furnish", "furnishing", "fully", "full", "semi", "un", "unfurnished", "bare",
               "shell", "fitted", "half", "furnishd", "phully", "fuli"}


def _x_furnishing(v: str) -> Optional[Dict[str, Any]]:
    semi, unf, full = _SEMI.search(v), _UNF.search(v), _FULL.search(v)
    if [bool(semi), bool(unf), bool(full)].count(True) != 1:
        return None  # none, or contradictory ("semi ... unfurnished")
    extra = {"nahi", "nhi", "not"} if (unf and re.search(r"furnish\w*\s*(?:nahi|nhi|not)|not\s*furnish", v)) else set()
    if [t for t in _TOK.findall(v) if t not in _FILL and t not in _FURN_VOCAB and t not in extra]:
        return None  # e.g. "semi furnished nahi hai", "fully furnished hai lekin ..." -> LLM
    if semi:
        return {"furnishing_status": "semi-furnished"}
    if unf:
        return {"furnishing_status": "bare-shell" if re.search(r"bare", v) else "unfurnished"}
    return {"furnishing_status": "fully furnished"}


# ── Unit number + floor ──────────────────────────────────────────────────────
_ORD = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7,
        "eighth": 8, "ninth": 9, "tenth": 10}
_FLOOR = re.compile(
    r"(?:(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:floor|flr)\b)"
    r"|(?:\bfloor\s*(?:no\.?\s*|number\s*)?(\d{1,2})\b)"
    r"|\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*floor\b"
    r"|\b(ground)\s*floor\b"
)
_UNIT_TOKEN = re.compile(r"\b[a-z]{0,2}[\-/]?\d{1,5}[a-z]?\b")
_UNIT_PREFIX = {"flat", "unit", "no", "number", "house", "shop", "office", "plot", "door", "room"}
_UF_VOCAB = {"flat", "unit", "number", "no", "num", "floor", "flr", "st", "nd", "rd", "th", "ground", "house",
             "door", "room", "office", "shop", "plot", "on", "at", "the", "of", "wale", "wala", "wali"}


def _ordinal(n: int) -> str:
    if 10 <= n % 100 <= 20:
        suf = "th"
    else:
        suf = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def _pick_unit_number(units: List[str]) -> Optional[str]:
    """Pick unit number from candidates, resolving natural spoken repetitions like 'D-17, 17 number'."""
    cleaned = [u.strip(".,;: -_") for u in units if u.strip(".,;: -_")]
    if not cleaned:
        return None
    if len(cleaned) == 1:
        return cleaned[0].upper()
    digits_map: Dict[str, List[str]] = {}
    for u in cleaned:
        d = re.sub(r"\D", "", u)
        if d:
            digits_map.setdefault(d, []).append(u)
    if len(digits_map) == 1:  # same number said twice
        cands = list(digits_map.values())[0]
        with_alpha = [c for c in cands if any(ch.isalpha() or ch in "-/" for ch in c)]
        return (with_alpha[0] if with_alpha else cands[0]).upper()
    return None  # two different numbers: which is the unit? -> LLM


def _floor_label(m: "re.Match") -> str:
    if m.group(1):
        return _ordinal(int(m.group(1)))
    if m.group(2):
        return _ordinal(int(m.group(2)))
    if m.group(3):
        return _ordinal(_ORD[m.group(3)])
    return "Ground"


def _x_unit_floor(v: str) -> Optional[Dict[str, Any]]:
    # "independent house / standalone" -> no unit, no floor (tools.is_standalone_from_speech has its own guards).
    # Only for a SHORT sentence: a longer one may also carry an objection or question.
    if len(_TOK.findall(v)) <= 4 and is_standalone_from_speech(v):
        return {"unit_number": "Standalone", "floor_number": "Ground"}

    ms = list(_FLOOR.finditer(v))
    if len(ms) > 1:
        return None
    if ms:
        m = ms[0]
        if m.group(1):
            # "flat 12 floor 3" would read as floor 12 -> refuse when the number is a unit label
            before = re.findall(r"[a-z]+", v[:m.start()])
            if before and before[-1] in _UNIT_PREFIX:
                return None
        rest = v[:m.start()] + " " + v[m.end():]
        if _leftover(rest, [_UNIT_TOKEN], _UF_VOCAB):
            return None
        units = _UNIT_TOKEN.findall(rest)
        if not units:
            return {"floor_number": _floor_label(m)}
        unit = _pick_unit_number(units)
        return {"unit_number": unit, "floor_number": _floor_label(m)} if unit else None

    # no floor word: a lone unit number ("407", "flat 402", "D-17")
    if _leftover(v, [_UNIT_TOKEN], _UF_VOCAB):
        return None
    unit = _pick_unit_number(_UNIT_TOKEN.findall(v))
    if unit and len(re.sub(r"\D", "", unit)) <= 4:
        return {"unit_number": unit}
    return None


# ── Price / rent ─────────────────────────────────────────────────────────────
_AMT = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|laakh|hazaar|hazar|thousand|k)\b", re.IGNORECASE)
_NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")
_UNIT_CANON = {"crore": "crore", "crores": "crore", "cr": "crore", "lakh": "lakh", "lakhs": "lakh",
               "lac": "lakh", "lacs": "lakh", "laakh": "lakh", "hazaar": "thousand", "hazar": "thousand",
               "thousand": "thousand", "k": "thousand"}
_RENT_VOCAB = {"rs", "rupees", "rupaye", "rupay", "inr", "per", "month", "monthly", "mahina", "mahine",
               "expect", "expecting", "expected", "rent", "kiraya", "crore", "lakh", "thousand", "k"}
_SALE_VOCAB = {"rs", "rupees", "rupaye", "rupay", "inr", "expect", "expecting", "expected", "price", "crore",
               "lakh", "demand", "rate", "cost", "total"}

# "one point five" / "dedh" / "fifty": a tiny closed list of spoken numbers. Anything else spoken in words
# ("paanch lakh", "saadhe teen crore") is not handled here -> the LLM converts it.
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
    vocab = _SALE_VOCAB if open_field == "sale_price" else _RENT_VOCAB

    if open_field in ("sale_price", "monthly_rent"):
        mm = _MARKET_RATE_STMT.search(v)
        if mm and not _Q_WORDS.search(v) and not _leftover(v, [_MARKET_RATE_STMT], vocab | {"jo", "bhi", "chal", "raha"}):
            return "Market Rate"

    v_norm = v
    if open_field == "sale_price":
        for pat, rep in _SPOKEN_SALE_NUMS:
            v_norm = pat.sub(rep, v_norm)

    nums = [n.replace(",", "").rstrip(".") for n in _NUM.findall(v_norm)]
    if not nums or len(set(nums)) > 1:
        return None  # no number, or a range / compound amount ("1 crore 20 lakh") -> LLM

    m = _AMT.search(v_norm)
    if m:
        # the same figure said twice for emphasis ("40, 40k") is not "extra content"
        if [t for t in _leftover(v_norm, [_AMT], vocab) if t.replace(",", "").rstrip(".") != nums[0]]:
            return None
        unit = _UNIT_CANON.get(m.group(2).lower(), m.group(2).lower())
        return f"{m.group(1).replace(',', '')} {unit}"

    # number with no unit: only meaningful for the open field's usual scale
    raw = _bare_number(v_norm, vocab)
    val = _to_float(raw) if raw else None
    if val is None:
        return None
    if open_field == "sale_price":
        clean = int(val) if float(val).is_integer() else val
        if 0.25 <= val < 15:
            return f"{clean} crore"      # 1.5 / 2 / 3.5 -> crore
        if 15 <= val <= 999:
            return f"{clean} lakh"       # 50 / 75 / 150 -> lakh
        if val >= 100_000:
            return str(int(val)) if float(val).is_integer() else str(val)
    elif 1000 <= val <= 99_999_999:      # monthly_rent / current_rent in rupees
        return str(int(val)) if float(val).is_integer() else str(val)
    return None


# ── Open-field only: leased / occupancy (closed yes/no vocabularies) ─────────
_LEASED_W = {"leased", "rented", "rent", "kiraye", "kirayedar", "kiraya", "tenant", "tenants", "lease", "occupied"}
_VACANT_W = {"vacant", "khaali", "khali", "empty"}
_NEG_W = {"nahi", "nhi", "nahin", "no", "not"}


def _x_leased(v: str) -> Optional[Dict[str, Any]]:
    toks = _TOK.findall(v)
    if any(t not in _FILL and t not in _LEASED_W and t not in _VACANT_W and t not in _NEG_W for t in toks):
        return None  # a number ("leased, 50000 rent"), another topic, anything unknown -> LLM
    leased = any(t in _LEASED_W for t in toks)
    vacant = any(t in _VACANT_W for t in toks)
    neg = any(t in _NEG_W for t in toks)
    if leased == vacant:  # neither, or both
        return None
    state = leased                      # True = leased, False = vacant
    return {"is_currently_leased": (not state) if neg else state}


_IMM_PHRASE = re.compile(r"immediate(?:ly)?|turant|\babhi\b|right\s*(?:abhi|now)|ready\s*to\s*move|available\s*now|right\s*away|any\s*time|anytime|jab\s*bhi")
_AVAIL_TOK = {"available", "avelable", "availeble", "avlble", "avalable", "avilable"}
_NOTICE = re.compile(r"notice(?:\s*period)?|\d+\s*(?:month|months|mahine|mahina|din|days|day|week|weeks)\b")
_OCC_VOCAB = {"available", "avelable", "availeble", "avlble", "avalable", "avilable", "right", "now", "away",
              "period", "notice", "move", "ready"}


def _x_occupancy(v: str) -> Optional[Dict[str, Any]]:
    toks = _TOK.findall(v)
    neg = any(t in _NEG_W for t in toks)
    imm = bool(_IMM_PHRASE.search(v)) or any(t in _AVAIL_TOK for t in toks)
    notice = bool(_NOTICE.search(v))
    if imm == notice:  # neither, or both
        return None
    left = _leftover(v, [_IMM_PHRASE, _NOTICE], _OCC_VOCAB | _NEG_W | {"months", "month", "mahine", "mahina", "din", "days", "day", "week", "weeks"})
    if left or re.search(r"\d", _NOTICE.sub(" ", _IMM_PHRASE.sub(" ", v))):
        return None
    return {"immediate_occupancy": (not neg)} if imm else {"immediate_occupancy": bool(neg)}


# ── Orchestration ────────────────────────────────────────────────────────────
def _amount_extractor(open_field: str, param: str):
    def _fn(v: str) -> Optional[Dict[str, Any]]:
        a = _x_amount(v, open_field)
        return {param: a} if a else None
    return _fn


_EXTRACTORS = {
    "unit_floor": _x_unit_floor,
    "bhk_config": _x_bhk,
    "approx_area": _x_area,
    "furnishing": _x_furnishing,
    "sale_price": _amount_extractor("sale_price", "expected_sale_price"),
    "monthly_rent": _amount_extractor("monthly_rent", "expected_monthly_rent"),
    "current_rent": _amount_extractor("current_rent", "current_rent_received"),
    "leased_status": _x_leased,
    "immediate_occupancy": _x_occupancy,
}


def extract(open_field: str, text: str) -> Optional[Dict[str, Any]]:
    """kwargs for save_property_details() when `text` is *only* a clean answer to `open_field`, else None.

    None means "not provably just a value" - the LLM then handles the turn (objections, questions,
    negations, several facts at once, STT garble, unusual phrasing, ...)."""
    fn = _EXTRACTORS.get(open_field)
    if not fn or not (text or "").strip():
        return None
    variants = _variants(text)
    if any(len(_TOK.findall(v)) > _MAX_TOKENS for v in variants):
        return None
    for v in variants:
        out = fn(v)
        if out:
            return out
    return None
    