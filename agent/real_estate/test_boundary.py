"""Regex-vs-LLM boundary tests (pure Python, no network, no audio, no LLM calls).
Run from the project root:  python -m pytest <path-to-this-folder>/test_boundary.py -q"""
import os
os.environ.setdefault("INTERNAL_SECRET", "test")   # config.py only logs a warning without it

# Place this file in the SAME folder as agent.py / tools.py / fastpath.py (the folder with __init__.py),
# so these relative imports resolve with no package name to configure.
from . import agent as A
from . import tools as T
from . import fastpath as F

# ---- 1. Hard refusals: regex may close the call without the LLM ------------------------------------
HARD = ["not interested", "nahi bechna", "no thanks", "nahi chahiye", "already sold", "bech diya",
        "mujhe interest nahi hai", "call kaat do"]
# ---- 2. Soft refusals: NEVER closed by regex, the LLM must offer a callback ------------------------
SOFT = ["nothing", "nothing at the moment", "no plans", "no plans right now", "not right now",
        "not at the moment", "kuch nahi", "abhi kuch nahi", "abhi nahi", "abhi koi plan nahi"]

def test_hard_refusals_still_deterministic():
    for t in HARD:
        # every hard refusal is recognised by at least one deterministic layer, and the tool guard accepts it
        assert A._CLEAR_REFUSAL_SHORT.match(t) or A._DIRECT_NOT_INTERESTED.search(t) or T.explicit_refusal(t), t
        assert T.explicit_refusal(t), t

def test_soft_refusals_go_to_llm():
    for t in SOFT:
        assert not A._CLEAR_REFUSAL_SHORT.match(t), ("short-refusal shortcut", t)
        assert not A._DIRECT_NOT_INTERESTED.search(t), ("direct-not-interested", t)
        assert not A._is_bare_refusal(t), ("bare refusal", t)
        assert not T.explicit_refusal(t), ("tools.explicit_refusal", t)
        assert A._is_soft_refusal(t), ("soft refusal detector", t)

def test_soft_detector_does_not_swallow_hard():
    for t in HARD:
        assert not A._is_soft_refusal(t), t

def test_bare_nahi_still_confirm_flow():
    assert A._is_bare_refusal("nahi")
    assert A._is_bare_refusal("no sir")

# ---- 3. fastpath: values only, any extra meaning -> None (LLM) -------------------------------------
def test_fastpath_values():
    assert F.extract("bhk_config", "3 BHK") == {"bhk_config": "3 BHK"}
    assert F.extract("approx_area", "1200 sq ft") == {"approx_area_sqft": 1200.0}
    assert F.extract("furnishing", "semi furnished") == {"furnishing_status": "semi-furnished"}
    assert F.extract("sale_price", "50 lakh") == {"expected_sale_price": "50 lakh"}
    assert F.extract("sale_price", "one crore") == {"expected_sale_price": "1 crore"}
    assert F.extract("sale_price", "two crore") == {"expected_sale_price": "2 crore"}
    assert F.extract("monthly_rent", "twenty thousand") == {"expected_monthly_rent": "20 thousand"}
    assert F.extract("monthly_rent", "twenty five thousand") == {"expected_monthly_rent": "25 thousand"}
    assert F.extract("bhk_config", "3 bed") == {"bhk_config": "3 BHK"}
    assert F.extract("unit_floor", "407 on 4th floor") == {"unit_number": "407", "floor_number": "4th"}
    assert F.extract("unit_floor", "second floor and third unit") == {"unit_number": "3", "floor_number": "2nd"}
    assert F.extract("unit_floor", "third unit second floor") == {"unit_number": "3", "floor_number": "2nd"}
    assert F.extract("unit_floor", "unit 3 and second floor") == {"unit_number": "3", "floor_number": "2nd"}
    assert F.extract("unit_floor", "3rd unit on 2nd floor") == {"unit_number": "3", "floor_number": "2nd"}
    assert F.extract("unit_floor", "flat 302 on 4th floor") == {"unit_number": "302", "floor_number": "4th"}

def test_fastpath_defers_to_llm():
    assert F.extract("furnishing", "furnished nahi hai") is None or F.extract("furnishing", "furnished nahi hai") == {"furnishing_status": "unfurnished"}
    assert F.extract("sale_price", "50 lakh se kam nahi dunga") is None
    assert F.extract("sale_price", "50 lakh se kam nahi dunga", allow_bare=False) is None
    assert F.extract("sale_price", "1 crore 20 lakh") is None
    assert F.extract("approx_area", "area pata nahi but 3 BHK hai") is None
    assert F.extract("approx_area", "2 bigha") is None
    assert F.extract("unit_floor", "flat 12 floor 3 but broker nahi chahiye") is None
    assert F.extract("bhk_config", "3 BHK hai lekin price kya milega") is None

def test_fastpath_no_bare_cross_field():
    assert F.extract("sale_price", "407", allow_bare=False) is None
    assert F.extract("monthly_rent", "1200", allow_bare=False) is None
    assert F.extract("bhk_config", "3", allow_bare=False) is None

# ---- 4. IVR long-turn: a long turn containing a question is a human, not a menu ---------------------
def test_ivr_long_turn_question_guard():
    assert A._ivr_long_turn_counts("press one for sales press two for support please stay on the line for the next available agent in the queue thank you for calling our office today we value your time")
    assert not A._ivr_long_turn_counts("this property was bought by my father long ago and now there is a dispute with the relatives about the registry so can you tell me what exactly is the process you follow?")


# ---- 5. AI / automotive disclosure: exact wording, mirrors the caller's word -------------------------
def test_ai_disclosure_wording_en():
    auto = "Yes, it is an automotive call and I'm an AI agent calling on behalf of My Estate Finder."
    ai = "Yes, I'm an AI agent calling on behalf of My Estate Finder."
    assert A.ai_disclosure_reply("Is this an automotive call?", "en") == auto
    assert A.ai_disclosure_reply("is this an automotive call", "en") == auto
    assert A.ai_disclosure_reply("Are you an AI agent?", "en") == ai
    assert A.ai_disclosure_reply("Are you a robot?", "en") == ai
    assert A.ai_disclosure_reply("Is this an automated call?", "en").startswith("Yes, it is an automated call")

def test_ai_disclosure_wording_hi():
    assert "automotive call hai" in A.ai_disclosure_reply("ye automotive call hai kya", "hi")
    assert "AI agent" in A.ai_disclosure_reply("kya aap ai ho", "hi")

def test_ai_questions_are_detected():
    for q in ["Is this an automotive call?", "Are you an AI agent?", "Are you an AI Agent", "is this an automated call",
              "are you a robot", "ye automotive call hai"]:
        assert A._asks_if_ai_or_automated(q), q
    for q in ["3 BHK", "nahi bechna", "price kitna milega"]:
        assert not A._asks_if_ai_or_automated(q), q