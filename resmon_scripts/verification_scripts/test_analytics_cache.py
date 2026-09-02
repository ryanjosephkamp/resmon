"""The analytics cache: hit when nothing changed, recompute when anything did.

Ledger open item 08: every Analytics figure was recomputed on each page load.
The cache keys on a fingerprint of the tables analytics reads, so these tests
pin the two behaviors that matter — a repeat request must not recompute, and
any corpus change must.
"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import analytics, database  # noqa: E402


def _client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from resmon import app
    return TestClient(app)


def _counting(monkeypatch, name):
    """Wrap analytics.<name> so calls are counted without changing results."""
    real = getattr(analytics, name)
    calls = {"n": 0}

    def wrapper(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(analytics, name, wrapper)
    return calls


def _insert_document(n: int) -> None:
    conn = resmon_mod._get_db()
    try:
        database.insert_document(conn, {
            "source_repository": "arxiv",
            "external_id": f"2408.{10000 + n}",
            "doi": None,
            "title": f"Cache invalidation test paper {n}",
            "authors": "A. Author",
            "abstract": "An abstract.",
            "publication_date": "2026-08-01",
            "url": "https://example.invalid/paper",
            "categories": "cs.DL",
            "metadata_hash": f"hash-{n}",
        })
    finally:
        resmon_mod._close_db(conn)


def test_repeat_request_is_served_from_cache(monkeypatch):
    client = _client()
    calls = _counting(monkeypatch, "overview")

    assert client.get("/api/analytics/overview").status_code == 200
    assert client.get("/api/analytics/overview").status_code == 200
    assert calls["n"] == 1, "second identical request must not recompute"


def test_corpus_change_invalidates(monkeypatch):
    client = _client()
    calls = _counting(monkeypatch, "overview")

    first = client.get("/api/analytics/overview").json()
    _insert_document(1)
    second = client.get("/api/analytics/overview").json()

    assert calls["n"] == 2, "a new document must force a recompute"
    assert first != second, "the recomputed payload must reflect the new document"


def test_params_are_cached_separately(monkeypatch):
    client = _client()
    calls = _counting(monkeypatch, "publication_volume")

    assert client.get("/api/analytics/publication-volume?months=6").status_code == 200
    assert client.get("/api/analytics/publication-volume?months=12").status_code == 200
    assert calls["n"] == 2, "different params are different cache entries"

    assert client.get("/api/analytics/publication-volume?months=6").status_code == 200
    assert calls["n"] == 2, "a repeat of either param set hits its own entry"


def test_fresh_database_does_not_inherit_a_stale_entry(monkeypatch):
    """Two different (empty) databases share a fingerprint; the key must differ."""
    client = _client()
    calls = _counting(monkeypatch, "overview")
    client.get("/api/analytics/overview")

    # Simulate an app-level reset: new database, same process.
    resmon_mod.close_db()
    client2 = _client()
    client2.get("/api/analytics/overview")

    assert calls["n"] == 2, "a fresh database must never be served another database's cache"


def test_cache_is_bounded(monkeypatch):
    client = _client()
    for m in range(1, 45):
        client.get(f"/api/analytics/publication-volume?months={m}")
    assert len(resmon_mod._analytics_cache) <= resmon_mod._ANALYTICS_CACHE_MAX
