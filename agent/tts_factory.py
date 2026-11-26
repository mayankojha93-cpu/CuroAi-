"""Shared TTS factory supporting Sarvam AI (default), ElevenLabs, Smallest AI, Soniox, and Indic Tiny TTS."""

import logging
import os
from typing import Any, AsyncGenerator, Dict, Optional

import aiohttp

from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
from pipecat.services.sarvam.tts import SarvamHttpTTSService
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.tracing.service_decorators import traced_tts

logger = logging.getLogger("tts-factory")

SUPPORTED_TTS_PROVIDERS = ("sarvam", "elevenlabs", "smallest", "soniox", "indic_tiny")


class IndicTinyTTSService(TTSService):
    """Pipecat TTSService backed by the self-hosted Indic Tiny TTS FastAPI service (Hindi & English)."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        aiohttp_session: aiohttp.ClientSession,
        voice: str = "female",
        language: str = "hi-IN",
        sample_rate: int = 8000,
        **kwargs,
    ):
        super().__init__(
            sample_rate=sample_rate,
            settings=TTSSettings(voice=voice, language=language),
            **kwargs,
        )
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._session = aiohttp_session

    def language_to_service_language(self, language: Language) -> Optional[str]:
        if language in (Language.HI, Language.HI_IN):
            return "hi-IN"
        if language in (Language.EN, Language.EN_IN, Language.EN_US, Language.EN_GB):
            return "en-IN"
        return str(language)

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        try:
            lang = self._settings.language or "hi-IN"
            # Route Devanagari text to the Hindi model even if the active setting is English.
            if any("\u0900" <= ch <= "\u097f" for ch in text):
                lang = "hi-IN"
            voice = self._settings.voice or "female"

            payload = {
                "text": text,
                "language": "en-IN" if str(lang).startswith("en") else "hi-IN",
                "voice": "male" if str(voice).lower() == "male" else "female",
                "sample_rate": self.sample_rate or 8000,
                "format": "pcm",
            }
            headers = {
                "X-API-Key": self._api_key,
                "Content-Type": "application/json",
            }

            async with self._session.post(f"{self._base_url}/tts", json=payload, headers=headers) as resp:
                if resp.status != 200:
                    err = await resp.text()
                    yield ErrorFrame(error=f"Indic Tiny TTS error ({resp.status}): {err}")
                    return
                audio_data = await resp.read()

            await self.start_tts_usage_metrics(text)
            if not audio_data:
                yield ErrorFrame(error="Indic Tiny TTS returned empty audio")
                return

            yield TTSAudioRawFrame(
                audio=audio_data,
                sample_rate=self.sample_rate or 8000,
                num_channels=1,
                context_id=context_id,
            )
        except Exception as e:
            yield ErrorFrame(error=f"Error generating Indic Tiny TTS: {e}", exception=e)
        finally:
            await self.stop_ttfb_metrics()


def normalize_tts_provider(raw: Optional[str]) -> str:
    """Normalize a TTS provider name or voice pipeline label into a canonical provider key."""
    val = (raw or "").strip().lower()
    if not val:
        return "sarvam"
    if "indic" in val:
        return "indic_tiny"
    if "eleven" in val:
        return "elevenlabs"
    if "smallest" in val:
        return "smallest"
    if "soniox" in val:
        return "soniox"
    if "sarvam" in val or "curoai" in val:
        return "sarvam"
    return "sarvam"


def extract_tts_provider(metadata: Optional[Dict[str, Any]] = None) -> str:
    """Extract the canonical TTS provider from call metadata, defaulting to 'sarvam'."""
    meta = metadata or {}
    call_obj = meta.get("call") if isinstance(meta.get("call"), dict) else {}
    raw = (
        meta.get("ttsProvider")
        or meta.get("tts_provider")
        or call_obj.get("tts_provider")
        or meta.get("voicePipeline")
        or meta.get("voice_pipeline")
        or call_obj.get("voice_pipeline")
        or os.getenv("DEFAULT_TTS_PROVIDER", "sarvam")
    )
    return normalize_tts_provider(str(raw) if raw else None)


def build_language_update_frame(provider: str, lang: str, voice_en: str = "", voice_hi: str = ""):
    """Build a provider-appropriate TTSUpdateSettingsFrame delta for switching between English and Hindi/Hinglish."""
    from pipecat.frames.frames import TTSUpdateSettingsFrame

    canon = normalize_tts_provider(provider)
    is_hi = lang == "hi"
    if canon == "sarvam":
        return TTSUpdateSettingsFrame(
            delta=SarvamHttpTTSService.Settings(
                voice=voice_hi if is_hi else voice_en,
                language=Language.HI_IN if is_hi else Language.EN_IN,
            )
        )
    if canon == "smallest":
        from pipecat.services.smallest.tts import SmallestTTSService

        return TTSUpdateSettingsFrame(
            delta=SmallestTTSService.Settings(
                language=Language.HI if is_hi else Language.EN,
            )
        )
    if canon == "soniox":
        from pipecat.services.soniox.tts import SonioxTTSService

        return TTSUpdateSettingsFrame(
            delta=SonioxTTSService.Settings(
                language="hi" if is_hi else "en",
            )
        )
    if canon == "indic_tiny":
        return TTSUpdateSettingsFrame(
            delta=TTSSettings(
                language=Language.HI_IN if is_hi else Language.EN_IN,
            )
        )
    # ElevenLabs multilingual_v2 handles English/Hindi/Hinglish automatically from text
    return None


def _build_sarvam_tts(
    session: aiohttp.ClientSession,
    *,
    lang: str = "en",
    speaker_en: Optional[str] = None,
    speaker_hi: Optional[str] = None,
    model: Optional[str] = None,
    sample_rate: int = 16000,
    pace: float = 1.08,
    temperature: float = 0.6,
) -> SarvamHttpTTSService:
    is_hi = lang == "hi"
    sp_en = speaker_en or os.getenv("REAL_ESTATE_TTS_SPEAKER") or os.getenv("TTS_SPEAKER") or "kavitha"
    sp_hi = speaker_hi or os.getenv("REAL_ESTATE_TTS_SPEAKER") or os.getenv("TTS_SPEAKER") or "kavitha"
    tts_model = model or os.getenv("REAL_ESTATE_TTS_MODEL") or os.getenv("TTS_MODEL") or "bulbul:v3"
    settings_kwargs: Dict[str, Any] = {
        "model": tts_model,
        "voice": sp_hi if is_hi else sp_en,
        "language": Language.HI_IN if is_hi else Language.EN_IN,
        "pace": pace,
    }
    if "v3" in tts_model:
        settings_kwargs["temperature"] = temperature
    return SarvamHttpTTSService(
        api_key=os.getenv("SARVAM_API_KEY", ""),
        aiohttp_session=session,
        sample_rate=sample_rate,
        settings=SarvamHttpTTSService.Settings(**settings_kwargs),
    )


def build_tts_service(
    provider: Optional[str],
    session: aiohttp.ClientSession,
    *,
    lang: str = "en",
    speaker_en: Optional[str] = None,
    speaker_hi: Optional[str] = None,
    model: Optional[str] = None,
    sample_rate: int = 16000,
    pace: float = 1.08,
    temperature: float = 0.6,
) -> TTSService:
    """Build a Pipecat TTSService for the requested provider, falling back to Sarvam AI if unconfigured."""
    canon = normalize_tts_provider(provider)
    logger.info(f"🔊 Initializing TTS provider: {canon} (lang={lang})")

    if canon == "elevenlabs":
        api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
        if not api_key:
            logger.warning("⚠️ ELEVENLABS_API_KEY not set -> falling back to Sarvam AI TTS")
        else:
            from pipecat.services.elevenlabs.tts import ElevenLabsHttpTTSService

            voice_id = os.getenv("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")
            el_model = os.getenv("ELEVENLABS_MODEL", "eleven_multilingual_v2")
            return ElevenLabsHttpTTSService(
                api_key=api_key,
                voice_id=voice_id,
                aiohttp_session=session,
                model=el_model,
                sample_rate=sample_rate,
            )

    elif canon == "smallest":
        api_key = os.getenv("SMALLEST_API_KEY", "").strip()
        if not api_key:
            logger.warning("⚠️ SMALLEST_API_KEY not set -> falling back to Sarvam AI TTS")
        else:
            from pipecat.services.smallest.tts import SmallestTTSService

            voice_id = os.getenv("SMALLEST_VOICE_ID", "rhea")
            sm_model = os.getenv("SMALLEST_MODEL", "lightning_v3.1_pro")
            return SmallestTTSService(
                api_key=api_key,
                sample_rate=sample_rate,
                settings=SmallestTTSService.Settings(
                    model=sm_model,
                    voice=voice_id,
                    language=Language.HI if lang == "hi" else Language.EN,
                ),
            )

    elif canon == "soniox":
        api_key = os.getenv("SONIOX_API_KEY", "").strip()
        if not api_key:
            logger.warning("⚠️ SONIOX_API_KEY not set -> falling back to Sarvam AI TTS")
        else:
            from pipecat.services.soniox.tts import SonioxTTSService

            sx_model = os.getenv("SONIOX_TTS_MODEL", "tts-rt-v2")
            sx_voice = os.getenv("SONIOX_TTS_VOICE", "Bryce")
            return SonioxTTSService(
                api_key=api_key,
                sample_rate=sample_rate,
                settings=SonioxTTSService.Settings(
                    model=sx_model,
                    voice=sx_voice,
                    language="hi" if lang == "hi" else "en",
                ),
            )

    elif canon == "indic_tiny":
        base_url = os.getenv("INDIC_TINY_TTS_URL", "http://127.0.0.1:8010").strip()
        api_key = os.getenv("INDIC_TINY_TTS_API_KEY", "").strip()
        if not api_key:
            logger.warning("⚠️ INDIC_TINY_TTS_API_KEY not set -> falling back to Sarvam AI TTS")
        else:
            voice = os.getenv("INDIC_TINY_TTS_VOICE", "female").strip() or "female"
            return IndicTinyTTSService(
                base_url=base_url,
                api_key=api_key,
                aiohttp_session=session,
                voice=voice,
                language="hi-IN" if lang == "hi" else "en-IN",
                sample_rate=sample_rate,
            )

    return _build_sarvam_tts(
        session,
        lang=lang,
        speaker_en=speaker_en,
        speaker_hi=speaker_hi,
        model=model,
        sample_rate=sample_rate,
        pace=pace,
        temperature=temperature,
    )
