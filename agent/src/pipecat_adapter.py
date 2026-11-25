"""Pipecat glue for the Airtel Wi-Fi Router Return Pickup agent.

Recreates the LiveKit session & agent interfaces on top of Pipecat frames:
  PlayoutTracker    tracks BotStartedSpeakingFrame / BotStoppedSpeakingFrame
  SpeechInjector    sits before TTS to inject frames
  TurnGate          runs AirtelTurnHandler on complete user turns, dropping LLM when handled
  LLMOutputGuard    holds LLM text until end, cleans tool text leaks, prefaces answers
  PipecatSession    update_instructions / update_tools / say / interrupt / set_reply_language / _dispatch
"""
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
    EndFrame,
    Frame,
    FunctionCallsStartedFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSSpeakFrame,
    TTSUpdateSettingsFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import FunctionCallParams
from pipecat.frames.frames import FunctionCallResultProperties
from pipecat.services.sarvam.tts import SarvamHttpTTSService
from pipecat.transcriptions.language import Language

from src.config import (
    CHAT_CTX_MAX_ITEMS,
    TTS_SPEAKER_EN,
    TTS_SPEAKER_HI,
    logger,
)
from src.state import ConversationState
from src.tools.agent_tools import AgentTools

ALL_AIRTEL_TOOLS = {
    "confirm_identity",
    "set_pickup",
    "set_pickup_date",
    "record_willing_no_date",
    "schedule_callback",
    "confirm_address",
    "record_device_issue",
    "record_refusal",
    "record_temporarily_unavailable",
    "record_recharge",
    "escalate_to_121",
    "record_shifted",
    "record_already_picked_up",
    "record_already_returned",
    "record_still_using_device",
    "record_do_not_call",
    "record_language_barrier",
}

_TOOL_NAMES_PATTERN = "|".join(sorted(ALL_AIRTEL_TOOLS, key=len, reverse=True))

_LEAK_PATTERNS = [
    re.compile(r"<(?:function|tool_call|call)[^>]*>.*?(?:</(?:function|tool_call|call)>|$)", re.S | re.I),
    re.compile(r"</?(?:function|tool_call|call)[^>]*>?", re.I),
    re.compile(r"\b(?:" + _TOOL_NAMES_PATTERN + r"|[a-z]+(?:_[a-z0-9]+)+)\s*(?:[\(\{>:].*?[\)\}]|>[^\s]+)", re.S | re.I),
    re.compile(r"\b(?:" + _TOOL_NAMES_PATTERN + r")\b", re.I),
    re.compile(r"\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b"),
    re.compile(r"[>:]?\s*\{[^{}]*\}", re.S),
    re.compile(r"^\s*\{.*$", re.S),
    re.compile(r"</?[a-zA-Z0-9_:-]+[^>]*>", re.S),
]


def _clean_leaks(s: str) -> str:
    for p in _LEAK_PATTERNS:
        s = p.sub('', s)
    return s.strip("` \n\t")


def _soften_tts_phrase(s: str) -> str:
    s = re.sub(r'^(Achha|Theek hai|Haanji|Haan ji|Samajh gayi|Got it|Sure|Perfect|Noted|Understood|Alright|Right)\.\s*', r'\1, ', s, flags=re.I)
    s = re.sub(r'(,\s*Sir|\bSir|\bji)\.\s+([A-Z])', r'\1... \2', s)
    s = s.replace("!", "... ")
    s = re.sub(r'[ \t]{2,}', ' ', s)
    return s.strip()


def _normalize_phonetics(s: str) -> str:
    """Ensure carrier shortcodes like 121 are spoken digit-by-digit ('one two one' / 'वन टू वन')

    rather than 'one hundred twenty-one' or 'एक सौ इक्कीस'.
    """
    if re.search(r'[\u0900-\u097F]', s):
        s = re.sub(r'\b121\b', 'वन टू वन', s)
        s = re.sub(r'१२१', 'वन टू वन', s)
    else:
        s = re.sub(r'\b121\b', 'one two one', s)
    return s


def prep_for_tts(text: str) -> str:
    return _normalize_phonetics(_soften_tts_phrase(_clean_leaks(text or ""))).strip()


