"""V-E3 verification: per-user Redis token bucket + polite User-Agent (IMPL-33).

Checks:

1. Opaque user hash is a 12-char lowercase hex prefix of SHA-256(user_id).
2. The User-Agent string matches the §10.3 format exactly.
3. A single user's bucket serializes 10 concurrent "executions" against
   the documented per-repo rate limit (captured request timestamps are
   spaced at >= the configured interval, within scheduler slack).
4. Two different users do NOT contend for each other's tokens.
5. ``safe_request`` installed under ``use_cloud_hook`` (a) overrides the
   User-Agent and (b) calls the hook's acquire path before each upstream
   HTTP attempt, proving the wiring between the cloud rate limit module
   and :mod:`implementation_scripts.api_base`.
"""

from __future__ import annotations

import hashlib
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
import pytest

from resmon_scripts.cloud.rate_limit import (
    CLOUD_USER_AGENT_VERSION,
    CloudRequestHook,
    InMemoryTokenBucket,
    build_user_agent,
    opaque_user_hash,
    use_cloud_hook,
)
from resmon_scripts.implementation_scripts import api_base


# ---------------------------------------------------------------------------
# 1. Opaque user hash
# ---------------------------------------------------------------------------


def test_opaque_user_hash_is_12_hex_chars():
    uid = "00000000-0000-0000-0000-000000000001"
    h = opaque_user_hash(uid)
    assert len(h) == 12
    assert re.fullmatch(r"[0-9a-f]{12}", h)
    # Stable and prefix of full sha256
    expected = hashlib.sha256(uid.encode("utf-8")).hexdigest()[:12]
    assert h == expected


def test_different_users_produce_different_hashes():
    assert opaque_user_hash("alice") != opaque_user_hash("bob")


# ---------------------------------------------------------------------------
# 2. User-Agent format
# ---------------------------------------------------------------------------


def test_user_agent_matches_section_10_3_format():
    uid = "user-xyz"
    ua = build_user_agent(uid)
    # resmon-cloud/<version> (+mailto:<12hex>@resmon.invalid)
    pattern = (
        r"^resmon-cloud/"
        + re.escape(CLOUD_USER_AGENT_VERSION)
        + r" \(\+mailto:[0-9a-f]{12}@resmon\.invalid\)$"
    )
    assert re.fullmatch(pattern, ua), ua
    assert opaque_user_hash(uid) in ua
    # No real email leakage
    assert uid not in ua


# ---------------------------------------------------------------------------
# 3. Per-user bucket serializes 10 concurrent executions
# ---------------------------------------------------------------------------


def _record_acquires(
    hook: CloudRequestHook,
    repo_slug: str,
    n_threads: int,
    per_thread: int,
) -> list[float]:
    """Simulate ``n_threads`` concurrent executions each making ``per_thread``
    upstream calls to ``repo_slug``. Returns captured timestamps (monotonic)
    at which each call was permitted to proceed."""
    timestamps: list[float] = []
    lock = threading.Lock()

    def worker() -> None:
        for _ in range(per_thread):
            hook.acquire(repo_slug)
            now = time.monotonic()
            with lock:
                timestamps.append(now)

    start = threading.Barrier(n_threads)

    def gated_worker() -> None:
        start.wait()
        worker()

    with ThreadPoolExecutor(max_workers=n_threads) as pool:
        futures = [pool.submit(gated_worker) for _ in range(n_threads)]
        for f in as_completed(futures):
            f.result()

    timestamps.sort()
    return timestamps


