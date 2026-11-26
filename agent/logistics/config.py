import os
import sys
import logging
from pathlib import Path
from dotenv import load_dotenv

LOGISTICS_DIR = Path(__file__).resolve().parent
AGENT_DIR = LOGISTICS_DIR.parent
ROOT_DIR = AGENT_DIR.parent

for p in (str(AGENT_DIR), str(LOGISTICS_DIR), str(ROOT_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

load_dotenv(AGENT_DIR / ".env")
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("logistics-agent")

for _name in ("pipecat", "pipecat.services.sarvam", "pipecat.services.soniox", "pipecat.audio.vad.silero"):
    logging.getLogger(_name).setLevel(logging.INFO)

# LLM Configuration (default: OpenRouter google/gemini-2.5-flash-lite)
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
LLM_MODEL = os.getenv("LOGISTICS_LLM_MODEL", os.getenv("LLM_MODEL", "google/gemini-2.5-flash-lite"))
LLM_PROVIDER = os.getenv("LOGISTICS_LLM_PROVIDER", "openrouter").strip().lower() or "openrouter"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
LLM_FALLBACK = os.getenv("LLM_FALLBACK", "1") == "1"
LLM_MAX_TOKENS = int(os.getenv("LOGISTICS_LLM_MAX_TOKENS", "180"))
OPENROUTER_PROVIDER_ORDER = [
    p.strip() for p in os.getenv("OPENROUTER_PROVIDER_ORDER", "").split(",") if p.strip()
]
OPENROUTER_PROVIDER_SORT = os.getenv("OPENROUTER_PROVIDER_SORT", "latency").strip()

# STT Configuration (Soniox)
SONIOX_API_KEY = os.getenv("SONIOX_API_KEY", "")
SONIOX_MODEL = os.getenv("SONIOX_MODEL", "stt-rt-v5")
STT_LANGUAGE = os.getenv("LOGISTICS_STT_LANGUAGE", "hi,en").strip() or "hi,en"

# TTS Configuration (Sarvam AI)
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY", "")
TTS_MODEL = os.getenv("LOGISTICS_TTS_MODEL", "bulbul:v4-flash")
TTS_SPEAKER = os.getenv("LOGISTICS_TTS_SPEAKER", os.getenv("REAL_ESTATE_TTS_SPEAKER", "kavitha_te_conversation"))
TTS_PACE = float(os.getenv("LOGISTICS_TTS_PACE", "0.96"))
TTS_TEMPERATURE = float(os.getenv("LOGISTICS_TTS_TEMPERATURE", "0.65"))
TTS_SAMPLE_RATE = int(os.getenv("LOGISTICS_TTS_SAMPLE_RATE", "16000"))

# Audio / VAD / Turn timing
PIPELINE_IN_SAMPLE_RATE = int(os.getenv("PIPELINE_IN_SAMPLE_RATE", "16000"))
PIPELINE_OUT_SAMPLE_RATE = int(os.getenv("PIPELINE_OUT_SAMPLE_RATE", "16000"))
VAD_CONFIDENCE = float(os.getenv("VAD_CONFIDENCE", "0.7"))
VAD_MIN_SILENCE = float(os.getenv("VAD_MIN_SILENCE", "0.45"))
USER_SPEECH_TIMEOUT = float(os.getenv("USER_SPEECH_TIMEOUT", "0.4"))

# Call duration & silence rules from Mittal Pigments spec
MAX_CALL_SECONDS = int(os.getenv("LOGISTICS_MAX_CALL_SECONDS", "150"))  # 2.5 minutes
MAX_CALL_EXTENSION_SECONDS = int(os.getenv("LOGISTICS_MAX_CALL_EXTENSION_SECONDS", "60"))  # for emergencies
SILENCE_PROMPT_SECONDS = float(os.getenv("LOGISTICS_SILENCE_SECONDS", "8.0"))
MAX_SILENCE_PROMPTS = int(os.getenv("LOGISTICS_MAX_SILENCE_PROMPTS", "2"))

# Backend integration
BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:3000").rstrip("/")
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "")
RECORD_CALLS = os.getenv("RECORD_CALLS", "1") == "1"
