FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

# ffmpeg is needed for WAV -> MP3 call recordings
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-load the Silero VAD model so the first call does not pay for it
RUN python -c "from pipecat.audio.vad.silero import SileroVADAnalyzer; SileroVADAnalyzer()"

COPY . .

EXPOSE 8088
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fs http://localhost:8088/health || exit 1

# The Exotel <-> Pipecat bridge (index.ts proxies /api/exotel/media-stream to this port).
# The old `python agent.py start` started a LiveKit worker that no longer exists: agent.py is now a library module.
CMD ["python", "agent_real_estate.py"]