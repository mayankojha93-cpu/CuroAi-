import os
import sys
import logging
from pathlib import Path
from dotenv import load_dotenv

# Resolve project paths
RE_DIR = Path(__file__).resolve().parent
AGENT_DIR = RE_DIR.parent
ROOT_DIR = AGENT_DIR.parent

for p in (str(AGENT_DIR), str(RE_DIR), str(ROOT_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

# Load environment configuration
load_dotenv(AGENT_DIR / ".env")
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("real-estate-agent")

# Suppress noisy internal LiveKit/Sarvam debug spam so conversation logs stand out cleanly
for _name in ("livekit.plugins.silero", "livekit.agents", "livekit"):
    logging.getLogger(_name).setLevel(logging.INFO)
# The Sarvam plugin sets DEBUG on its own child loggers (".log", ".log.SpeechStream"), so the parent
# level alone is ignored and every 100 audio chunks / VAD event is printed 3x. Silence them explicitly.
for _name in ("livekit.plugins.sarvam", "livekit.plugins.sarvam.log", "livekit.plugins.sarvam.log.SpeechStream"):
    logging.getLogger(_name).setLevel(logging.WARNING)

# Agent Name registered on LiveKit Server
AGENT_NAME = os.getenv("REAL_ESTATE_AGENT_NAME", "my-estate-finder-agent")

# LLM Configuration
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "meta-llama/llama-3.3-70b-instruct")

# Speech Configuration (Sarvam AI)
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY")

# STT: default hi-IN for Hindi + English (Hinglish) conversations
STT_LANGUAGE = os.getenv("RE_STT_LANGUAGE", os.getenv("STT_LANGUAGE", "hi-IN")).strip() or "hi-IN"
# STT mode: "codemix" is best for Hinglish (mixes Hindi/English words naturally),
# "transcribe" for pure Hindi, "translit" for romanized output.
# "codemix" on saaras:v4 significantly reduces garbling of English domain words like
# "residential", "semi-furnished", "available" in a Hindi sentence.
STT_MODE = os.getenv("RE_STT_MODE", "codemix").strip() or "codemix"

TTS_LANGUAGE_HI = os.getenv("TTS_LANGUAGE_HI", "hi-IN")
TTS_LANGUAGE_EN = os.getenv("TTS_LANGUAGE_EN", "en-IN")

# TTS Model & Speaker
# Using bulbul:v3 with speaker 'priya' (verified 100% Indian female voice, same as 1st pipeline)
# In bulbul:v3, 'priya' and 'simran' natively speak both Hindi ('hi-IN') and English ('en-IN')
TTS_MODEL      = os.getenv("REAL_ESTATE_TTS_MODEL",      "bulbul:v3")
TTS_SPEAKER    = os.getenv("REAL_ESTATE_TTS_SPEAKER",    "priya")
TTS_SPEAKER_HI = os.getenv("REAL_ESTATE_TTS_SPEAKER_HI", TTS_SPEAKER)
TTS_SPEAKER_EN = os.getenv("REAL_ESTATE_TTS_SPEAKER_EN", TTS_SPEAKER)

DEFAULT_LANGUAGE = os.getenv("REAL_ESTATE_DEFAULT_LANGUAGE", "en")

# TTS Delivery Dynamics
# 1.0 sounded a bit slow/flat; 1.1 rushed like an IVR. 1.05 = relaxed but not sluggish. Tune with REAL_ESTATE_TTS_PACE.
TTS_PACE = float(os.getenv("REAL_ESTATE_TTS_PACE", "1.05"))
# slightly higher = more natural variation in intonation (less monotone / robotic)
TTS_TEMPERATURE = float(os.getenv("REAL_ESTATE_TTS_TEMPERATURE", "0.8"))

# ── LLM provider ──────────────────────────────────────────────────────────────
# LLM TTFT is the biggest part of a turn. OpenRouter adds a routing hop and its TTFT swings 0.7-2.4s.
# Groq's own endpoint serves the same llama-3.3-70b with ~0.2-0.5s TTFT.
#   LLM_PROVIDER = auto (default: groq when GROQ_API_KEY is set, else openrouter) | groq | openrouter
#   LLM_FALLBACK = 1 : if Groq errors / times out (it sometimes rejects a tool call with HTTP 400), the same
#                      request is retried on OpenRouter automatically, so a call never goes silent.
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "auto").strip().lower() or "auto"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
LLM_FALLBACK = os.getenv("LLM_FALLBACK", "1") == "1"
LLM_ATTEMPT_TIMEOUT = float(os.getenv("LLM_ATTEMPT_TIMEOUT", "4.0"))

