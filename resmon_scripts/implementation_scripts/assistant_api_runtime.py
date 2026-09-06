"""The assistant for someone who has a key rather than a subscription.

2.0a's runtime drives the ``claude`` CLI, which brings its own agent loop, its
own MCP client and its own permission hook. A user with an OpenAI or Anthropic
key and no CLI got nothing at all, and decision 1 of the phase brief says so in
as many words: *"so a user without a CLI is not locked out — but not first"*.

This is resmon's own loop over the same ``mcp_server.TOOLS``, emitting the same
events, pausing at the same card, with the same constitution above the
conversation. What is *not* the same is written down below rather than left for
someone to discover.

## What is genuinely identical, and why it is not a resemblance

**The permission pause is one function.** Both runtimes call
``assistant_permission_server.ask_backend`` — the CLI's copy reaches it as an
MCP tool in a separate process, this one as a call on its worker thread — so
"the same pause" is a fact about the code rather than two things that look
alike. A card, a blocked caller, and deny on anything that is not an explicit
allow.

**The tools are one list.** ``mcp_server.TOOLS`` converted per family; a tool
added there is offered here with no edit, and
``test_every_tool_converts_for_every_family`` parametrises over the list so it
cannot be otherwise.

**The write set is one list.** ``mcp_server.WRITE_TOOLS`` decides what waits for
a person, exactly as it decides the CLI's ``--allowedTools``.

## What is different, and is said out loud

**A stateless API has no session to resume.** The CLI keeps the conversation and
resmon hands it a session id; here resmon *is* the memory. Past turns are
replayed as **text only** — what was asked and what was answered — and the tool
calls and their results are not. Three reasons, in order of weight: replaying
stored tool results re-injects untrusted abstract text into every later turn,
for ever; a transcript's worth of tool output is paid for again on every turn;
and reconstructing exactly-paired ``tool_use``/``tool_result`` blocks across a
transcript that may have been truncated is a source of malformed requests. So
the model sees the conversation and not the raw evidence behind it, and the
Settings tab says that.

**The ceiling is steps and tokens, not dollars.** ``claude`` enforces
``--max-budget-usd`` on itself and reports ``total_cost_usd``; a raw provider
API reports tokens and resmon does not know anyone's price list. Inventing a
cost from a price table this app does not maintain would be exactly the kind of
plausible number resmon refuses to render, so **cost is reported as unknown**
(the store keeps NULL, the panel says "not reported") and the guard is on two
things resmon can actually count. The numbers come from 2.0a's measured table
rather than from taste — see ``MAX_TOOL_ITERATIONS`` and ``MAX_TURN_TOKENS``.

**There is no prompt caching to lean on.** Every iteration re-sends the
constitution and the tool schemas, which is why the step ceiling is low.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Optional

import httpx

from .assistant_constitution import load_assistant_constitution
from .assistant_tool_calling import tool_calling
from .credential_manager import AI_CREDENTIAL_NAMES, get_credential

logger = logging.getLogger(__name__)

__all__ = [
    "ApiKeyRuntime",
    "MAX_TOOL_ITERATIONS",
    "MAX_TURN_TOKENS",
    "history_to_text_turns",
    "tools_for_family",
]

# How many times one turn may go round the loop: model → tools → model.
#
# **Four is the most any of 2.0a's ten canonical requests needed** (create-routine,
# which read the sources, created the routine, waited for the card and read the
# result back). Eight is twice that. A loop is what a runaway looks like here —
# there is no per-call cost figure to stop on — and a turn that has called ten
# rounds of tools has stopped answering the question it was asked.
MAX_TOOL_ITERATIONS = 8

# And a ceiling on what one turn may consume, counted from what the provider
# reports rather than estimated.
#
# 2.0a's dearest measured turn was ~53,400 tokens in and out together. This is
# twice that, rounded down to a round number. It is a **runaway stop, not a
# quota**: the guard against ordinary turns getting dearer is a measurement, and
# this is the thing that ends a loop nobody is watching.
MAX_TURN_TOKENS = 100_000

# One provider call. Long enough for a slow model on a long context; short
# enough that a turn cannot hang a worker thread indefinitely.
REQUEST_TIMEOUT = httpx.Timeout(180.0, connect=10.0)


@dataclass
class _Usage:
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens


# ---------------------------------------------------------------------------
# The tool table, in each family's shape
# ---------------------------------------------------------------------------

def tools_for_family(family: str) -> list[dict]:
    """``mcp_server.TOOLS`` as *family* wants to receive it.

    The names are the tools' own — no ``mcp__resmon__`` prefix, because there is
    no MCP server in this path and a prefix would be a fiction about how the
    call is made. The panel already shows the short name for the CLI path, so
    the two agree on screen.
    """
    import mcp_server  # noqa: PLC0415 — a sibling script, not a package

    if family == "anthropic":
        return [{
            "name": tool["name"],
            "description": tool["description"],
            "input_schema": tool["schema"],
        } for tool in mcp_server.TOOLS]

    if family == "openai":
        return [{
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["schema"],
            },
        } for tool in mcp_server.TOOLS]

    if family == "google":
        # Gemini takes one `tools` entry holding every declaration, and rejects
        # JSON-Schema keywords it does not know — `default` among them, which
        # several of resmon's schemas carry.
        return [{"function_declarations": [{
            "name": tool["name"],
            "description": tool["description"],
            "parameters": _gemini_schema(tool["schema"]),
        } for tool in mcp_server.TOOLS]}]

    raise ValueError(f"no tool shape for family {family!r}")


def _gemini_schema(schema: Any) -> Any:
    """A JSON schema Gemini accepts: its keyword set, not JSON Schema's.

    ``default`` and ``$schema`` are rejected outright rather than ignored, and
    several of resmon's tool schemas carry a ``default``. Stripped rather than
    rewritten: a default the model cannot see is a default the *tool* still
    applies, because the handler reads it from the arguments it was given.
    """
    if isinstance(schema, dict):
        return {key: _gemini_schema(value) for key, value in schema.items()
                if key not in ("default", "$schema", "additionalProperties")}
    if isinstance(schema, list):
        return [_gemini_schema(item) for item in schema]
    return schema


# ---------------------------------------------------------------------------
# The conversation, rebuilt from resmon's own transcript
# ---------------------------------------------------------------------------

def history_to_text_turns(history: Optional[list[dict]]) -> list[dict]:
    """Past turns as ``{"role": ..., "text": ...}``, text only.

    System notices are dropped: they are resmon talking to the person about the
    conversation, not part of it, and feeding them back would have the model
    explaining resmon's own plumbing. Empty assistant turns — a turn that only
    called tools — are dropped too, because a message with no content is a
    request error on more than one provider.
    """
    turns: list[dict] = []
    for message in history or []:
        role = message.get("role")
        text = str(message.get("content") or "").strip()
        if role not in ("user", "assistant") or not text:
            continue
        turns.append({"role": role, "text": text})
    return turns


# ---------------------------------------------------------------------------
# The runtime
# ---------------------------------------------------------------------------

class ApiKeyRuntime:
    """resmon's own agent loop, over a provider the user has a key for."""

    kind = "api_key"

    def __init__(
        self,
        *,
        provider: str,
        model: str,
        backend_port: Optional[int] = None,
        base_url: Optional[str] = None,
        custom_base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        max_iterations: int = MAX_TOOL_ITERATIONS,
        max_tokens: int = MAX_TURN_TOKENS,
    ) -> None:
        self.provider = (provider or "").strip().lower()
        self.model = (model or "").strip()
        self.backend_port = backend_port
        # Only for tests and for a custom endpoint: everything else resolves
        # from ``llm_remote._PROVIDER_SPECS``, one table for both lanes.
        self._base_url = base_url
        self.custom_base_url = (custom_base_url or "").strip()
        self._api_key = api_key
        self.max_iterations = max_iterations
        self.max_tokens = max_tokens
        self.answer = tool_calling(self.provider)

    # -- availability ---------------------------------------------------

    def status(self):
        from .assistant_runtime import RuntimeStatus  # noqa: PLC0415 - cycle

        if not self.provider:
            return RuntimeStatus(
                self.kind, False,
                "No AI provider is chosen for the assistant. Pick one in "
                "Settings → AI, under Assistant.")
        if not self.answer.offered:
            return RuntimeStatus(self.kind, False, self.answer.assistant_reason)
        if not self.model:
            return RuntimeStatus(
                self.kind, False,
                f"No model is chosen for the assistant on {self.provider}. Pick "
                "one in Settings → AI, under Assistant.")
        if self.provider == "custom" and not self.custom_base_url:
            return RuntimeStatus(
                self.kind, False,
                "A custom endpoint needs its base URL, which is set with the "
                "custom provider in Settings → AI.")
        if not self._key():
            alias = self._alias()
            return RuntimeStatus(
                self.kind, False,
                f"No {self.provider} API key is stored. Add one under "
                f"Repositories & API Keys ({alias}); resmon reads it from your "
                "system keychain and never puts it in a conversation.")
        # Deliberately not "ready". Nothing here has spent a token, so nothing
        # here knows the key is accepted -- the same line every other surface in
        # resmon draws between found and working.
        return RuntimeStatus(
            self.kind, True,
            f"resmon will drive {self.provider} ({self.model}) with your own key. "
            "Whether the key is accepted is not known until the first turn.",
            how="api_key",
        )

    def _alias(self) -> str:
        return ("custom_llm_api_key" if self.provider == "custom"
                else f"{self.provider}_api_key")

    def _key(self) -> Optional[str]:
        """The key, fetched at use time and never stored on the instance.

        Same rule as ``llm_factory``: a lane names the slot it needs, and the
        value is looked up when it is needed rather than carried around.
        """
        if self._api_key:
            return self._api_key
        alias = self._alias()
        if alias in AI_CREDENTIAL_NAMES or alias == "custom_llm_api_key":
            return get_credential(alias)
        return None

    def base_url(self) -> str:
        if self._base_url:
            return self._base_url.rstrip("/")
        if self.provider == "custom":
            return self.custom_base_url.rstrip("/")
        if self.provider == "anthropic":
            return "https://api.anthropic.com"
        if self.provider == "google":
            return "https://generativelanguage.googleapis.com"
        from .llm_remote import _PROVIDER_SPECS  # noqa: PLC0415

        spec = _PROVIDER_SPECS.get(self.provider)
        if spec is None:
            raise ValueError(f"no base URL for provider {self.provider!r}")
        return spec.base_url.rstrip("/")

    # -- running --------------------------------------------------------

    def run_turn(
        self,
        session_id: int,
        prompt: str,
        *,
        cli_session_id: str = "",
        resume: bool = False,
        on_event: Optional[Callable[[dict], None]] = None,
        history: Optional[list[dict]] = None,
    ) -> Iterator[dict]:
        """One turn: model, tools, model, until it stops asking for tools.

        ``cli_session_id`` and ``resume`` are accepted and unused — the protocol
        is the CLI runtime's and a stateless API has no session to resume. Said
        here rather than silently ignored.
        """
        emit = on_event or (lambda _event: None)
        try:
            yield from self._loop(session_id, prompt, history, emit)
        except Exception as exc:                     # noqa: BLE001
            # Nothing escapes into a half-written SSE response: a truncated
            # stream is, in a panel, indistinguishable from a model that stopped
            # mid-sentence. 1.9a shipped that bug twice.
            logger.exception("API-key assistant turn failed")
            event = {
                "type": "error",
                "message": _sentence_for(exc, self.provider, self._key()),
                "detail": type(exc).__name__,
            }
            emit(event)
            yield event

    def _loop(
        self, session_id: int, prompt: str,
        history: Optional[list[dict]], emit: Callable[[dict], None],
    ) -> Iterator[dict]:
        status = self.status()
        if not status.available:
            event = {"type": "error", "message": status.reason, "detail": "unavailable"}
            emit(event)
            yield event
            return

        self._point_tools_at_this_backend()
        family = self.answer.family or "openai"
        tools = tools_for_family(family)
        constitution = load_assistant_constitution()
        conversation = _new_conversation(family, history_to_text_turns(history), prompt)
        usage = _Usage()

        started = {
            "type": "started",
            "cli_session_id": None,
            "model": self.model,
            "tools": [tool["name"] for tool in _mcp_tools()],
            "mcp_servers": [],
            "runtime": self.kind,
            "provider": self.provider,
        }
        emit(started)
        yield started

        for iteration in range(self.max_iterations):
            reply = self._call(family, constitution, tools, conversation, usage)

            for text in reply["texts"]:
                event = {"type": "text_delta", "text": text}
                emit(event)
                yield event

            if not reply["tool_calls"]:
                yield from _emit_done(emit, usage, "success")
                return

            _append_assistant_turn(family, conversation, reply)

            for call in reply["tool_calls"]:
                for event in self._run_one_tool(session_id, family, conversation, call):
                    emit(event)
                    yield event

            if usage.total >= self.max_tokens:
                message = (
                    f"That turn reached resmon's per-answer limit of "
                    f"{self.max_tokens:,} tokens and was stopped part-way. Ask for "
                    f"something narrower — a smaller page of results, or one "
                    f"question at a time."
                )
                event = {"type": "error", "message": message, "detail": "token_ceiling"}
                emit(event)
                yield event
                yield from _emit_done(emit, usage, "error_token_ceiling", is_error=True)
                return

        message = (
            f"The assistant used all {self.max_iterations} of the tool steps resmon "
            f"allows in one answer and was stopped. Ask for one thing at a time."
        )
        event = {"type": "error", "message": message, "detail": "iteration_ceiling"}
        emit(event)
        yield event
        yield from _emit_done(emit, usage, "error_iteration_ceiling", is_error=True)

    def _point_tools_at_this_backend(self) -> None:
        """Pin ``mcp_server``'s client to the backend this runtime belongs to.

        The CLI path gets this for free: resmon writes ``RESMON_PORT`` into the
        MCP config it hands the CLI, explicitly, because 2.0a found that falling
        back to the default port attached the tools to a **different resmon** —
        a launchd daemon over a different database, answering every question
        truthfully about the wrong corpus.

        In-process the same hazard exists in a quieter form: ``mcp_server``
        would otherwise discover a port for itself, and on a machine running two
        resmons it could discover the other one. Naming it is the same rule
        applied to the same client from the other side.
        """
        if not self.backend_port:
            return
        import mcp_server  # noqa: PLC0415

        mcp_server.backend._base = f"http://127.0.0.1:{self.backend_port}"
        mcp_server.backend._tried = []

    def _run_one_tool(
        self, session_id: int, family: str, conversation: dict, call: dict,
    ) -> Iterator[dict]:
        """Announce a call, ask about it if it writes, run it, report the result."""
        import mcp_server  # noqa: PLC0415

        yield {
            "type": "tool_call",
            "tool_name": call["name"],
            "raw_name": call["name"],
            "input": call["arguments"],
            "tool_use_id": call["id"],
        }

        if call["name"] in mcp_server.WRITE_TOOLS:
            verdict = self._ask_permission(session_id, call)
            if verdict.get("behavior") != "allow":
                content = str(verdict.get("message") or "You did not allow this.")
                _append_tool_result(family, conversation, call, content, is_error=True)
                yield {
                    "type": "tool_result", "tool_use_id": call["id"],
                    "is_error": True, "content": content,
                }
                return

        result = mcp_server.call_tool(call["name"], call["arguments"])
        content = "\n".join(
            block.get("text", "") for block in result.get("content") or []
            if isinstance(block, dict)
        )
        _append_tool_result(family, conversation, call, content,
                            is_error=bool(result.get("isError")))
        yield {
            "type": "tool_result", "tool_use_id": call["id"],
            "is_error": bool(result.get("isError")), "content": content,
        }

    def _ask_permission(self, session_id: int, call: dict) -> dict:
        """The same card, through the same endpoint, as the CLI path.

        A loopback HTTP call to this very backend rather than a direct call into
        the broker: the broker's own docstring says every one of its methods is
        called from the event loop and that a caller from a worker thread would
        break it — and this runs on a worker thread. Going through the endpoint
        keeps that true, and keeps both runtimes on one path.
        """
        from assistant_permission_server import ask_backend  # noqa: PLC0415

        if not self.backend_port:
            return {"behavior": "deny",
                    "message": ("resmon could not be reached to ask you about this, "
                                "so it was not run.")}
        return ask_backend(
            f"http://127.0.0.1:{self.backend_port}", session_id,
            call["name"], call["arguments"], call["id"],
        )

    # -- the provider call ----------------------------------------------

    def _call(self, family: str, constitution: str, tools: list[dict],
              conversation: dict, usage: _Usage) -> dict:
        key = self._key() or ""
        if family == "anthropic":
            return self._call_anthropic(key, constitution, tools, conversation, usage)
        if family == "google":
            return self._call_google(key, constitution, tools, conversation, usage)
        return self._call_openai(key, constitution, tools, conversation, usage)

    def _post(self, url: str, *, headers: dict, payload: dict) -> dict:
        with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
            response = client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            return response.json()

    def _call_anthropic(self, key: str, constitution: str, tools: list[dict],
                        conversation: dict, usage: _Usage) -> dict:
        body = self._post(
            f"{self.base_url()}/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            payload={
                "model": self.model,
                "max_tokens": 4096,
                # The constitution above the conversation, not inside it. The
                # 1.8.4 failure was a lane that asked a model to follow rules it
                # was never given, and the fix is the same on every runtime.
                "system": constitution,
                "messages": conversation["messages"],
                "tools": tools,
            },
        )
        _add_usage(usage, (body.get("usage") or {}).get("input_tokens"),
                   (body.get("usage") or {}).get("output_tokens"))
        texts, calls = [], []
        for block in body.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and block.get("text"):
                texts.append(block["text"])
            elif block.get("type") == "tool_use":
                calls.append({"id": str(block.get("id") or ""),
                              "name": str(block.get("name") or ""),
                              "arguments": block.get("input") or {}})
        return {"texts": texts, "tool_calls": calls, "raw": body}

    def _call_openai(self, key: str, constitution: str, tools: list[dict],
                     conversation: dict, usage: _Usage) -> dict:
        messages = [{"role": "system", "content": constitution},
                    *conversation["messages"]]
        body = self._post(
            f"{self.base_url()}/chat/completions",
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json"},
            payload={"model": self.model, "messages": messages, "tools": tools},
        )
        _add_usage(usage, (body.get("usage") or {}).get("prompt_tokens"),
                   (body.get("usage") or {}).get("completion_tokens"))
        choice = (body.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        texts = [message["content"]] if message.get("content") else []
        calls = []
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            calls.append({
                "id": str(call.get("id") or ""),
                "name": str(function.get("name") or ""),
                "arguments": _loads(function.get("arguments")),
            })
        return {"texts": texts, "tool_calls": calls, "raw": body}

    def _call_google(self, key: str, constitution: str, tools: list[dict],
                     conversation: dict, usage: _Usage) -> dict:
        url = (f"{self.base_url()}/v1beta/models/{self.model}:generateContent"
               f"?key={key}")
        body = self._post(
            url, headers={"Content-Type": "application/json"},
            payload={
                "system_instruction": {"parts": [{"text": constitution}]},
                "contents": conversation["messages"],
                "tools": tools,
            },
        )
        meta = body.get("usageMetadata") or {}
        _add_usage(usage, meta.get("promptTokenCount"), meta.get("candidatesTokenCount"))
        texts, calls = [], []
        candidates = body.get("candidates") or []
        parts = ((candidates[0].get("content") or {}).get("parts") or []) if candidates else []
        for index, part in enumerate(parts):
            if not isinstance(part, dict):
                continue
            if part.get("text"):
                texts.append(part["text"])
            call = part.get("functionCall")
            if isinstance(call, dict) and call.get("name"):
                calls.append({
                    # Gemini's function calls carry no id of their own; the
                    # result is matched back by *name*. resmon still needs an id
                    # for the panel and the permission card, so one is minted
                    # and is deliberately not sent anywhere.
                    "id": f"call_{index}_{call['name']}",
                    "name": str(call["name"]),
                    "arguments": call.get("args") or {},
                })
        return {"texts": texts, "tool_calls": calls, "raw": body}


# ---------------------------------------------------------------------------
# Conversation bookkeeping, per family
# ---------------------------------------------------------------------------

def _new_conversation(family: str, turns: list[dict], prompt: str) -> dict:
    messages: list[dict] = []
    for turn in turns:
        if family == "google":
            messages.append({"role": "user" if turn["role"] == "user" else "model",
                             "parts": [{"text": turn["text"]}]})
        else:
            messages.append({"role": turn["role"], "content": turn["text"]})
    if family == "google":
        messages.append({"role": "user", "parts": [{"text": prompt}]})
    else:
        messages.append({"role": "user", "content": prompt})
    return {"family": family, "messages": messages}


def _append_assistant_turn(family: str, conversation: dict, reply: dict) -> None:
    messages = conversation["messages"]
    if family == "anthropic":
        content: list[dict] = [{"type": "text", "text": t} for t in reply["texts"]]
        content += [{"type": "tool_use", "id": c["id"], "name": c["name"],
                     "input": c["arguments"]} for c in reply["tool_calls"]]
        messages.append({"role": "assistant", "content": content})
    elif family == "google":
        parts: list[dict] = [{"text": t} for t in reply["texts"]]
        parts += [{"functionCall": {"name": c["name"], "args": c["arguments"]}}
                  for c in reply["tool_calls"]]
        messages.append({"role": "model", "parts": parts})
    else:
        messages.append({
            "role": "assistant",
            "content": "".join(reply["texts"]) or None,
            "tool_calls": [{"id": c["id"], "type": "function",
                            "function": {"name": c["name"],
                                         "arguments": json.dumps(c["arguments"])}}
                           for c in reply["tool_calls"]],
        })


def _append_tool_result(family: str, conversation: dict, call: dict,
                        content: str, *, is_error: bool) -> None:
    messages = conversation["messages"]
    if family == "anthropic":
        messages.append({"role": "user", "content": [{
            "type": "tool_result", "tool_use_id": call["id"],
            "content": content, "is_error": is_error,
        }]})
    elif family == "google":
        messages.append({"role": "user", "parts": [{"functionResponse": {
            "name": call["name"],
            "response": {"content": content, "is_error": is_error},
        }}]})
    else:
        messages.append({"role": "tool", "tool_call_id": call["id"],
                         "content": content})


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _mcp_tools() -> list[dict]:
    import mcp_server  # noqa: PLC0415

    return mcp_server.TOOLS


def _loads(raw: Any) -> dict:
    """A tool call's arguments, which arrive as a JSON *string* on this family.

    A model that emits unparseable arguments gets an empty object rather than an
    exception: the tool then refuses on its own terms and the model is told why,
    which is a better answer than a turn that died.
    """
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _add_usage(usage: _Usage, prompt: Any, completion: Any) -> None:
    for value, field in ((prompt, "input_tokens"), (completion, "output_tokens")):
        try:
            setattr(usage, field, getattr(usage, field) + int(value))
        except (TypeError, ValueError):
            pass


def _emit_done(emit: Callable[[dict], None], usage: _Usage, subtype: str,
               *, is_error: bool = False) -> Iterator[dict]:
    event = {
        "type": "done",
        "result_text": None,
        "subtype": subtype,
        "is_error": is_error,
        # **Not a number resmon has.** A provider API reports tokens, not money,
        # and resmon maintains no price list. NULL becomes "cost not reported"
        # in the panel, which is the truth; a computed figure would be a
        # measurement nobody made.
        "cost_usd": None,
        "input_tokens": usage.input_tokens or None,
        "output_tokens": usage.output_tokens or None,
        "cache_read_tokens": None,
        "cache_creation_tokens": None,
        "errors": [],
    }
    emit(event)
    yield event


def _sentence_for(exc: Exception, provider: str, secret: Optional[str]) -> str:
    """One sentence a person can act on, with the key stripped out.

    Built from what the provider said, never from a guess — and sanitised twice,
    once against this runtime's own key and once against the shapes, because an
    upstream can echo back a key this process never sent.
    """
    from .ai_errors import classify_exception  # noqa: PLC0415

    try:
        error = classify_exception(exc, provider=provider, model="",
                                   credential_alias=None, secret=secret or "")
        return str(error.message)
    except Exception:                                # pragma: no cover - defensive
        text = str(exc)
        if secret and secret in text:
            text = text.replace(secret, "[REDACTED]")
        return f"The {provider} API could not answer that turn: {text[:300]}"
