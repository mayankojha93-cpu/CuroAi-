import re
import json
import asyncio
import logging
from livekit.agents import Agent, StopResponse
from src.carrier_filter import classify_carrier_message
from .prompts import get_step_instructions
from .state import RealEstateState
from .config import CHAT_CTX_MAX_ITEMS

# Leak patterns for tool-call text that the LLM sometimes types instead of calling the tool.
_LEAK_PATTERNS = [
    re.compile(r'<function[^>]*>.*?(?:</function>|$)', re.S),               # <function=x>{...}</function>
    re.compile(r'\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\s*[\(\{][^)}]*[\)\}]?'),     # tool_name(...) / tool_name{...}
    re.compile(r'\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b'),                        # lone snake_case identifiers
    re.compile(r'^\s*\{.*$', re.S),                                         # JSON blobs
]


def _clean_leaks(s: str) -> str:
    for p in _LEAK_PATTERNS:
        s = p.sub('', s)
    return s


def _call_open(buf: str) -> bool:
    """True while a call-like region ((...), {...}, <function>...) is still unclosed."""
    if "<function" in buf and "</function>" not in buf:
        return True
    return any(buf.count(a) > buf.count(b) for a, b in (("(", ")"), ("{", "}"), ("<", ">")))


logger = logging.getLogger("real-estate-agent")

# ── Recovery for "tool call typed as plain text" ──────────────────────────────
# Llama sometimes prints {"name": "save_property_details", "parameters": {...}} as its reply instead
# of making a real tool call. The tts_node guard strips it, so the caller heard NOTHING (dead air).
_TEXT_CALL_RE = re.compile(r'^\s*(?:\{|<function|[a-z]+(?:_[a-z0-9]+)+\s*[\(\{])')

# get_missing_fields() ids -> save_property_details parameter names
_FIELD_TO_PARAMS = {
    "location": ("sector_or_location",),
    "society_sector": ("project_or_society",),
    "project_sector": ("project_or_society",),
    "unit_floor": ("unit_number", "floor_number"),
    "bhk_config": ("bhk_config",),
    "commercial_type": ("commercial_type",),
    "approx_area": ("approx_area_sqft",),
    "furnishing": ("furnishing_status",),
    "sale_price": ("expected_sale_price",),
    "monthly_rent": ("expected_monthly_rent",),
    "immediate_occupancy": ("immediate_occupancy",),
    "leased_status": ("is_currently_leased",),
    "current_rent": ("current_rent_received",),
}

# Short utterances that must NOT flip the reply language (e.g. 'Hello.' flipped Hindi -> English).
_NEUTRAL_UTTERANCES = {
    "hello", "hi", "hey", "helo", "hallo", "ok", "okay", "yes", "no", "hmm", "haan", "han", "ji",
    "haanji", "haan ji", "हेलो", "हैलो", "हेल्लो", "हाँ", "हां", "जी", "हम्म", "ओके",
}


def _is_neutral_utterance(text: str) -> bool:
    t = re.sub(r"[\s.,?!\u0964]+", " ", (text or "").lower()).strip()
    return t in _NEUTRAL_UTTERANCES


# ── Caller asks US for the price/rate ("kya rate chal raha hai? kitne mein bech sakte hain?") ──
# Handled deterministically (no LLM): speak valuation line + short thank-you, then hang up.
_PRICE_Q_LATIN = re.compile(
    r"(kya\s+(rate|price|bhav|bhaav|value|daam|dam)\b"
    r"|\b(rate|price|bhav|bhaav|daam|dam|value)\s+(kya|kitna|kitni|chal\s*raha|chal\s*rha|chalega)"
    r"|market\s+(rate|price|value)"
    r"|kitn[ae]\s+(me|mein|main)\s+(bech|bik|sell)"
    r"|kitn[ae]\s+(milega|mil\s*sakta|mil\s*jayega|mil\s*jaayega)"
    r"|how\s+much\s+(can|will|would|do|should)"
    r"|what\s+(is|are|'s)\s+(the\s+)?(rate|price|value|market)"
    r"|what\s+price|valuation)",
    re.I,
)
_PRICE_Q_DEV = re.compile(
    r"(क्या\s*(रेट|प्राइस|भाव|कीमत|दाम|वैल्यू)"
    r"|(रेट|प्राइस|भाव|कीमत|दाम)\s*(क्या|कितना|कितनी|चल)"
    r"|मार्केट\s*(रेट|प्राइस|वैल्यू)"
    r"|कितने\s*में\s*(बेच|बिक)"
    r"|कितना\s*मिलेगा|वैल्यूएशन)"
)
_HAS_AMOUNT = re.compile(r"[0-9०-९]|lakh|lac\b|crore|cr\b|लाख|करोड़|करोड", re.I)


