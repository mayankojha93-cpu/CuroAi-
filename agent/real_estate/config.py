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

# Agent Name registered on LiveKit Server
AGENT_NAME = os.getenv("REAL_ESTATE_AGENT_NAME", "my-estate-finder-agent")

# LLM Configuration
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "meta-llama/llama-3.3-70b-instruct")

# Speech Configuration (Sarvam AI)
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY")
STT_LANGUAGE = os.getenv("STT_LANGUAGE", "hi-IN").strip() or "hi-IN"
TTS_LANGUAGE_HI = os.getenv("TTS_LANGUAGE_HI", "hi-IN")
TTS_LANGUAGE_EN = os.getenv("TTS_LANGUAGE_EN", "en-IN")
# Aditya is a natural male Indian voice in Sarvam bulbul:v3 suited for "Sagar"
TTS_SPEAKER = os.getenv("REAL_ESTATE_TTS_SPEAKER", "aditya")

OPENROUTER_PROVIDER_SORT = os.getenv("OPENROUTER_PROVIDER_SORT", "latency").strip()
PREEMPTIVE_GENERATION = os.getenv("PREEMPTIVE_GENERATION", "1") == "1"

def _opt_float(name: str):
    v = os.getenv(name, "").strip()
    try:
        return float(v) if v else None
    except ValueError:
        return None

ENDPOINT_MIN_DELAY = _opt_float("ENDPOINT_MIN_DELAY")
ENDPOINT_MAX_DELAY = _opt_float("ENDPOINT_MAX_DELAY")

# Backend & Secret
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000")
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "dev-secret-key-12345")