def _estimate_speech_duration(text: str) -> float:
    words = len(text.split()) if text else 0
    return max(1.5, words / 2.5 + 1.0)


def _message_text(msg: Any) -> str:
    content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


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
    hints = typing.get_type_hints(fn)
    props: Dict[str, Any] = {}
    required: List[str] = []
    for name, p in sig.parameters.items():
        if name == "self":
            continue
        props[name] = {"type": _json_type(hints.get(name, str))}
        if p.default is inspect.Parameter.empty:
            required.append(name)
    return FunctionSchema(
        name=fn.__name__,
        description=(inspect.getdoc(fn) or fn.__name__).strip(),
        properties=props,
        required=required,
    )


def _coerce_tool_args(fn: Callable, kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """Llama-class models often send booleans as strings ("false") or empty args as null.
    bool("false") is True in Python, which would silently turn a denial into a confirmation."""
    try:
        hints = typing.get_type_hints(fn)
    except Exception:
        return kwargs
    out: Dict[str, Any] = {}
    for k, v in kwargs.items():
        want = hints.get(k)
        if v is None:
            if want is bool:
                continue  # let the tool's default apply
            out[k] = "" if want in (str, None) else v
        elif want is bool and isinstance(v, str):
            out[k] = v.strip().lower() in ("true", "1", "yes", "y", "haan", "ha", "ji")
        elif want is bool and isinstance(v, (int, float)):
            out[k] = bool(v)
        elif want is str and not isinstance(v, str):
            out[k] = str(v)
        else:
            out[k] = v
    return out


class SpeechHandle:
    def __init__(self, tracker: "PlayoutTracker", text: str):
        self._tracker = tracker
        self._text = text
        self._t0 = time.monotonic()

    async def wait_for_playout(self):
        await self._tracker.wait_cycle(self._t0, timeout=_estimate_speech_duration(self._text) + 8.0)


class PlayoutTracker(FrameProcessor):
    def __init__(self, state: ConversationState):
        super().__init__()
        self.state = state
        self.speaking = False
        self._started_at = 0.0
        self._stopped_at = 0.0
        self._cond = asyncio.Condition()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            self.speaking = True
            self.state.agent_speaking = True
            self._started_at = time.monotonic()
            async with self._cond:
                self._cond.notify_all()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.speaking = False
            self.state.agent_speaking = False
            self._stopped_at = time.monotonic()
            self.state.last_agent_speech_end = time.time()
            async with self._cond:
                self._cond.notify_all()
        await self.push_frame(frame, direction)

    async def wait_cycle(self, since: float, timeout: float):
        async def _wait():
            async with self._cond:
                await self._cond.wait_for(lambda: self._started_at >= since)
                await self._cond.wait_for(lambda: (not self.speaking) and self._stopped_at >= self._started_at)

        try:
            await asyncio.wait_for(_wait(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.debug("wait_cycle timed out -> assuming playout finished")


class SpeechInjector(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)

    async def inject(self, frame: Frame):
        await self.push_frame(frame, FrameDirection.DOWNSTREAM)


class LLMOutputGuard(FrameProcessor):
    def __init__(self, state: ConversationState, handler, log_dialogue: Callable[[str, str], None]):
        super().__init__()
        self.state = state
        self.handler = handler
        self.log_dialogue = log_dialogue
        self._buf: List[str] = []
        self._tool_seen = False
        self._end_evt = asyncio.Event()
        self._end_evt.set()

    async def wait_end(self, timeout: float = 1.5):
        try:
            await asyncio.wait_for(self._end_evt.wait(), timeout)
        except asyncio.TimeoutError:
            pass

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._buf.clear()
            self._tool_seen = False
            self._end_evt.clear()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, FunctionCallsStartedFrame):
            self._tool_seen = True
            await self.push_frame(frame, direction)
            return

        if type(frame) is LLMTextFrame:
            self._buf.append(frame.text)
            return

        if isinstance(frame, InterruptionFrame):
            self._buf.clear()
            self._end_evt.set()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMFullResponseEndFrame):
            full = "".join(self._buf)
            self._buf.clear()
            out = await self._finalize(full)
            if out:
                await self.push_frame(LLMTextFrame(out), FrameDirection.DOWNSTREAM)
            self._end_evt.set()
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)

    async def _finalize(self, full: str) -> Optional[str]:
        st = self.state
        if st.closing_spoken:
            return None

        if self._tool_seen:
            if full.strip():
                logger.info(f"🔇 Dropped LLM text that came with a tool call: {full.strip()[:140]!r}")
            return None

        if not full.strip():
            return None
        return self._log_and_prep(full)

    def _log_and_prep(self, text: str) -> Optional[str]:
        clean = _clean_leaks(text).strip()
        if not clean:
            return None
        self.log_dialogue("assistant", clean)
        return prep_for_tts(clean)


