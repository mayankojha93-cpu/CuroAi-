import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent
ROOT_DIR = AGENT_DIR.parent

for p in (str(AGENT_DIR), str(ROOT_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from livekit.agents import cli
from real_estate.worker import server

if __name__ == "__main__":
    cli.run_app(server)