def test_ten_concurrent_executions_respect_documented_rate():
    # "arxiv" documented polite limit modelled as 5 req/s (capacity 1 so the
    # very first request for every thread queues in order).
    refill = 5.0
    interval = 1.0 / refill  # 0.2s

    backend = InMemoryTokenBucket()
    hook = CloudRequestHook.build(
        user_id="user-a",
        backend=backend,
        repo_limits={"arxiv": (1.0, refill)},
    )

    # 10 concurrent executions, each making 3 requests -> 30 total calls.
    timestamps = _record_acquires(hook, "arxiv", n_threads=10, per_thread=3)
    assert len(timestamps) == 30

    # Every consecutive pair must be spaced at >= the refill interval,
    # allowing small downward slack for OS scheduler jitter.
    gaps = [b - a for a, b in zip(timestamps, timestamps[1:])]
    slack = 0.03  # 30 ms tolerance for sleep wakeup jitter
    violations = [g for g in gaps if g < interval - slack]
    assert not violations, (
        f"Per-user bucket failed to enforce {interval}s interval; "
        f"violating gaps: {violations[:5]}"
    )

    # End-to-end wall time must be at least (N-1) * interval; otherwise the
    # bucket is effectively not limiting.
    wall = timestamps[-1] - timestamps[0]
    assert wall >= (len(timestamps) - 1) * interval - slack


def test_independent_users_do_not_contend():
    refill = 5.0
    backend = InMemoryTokenBucket()

    def run_for_user(uid: str) -> float:
        hook = CloudRequestHook.build(
            user_id=uid,
            backend=backend,
            repo_limits={"arxiv": (1.0, refill)},
        )
        t0 = time.monotonic()
        # Only one thread per user here — we're measuring independence, not
        # concurrency, across users.
        for _ in range(5):
            hook.acquire("arxiv")
        return time.monotonic() - t0

    results: dict[str, float] = {}
    threads = [
        threading.Thread(
            target=lambda uid=uid: results.__setitem__(uid, run_for_user(uid))
        )
        for uid in ("alice", "bob")
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # If the buckets shared state across users we would expect ~10 * 0.2s = 2s
    # total across the two threads running concurrently; with independent
    # buckets each thread finishes in ~5 * 0.2 = 1s. Assert each user's wall
    # time is < 1.4s (allowing generous slack).
    for uid, elapsed in results.items():
        assert elapsed < 1.4, (uid, elapsed)


# ---------------------------------------------------------------------------
# 4. safe_request honors the installed cloud hook
# ---------------------------------------------------------------------------


def test_safe_request_overrides_ua_and_calls_hook(monkeypatch):
    """Under ``use_cloud_hook`` a real ``safe_request`` call must (a) send
    the polite User-Agent on the wire, and (b) have called the hook's
    ``acquire_for_url`` path before issuing the request."""
    captured_headers: dict[str, str] = {}
    acquire_calls: list[str] = []

    class _RecordingHook:
        user_agent = build_user_agent("user-xyz")

        def acquire_for_url(self, url: str) -> None:
            acquire_calls.append(url)

    # Patch httpx.Client at the module used by safe_request so no network
    # traffic leaves the test process.
    class _FakeResponse:
        status_code = 200
        url = "http://fake/test"

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def request(self, method, url, headers=None, **kwargs):
            captured_headers.update(headers or {})
            return _FakeResponse()

    monkeypatch.setattr(api_base.httpx, "Client", _FakeClient)

    hook = _RecordingHook()
    with use_cloud_hook(hook):  # type: ignore[arg-type]
        api_base.safe_request("GET", "https://export.arxiv.org/api/query")

    assert captured_headers.get("User-Agent") == hook.user_agent
    assert acquire_calls == ["https://export.arxiv.org/api/query"]


def test_safe_request_without_hook_preserves_default_ua(monkeypatch):
    """Sanity: local-desktop paths (no hook) keep the resmon/1.0 UA."""
    captured: dict[str, str] = {}

    class _FakeResp:
        status_code = 200
        url = "http://fake/test"

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def request(self, method, url, headers=None, **kwargs):
            captured.update(headers or {})
            return _FakeResp()

    monkeypatch.setattr(api_base.httpx, "Client", _FakeClient)

    # Ensure no hook is installed in this context.
    assert api_base.get_cloud_request_hook() is None
    api_base.safe_request("GET", "https://example.org/")

    assert captured.get("User-Agent", "").startswith("resmon/1.0")