class TurnGate(FrameProcessor):
    def __init__(self, state: ConversationState, handler, context, log_dialogue: Callable[[str, str], None]):
        super().__init__()
        self.state = state
        self.handler = handler
        self.context = context
        self.log_dialogue = log_dialogue
        # The old code counted user messages in the context. _trim_context() deletes old messages, so after a few
        # turns the count stopped growing: new customer turns were no longer detected, so the regex layer
        # (carrier / DND / fast-path) was skipped and the customer's words were never logged.
        # A message is "new" when it is a different dict object, or the same one with different text.
        self._last_user_msg: Any = None
        self._last_user_text: Optional[str] = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if (
            isinstance(frame, LLMContextFrame)
            and direction == FrameDirection.DOWNSTREAM
            and not getattr(frame, "speculation", False)
        ):
            msgs = frame.context.get_messages() if hasattr(frame.context, "get_messages") else frame.context.messages
            last = msgs[-1] if msgs else None
            role = last.get("role") if isinstance(last, dict) else getattr(last, "role", None)
            if role == "user":
                cur_text = _message_text(last).strip()
                if last is not self._last_user_msg or cur_text != self._last_user_text:
                    self._last_user_msg = last
                    self._last_user_text = cur_text
                    text = cur_text
                    if text:
                        self.state.last_activity_time = time.time()
                        self.log_dialogue("customer", text)
                        try:
                            handled = await self.handler.handle_turn(text)
                        except Exception as e:
                            logger.error(f"Turn handler crashed, falling back to LLM: {e}", exc_info=True)
                            handled = False
                        if handled:
                            logger.info("🛑 Turn handled deterministically -> LLM skipped")
                            return
                    else:
                        return
            self._trim_context()

        await self.push_frame(frame, direction)

    def _trim_context(self):
        if CHAT_CTX_MAX_ITEMS <= 0:
            return
        msgs = list(self.context.get_messages())
        if len(msgs) <= CHAT_CTX_MAX_ITEMS + 1:
            return
        system = msgs[:1] if msgs and msgs[0].get("role") == "system" else []
        rest = msgs[len(system):][-CHAT_CTX_MAX_ITEMS:]
        while rest and rest[0].get("role") != "user":
            rest.pop(0)
        if rest:
            self.context.set_messages(system + rest)