# FASTPATH_ENABLED=1 : clean answers to the open intake question (BHK, area, furnishing, unit/floor, price,
#                      leased/vacant, occupancy, commercial type) are parsed with regex and the LLM call is
#                      skipped entirely (turn = EOU + TTS only). Anything unclear still goes to the LLM.
FASTPATH_ENABLED = os.getenv("FASTPATH_ENABLED", "1") == "1"
# PRERENDER_GREETING=1 : while the phone is still ringing the opening line is synthesised in advance and
#                        played from memory the moment the callee answers (no TTS wait on "Hello?").
#                        Costs one greeting's worth of TTS characters for calls that are never answered.
PRERENDER_GREETING = os.getenv("PRERENDER_GREETING", "1") == "1"
# PRERENDER_COMMON=1 : also pre-synthesise the fixed lines that need no LLM (other-property question, closings)
#                      while the phone rings, so they play with no TTS wait. Needs PRERENDER_GREETING-style TTS usage.
PRERENDER_COMMON = os.getenv("PRERENDER_COMMON", "1") == "1"

OPENROUTER_PROVIDER_SORT = os.getenv("OPENROUTER_PROVIDER_SORT", "latency").strip()
PREEMPTIVE_GENERATION = os.getenv("PREEMPTIVE_GENERATION", "1") == "1"

# ── Latency switches (all env-controllable so each change can be A/B tested / rolled back) ──
# FAST_TOOL_REPLY=1 : after a tool call, speak the canonical next question directly instead of
#                     making a 2nd LLM round trip just to read it out. Set 0 to restore old behaviour.
FAST_TOOL_REPLY = os.getenv("FAST_TOOL_REPLY", "1") == "1"
# LATENCY_LOG=1 : per-turn EOU / LLM TTFT / TTS TTFB breakdown in the logs.
LATENCY_LOG = os.getenv("LATENCY_LOG", "1") == "1"
# VAD silence needed to end a speech segment. Default = your current value (0.45).
# Try 0.30-0.35 only after reading the latency logs.
VAD_MIN_SILENCE = float(os.getenv("VAD_MIN_SILENCE", "0.35"))
# Optional OpenRouter provider pinning, e.g. OPENROUTER_PROVIDER_ORDER=Groq,Cerebras (allow_fallbacks stays
# True in worker.py). Default is OFF (OPENROUTER_PROVIDER_SORT as before): in a recent test log LLM TTFT was
# 1.6-2.4s vs 0.7-0.9s earlier, so pinning must be A/B tested against your own latency logs before enabling.
# "none" or empty = off.
_prov_raw = os.getenv("OPENROUTER_PROVIDER_ORDER", "")
OPENROUTER_PROVIDER_ORDER = [] if _prov_raw.strip().lower() == "none" else [p.strip() for p in _prov_raw.split(",") if p.strip()]
# Max chat-history items sent to the LLM per call (system instructions are always kept). Every step's
# instructions already carry the next missing field, so old turns add prompt tokens (-> TTFT) but no value.
# 0 disables trimming.
CHAT_CTX_MAX_ITEMS = int(os.getenv("CHAT_CTX_MAX_ITEMS", "16"))

def _opt_float(name: str):
    v = os.getenv(name, "").strip()
    try:
        return float(v) if v else None
    except ValueError:
        return None

ENDPOINT_MIN_DELAY = _opt_float("ENDPOINT_MIN_DELAY") if _opt_float("ENDPOINT_MIN_DELAY") is not None else 0.05  # VAD already waits VAD_MIN_SILENCE; an extra 0.15s on top was pure dead time
ENDPOINT_MAX_DELAY = _opt_float("ENDPOINT_MAX_DELAY") if _opt_float("ENDPOINT_MAX_DELAY") is not None else 0.45

# Max tokens the LLM may generate per reply. 120 was too low: a tool call with many parameters
# (save_property_details has 14) got CUT OFF mid-JSON and the caller heard nothing.
# Short spoken replies are unaffected (generation stops at end-of-sequence), so this costs no latency.
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "300"))
# Optional silero deactivation threshold (lower = VAD ends speech sooner on noisy phone lines).
# Leave unset unless the logs show END_SPEECH arriving >1s after the caller stopped talking.
VAD_DEACTIVATION = _opt_float("VAD_DEACTIVATION")

# Backend & Secret
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000")
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "")
if not INTERNAL_SECRET:
    logger.warning("INTERNAL_SECRET is not set; backend calls will be rejected.")