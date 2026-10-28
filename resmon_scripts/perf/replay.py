"""Recorded replies for every scholarly source, beneath the real clients.

A sweep's wall time is mostly the sources' own latency and resmon's rate
limiters, so a benchmark that hits the live APIs measures the internet, and one
that mocks the clients measures nothing resmon does. This module sits at the
bottom instead: it replaces httpx's transports, so every client builds its real
request, passes through ``safe_request`` and the real ``RateLimiter``, and
parses a real reply -- the one recorded from the upstream, served after the
latency that upstream actually took.

* ``record`` forwards each request, stores the reply and how long it took.
* ``replay`` serves the stored reply after the recorded latency (or a scaled
  one), and never opens a socket to anything but loopback. A request with no
  recording is written to ``misses.jsonl`` and answered with a connection
  error, so the source records a non-answer and the harness can refuse the run
  rather than report a faster sweep that skipped work.

Loopback requests (a local embedding model, the app's own backend) pass
straight through in both modes.

Recordings hold upstream content (titles and abstracts) and stay out of the
repository; ``perf/README.md`` says where they are kept and how to make them.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlsplit

import httpx

MODE_ENV = "RESMON_PERF_REPLAY"
DIR_ENV = "RESMON_PERF_REPLIES"
LATENCY_ENV = "RESMON_PERF_LATENCY"

_LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}

# Headers worth keeping. Content-Encoding and Content-Length describe the
# bytes on the wire, which httpx has already decoded by the time a reply is
# stored, so replaying them would describe a body that is not there.
_KEPT_HEADERS = {"content-type", "retry-after", "link", "x-total-count",
                 "x-ratelimit-remaining", "x-ratelimit-limit"}


def request_key(method: str, url: str, body: bytes = b"") -> str:
    """A request's identity: method, host, path, sorted query and body hash.

    Query order is not part of it: two clients that build the same parameters
    in a different order are asking the same question.
    """
    parts = urlsplit(url)
    query = urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True)))
    key = f"{method.upper()} {parts.scheme}://{parts.netloc.lower()}{parts.path}?{query}"
    if body:
        key += " #" + hashlib.sha256(body).hexdigest()[:16]
    return key


def _file_for(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]


class Recordings:
    """The replies on disk: an index of keys, and one gzip file per reply."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.bodies = self.root / "bodies"
        self.index_path = self.root / "index.json"
        self.misses_path = self.root / "misses.jsonl"
        self._lock = threading.Lock()
        self.index: dict[str, list[dict]] = {}
        if self.index_path.exists():
            self.index = json.loads(self.index_path.read_text(encoding="utf-8"))
        self._cursor: dict[str, int] = {}

    # -- recording ---------------------------------------------------------

    def add(self, key: str, url: str, response: httpx.Response, content: bytes,
            elapsed: float) -> None:
        with self._lock:
            entries = self.index.setdefault(key, [])
            name = f"{_file_for(key)}-{len(entries)}.gz"
            self.bodies.mkdir(parents=True, exist_ok=True)
            (self.bodies / name).write_bytes(gzip.compress(content))
            entries.append({
                "url": url,
                "status": response.status_code,
                "headers": {k: v for k, v in response.headers.items()
                            if k.lower() in _KEPT_HEADERS},
                "body": name,
                "bytes": len(content),
                "elapsed_ms": round(elapsed * 1000.0, 1),
            })
            self._save_locked()

    def _save_locked(self) -> None:
        tmp = self.index_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.index, indent=1, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self.index_path)

    # -- replaying ---------------------------------------------------------

    def next_for(self, key: str) -> Optional[dict]:
        """The next recorded reply for ``key``; the last one again once used up.

        A retry of a request that failed during recording is served the same
        sequence the upstream gave, so a recorded 503 followed by a 200 replays
        as exactly that.
        """
        with self._lock:
            entries = self.index.get(key)
            if not entries:
                return None
            i = self._cursor.get(key, 0)
            self._cursor[key] = i + 1
            return entries[min(i, len(entries) - 1)]

    def body(self, entry: dict) -> bytes:
        return gzip.decompress((self.bodies / entry["body"]).read_bytes())

    def miss(self, key: str, url: str) -> None:
        with self._lock:
            with open(self.misses_path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"key": key, "url": url, "at": time.time()}) + "\n")


def _latency_scale() -> Optional[float]:
    """``recorded`` (1.0), ``zero`` (no delay) or a float scale factor."""
    raw = os.environ.get(LATENCY_ENV, "recorded").strip().lower()
    if raw in ("", "recorded"):
        return 1.0
    if raw == "zero":
        return 0.0
    return float(raw)


def install(mode: str, root: Path) -> Recordings:
    """Replace httpx's sync and async transports for this process."""
    if mode not in ("record", "replay"):
        raise ValueError(f"unknown replay mode {mode!r}")
    recordings = Recordings(root)
    scale = _latency_scale()
    real_sync = httpx.HTTPTransport.handle_request
    real_async = httpx.AsyncHTTPTransport.handle_async_request

    def _is_loopback(request: httpx.Request) -> bool:
        return (request.url.host or "").lower() in _LOOPBACK

    def _replayed(request: httpx.Request, entry: dict) -> httpx.Response:
        return httpx.Response(
            status_code=entry["status"],
            headers=entry["headers"],
            content=recordings.body(entry),
            request=request,
        )

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if _is_loopback(request):
            return real_sync(self, request)
        body = request.read()
        key = request_key(request.method, str(request.url), body)
        if mode == "record":
            started = time.perf_counter()
            response = real_sync(self, request)
            content = response.read()
            elapsed = time.perf_counter() - started
            recordings.add(key, str(request.url), response, content, elapsed)
            return httpx.Response(
                status_code=response.status_code,
                headers={k: v for k, v in response.headers.items()
                         if k.lower() not in ("content-encoding", "content-length",
                                              "transfer-encoding")},
                content=content, request=request,
            )
        entry = recordings.next_for(key)
        if entry is None:
            recordings.miss(key, str(request.url))
            raise httpx.ConnectError("no recorded reply for this request", request=request)
        if scale:
            time.sleep(entry["elapsed_ms"] / 1000.0 * scale)
        return _replayed(request, entry)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if _is_loopback(request):
            return await real_async(self, request)
        import asyncio

        body = await request.aread()
        key = request_key(request.method, str(request.url), body)
        if mode == "record":
            started = time.perf_counter()
            response = await real_async(self, request)
            content = await response.aread()
            elapsed = time.perf_counter() - started
            recordings.add(key, str(request.url), response, content, elapsed)
            return httpx.Response(
                status_code=response.status_code,
                headers={k: v for k, v in response.headers.items()
                         if k.lower() not in ("content-encoding", "content-length",
                                              "transfer-encoding")},
                content=content, request=request,
            )
        entry = recordings.next_for(key)
        if entry is None:
            recordings.miss(key, str(request.url))
            raise httpx.ConnectError("no recorded reply for this request", request=request)
        if scale:
            await asyncio.sleep(entry["elapsed_ms"] / 1000.0 * scale)
        return _replayed(request, entry)

    httpx.HTTPTransport.handle_request = handle_request  # type: ignore[method-assign]
    httpx.AsyncHTTPTransport.handle_async_request = handle_async_request  # type: ignore[method-assign]
    return recordings


def install_from_environment() -> Optional[Recordings]:
    mode = os.environ.get(MODE_ENV, "").strip()
    if not mode:
        return None
    root = os.environ.get(DIR_ENV)
    if not root:
        raise SystemExit(f"{MODE_ENV}={mode} needs {DIR_ENV}")
    return install(mode, Path(root))
