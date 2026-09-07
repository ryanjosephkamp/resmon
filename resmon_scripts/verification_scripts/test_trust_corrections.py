"""Synthetic existing-schema matches and current matcher evidence for P2-P4.

The seed is also used by the Electron regression. This is synthetic stored
metadata, not scholarly precision evidence or a live provider test.
"""
from __future__ import annotations
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from implementation_scripts.api_base import Author
from implementation_scripts.database import init_db
from implementation_scripts.entity_matching import BASES, match
from implementation_scripts.watch_profiles import create_profile


def seed_existing_and_current(db_path: str) -> dict:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    init_db(conn=conn)
    profile = create_profile(conn, {"display_name": "Trust Synthetic",
        "names": ["Jane Doe", "Plato"], "affiliations": ["MIT"],
        "identifiers": {"orcid": {"value": "0000-0002-1825-0097"}}})
    cases = [(f"Historical {basis}", basis, "Jane Doe", "old policy evidence") for basis in BASES]
    for title, author in [
        ("Ambiguous candidate", Author("Plato", affiliations=("MIT",))),
        ("Conflicting identifier", Author("Jane Doe", orcid="0000-0001-5109-3700", affiliations=("MIT",))),
        ("Current affiliation", Author("Jane Doe", affiliations=("MIT",))),
        ("Current identifier", Author("Jane Doe", orcid="0000-0002-1825-0097")),
    ]:
        found = match([author], profile)
        cases.append((title, found.basis, found.matched_author, found.evidence))
    for index, (title, basis, author, evidence) in enumerate(cases):
        cursor = conn.execute("INSERT INTO documents (source_repository,external_id,title,metadata_hash) VALUES ('fixture',?,?,?)", (str(index), title, f"trust-{index}"))
        conn.execute("INSERT INTO watch_profile_matches (document_id,profile_id,basis,matched_author,evidence,first_seen_at) VALUES (?,?,?,?,?,?)", (cursor.lastrowid, profile["id"], basis, author, evidence, "2026-09-01 00:00:00"))
    conn.commit()
    conn.close()
    return {"profile_id": profile["id"], "papers": len(cases), "historical": len(BASES)}


def test_opening_an_existing_database_preserves_matches_and_papers(tmp_path):
    path = str(tmp_path / "existing.db")
    seeded = seed_existing_and_current(path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    before = [tuple(r) for r in conn.execute("SELECT * FROM watch_profile_matches ORDER BY document_id")]
    schema = conn.execute("SELECT sql FROM sqlite_master WHERE name='watch_profile_matches'").fetchone()[0]
    conn.close()
    # Reopen a populated existing-schema DB, the path a startup takes. No sweep
    # is requested and nothing authorizes automatic historical re-evaluation.
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    init_db(conn=conn)
    assert [tuple(r) for r in conn.execute("SELECT * FROM watch_profile_matches ORDER BY document_id")] == before
    assert conn.execute("SELECT count(*) FROM documents").fetchone()[0] == seeded["papers"]
    assert conn.execute("SELECT sql FROM sqlite_master WHERE name='watch_profile_matches'").fetchone()[0] == schema
    for basis in BASES:
        assert repr(basis) in schema
    conn.close()


if __name__ == "__main__":
    print(json.dumps(seed_existing_and_current(sys.argv[1])))
