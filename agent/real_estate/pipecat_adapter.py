"""Pipecat glue for the real-estate agent.

tools.py and agent.py were written against a LiveKit-style `agent` / `session` object
(update_instructions, update_tools, say(...).wait_for_playout(), interrupt()). Pipecat has none of that, so
before this module existed:

  * the closing line was never spoken (the tools found no session and hung up immediately),
  * FAST_TOOL_REPLY lines (`state.direct_reply`) were never spoken -> dead air after every tool call,
  * step instructions / tool lists never changed after the first system prompt,
  * the deterministic shortcuts in agent.py (IVR drop, refusal confirm, repeat, don't-know ...) never ran.

Everything below re-creates those hooks on top of real Pipecat frames:

  PlayoutTracker    sees BotStarted/StoppedSpeaking -> wait_for_playout(), last_agent_speech_end
  SpeechInjector    sits right before TTS; the only place speech is pushed from outside the LLM
  TurnGate          between user aggregator and LLM: runs RealEstateTurnHandler on the COMPLETE user turn,
                    swallows the LLM run when a shortcut already answered
  LLMOutputGuard    between LLM and TTS: holds LLM text until the generation ends, drops text that came with a
                    tool call (double-question bug), recovers tool calls typed as text, strips leaks
  PipecatSession    update_instructions / update_tools / say / interrupt / language switch / tool dispatch
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
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import FunctionCallParams
from pipecat.frames.frames import FunctionCallResultProperties
from pipecat.services.sarvam.tts import SarvamHttpTTSService
from pipecat.transcriptions.language import Language

from .agent import (
    _INLINE_CALL_RE,
    _TEXT_CALL_RE,
    _clean_leaks,
    _soften_tts_phrase,
    RealEstateTurnHandler,
)
from .config import (
    CHAT_CTX_MAX_ITEMS,
    TTS_SPEAKER_EN,
    TTS_SPEAKER_HI,
    logger,
)
from .state import RealEstateState
from .tools import RealEstateTools, extract_question, _estimate_speech_duration


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────
def prep_for_tts(text: str) -> str:
    """Same clean-up the old LiveKit tts_node did: strip leaked tool text, soften, speak digits."""
    return _soften_tts_phrase(_clean_leaks(text or "")).strip()


def _message_text(msg: Any) -> str:
    content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def _json_type(annotation: Any) -> str:
    """Optional[Union[float, str]] -> 'number' ; Optional[bool] -> 'boolean' ; default 'string'."""
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


_TOOL_PARAM_DESCRIPTIONS: Dict[str, str] = {
    "category": "Property category: 'residential' or 'commercial'",
    "intent": "Customer intent: 'sale' (to sell) or 'lease' (to rent or lease out)",
    "project_or_society": "Name of the society, apartment complex, or project (e.g. 'Signature Global', 'DLF Phase 2')",
    "sector_or_location": "Area, sector, or locality of the property (e.g. 'Sector 62', 'Indiranagar')",
    "unit_number": "Flat, door, or unit number (e.g. '407', 'Flat 302', 'Standalone' if independent property)",
    "floor_number": "Floor or storey (e.g. '4th', 'Ground', '2nd', 'Top')",
    "bhk_config": "Bedroom configuration (e.g. '2 BHK', '3 BHK', '3.5 BHK', 'Studio'). Residential only.",
    "commercial_type": "Commercial unit type: 'office space', 'retail shop', 'showroom', 'warehouse', etc. Commercial only.",
    "approx_area_sqft": "Total super area in square feet as a number (e.g. 1800). Multiply gaj by 9 (200 gaj = 1800 sq ft).",
    "furnishing_status": "Furnishing: 'unfurnished', 'semi-furnished', or 'fully-furnished'",
    "expected_sale_price": "Expected sale price with unit (e.g. '50 Lakh', '1.5 Crore', 'Market Rate')",
    "expected_monthly_rent": "Expected monthly rent with unit (e.g. '25 Thousand', '40,000', '1.5 Lakh', 'Market Rate')",
    "is_currently_leased": "Whether commercial property is leased (true) or vacant (false)",
    "current_rent_received": "Current monthly rent being received from tenant if leased",
    "immediate_occupancy": "Whether property is ready for immediate occupancy (true) or notice period (false)",
    "caller_words": "The exact words spoken by the caller justifying this action",
    "field_id": "The ID of the field the caller cannot share or does not know",
    "time_slot": "Preferred callback time slot (e.g. 'evening', 'morning', '2 PM')",
    "preferred_day": "Preferred callback day (e.g. 'tomorrow', 'Monday')",
    "reason": "Handoff reason (e.g. 'Price valuation requested', 'Customer requested human advisor')",
    "location": "New property location or sector",
    "has_other": "True if customer has another property to sell/rent, False if no other property",
    "name": "Good name of the property owner for records",
    "phone": "WhatsApp number to send details to",
}


def schema_for_tool(fn: Callable) -> FunctionSchema:
    """Build the LLM-facing schema straight from the tool method (signature + docstring), so the schema can
    never drift from the real parameters (the hand-written schemas did: bhk_type / super_area_sqft /
    expected_price_lakhs were NOT parameters of save_property_details, so every call raised TypeError)."""
    sig = inspect.signature(fn)
    hints = typing.get_type_hints(fn)
    props: Dict[str, Any] = {}
    required: List[str] = []
    for name, p in sig.parameters.items():
        if name == "self":
            continue
        p_dict: Dict[str, Any] = {"type": _json_type(hints.get(name, str))}
        if name in _TOOL_PARAM_DESCRIPTIONS:
            p_dict["description"] = _TOOL_PARAM_DESCRIPTIONS[name]
        props[name] = p_dict
        if p.default is inspect.Parameter.empty:
            required.append(name)
    return FunctionSchema(
        name=fn.__name__,
        description=(inspect.getdoc(fn) or fn.__name__).strip(),
        properties=props,
        required=required,
    )


class SpeechHandle:
    """Returned by PipecatSession.say(); mirrors the small part of the old API that tools.py uses."""

    def __init__(self, tracker: "PlayoutTracker", text: str):
        self._tracker = tracker
        self._text = text
        self._t0 = time.monotonic()

    async def wait_for_playout(self):
        await self._tracker.wait_cycle(self._t0, timeout=_estimate_speech_duration(self._text) + 8.0)


# ──────────────────────────────────────────────────────────────────────────────
# Processors
# ──────────────────────────────────────────────────────────────────────────────
class PlayoutTracker(FrameProcessor):
    """Place AFTER transport.output(). Tracks when the bot really started / stopped talking on the line."""

    def __init__(self, state: RealEstateState):
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
            self._started_at = time.monotonic()
            async with self._cond:
                self._cond.notify_all()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.speaking = False
            self._stopped_at = time.monotonic()
            self.state.last_agent_speech_end = time.time()
            async with self._cond:
                self._cond.notify_all()
        await self.push_frame(frame, direction)

    async def wait_cycle(self, since: float, timeout: float):
        """Wait until the bot has started AND then stopped speaking after `since` (monotonic)."""

        async def _wait():
            async with self._cond:
                await self._cond.wait_for(lambda: self._started_at >= since)
                await self._cond.wait_for(lambda: (not self.speaking) and self._stopped_at >= self._started_at)

        try:
            await asyncio.wait_for(_wait(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.debug("wait_cycle timed out -> assuming playout finished")


class SpeechInjector(FrameProcessor):
    """Place right BEFORE tts. PipecatSession pushes TTSSpeakFrame / TTSUpdateSettingsFrame through here."""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)

    async def inject(self, frame: Frame):
        await self.push_frame(frame, FrameDirection.DOWNSTREAM)


class LLMOutputGuard(FrameProcessor):
    """Place between llm and SpeechInjector.

    Mirrors the old llm_node(): Llama often says a sentence AND calls a tool in the same generation. The tool then
    speaks the canonical next question, so the caller used to hear two questions. So LLM text is HELD until the
    generation ends and then:
      * tool call in this generation   -> drop the text (keep a short ANSWER to a caller question as a preface)
      * tool call typed as plain text  -> recover/execute it, speak the canonical reply
      * plain speech                   -> clean + forward
    """

    def __init__(self, state: RealEstateState, handler: RealEstateTurnHandler, log_dialogue: Callable[[str, str], None]):
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

        if type(frame) is LLMTextFrame:  # exact type: skip subclasses (TTS text frames etc.)
            self._buf.append(frame.text)
            return

        if isinstance(frame, InterruptionFrame):
            self._buf.clear()
            self._end_evt.set()
            self.state.llm_busy_since = 0.0
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMFullResponseEndFrame):
            self.state.llm_busy_since = 0.0
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
            return None  # closing line is spoken deterministically

        if self._tool_seen:
            if full.strip():
                pre = self.handler._answer_preface(full)
                if pre:
                    st.pending_preface = pre
                    logger.info(f"💬 Kept LLM answer to the caller's question as preface: {pre!r}")
                else:
                    logger.info(f"🔇 Dropped LLM text that came with a tool call: {full.strip()[:140]!r}")
            return None

        m = _INLINE_CALL_RE.search(full)
        if m or _TEXT_CALL_RE.match(full):
            start = m.start() if m else 0
            if m and m.group(0).startswith('"name"'):
                brace = full.rfind("{", 0, m.start())
                start = brace if brace >= 0 else m.start()
            recovered = await self.handler._recover_text_tool_call(full[start:])
            if not recovered:
                return None
            return self._log_and_prep(recovered)

        if not full.strip():
            return None
        return self._log_and_prep(full)

    def _log_and_prep(self, text: str) -> Optional[str]:
        clean = _clean_leaks(text).strip()
        if not clean:
            return None
        q = extract_question(clean)
        if q:
            self.state.last_agent_question = q
        self.log_dialogue("assistant", clean)
        return prep_for_tts(clean)


class TurnGate(FrameProcessor):
    """Place between context_aggregator.user() and the LLM.

    The user aggregator emits an LLMContextFrame when the caller's turn is complete (VAD + all STT segments merged).
    That is the equivalent of LiveKit's on_user_turn_completed, so the whole deterministic shortcut layer runs here.
    """

    def __init__(self, state: RealEstateState, handler: RealEstateTurnHandler, context, log_dialogue: Callable[[str, str], None]):
        super().__init__()
        self.state = state
        self.handler = handler
        self.context = context
        self.log_dialogue = log_dialogue
        self._seen_user_msgs = 0
        self._last_user_text = ""
        # _trim_context() drops old messages, so the number of user messages left in the context is NOT a running
        # turn counter. Every user message trimmed away is added here so (count in context + dropped) keeps growing
        # by exactly one per real caller turn. Without it, after the first trim every later turn looked "old" and the
        # whole deterministic layer (IVR check, hold, language switch, push_user_text, step refresh) was skipped.
        self._dropped_users = 0

    @staticmethod
    def _role_of(m) -> Optional[str]:
        return m.get("role") if isinstance(m, dict) else getattr(m, "role", None)

    def _count_users(self, msgs) -> int:
        return sum(1 for m in msgs if self._role_of(m) == "user")

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        # Live caller-activity tracking for the silence watchdog (a long answer must not trigger "are you there?").
        if isinstance(frame, UserStartedSpeakingFrame):
            self.state.user_speaking = True
            self.state.last_activity_time = time.time()
            if self._seen_user_msgs == 0 and getattr(self.state.step, "value", self.state.step) == "INTRODUCTION":
                self.state.opening_speech_interrupted = True
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self.state.user_speaking = False
            self.state.last_activity_time = time.time()

        if (
            isinstance(frame, LLMContextFrame)
            and direction == FrameDirection.DOWNSTREAM
        ):
            msgs = frame.context.get_messages() if hasattr(frame.context, "get_messages") else frame.context.messages
            last = msgs[-1] if msgs else None
            role = last.get("role") if isinstance(last, dict) else getattr(last, "role", None)
            if role == "user":
                n_user = self._count_users(msgs) + self._dropped_users
                text = _message_text(last).strip()
                is_new_turn = n_user > self._seen_user_msgs
                is_updated_turn = (n_user == self._seen_user_msgs and bool(text) and text != self._last_user_text)
                if is_new_turn or is_updated_turn:  # a NEW or updated caller turn (including speculative frames)
                    self._seen_user_msgs = n_user
                    if text:
                        self._last_user_text = text
                        self.state.last_activity_time = time.time()
                        self.log_dialogue("customer", text)
                        try:
                            handled = await self.handler.handle_turn(text)
                        except Exception as e:  # never let a bug in a shortcut kill the call
                            logger.error(f"Turn handler crashed, falling back to LLM: {e}", exc_info=True)
                            handled = False
                        if handled:
                            logger.info("🛑 Turn handled deterministically -> LLM skipped")
                            return
                    else:
                        return  # empty transcript: nothing to answer
            self._trim_context()
            self.state.llm_busy_since = time.time()   # LLM is now working on this turn (cleared in LLMOutputGuard)

        await self.push_frame(frame, direction)

    def _trim_context(self):
        """Cap history sent to the LLM (fewer prompt tokens -> lower TTFT). Keeps the system prompt and never starts
        the kept window in the middle of a tool_call/tool pair."""
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
            new_msgs = system + rest
            self._dropped_users += max(0, self._count_users(msgs) - self._count_users(new_msgs))
            self.context.set_messages(new_msgs)


# ──────────────────────────────────────────────────────────────────────────────
# Session adapter (what tools.py / agent.py call)
# ──────────────────────────────────────────────────────────────────────────────
class PipecatSession:
    """Plays the role of both `agent` and `agent.session` for RealEstateTools / RealEstateTurnHandler."""

    def __init__(
        self,
        state: RealEstateState,
        tools: RealEstateTools,
        context,
        injector: SpeechInjector,
        tracker: PlayoutTracker,
        log_dialogue: Callable[[str, str], None],
        tts_provider: str = "sarvam",
    ):
        self.state = state
        self.tools = tools
        self.context = context
        self.injector = injector
        self.tracker = tracker
        self.log_dialogue = log_dialogue
        self.tts_provider = tts_provider
        self.guard: Optional[LLMOutputGuard] = None
        self.task = None  # PipelineTask, set by worker
        self._current_tool_names: set = set()
        self._speak_q: "asyncio.Queue[Optional[Frame]]" = asyncio.Queue()
        self._speaker_task: Optional[asyncio.Task] = None

    # tools.py reads `self.agent.session`
    @property
    def session(self):
        return self

    # ── lifecycle ──
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
        """Single consumer keeps spoken lines in the order they were requested."""
        while True:
            frame = await self._speak_q.get()
            try:
                await self.injector.inject(frame)
            except Exception as e:
                logger.warning(f"speech injection failed: {e}")

    # ── agent API used by tools.py / agent.py ──
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
        # An empty list means "no tools" (CLOSING step) -> prevents hallucinated tool calls.
        self.context.set_tools(ToolsSchema(standard_tools=schemas) if schemas else ToolsSchema(standard_tools=[]))

    def say(self, text: str, audio=None, allow_interruptions: bool = True) -> SpeechHandle:
        """Queue a line for TTS. `audio` (pre-rendered frames) is accepted for API compatibility but ignored."""
        spoken = prep_for_tts(text)
        handle = SpeechHandle(self.tracker, spoken)
        if spoken:
            frame = TTSSpeakFrame(spoken)
            if not allow_interruptions:
                frame.interruptible = False  # closing line: a "haan haan" backchannel must not cut it off
            self._speak_q.put_nowait(frame)
        return handle

    async def interrupt(self):
        if self.task:
            await self.task.queue_frame(InterruptionFrame())

    # ── language ──
    def set_reply_language(self, lang: str):
        asyncio.create_task(self._apply_language(lang))

    async def _apply_language(self, lang: str):
        from tts_factory import build_language_update_frame

        frame = build_language_update_frame(self.tts_provider, lang, TTS_SPEAKER_EN, TTS_SPEAKER_HI)
        if not frame:
            return
        try:
            await self.injector.inject(frame)
            logger.info(f"🌐 TTS ({self.tts_provider}) switched to {lang}")
        except Exception as e:
            logger.warning(f"TTS language switch failed: {e}")

    # ── tool dispatch (registered on the LLM service for every tool name) ──
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
        logger.info(f"🔧 Tool call: {name}({kwargs})")
        try:
            result = await fn(**kwargs)
        except Exception as e:
            logger.error(f"Tool {name} failed: {e}", exc_info=True)
            result = "The tool failed. Re-ask the current open question in simple words."

        # Wait for the LLM's own text of this generation to be classified (preface vs. drop).
        if self.guard:
            await self.guard.wait_end()

        if st.closing_spoken:
            # The closing line was already queued by the tool itself; the LLM must stay silent.
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

        # No canonical line -> let the LLM phrase the answer from the tool result.
        await params.result_callback(result)