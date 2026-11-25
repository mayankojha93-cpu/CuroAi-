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

# ---- 6. Regression tests for the fixes ---------------------------------------------------------------
def test_refusing_brokers_is_not_refusing_the_call():
    for t in ["broker nahi chahiye", "flat 12 floor 3 but broker nahi chahiye", "no brokers please", "dalal nahi chahiye"]:
        assert not T.explicit_refusal(t), t
        assert not A._DIRECT_NOT_INTERESTED.search(t), t
    # a real refusal that also mentions brokers is still a refusal
    assert T.explicit_refusal("not interested, no brokers")
    assert T.explicit_refusal("nahi bechna, broker nahi chahiye")

def test_polite_not_at_all_is_not_a_refusal():
    assert not T.explicit_refusal("not at all")
    assert not T.explicit_refusal("not at all, go ahead")
    assert T.explicit_refusal("not at all interested")

def test_not_planning_right_now_is_soft():
    for t in ["not planning right now", "not selling at the moment", "not looking to sell right now", "not planning currently"]:
        assert not T.explicit_refusal(t), ("must not close the call", t)
        assert A._is_soft_refusal(t), ("must be offered a callback", t)
    # hard versions stay hard
    for t in ["not planning", "not selling", "not interested right now"]:
        assert T.explicit_refusal(t), t

def test_machine_announcements_with_human_words_are_caught():
    machine = [
        "The subscriber you are calling is not available, please try again later",
        "the number you have dialed is switched off",
        "jis vyakti se aap baat karna chahte hain woh abhi available nahi hai kripya baad mein try karein",
        "Please leave a message after the beep",
    ]
    for t in machine:
        assert A._MACHINE_ANNOUNCE_RE.search(t) or A._STRONG_VM_RE.search(t), t

def test_humans_are_not_flagged_as_voicemail():
    human = ["mera phone switched off tha isliye call nahi uthaya", "leave a message with my son", "please try later sir, I am busy",
             "my phone was not reachable yesterday", "main later baat karta hoon"]
    for t in human:
        assert not A._STRONG_VM_RE.search(t), ("strong-vm", t)
        assert not A._MACHINE_ANNOUNCE_RE.search(t), ("machine-announce", t)

# ---- 7. Silence policy -------------------------------------------------------------------------------
from .state import SilenceGuard

def _tick(g, now, **kw):
    base = dict(bot_speaking=False, hold_until=0.0, caller_activity_at=0.0, agent_speech_end_at=0.0, answered_at=0.0)
    base.update(kw)
    return g.tick(now, **base)

def test_silence_counter_resets_when_caller_answers():
    g = SilenceGuard(8, 3)
    assert _tick(g, 10) == "prompt" and g.prompts == 1
    assert _tick(g, 20) == "prompt" and g.prompts == 2
    # caller speaks at t=22 -> counter must restart, so 3 more pauses do NOT hang up
    assert _tick(g, 31, caller_activity_at=22) == "prompt" and g.prompts == 1
    assert _tick(g, 40, caller_activity_at=22) == "prompt" and g.prompts == 2
    assert _tick(g, 49, caller_activity_at=22) == "prompt" and g.prompts == 3

def test_silence_hangs_up_after_unanswered_prompts():
    g = SilenceGuard(8, 3)
    out = [_tick(g, t) for t in (10, 20, 30, 40)]
    assert out == ["prompt", "prompt", "prompt", "hangup"]

def test_silence_quiet_while_someone_is_busy():
    g = SilenceGuard(8, 3)
    assert _tick(g, 50, bot_speaking=True) is None
    assert _tick(g, 50, user_speaking=True, caller_activity_at=45) is None      # long caller answer
    assert _tick(g, 50, hold_until=90) is None                                  # "ek minute"
    assert _tick(g, 50, llm_busy_since=45) is None                              # LLM still generating
    assert _tick(g, 70, llm_busy_since=45) == "prompt"                          # ...but a hung LLM is capped
    assert _tick(SilenceGuard(8, 3), 100, user_speaking=True, caller_activity_at=10) == "prompt"  # stale flag ignored

# ---- 8. TurnGate must keep recognising NEW caller turns after the context is trimmed ------------------
class _Ctx:
    def __init__(self, msgs): self.msgs = msgs
    def get_messages(self): return list(self.msgs)
    def set_messages(self, m): self.msgs = list(m)

def test_turn_counter_survives_context_trim():
    try:
        import pytest
        pytest.importorskip("pipecat")
    except ImportError:
        pass
    from . import pipecat_adapter as PA
    gate = PA.TurnGate.__new__(PA.TurnGate)
    gate._seen_user_msgs = 0
    gate._dropped_users = 0
    gate.context = _Ctx([{"role": "system", "content": "s"}])
    PA.CHAT_CTX_MAX_ITEMS = 8
    new_turns = 0
    for i in range(30):
        gate.context.msgs.append({"role": "user", "content": f"u{i}"})
        msgs = gate.context.get_messages()
        n_user = gate._count_users(msgs) + gate._dropped_users
        if n_user > gate._seen_user_msgs:       # exact check TurnGate.process_frame performs
            gate._seen_user_msgs = n_user
            new_turns += 1
        gate._trim_context()
        gate.context.msgs.append({"role": "assistant", "content": "a"})
        gate.context.msgs.append({"role": "assistant", "content": "tool-call"})
        gate.context.msgs.append({"role": "tool", "content": "r"})
    assert new_turns == 30