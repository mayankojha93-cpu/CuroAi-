import os
import sys
import logging
from pathlib import Path
from dotenv import load_dotenv

# Resolve project paths
SRC_DIR = Path(__file__).resolve().parent
AGENT_DIR = SRC_DIR.parent
ROOT_DIR = AGENT_DIR.parent

# Ensure both AGENT_DIR and ROOT_DIR are in sys.path
for p in (str(AGENT_DIR), str(SRC_DIR), str(ROOT_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

# Load environment configuration
load_dotenv(AGENT_DIR / ".env")
load_dotenv(ROOT_DIR / ".env")

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("telecom-voice-agent")

# Suppress noisy internal Pipecat debug spam so conversation logs stand out cleanly
for _name in ("pipecat", "pipecat.services.sarvam", "pipecat.services.soniox", "pipecat.audio.vad.silero"):
    logging.getLogger(_name).setLevel(logging.INFO)

# Agent Config
AGENT_NAME = os.getenv("AGENT_NAME", "telecom-router-pickup-agent")
PERSONA_NAME = os.getenv("PERSONA_NAME", "Kavitha")

# LLM — OpenRouter / Groq
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "google/gemini-2.5-flash-lite")

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "auto").strip().lower() or "auto"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
LLM_FALLBACK = os.getenv("LLM_FALLBACK", "1") == "1"
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "300"))

OPENROUTER_PROVIDER_SORT = os.getenv("OPENROUTER_PROVIDER_SORT", "latency").strip()
_prov_raw = os.getenv("OPENROUTER_PROVIDER_ORDER", "Groq,Cerebras,Together,DeepInfra")
OPENROUTER_PROVIDER_ORDER = [] if _prov_raw.strip().lower() == "none" else [p.strip() for p in _prov_raw.split(",") if p.strip()]

PREEMPTIVE_GENERATION = os.getenv("PREEMPTIVE_GENERATION", "1") == "1"
DIRECT_SPEAK = os.getenv("DIRECT_SPEAK", "1") == "1"
CHAT_CTX_MAX_ITEMS = int(os.getenv("CHAT_CTX_MAX_ITEMS", "16"))

# Speech-to-Text (STT) — Soniox
SONIOX_API_KEY = os.getenv("SONIOX_API_KEY")
SONIOX_MODEL = os.getenv("SONIOX_MODEL", "stt-rt-v5")
# STT: default hi,en for Hindi + English (Hinglish) conversations
STT_LANGUAGE = os.getenv("STT_LANGUAGE", "hi,en").strip() or "hi,en"

# Text-to-Speech (TTS) — Sarvam AI
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY")
TTS_LANGUAGE_HI = os.getenv("TTS_LANGUAGE_HI", "hi-IN")
TTS_LANGUAGE_EN = os.getenv("TTS_LANGUAGE_EN", "en-IN")
TTS_MODEL = os.getenv("TTS_MODEL", "bulbul:v4-flash")
TTS_SPEAKER = os.getenv("TTS_SPEAKER", "kavitha_te_conversation")
TTS_SPEAKER_HI = os.getenv("TTS_SPEAKER_HI", TTS_SPEAKER)
TTS_SPEAKER_EN = os.getenv("TTS_SPEAKER_EN", TTS_SPEAKER)
TTS_PACE = float(os.getenv("TTS_PACE", "1.0"))
TTS_TEMPERATURE = float(os.getenv("TTS_TEMPERATURE", "0.65"))

def _opt_float(name):
    v = os.getenv(name, "").strip()
    try:
        return float(v) if v else None
    except ValueError:
        return None

ENDPOINT_MIN_DELAY = _opt_float("ENDPOINT_MIN_DELAY") if _opt_float("ENDPOINT_MIN_DELAY") is not None else 0.10
ENDPOINT_MAX_DELAY = _opt_float("ENDPOINT_MAX_DELAY") if _opt_float("ENDPOINT_MAX_DELAY") is not None else 1.0

# ── Pipecat / telephony runtime ───────────────────────────────────────────────
PIPELINE_IN_SAMPLE_RATE = int(os.getenv("PIPELINE_IN_SAMPLE_RATE", "16000"))
PIPELINE_OUT_SAMPLE_RATE = int(os.getenv("PIPELINE_OUT_SAMPLE_RATE", "8000"))
TTS_SAMPLE_RATE = int(os.getenv("TTS_SAMPLE_RATE", str(PIPELINE_OUT_SAMPLE_RATE)))

VAD_MIN_SILENCE = float(os.getenv("VAD_MIN_SILENCE", "0.45"))
USER_SPEECH_TIMEOUT = float(os.getenv("USER_SPEECH_TIMEOUT", "0.6"))

MAX_CALL_SECONDS = int(os.getenv("MAX_CALL_SECONDS", "300"))
SILENCE_PROMPT_SECONDS = float(os.getenv("SILENCE_PROMPT_SECONDS", "8"))
MAX_SILENCE_PROMPTS = int(os.getenv("MAX_SILENCE_PROMPTS", "3"))
RECORD_CALLS = os.getenv("RECORD_CALLS", "1") == "1"

# Backend & Integration Configs
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000")
_INTERNAL_SECRET_ENV = os.getenv("INTERNAL_SECRET", "").strip()
if not _INTERNAL_SECRET_ENV:
    # The old code defaulted the value first, so its "not set" warning could never fire.
    logger.warning("INTERNAL_SECRET is not set; falling back to the insecure dev default. Set it in production.")
INTERNAL_SECRET = _INTERNAL_SECRET_ENV or "dev-secret-key-12345"

# ── Deterministic turn handling (regex layer in front of the LLM) ─────────────
# Plain yes/no answers are acted on by code, without an LLM round-trip (set to 0 to send everything to the LLM).
FASTPATH_ENABLED = os.getenv("FASTPATH_ENABLED", "1") == "1"
# A WEAK carrier pattern (one a real customer could also say) only counts on utterances at least this long.
CARRIER_WEAK_MIN_WORDS = int(os.getenv("CARRIER_WEAK_MIN_WORDS", "7"))
# After a "your call is on hold" announcement, stay silent this long before the silence watchdog speaks.
HOLD_WAIT_SECONDS = float(os.getenv("HOLD_WAIT_SECONDS", "30"))

# ENABLE_HUMAN_REGEX_SHORTCUTS=0 : keep regex strictly for IVR/voicemail/carrier detection and compliance (DND, bot disclosure).
# All human conversational turns proceed to the LLM (google/gemini-2.5-flash-lite) to understand natural speech without rigid regex intercepts.
ENABLE_HUMAN_REGEX_SHORTCUTS = os.getenv("ENABLE_HUMAN_REGEX_SHORTCUTS", "0") == "1"