def _asks_agent_for_price(text: str) -> bool:
    """True when the caller is ASKING for a rate/valuation (not stating their own expected price)."""
    if not text or _HAS_AMOUNT.search(text):
        return False
    if _PRICE_Q_DEV.search(text):
        return True
    cands = [text]
    try:
        from src.transliteration import romanize_hindi
        cands.append(romanize_hindi(text))
    except Exception:
        pass
    return any(_PRICE_Q_LATIN.search((c or "").lower()) for c in cands)


# ── Caller asks us to REPEAT the last question ("aapne pichhle kya puchha tha?") ──
# Previously the LLM treated this as "don't know" and silently skipped the open field.
# Handled deterministically: re-ask the currently open question, no tool call.
_REPEAT_LATIN = re.compile(
    r"(kya\s+(pu|poo)\w*"
    r"|kya\s+(bola|bole|kaha|kaho)\b"
    r"|pich\w*\s+kya"
    r"|pehle\s+kya"
    r"|phir\s+se|fir\s+se|dobara|dubara|ek\s+baar\s+(aur|phir)"
    r"|samajh\s+nahi|samjha\s+nahi|sun\s+nahi|suna\s+nahi"
    r"|\brepeat\b|say\s+again|\bpardon\b|what\s+did\s+you\s+(say|ask)|what\s+was\s+the\s+question"
    # STT often garbles "repeat" on phone lines ("Parali, please" in a real call), and callers say these too
    r"|\bre+p[ei]+a?t\w*|\bri+p[ei]+a?t\w*|\bpa+r[ae]li\b"
    r"|once\s+more|one\s+more\s+time|come\s+again|again\s+please|phir\s+bolo|fir\s+bolo|dobara\s+bolo)",
    re.I,
)
_REPEAT_DEV = re.compile(
    r"(क्या\s*(पूछ|पुछ|बोल|कहा)|पिछले\s*क्या|पहले\s*क्या|दोबारा|फिर\s*से|रिपीट|समझ\s*नहीं|सुन\s*नहीं)"
)


def _asks_repeat(text: str) -> bool:
    if not text:
        return False
    if _REPEAT_DEV.search(text):
        return True
    cands = [text]
    try:
        from src.transliteration import romanize_hindi
        cands.append(romanize_hindi(text))
    except Exception:
        pass
    return any(_REPEAT_LATIN.search((c or "").lower()) for c in cands)


def _chunk_text(chunk):
    """Text carried by an llm_node chunk (str or ChatChunk); None for tool-call/empty chunks."""
    if isinstance(chunk, str):
        return chunk
    delta = getattr(chunk, "delta", None)
    return getattr(delta, "content", None) if delta else None


def _chunk_has_tool_call(chunk) -> bool:
    """True for a genuine (structured) tool-call chunk."""
    if isinstance(chunk, str):
        return False
    delta = getattr(chunk, "delta", None)
    return bool(delta and getattr(delta, "tool_calls", None))


# A tool call typed as text ANYWHERE in the reply (not just at the start), e.g.
# "Third floor, noted Sir. <function=save_property_details>{...}</function> Is the property leased?"
_INLINE_CALL_RE = re.compile(
    r'<function[=\s>]'
    r'|"name"\s*:\s*"[a-z]+(?:_[a-z0-9]+)+"'
    r'|\b[a-z]+(?:_[a-z0-9]+)+\s*[\(\{]'
)

_Q_LEAD_RE = re.compile(r"^(?:ji sir|sure sir|sorry sir|sir)\s*[,.]?\s+", re.I)


def _extract_question(spoken: str) -> str:
    """The question part of a spoken line: from the first sentence that ends with '?' to the end.
    Drops acks like 'Okay.' and re-ask leads like 'Ji Sir,' so a later 'repeat' sounds clean."""
    parts = re.split(r"(?<=[.!?।])\s+", (spoken or "").strip())
    for i, p in enumerate(parts):
        if p.rstrip().endswith("?"):
            q = " ".join(parts[i:]).strip()
            return _Q_LEAD_RE.sub("", q).strip()
    return ""


