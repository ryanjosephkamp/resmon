"""A real HTTP server that speaks the embedding protocols, for tests.

**Not a test double for the client.** ``embeddings.py`` is exercised unchanged
against this: a real socket, a real ``httpx`` request, real status codes, real
JSON, and the retry and timeout behaviour of the actual HTTP stack. The only
thing that is not real is the model on the far end, which returns a deterministic
vector so a ranking can be asserted.

That distinction is the reason this file exists rather than a ``monkeypatch`` of
``embed_texts``. Ledger 23: the MCP stub stripped the query string the bug lived
in, and the suite was structurally blind to it. A double that cannot fail the way
the real dependency fails is not evidence. This one *can* — it can refuse, 404,
return the wrong count, reorder a batch, and answer with Ollama's own "I cannot
embed" body — and each of those is a test below.

In the handback ledger, a row checked against this server is **real dependency,
in-process**: the socket and the HTTP stack are real, the upstream is not, and
the row says so.
"""

from __future__ import annotations

import hashlib
import json
import math
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

# The exact body Ollama 0.33.2 returns when the loaded model is a chat model.
# Copied verbatim from a live call on 2026-09-05 rather than paraphrased: P9 is
# about *this* string reaching the user as a capability answer, and a
# paraphrase would test resmon against resmon's idea of the message.
OLLAMA_CANNOT_EMBED_BODY = (
    '{"error":"This server does not support embeddings. '
    'Start it with `--embeddings`"}'
)

DEFAULT_DIMS = 8


def deterministic_vector(text: str, dims: int = DEFAULT_DIMS) -> list[float]:
    """A stable unit vector derived from *text*.

    Deterministic so a ranking is assertable, and normalised so distances are
    comparable. Similar strings do **not** get similar vectors — this is a hash,
    not a model — so a test that wants two documents close together builds them
    with the same text rather than with similar text.
    """
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    raw = [digest[i % len(digest)] / 255.0 - 0.5 for i in range(dims)]
    norm = math.sqrt(sum(v * v for v in raw)) or 1.0
    return [v / norm for v in raw]


class EmbeddingServer:
    """A loopback server speaking Ollama's ``/api/embed`` and the OpenAI shape.

    Behaviour is switchable at runtime so one server can play a cooperative
    provider, a chat model that refuses, a provider with no such route, and a
    provider that returns the wrong number of vectors.
    """

    def __init__(self, dims: int = DEFAULT_DIMS) -> None:
        self.dims = dims
        # "ok" | "cannot_embed" | "not_found" | "short_count" | "reordered" | "error_500"
        self.mode = "ok"
        self.calls: list[dict[str, Any]] = []
        self.batch_sizes: list[int] = []
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        # Set to a threading.Event to make every request block until it is set --
        # how a test cancels a backfill mid-run deterministically.
        self.gate: Optional[threading.Event] = None

    # -- lifecycle ----------------------------------------------------------

    def __enter__(self) -> "EmbeddingServer":
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # noqa: A003 - silence the default stderr spam
                pass

            def _send(self, status: int, body: str) -> None:
                payload = body.encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler's contract
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8") if length else "{}"
                try:
                    request = json.loads(raw)
                except json.JSONDecodeError:
                    request = {}
                outer.calls.append({
                    "path": self.path,
                    "body": request,
                    "authorization": self.headers.get("Authorization"),
                    "api_key_header": self.headers.get("x-goog-api-key"),
                })
                if outer.gate is not None:
                    outer.gate.wait(30)

                if outer.mode == "not_found":
                    self._send(404, '{"error":{"message":"Not Found"}}')
                    return
                if outer.mode == "cannot_embed":
                    self._send(200, OLLAMA_CANNOT_EMBED_BODY)
                    return
                if outer.mode == "error_500":
                    self._send(500, '{"error":{"message":"upstream is unwell"}}')
                    return

                if self.path.endswith("/api/embed"):
                    texts = request.get("input") or []
                    if isinstance(texts, str):
                        texts = [texts]
                    outer.batch_sizes.append(len(texts))
                    vectors = [deterministic_vector(t, outer.dims) for t in texts]
                    if outer.mode == "short_count" and vectors:
                        vectors = vectors[:-1]
                    self._send(200, json.dumps({"model": request.get("model"),
                                                "embeddings": vectors}))
                    return

                if self.path.endswith("/embeddings"):
                    texts = request.get("input") or []
                    if isinstance(texts, str):
                        texts = [texts]
                    outer.batch_sizes.append(len(texts))
                    data = [
                        {"index": i, "embedding": deterministic_vector(t, outer.dims)}
                        for i, t in enumerate(texts)
                    ]
                    if outer.mode == "short_count" and data:
                        data = data[:-1]
                    if outer.mode == "reordered":
                        # The OpenAI shape permits this. A client that trusts
                        # arrival order rather than ``index`` ranks papers
                        # against other papers' vectors and nothing raises.
                        data = list(reversed(data))
                    self._send(200, json.dumps({"data": data}))
                    return

                self._send(404, '{"error":{"message":"no such route"}}')

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True, name="embedding-server"
        )
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(10)

    # -- addressing ---------------------------------------------------------

    @property
    def port(self) -> int:
        assert self._server is not None
        return self._server.server_address[1]

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"
