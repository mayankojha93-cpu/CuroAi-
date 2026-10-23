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

# Agent Config
AGENT_NAME = os.getenv("AGENT_NAME", "telecom-router-pickup-agent")

# LLM — OpenRouter (meta-llama/llama-3.3-70b-instruct)
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "meta-llama/llama-3.3-70b-instruct")

# Speech — Sarvam AI (STT + TTS)
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY")


DIRECT_SPEAK = os.getenv("DIRECT_SPEAK", "1") == "1"
OPENROUTER_PROVIDER_SORT = os.getenv("OPENROUTER_PROVIDER_SORT", "latency").strip()
PREEMPTIVE_GENERATION = os.getenv("PREEMPTIVE_GENERATION", "1") == "1"
def _opt_float(name):
    v = os.getenv(name, "").strip()
    try:
        return float(v) if v else None
    except ValueError:
        return None
ENDPOINT_MIN_DELAY = _opt_float("ENDPOINT_MIN_DELAY")
ENDPOINT_MAX_DELAY = _opt_float("ENDPOINT_MAX_DELAY")

# Backend & Integration Configs
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000")
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "dev-secret-key-12345")
