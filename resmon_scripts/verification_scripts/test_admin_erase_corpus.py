"""The Danger Zone must be able to erase the corpus, and must say so honestly.

Until 1.7.1 nothing here did. "Erase all app data" and "Factory reset" both
removed executions, configs and keys while leaving every collected paper in
place — on a real install, tens of thousands of them surviving a reset that
claimed to erase everything. These tests pin the fix in both directions: the
things that should clear the corpus do, and the things that should not, do not.
"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.database import insert_document  # noqa: E402


def _client():
    import resmon as resmon_mod
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from fastapi.testclient import TestClient
    from resmon import app
    return TestClient(app), resmon_mod


def _seed(db, n=3):
    for i in range(n):
        insert_document(db, {
            "source_repository": "arxiv", "external_id": f"x{i}", "doi": None,
            "title": f"Paper {i}", "authors": "A", "abstract": "b",
            "publication_date": "2026-01-01", "url": "u", "categories": "c",
            "metadata_hash": f"h{i}",
        })
    return db.execute("SELECT COUNT(*) FROM documents").fetchone()[0]


CONFIRM = {"confirm": "CONFIRM"}


def _count(db):
    return db.execute("SELECT COUNT(*) FROM documents").fetchone()[0]


def test_the_dedicated_corpus_erase_removes_every_paper():
    client, mod = _client()
    db = mod._get_db()
    assert _seed(db) == 3

    r = client.post("/api/admin/erase-corpus", json=CONFIRM)
    assert r.status_code == 200, r.text
    assert r.json()["documents_removed"] == 3
    assert _count(mod._get_db()) == 0


def test_erasing_execution_history_keeps_the_papers():
    """The distinction the labels now make explicit."""
    client, mod = _client()
    db = mod._get_db()
    _seed(db)

    client.post("/api/admin/erase-executions", json=CONFIRM)
    assert _count(mod._get_db()) == 3


def test_erase_all_app_data_now_includes_the_corpus():
    client, mod = _client()
    db = mod._get_db()
    _seed(db)

    r = client.post("/api/admin/erase-app-data", json=CONFIRM)
    assert r.status_code == 200, r.text
    assert r.json()["documents_removed"] == 3
    assert _count(mod._get_db()) == 0


def test_factory_reset_is_actually_a_factory_reset():
    """The single most misleading label in the app before 1.7.1."""
    client, mod = _client()
    db = mod._get_db()
    _seed(db)

    r = client.post("/api/admin/factory-reset", json=CONFIRM)
    assert r.status_code == 200, r.text
    assert r.json()["documents_removed"] == 3
    assert _count(mod._get_db()) == 0


def test_erasing_the_corpus_takes_its_derived_rows_with_it():
    """Authors, categories and the search index all hang off documents; a
    surviving FTS row would surface a paper that no longer exists."""
    client, mod = _client()
    db = mod._get_db()
    _seed(db)
    assert db.execute("SELECT COUNT(*) FROM document_authors").fetchone()[0] > 0

    client.post("/api/admin/erase-corpus", json=CONFIRM)
    db = mod._get_db()
    assert db.execute("SELECT COUNT(*) FROM document_authors").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM document_categories").fetchone()[0] == 0
    assert db.execute(
        "SELECT COUNT(*) FROM documents_fts").fetchone()[0] == 0


def test_erasing_the_corpus_requires_confirmation():
    client, _ = _client()
    assert client.post("/api/admin/erase-corpus", json={}).status_code in (400, 422)
