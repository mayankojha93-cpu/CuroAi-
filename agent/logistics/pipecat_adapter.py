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
from .state import LogisticsState

_TOOL_LEAK_RE = re.compile(r"<function=[^>]+>.*?(?:</function>|$)", re.S | re.I)


def clean_tts_text(text: str) -> str:
    cleaned = _TOOL_LEAK_RE.sub("", text or "")
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned


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
    def __init__(self, state: LogisticsState):
        super().__init__()
        self.state = state
        self.speaking = False
        self._stopped_event = asyncio.Event()
        self._stopped_event.set()

    async def wait_for_playout(self, timeout: float = 12.0):
        try:
            await asyncio.wait_for(self._stopped_event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            self.speaking = True
            self._stopped_event.clear()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.speaking = False
            self.state.last_agent_speech_end = time.time()
            self._stopped_event.set()
        elif isinstance(frame, UserStartedSpeakingFrame):
            self.state.user_speaking = True
            self.state.last_activity_time = time.time()
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

    def __init__(self, state: LogisticsState, log_dialogue: Callable[[str, str], None]):
        super().__init__()
        self.state = state
        self.log_dialogue = log_dialogue
        self._buffer: List[str] = []
        self._in_response = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
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
