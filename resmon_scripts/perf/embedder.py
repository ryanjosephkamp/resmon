"""A deterministic embedding model on loopback, in Ollama's ``/api/embed`` shape.

Semantic search is resmon's work (the settings, the probe, the ``vec0`` index,
the nearest-neighbour query, the page) wrapped around one call it cannot make
itself: turning a phrase into a vector. A benchmark must not time somebody
else's model, so this answers that call from a hash of the text, at the width
of a common local model (768 for ``nomic-embed-text``), as fast as the socket
allows. What it times is resmon's side of semantic search, not the model's.
"""

from __future__ import annotations

import hashlib
import json
import random
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def vector_for(text: str, dims: int) -> list[float]:
    local = random.Random(int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:8], "big"))
    values = [local.uniform(-1.0, 1.0) for _ in range(dims)]
    norm = sum(v * v for v in values) ** 0.5 or 1.0
    return [v / norm for v in values]


class FakeEmbedder:
    """``with FakeEmbedder(768) as model: model.url``"""

    def __init__(self, dims: int) -> None:
        self.dims = dims
        dims_ = dims

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - the stdlib's name
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
                texts = payload.get("input") or []
                if isinstance(texts, str):
                    texts = [texts]
                body = json.dumps({"model": payload.get("model"),
                                   "embeddings": [vector_for(t, dims_) for t in texts]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def __enter__(self) -> "FakeEmbedder":
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._server.shutdown()
        self._server.server_close()
