"""A real HTTP server speaking the three tool-calling shapes, for tests.

**Not a test double for the runtime.** ``assistant_api_runtime`` runs unchanged
against this: a real socket, a real ``httpx`` request, real status codes, real
JSON. The only thing that is not real is the model, whose replies a test scripts
turn by turn so the loop is deterministic.

That is the distinction the whole handback format turns on, and this file exists
because of it. The property under test is **what resmon sends** — where the
constitution lands, which tools are offered, how a tool result is fed back — and
that is only observable in the request body a server actually receives.
``calls`` keeps every one of them.

In the ledger, a row checked against this server is **real dependency,
in-process**: the socket and the HTTP stack are real, the provider is not, and
the row says so. What it cannot see is written down there too — whether the real
provider accepts these schemas, and whether a real model does anything sensible
with them.

## Scripting a turn

``server.script = [reply, reply, ...]`` — one entry per provider call, popped in
order. Each entry is ``{"text": str, "calls": [{"name":…, "arguments": {…}}]}``.
A reply with calls makes the runtime run tools and come back; a reply without
ends the turn. Running past the end of the script is a test bug and answers with
a plain text reply rather than looping for ever.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

__all__ = ["ProviderServer"]


class ProviderServer:
    """One loopback server that can answer as any of the three families."""

    def __init__(self, family: str) -> None:
        assert family in ("anthropic", "openai", "google"), family
        self.family = family
        self.calls: list[dict[str, Any]] = []
        self.script: list[dict] = []
        # "ok" | "unauthorized" | "error_500" | "no_such_route"
        self.mode = "ok"
        # Reported per call, so a test can drive the token ceiling without
        # scripting a hundred turns.
        self.tokens_per_call = (10, 5)
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    # -- lifecycle ----------------------------------------------------------

    def __enter__(self) -> "ProviderServer":
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # noqa: A003
                pass

            def _send(self, status: int, body: str) -> None:
                payload = body.encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8") if length else "{}"
                try:
                    request = json.loads(raw)
                except json.JSONDecodeError:
                    request = {}
                outer.calls.append({
                    "path": self.path,
                    "body": request,
                    # Every header a key could ride on, so a test can assert
                    # that it rode on the right one and on no other.
                    "authorization": self.headers.get("Authorization"),
                    "x_api_key": self.headers.get("x-api-key"),
                    "raw": raw,
                })

                if outer.mode == "unauthorized":
                    self._send(401, '{"error":{"message":"Incorrect API key provided"}}')
                    return
                if outer.mode == "error_500":
                    self._send(500, '{"error":{"message":"upstream is unwell"}}')
                    return
                if outer.mode == "no_such_route":
                    self._send(404, '{"error":{"message":"no such route"}}')
                    return

                reply = (outer.script.pop(0) if outer.script
                         else {"text": "nothing more was scripted", "calls": []})
                self._send(200, json.dumps(outer._render(reply)))

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True, name="provider-server")
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)

    @property
    def base_url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    # -- the three response shapes -----------------------------------------

    def _render(self, reply: dict) -> dict:
        text = reply.get("text") or ""
        calls = reply.get("calls") or []
        prompt_tokens, completion_tokens = self.tokens_per_call

        if self.family == "anthropic":
            content: list[dict] = []
            if text:
                content.append({"type": "text", "text": text})
            for index, call in enumerate(calls):
                content.append({"type": "tool_use", "id": f"toolu_{index}",
                                "name": call["name"], "input": call.get("arguments") or {}})
            return {"id": "msg_1", "type": "message", "role": "assistant",
                    "content": content,
                    "usage": {"input_tokens": prompt_tokens,
                              "output_tokens": completion_tokens}}

        if self.family == "google":
            parts: list[dict] = []
            if text:
                parts.append({"text": text})
            for call in calls:
                parts.append({"functionCall": {"name": call["name"],
                                               "args": call.get("arguments") or {}}})
            return {"candidates": [{"content": {"role": "model", "parts": parts}}],
                    "usageMetadata": {"promptTokenCount": prompt_tokens,
                                      "candidatesTokenCount": completion_tokens}}

        message: dict[str, Any] = {"role": "assistant", "content": text or None}
        if calls:
            message["tool_calls"] = [
                {"id": f"call_{index}", "type": "function",
                 "function": {"name": call["name"],
                              "arguments": json.dumps(call.get("arguments") or {})}}
                for index, call in enumerate(calls)
            ]
        return {"choices": [{"index": 0, "message": message,
                             "finish_reason": "tool_calls" if calls else "stop"}],
                "usage": {"prompt_tokens": prompt_tokens,
                          "completion_tokens": completion_tokens}}

    # -- reading what resmon sent ------------------------------------------

    def system_text(self, call: dict) -> str:
        """Whatever arrived on this family's *system* channel, as one string."""
        body = call["body"]
        if self.family == "anthropic":
            return str(body.get("system") or "")
        if self.family == "google":
            parts = (body.get("system_instruction") or {}).get("parts") or []
            return "".join(p.get("text", "") for p in parts)
        for message in body.get("messages") or []:
            if message.get("role") == "system":
                return str(message.get("content") or "")
        return ""

    def user_text(self, call: dict) -> str:
        """Everything that arrived in the conversation, system channel excluded."""
        body = call["body"]
        if self.family == "google":
            out = []
            for content in body.get("contents") or []:
                for part in content.get("parts") or []:
                    out.append(json.dumps(part))
            return "\n".join(out)
        out = []
        for message in body.get("messages") or []:
            if message.get("role") == "system":
                continue
            out.append(json.dumps(message.get("content")))
        return "\n".join(out)

    def tool_names(self, call: dict) -> list[str]:
        """The tool names offered on this call, in this family's shape."""
        tools = call["body"].get("tools") or []
        if self.family == "anthropic":
            return [t["name"] for t in tools]
        if self.family == "google":
            declarations = tools[0].get("function_declarations") if tools else []
            return [d["name"] for d in declarations or []]
        return [t["function"]["name"] for t in tools]