def _parse_text_tool_call(raw: str):
    """Best-effort parse of a text-typed tool call, tolerant of truncated JSON."""
    m = (
        re.search(r'"name"\s*:\s*"([A-Za-z_]\w*)"', raw)
        or re.match(r'\s*<function=([A-Za-z_]\w*)', raw)
        or re.match(r'\s*([a-z]+(?:_[a-z0-9]+)+)\s*[\(\{]', raw)
    )
    if not m:
        return None, {}
    name = m.group(1)
    pm = re.search(r'"(?:parameters|arguments)"\s*:\s*\{(.*)', raw, re.S)
    body = pm.group(1) if pm else raw
    args = {}
    for k, v in re.findall(r'"(\w+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)', body):
        if k == "name" or v == "null":
            continue
        if v.startswith('"'):
            try:
                val = json.loads(v)
            except Exception:
                val = v.strip('"')
        elif v in ("true", "false"):
            val = v == "true"
        else:
            val = float(v) if "." in v else int(v)
        args[k] = val
    return name, args


class RealEstateAgent(Agent):
    """Voice agent for My Estate Finder property intake (Priya)."""

    def __init__(self, state: RealEstateState, tools_instance):
        self._re_state = state
        self._re_tools = tools_instance
        self.on_language_change = None
        super().__init__(
            instructions=get_step_instructions(state),
            tools=tools_instance.tools_for_step(state.step),
        )

    async def sync_step(self):
        """Sync instructions and available tools when step changes."""
        await self.update_instructions(get_step_instructions(self._re_state))
        await self.update_tools(self._re_tools.tools_for_step(self._re_state.step))

    async def on_user_turn_completed(self, turn_ctx, new_message):
        # LATENCY: a new customer turn invalidates any unspoken fast reply left over from an
        # interrupted previous turn.
        self._re_state.direct_reply = None

        # Closing line is already being spoken: ignore anything the customer says now
        # (e.g. 'haan haan theek hai') so it cannot trigger a second reply.
        if self._re_state.closing_spoken:
            raise StopResponse()
        text = (getattr(new_message, "text_content", None) or "").strip()
        kind = classify_carrier_message(text)
        if kind:
            logger.warning(f"📵 Carrier announcement ({kind}) ignored: '{text[:100]}'")
            raise StopResponse()

        state = self._re_state
        state.last_user_text = text
        low_text = text.lower()

        # Caller says "standalone" / "independent" property -> no unit number or floor exists, so
        # get_missing_fields() stops asking for them. Checked on every pre-closing intake turn.
        from .tools import is_standalone_from_speech
        from .state import RealEstateStep as _SS
        standalone_changed = False
        if (
            not state.is_standalone
            and state.step in (
                _SS.CATEGORY_SELECT, _SS.ASK_NEW_LOCATION,
                _SS.RESIDENTIAL_SALE, _SS.RESIDENTIAL_LEASE,
                _SS.COMMERCIAL_SALE, _SS.COMMERCIAL_LEASE,
            )
            and is_standalone_from_speech(text)
        ):
            state.is_standalone = True
            standalone_changed = True
            logger.info(f"🏠 Standalone/independent property -> unit & floor will be skipped: '{text}'")

        # Caller asks us to repeat / says "what did you ask?" -> re-ask the open question (no LLM,
        # no tool call, nothing skipped). Runs BEFORE category detection because the caller's
        # words often quote the question itself ("residential hai ya commercial hai na?").
        from .state import RealEstateStep as _S
        from .tools import classify_category, classify_intent
        _intake = (_S.RESIDENTIAL_SALE, _S.RESIDENTIAL_LEASE, _S.COMMERCIAL_SALE, _S.COMMERCIAL_LEASE)
        if state.step in _intake or state.step == _S.CATEGORY_SELECT:
            _neutral = _is_neutral_utterance(text)
            _reask = None
            if state.step == _S.CATEGORY_SELECT and (_asks_repeat(text) or _neutral):
                # A bare "haan"/"ji" does not answer "residential or commercial? sell or rent?"
                # (often it is just a backchannel that interrupted the question).
                _cat, _int = classify_category(text), classify_intent(text)
                if _asks_repeat(text) or not (_cat or _int):
                    en = state.reply_lang == "en"
                    if state.category and not state.intent:
                        _reask = "Are you looking to sell or rent it out?" if en else "Aap ise sell karna chahte hain ya rent par dena chahte hain?"
                    elif state.intent and not state.category:
                        _reask = "Is it a residential or commercial property?" if en else "Yeh residential property hai ya commercial?"
                    else:
                        _reask = (
                            "Is it a residential or commercial property? And are you looking to sell or rent it out?"
                            if en else
                            "Yeh residential property hai ya commercial? Aur aap ise sell karna chahte hain ya rent par dena chahte hain?"
                        )
            elif state.step in _intake and _asks_repeat(text):
                _missing = state.get_missing_fields()
                if _missing:
                    _reask = _missing[0]["question_en"] if state.reply_lang == "en" else _missing[0]["question_hi"]
            if _reask:
                lead = "Sure Sir, " if state.reply_lang == "en" else "Ji Sir, "
                logger.info(f"🔁 Repeat/backchannel -> re-asking open question (no LLM): '{_reask}'")
                try:
                    self.session.say(lead + _reask, allow_interruptions=True)
                except Exception as e:
                    logger.warning(f"Re-ask failed, falling back to LLM: {e}")
                else:
                    raise StopResponse()

        # "Repeat" at ANY other step (intro, other-property, new location, name): say the last question
        # we actually asked, verbatim. Repeating only happens when the caller asks for it.
        if state.step not in _intake and state.step != _S.CATEGORY_SELECT and state.step != _S.CLOSING \
                and _asks_repeat(text) and state.last_agent_question:
            lead = "Sure Sir, " if state.reply_lang == "en" else "Ji Sir, "
            logger.info(f"🔁 Repeat requested -> re-asking last question (no LLM): '{state.last_agent_question}'")
            try:
                self.session.say(lead + state.last_agent_question, allow_interruptions=True)
            except Exception as e:
                logger.warning(f"Re-ask failed, falling back to LLM: {e}")
            else:
                raise StopResponse()

        impatient_phrases = (
            "jaldi bolo", "jaldi batao", "time nahi", "time nhi", "bahut sawal", "kitna sawal",
            "kitne sawal", "hurry up", "don't have time", "dont have time", "wrap it up",
            "seedha point", "stop asking", "bakwas band", "short me bolo", "short mein",
        )
        if any(p in low_text for p in impatient_phrases):
            logger.info(f"⚠️ Impatience pattern detected in caller utterance: '{text}'")
            state.impatient_detected = True

        # Proactively detect category & intent directly from caller utterance
        from .tools import classify_category, classify_intent, commercial_type_from_speech
        from .state import RealEstateStep

        detected_cat = classify_category(text)
        detected_int = classify_intent(text)
        step_changed = False

        if detected_cat:
            old_cat = state.category
            state.category = detected_cat
            if detected_cat == "commercial":
                state.bhk_config = None
                # Keep exactly what the caller said as the unit type ("office", "shop"...). Never assumed:
                # if they only said "commercial", the type stays empty and is asked next.
                _said = commercial_type_from_speech(text)
                if _said and _said != "Other" and not state.commercial_type:
                    state.commercial_type = _said
                    logger.info(f"🏢 Commercial unit type from caller's words: '{_said}'")
                if state.step == RealEstateStep.RESIDENTIAL_SALE:
                    state.step = RealEstateStep.COMMERCIAL_SALE
                    step_changed = True
                elif state.step == RealEstateStep.RESIDENTIAL_LEASE:
                    state.step = RealEstateStep.COMMERCIAL_LEASE
                    step_changed = True
            elif detected_cat == "residential":
                state.commercial_type = None
                if state.step == RealEstateStep.COMMERCIAL_SALE:
                    state.step = RealEstateStep.RESIDENTIAL_SALE
                    step_changed = True
                elif state.step == RealEstateStep.COMMERCIAL_LEASE:
                    state.step = RealEstateStep.RESIDENTIAL_LEASE
                    step_changed = True
            if old_cat != detected_cat:
                logger.info(f"🏷️ Proactively recognized property category: '{detected_cat}' from utterance: '{text}'")

        if detected_int and not state.intent:
            state.intent = detected_int
            logger.info(f"🎯 Proactively recognized intent: '{detected_int}' from utterance: '{text}'")

        if state.step in (RealEstateStep.CATEGORY_SELECT, RealEstateStep.ASK_NEW_LOCATION) and state.category and state.intent:
            if state.category == "commercial":
                state.step = RealEstateStep.COMMERCIAL_LEASE if state.intent == "lease" else RealEstateStep.COMMERCIAL_SALE
            else:
                state.step = RealEstateStep.RESIDENTIAL_LEASE if state.intent == "lease" else RealEstateStep.RESIDENTIAL_SALE
            step_changed = True

        if standalone_changed and not step_changed:
            # MUST be synchronous: otherwise the LLM could still see the old "ask unit & floor" instruction.
            try:
                await self.update_instructions(get_step_instructions(state))
            except Exception as e:
                logger.warning(f"Failed to refresh instructions after standalone detection: {e}")

        # Greetings / backchannels like "Hello." must not flip the reply language.
        lang_switched = False if _is_neutral_utterance(text) else state.update_reply_lang(text)
        if lang_switched or state.impatient_detected or step_changed:
            lang = state.reply_lang
            if lang_switched:
                logger.info(f"🌐 Customer switched language -> {lang}")
                if self.on_language_change:
                    try:
                        self.on_language_change(lang)
                    except Exception as e:
                        logger.warning(f"Language switch callback failed: {e}")

            if step_changed:
                # MUST be synchronous: the tool set changes, so the LLM must see the correct
                # tools *before* it starts generating. Running this as a background task causes
                # the LLM to run with stale tools, which leads to wrong step transitions and
                # premature closings (issues #1 and #2).
                try:
                    await self.update_instructions(get_step_instructions(state))
                    await self.update_tools(self._re_tools.tools_for_step(state.step))
                    logger.info(f"Step sync'd ({state.step.value}): instructions + tools updated.")
                except Exception as e:
                    logger.warning(f"Failed to refresh instructions/tools on step change: {e}")
            else:
                # Instruction-only refresh (language switch / impatience): tool set stays the same,
                # so it is safe to run as a background task without delaying LLM dispatch.
                _agent = self
                async def _refresh_lang_instructions():
                    try:
                        await _agent.update_instructions(get_step_instructions(state))
                    except Exception as e:
                        logger.warning(f"Failed to refresh instructions: {e}")
                asyncio.create_task(_refresh_lang_instructions())

        # Caller asks "what rate / what price can I get?" during intake -> valuation line + closing,
        # spoken deterministically (no LLM round trip), then the call ends.
        if (
            state.step in (
                RealEstateStep.RESIDENTIAL_SALE, RealEstateStep.RESIDENTIAL_LEASE,
                RealEstateStep.COMMERCIAL_SALE, RealEstateStep.COMMERCIAL_LEASE,
            )
            and not state.closing_spoken
            and _asks_agent_for_price(text)
        ):
            logger.info(f"💰 Caller asked for price/valuation -> valuation closing (no LLM): '{text}'")
            state.valuation_requested = True
            try:
                await self._re_tools.book_advisor_handoff(reason="Price valuation requested")
            except Exception as e:
                logger.warning(f"Valuation closing failed, falling back to LLM: {e}")
                state.valuation_requested = False
            else:
                raise StopResponse()

    async def llm_node(self, chat_ctx, tools, model_settings):
        """Prevent hallucinated second tool call when last item was tool output.

        LATENCY: when the tool already decided the exact next line (state.direct_reply), speak it
        directly instead of making a second LLM round trip just to read it out."""
        if self._re_state.closing_spoken:
            return  # closing is spoken deterministically via session.say
        items = getattr(chat_ctx, "items", None) or []
        if items and getattr(items[-1], "type", None) == "function_call_output":
            reply = self._re_state.direct_reply
            if reply:
                self._re_state.direct_reply = None
                logger.info(f"⚡ FAST_REPLY (2nd LLM call skipped): '{reply}'")
                yield reply
                return
            tools = []

        # LATENCY: cap history sent to the LLM (fewer prompt tokens -> faster TTFT). The system
        # instructions are preserved by truncate(); step instructions already hold the open question.
        if CHAT_CTX_MAX_ITEMS > 0 and len(items) > CHAT_CTX_MAX_ITEMS:
            try:
                chat_ctx = chat_ctx.copy()
                chat_ctx.truncate(max_items=CHAT_CTX_MAX_ITEMS)
            except Exception as e:
                logger.debug(f"chat_ctx truncate skipped: {e}")

        # Stream the LLM, but HOLD its text until the generation ends. Why: Llama often says a sentence
        # AND calls a tool in the same turn. The tool then speaks the canonical next question (FAST_REPLY),
        # so the caller heard two questions (the LLM's own, frequently for the wrong field, plus ours) and
        # questions got repeated. Tool-call chunks are still forwarded immediately, so tool turns lose no time
        # (the call has to finish before the tool can run anyway); only text-only turns wait for the short
        # reply to finish.
        #   - real tool call in this generation -> drop the LLM text; the tool's reply is the only thing spoken
        #   - tool call typed as text (anywhere in the reply) -> recover it, speak the canonical reply
        #   - plain speech -> flush as-is
        held = []
        saw_tool = False
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            if _chunk_has_tool_call(chunk):
                saw_tool = True
                yield chunk
                continue
            if not _chunk_text(chunk):
                yield chunk                      # empty / metadata chunk
                continue
            held.append(chunk)

        full = "".join(_chunk_text(c) or "" for c in held)
        if saw_tool:
            if full.strip():
                logger.info(f"🔇 Dropped LLM text that came with a tool call (avoids double question): {full.strip()[:140]!r}")
            return
        m = _INLINE_CALL_RE.search(full)
        if m or _TEXT_CALL_RE.match(full):
            start = m.start() if m else 0
            if m and m.group(0).startswith('"name"'):
                brace = full.rfind("{", 0, m.start())
                start = brace if brace >= 0 else m.start()
            recovered = await self._recover_text_tool_call(full[start:])
            if recovered:
                yield recovered
            return
        for c in held:
            yield c

    async def _recover_text_tool_call(self, raw: str):
        """The LLM typed a tool call as text. Execute it safely and return the line to speak."""
        state = self._re_state
        name, args = _parse_text_tool_call(raw)
        logger.warning(f"🩹 Tool call typed as text -> recovering: name={name} args={args} raw={raw[:160]!r}")

        allowed = set()
        for t in self._re_tools.tools_for_step(state.step):
            n = getattr(getattr(t, "info", None), "name", None) or getattr(t, "__name__", None)
            if n:
                allowed.add(n)

        try:
            if name in allowed:
                fn = getattr(self._re_tools, name, None)
                if name == "save_property_details":
                    # Trust ONLY the field we just asked about; the text-typed JSON often contains
                    # invented values for every other field.
                    missing = state.get_missing_fields()
                    keep = _FIELD_TO_PARAMS.get(missing[0]["id"], ()) if missing else ()
                    safe = {k: v for k, v in args.items() if k in keep}
                    if safe:
                        await fn(**safe)
                elif fn is not None:
                    try:
                        await fn(**args)
                    except TypeError:
                        await fn()
        except Exception as e:
            logger.warning(f"Recovered tool call failed: {e}")

        if state.closing_spoken:
            return None                      # closing line is spoken via session.say
        reply, state.direct_reply = state.direct_reply, None
        if reply:
            logger.info(f"⚡ RECOVERED reply: '{reply}'")
            return reply

        # Nothing usable -> never stay silent: re-ask the question that is currently open.
        missing = state.get_missing_fields()
        en = state.reply_lang == "en"
        if missing:
            q = missing[0]["question_en"] if en else missing[0]["question_hi"]
            lead = "Sorry Sir, I missed that. " if en else "Sorry Sir, main sun nahi payi. "
            return lead + q
        return "Sorry Sir, could you please repeat that?" if en else "Sorry Sir, kya aap dobara bata sakte hain?"

    def tts_node(self, text, model_settings):
        """Safety net. LLM output arrives as tiny token fragments, so we buffer until a full
        sentence is complete and only then strip leaked tool-call text. Whitespace between
        tokens is preserved (never strip() individual chunks)."""
        async def guard():
            buf = ""
            async for chunk in text:
                buf += chunk
                if not _call_open(buf) and buf.rstrip().endswith((".", "?", "!", "\u0964")):
                    out, buf = _clean_leaks(buf), ""
                    if out.strip():
                        _q = _extract_question(out)
                        if _q:
                            self._re_state.last_agent_question = _q   # for "repeat that"
                        yield out
            out = _clean_leaks(buf)
            if out.strip():
                _q = _extract_question(out)
                if _q:
                    self._re_state.last_agent_question = _q
                yield out

        return Agent.default.tts_node(self, guard(), model_settings)
        