class PipecatSession:
    def __init__(
        self,
        state: ConversationState,
        tools: AgentTools,
        context,
        injector: SpeechInjector,
        tracker: PlayoutTracker,
        log_dialogue: Callable[[str, str], None],
    ):
        self.state = state
        self.tools = tools
        self.context = context
        self.injector = injector
        self.tracker = tracker
        self.log_dialogue = log_dialogue
        self.guard: Optional[LLMOutputGuard] = None
        self.task = None
        self._current_tool_names: set = set()
        self._speak_q: "asyncio.Queue[Optional[Frame]]" = asyncio.Queue()
        self._speaker_task: Optional[asyncio.Task] = None

    @property
    def session(self):
        return self

    def start(self):
        if self._speaker_task is None:
            self._speaker_task = asyncio.create_task(self._speaker_loop())

    async def close(self):
        if self._speaker_task:
            self._speaker_task.cancel()
            try:
                await self._speaker_task
            except (asyncio.CancelledError, Exception):
                pass
            self._speaker_task = None

    async def _speaker_loop(self):
        while True:
            frame = await self._speak_q.get()
            try:
                await self.injector.inject(frame)
            except Exception as e:
                logger.warning(f"speech injection failed: {e}")

    async def update_instructions(self, text: str):
        msgs = list(self.context.get_messages())
        if msgs and msgs[0].get("role") == "system":
            msgs[0] = {"role": "system", "content": text}
        else:
            msgs.insert(0, {"role": "system", "content": text})
        self.context.set_messages(msgs)

    async def update_tools(self, tool_methods: List[Callable]):
        schemas = [schema_for_tool(t) for t in tool_methods]
        self._current_tool_names = {s.name for s in schemas}
        self.context.set_tools(ToolsSchema(standard_tools=schemas) if schemas else ToolsSchema(standard_tools=[]))

    async def sync_step(self):
        """Called by AgentTools._go() after every step change to sync LLM prompt & tools."""
        from src.prompts import get_step_instructions
        await self.update_instructions(get_step_instructions(self.state))
        await self.update_tools(self.tools.tools_for_step(self.state.step))

    def say(self, text: str, allow_interruptions: bool = True, **kwargs) -> SpeechHandle:
        spoken = prep_for_tts(text)
        handle = SpeechHandle(self.tracker, spoken)
        if spoken:
            frame = TTSSpeakFrame(spoken)
            if not allow_interruptions:
                frame.interruptible = False
            self._speak_q.put_nowait(frame)
        return handle

    async def interrupt(self):
        if self.task:
            await self.task.queue_frame(InterruptionFrame())

    def set_reply_language(self, lang: str):
        asyncio.create_task(self._apply_language(lang))

    async def _apply_language(self, lang: str):
        voice = TTS_SPEAKER_EN if lang == "en" else TTS_SPEAKER_HI
        language = Language.EN_IN if lang == "en" else Language.HI_IN
        try:
            self._speak_q.put_nowait(
                TTSUpdateSettingsFrame(delta=SarvamHttpTTSService.Settings(voice=voice, language=language))
            )
            logger.info(f"🌐 Airtel TTS switched to {lang} ({voice})")
        except Exception as e:
            logger.warning(f"TTS language switch failed: {e}")

    def register_tools_on(self, llm_service, all_tool_methods: List[Callable]):
        for fn in all_tool_methods:
            llm_service.register_function(fn.__name__, self._dispatch)

    async def _dispatch(self, params: FunctionCallParams):
        name = params.function_name
        st = self.state
        fn = getattr(self.tools, name, None)
        args = dict(params.arguments or {})

        if fn is None or (self._current_tool_names and name not in self._current_tool_names):
            logger.warning(f"Tool '{name}' is not available at step {st.step.value}")
            await params.result_callback(
                f"Tool {name} is not available now. Continue the conversation without it.",
                properties=FunctionCallResultProperties(run_llm=True),
            )
            return

        sig = inspect.signature(fn)
        accepts_kwargs = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
        kwargs = args if accepts_kwargs else {k: v for k, v in args.items() if k in sig.parameters}
        kwargs = _coerce_tool_args(fn, kwargs)
        logger.info(f"🔧 Tool call: {name}({kwargs})")
        try:
            result = await fn(**kwargs)
        except Exception as e:
            logger.error(f"Tool {name} failed: {e}", exc_info=True)
            result = "The tool failed. Re-ask the current open question in simple words."

        if self.guard:
            await self.guard.wait_end()

        if st.closing_spoken:
            await params.result_callback(result, properties=FunctionCallResultProperties(run_llm=False))
            return

        reply, st.direct_reply = st.direct_reply, None
        if reply:
            pre, st.pending_preface = st.pending_preface, None
            if pre:
                reply = f"{pre} {reply}"
            logger.info(f"⚡ FAST_REPLY (2nd LLM call skipped): '{reply}'")

            async def _speak_after_context_update(text=reply):
                self.log_dialogue("assistant", text)
                self.say(text)

            await params.result_callback(
                result,
                properties=FunctionCallResultProperties(run_llm=False, on_context_updated=_speak_after_context_update),
            )
            return

        await params.result_callback(result)
        