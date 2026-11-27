import asyncio
import inspect
import re
import time
import typing
from typing import Any, Callable, Dict, List, Optional

from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import FunctionCallParams

from .config import logger
from .prompts import build_system_prompt
from .state import LogisticsState

_TOOL_LEAK_RE = re.compile(r"<function=[^>]+>.*?(?:</function>|$)", re.S | re.I)


def clean_tts_text(text: str) -> str:
    cleaned = _TOOL_LEAK_RE.sub("", text or "")
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned


_WAIT_PATTERNS = (
    "रुको", "रुकिए", "एक मिनट", "एक सेकंड", "ठहरो", "ठहरिए", "होल्ड",
    "wait", "hold on", "one minute", "one second", "hang on", "ruk", "ek minute",
)
_CORRECTION_PATTERNS = (
    "नहीं नहीं", "गलत", "बदल", "सॉरी", "मेरा मतलब", "वो नहीं", "पहले वाला नहीं",
    "actually", "sorry", "wrong", "correction", "change that", "not that",
    "galat", "nahi nahi",
)
_QUESTION_WORDS = (
    "क्या", "कब", "कहाँ", "कहां", "कौन", "क्यों", "कितना", "कितने", "कैसे",
    "किस", "भाड़ा", "पैसा", "पेमेंट", "who", "what", "when", "where", "why", "how",
    "kya", "kab", "kahan", "kaun", "kyun", "kitna", "kaise", "bhada", "paisa",
)


def classify_barge_in_intent(text: str) -> str:
    """Classify a barge-in utterance into wait, correction, question, or info."""
    norm = (text or "").strip().lower()
    if not norm:
        return "info"
    if any(p in norm for p in _WAIT_PATTERNS):
        return "wait"
    if any(p in norm for p in _CORRECTION_PATTERNS):
        return "correction"
    if "?" in norm or "？" in norm or any(w in norm for w in _QUESTION_WORDS):
        return "question"
    return "info"


def extract_pending_question(text: str) -> str:
    """Extract the last question sentence from an assistant utterance, if any."""
    cleaned = (text or "").strip()
    if "?" not in cleaned and "？" not in cleaned:
        return ""
    parts = re.split(r"(?<=[?？।.!])\s+", cleaned)
    for part in reversed(parts):
        if "?" in part or "？" in part:
            return part.strip()
    return cleaned


def refresh_system_prompt(context: Any, state: LogisticsState) -> None:
    """Sync the LLMContext system message with the backend LogisticsState."""
    if not context:
        return
    msgs = (
        context.get_messages()
        if hasattr(context, "get_messages")
        else getattr(context, "messages", None)
    )
    if isinstance(msgs, list) and msgs and msgs[0].get("role") == "system":
        msgs[0]["content"] = build_system_prompt(state)


def _json_type(annotation: Any) -> str:
    origin = typing.get_origin(annotation)
    if origin is typing.Union:
        args = [a for a in typing.get_args(annotation) if a is not type(None)]
        return _json_type(args[0]) if args else "string"
    if annotation is bool:
        return "boolean"
    if annotation is int:
        return "integer"
    if annotation is float:
        return "number"
    return "string"


def schema_for_tool(fn: Callable) -> FunctionSchema:
    sig = inspect.signature(fn)
    doc = inspect.getdoc(fn) or fn.__name__
    desc = doc.split("\nArgs:")[0].strip()
    properties: Dict[str, Any] = {}
    required: List[str] = []
    for name, param in sig.parameters.items():
        if name == "self":
            continue
        properties[name] = {
            "type": _json_type(param.annotation),
            "description": name.replace("_", " "),
        }
        if param.default is inspect.Parameter.empty:
            required.append(name)
    return FunctionSchema(name=fn.__name__, description=desc, properties=properties, required=required)


