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

# Agent and Model Configs
AGENT_NAME = os.getenv("AGENT_NAME", "telecom-router-pickup-agent")
LLM_MODEL = os.getenv("LLM_MODEL", "llama-3.1-8b-instant")
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

# Backend & Integration Configs
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000")
INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "dev-secret-key-12345")
