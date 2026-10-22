FROM python:3.11-slim

WORKDIR /app

# Install system audio and build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ffmpeg \
    libasound2-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download models and plugin weights
RUN python -c "
from livekit.plugins import silero, sarvam, groq
silero.VAD.load()
"

# Copy application source code
COPY . .

# Run the LiveKit agent worker in production mode
CMD ["python", "agent.py", "start"]