class PlayoutTracker(FrameProcessor):
    def __init__(self, state: LogisticsState, context: Optional[Any] = None):
        super().__init__()
        self.state = state
        self.context = context
        self.speaking = False
        self._stopped_event = asyncio.Event()
        self._stopped_event.set()

    def _refresh_system_prompt(self):
        refresh_system_prompt(self.context, self.state)

    async def wait_for_playout(self, timeout: float = 12.0):
        try:
            await asyncio.wait_for(self._stopped_event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            self.speaking = True
            if self.state.opening_speech_active and self.state.intro_started_at <= 0.0:
                self.state.intro_started_at = time.monotonic()
            self._stopped_event.clear()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.speaking = False
            self.state.last_agent_speech_end = time.time()
            if self.state.opening_speech_active and not self.state.user_speaking:
                self.state.opening_speech_active = False
                self.state.intro_spoken_count = len(self.state.intro_sentences)
                self.state.advance_state_from_fields()
            self._stopped_event.set()
        elif isinstance(frame, UserStartedSpeakingFrame):
            self.state.user_speaking = True
            self.state.last_activity_time = time.time()
            was_speaking = self.speaking or self.state.opening_speech_active or self.state.llm_busy_since > 0.0
            if self.state.opening_speech_active:
                self.state.opening_speech_active = False
                self.state.opening_speech_interrupted = True
                elapsed = (
                    max(0.0, time.monotonic() - self.state.intro_started_at)
                    if self.state.intro_started_at > 0.0
                    else 0.0
                )
                self.state.mark_intro_elapsed(elapsed)
            if was_speaking:
                self.state.barge_in_pending = True
                self.state.barge_in_count += 1
                self.state.interrupted_step = self.state.current_step
                self.state.interrupted_question = self.state.pending_question
                self._refresh_system_prompt()
                logger.info(
                    f"⚡ Driver barge-in #{self.state.barge_in_count} at step={self.state.interrupted_step}; "
                    f"context updated."
                )
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self.state.user_speaking = False
            self.state.last_activity_time = time.time()
        await self.push_frame(frame, direction)


class SpeechInjector(FrameProcessor):
    def __init__(self):
        super().__init__()

    async def speak(self, text: str):
        cleaned = clean_tts_text(text)
        if cleaned:
            await self.push_frame(TTSSpeakFrame(text=cleaned), FrameDirection.DOWNSTREAM)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


class LLMOutputGuard(FrameProcessor):
    """Buffers LLM response text per turn, strips leaked tool tags, and logs assistant turns."""

    def __init__(self, state: LogisticsState, log_dialogue: Callable[[str, str], None], context: Optional[Any] = None):
        super().__init__()
        self.state = state
        self.log_dialogue = log_dialogue
        self.context = context
        self._buffer: List[str] = []
        self._in_response = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, (InterruptionFrame, UserStartedSpeakingFrame)):
            if self._in_response or self._buffer:
                self._buffer = []
                self._in_response = False
                self.state.llm_busy_since = 0.0
            await self.push_frame(frame, direction)
        elif isinstance(frame, LLMFullResponseStartFrame):
            self._in_response = True
            self._buffer = []
            self.state.llm_busy_since = time.time()
            await self.push_frame(frame, direction)
        elif isinstance(frame, LLMTextFrame):
            if self._in_response:
                self._buffer.append(frame.text)
            else:
                await self.push_frame(frame, direction)
        elif isinstance(frame, LLMFullResponseEndFrame):
            self._in_response = False
            self.state.llm_busy_since = 0.0
            full_text = clean_tts_text("".join(self._buffer))
            self._buffer = []
            if full_text:
                if self.state.last_activity_time > 0:
                    lat = time.time() - self.state.last_activity_time
                    if 0.05 < lat < 15.0:
                        self.state.latency_samples.append(lat)
                self.state.last_bot_utterance = full_text
                if self.state.last_interruption_type != "wait":
                    q = extract_pending_question(full_text)
                    if q:
                        self.state.pending_question = q
                self.state.barge_in_pending = False
                self.state.last_interruption_type = ""
                if self.state.opening_speech_interrupted:
                    self.state.intro_spoken_count = len(self.state.intro_sentences)
                    self.state.opening_speech_interrupted = False
                self.state.advance_state_from_fields()
                refresh_system_prompt(self.context, self.state)
                self.log_dialogue("assistant", full_text)
                await self.push_frame(LLMTextFrame(text=full_text), direction)
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)


class LogisticsSession:
    def __init__(self, state: LogisticsState, context: Any, injector: SpeechInjector, tracker: PlayoutTracker):
        self.state = state
        self.context = context
        self.injector = injector
        self.tracker = tracker
        self.task: Optional[Any] = None

    def register_tools_on(self, llm_service: Any, tool_fns: List[Callable]):
        for fn in tool_fns:
            async def _handler(params: FunctionCallParams, _fn=fn):
                try:
                    res = await _fn(**params.arguments)
                    await params.result_callback(res)
                except Exception as e:
                    logger.error(f"Tool {_fn.__name__} failed: {e}", exc_info=True)
                    await params.result_callback(f"Error: {e}")

            llm_service.register_function(fn.__name__, _handler)
        schemas = [schema_for_tool(fn) for fn in tool_fns]
        self.context.set_tools(ToolsSchema(standard_tools=schemas))

    async def say(self, text: str):
        await self.injector.speak(text)
        await self.tracker.wait_for_playout(timeout=12.0)
