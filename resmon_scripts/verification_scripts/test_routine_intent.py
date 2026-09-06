"""``routines.intent``, from the editor's request body to the audit that reads it.

The column shipped in 1.9a and the coverage audit has read it since 1.9b, but
nothing could *write* one: no request body carried the field, so every audit in
the field fell back to the routine's keywords and compared a query against
results that query produced. The panel said so, honestly, and the reading was
still circular.

**The property (R1): an intent written in the routine editor arrives at
``routines.intent``, and the audit for that routine reports it as ``stated``.**
The boundary here is the HTTP API against a real database — the renderer's half
(that the modal puts the field in the body) is jsdom in
``RoutineIntentField.test.tsx``, and the whole path from a typed character to the
stored column is ``e2e/routine-intent.spec.ts`` in a real Electron window.

**Blank is a clear, not a no-op**, and blank is stored as ``NULL`` rather than
``""``. ``intent_for`` treats both as absent, so two representations of absent
would be a distinction the rest of the app has to keep remembering.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import coverage_audit  # noqa: E402


def _client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from resmon import app
    return TestClient(app)


def _body(name: str = "astro", **extra) -> dict:
    body = {
        "name": name,
        "schedule_cron": "0 8 * * *",
        "parameters": {"query": "time series", "keywords": ["time series"],
                       "repositories": ["arxiv"]},
        "is_active": False,
    }
    body.update(extra)
    return body


INTENT = "methods for irregular time series in astronomy"


# ---------------------------------------------------------------------------
# It arrives
# ---------------------------------------------------------------------------


def test_an_intent_sent_on_create_is_stored_and_read_back():
    client = _client()
    created = client.post("/api/routines", json=_body(intent=INTENT))
    assert created.status_code == 201, created.text
    rid = created.json()["id"]

    fetched = client.get(f"/api/routines/{rid}")
    assert fetched.status_code == 200
    assert fetched.json()["intent"] == INTENT

    # And on the list route the Routines page actually renders from, because
    # that is where the edit modal hydrates its form.
    listed = [r for r in client.get("/api/routines").json() if r["id"] == rid]
    assert listed and listed[0]["intent"] == INTENT


def test_an_intent_sent_on_update_replaces_the_previous_one():
    client = _client()
    rid = client.post("/api/routines", json=_body(intent="first")).json()["id"]
    updated = client.put(f"/api/routines/{rid}", json={"intent": INTENT})
    assert updated.status_code == 200
    assert client.get(f"/api/routines/{rid}").json()["intent"] == INTENT


def test_a_blank_intent_clears_it_rather_than_being_ignored():
    """The editor sends the whole form; a deleted sentence means delete it."""
    client = _client()
    rid = client.post("/api/routines", json=_body(intent=INTENT)).json()["id"]
    assert client.put(f"/api/routines/{rid}", json={"intent": "   "}).status_code == 200
    assert client.get(f"/api/routines/{rid}").json()["intent"] is None


def test_an_absent_intent_on_update_leaves_the_stored_one_alone():
    """A caller that does not mention the field is not asking to erase it.

    ``None`` on the model means "not sent" and ``""`` means "cleared"; conflating
    them would let any other surface that PUTs a routine — the Calendar popover,
    a future API client — silently drop an intent it never knew about.
    """
    client = _client()
    rid = client.post("/api/routines", json=_body(intent=INTENT)).json()["id"]
    assert client.put(f"/api/routines/{rid}", json={"name": "renamed"}).status_code == 200
    assert client.get(f"/api/routines/{rid}").json()["intent"] == INTENT


def test_blank_is_stored_as_null_rather_than_an_empty_string():
    client = _client()
    rid = client.post("/api/routines", json=_body(intent="  ")).json()["id"]
    conn = resmon_mod._get_db()
    try:
        row = conn.execute("SELECT intent FROM routines WHERE id = ?", (rid,)).fetchone()
    finally:
        resmon_mod._close_db(conn)
    stored = row["intent"] if isinstance(row, sqlite3.Row) else row[0]
    assert stored is None


def test_a_routine_created_without_an_intent_has_none():
    """No backfill from the keywords, at any layer.

    ``database._migrate_embeddings_and_links`` refuses to backfill for the same reason:
    a routine whose intent was copied from its keywords would claim its owner
    stated one, and the audit's whole distinction is between those two facts.
    """
    client = _client()
    rid = client.post("/api/routines", json=_body()).json()["id"]
    assert client.get(f"/api/routines/{rid}").json()["intent"] is None


# ---------------------------------------------------------------------------
# The audit reads it
# ---------------------------------------------------------------------------


def test_the_audit_compares_against_a_stored_intent_and_labels_it_stated():
    """The end of the property: written through the API, used by the audit.

    **Mutation:** drop ``"intent"`` from ``create_routine``'s ``routine_dict``
    (or from ``insert_routine``'s column list) and this fails on
    ``intent_source``, which is exactly the circular reading R1 exists to end.
    """
    client = _client()
    rid = client.post("/api/routines", json=_body(intent=INTENT)).json()["id"]
    audit = client.get(f"/api/routines/{rid}/coverage")
    assert audit.status_code == 200
    payload = audit.json()
    assert payload["intent"] == INTENT
    assert payload["intent_source"] == "stated"


def test_without_one_the_audit_still_falls_back_to_the_keywords():
    client = _client()
    rid = client.post("/api/routines", json=_body()).json()["id"]
    payload = client.get(f"/api/routines/{rid}/coverage").json()
    assert payload["intent_source"] == "keywords"
    assert payload["intent"] == "time series"


def test_every_audit_payload_carries_the_two_list_totals():
    """R2's shape, including on the early returns.

    The panel reads ``off_target_total`` to say "showing 25 of N". Three of the
    four payloads ``_coverage_for_routine`` can return are hand-built early exits
    rather than ``audit_routine``'s output, and a missing key there would make the
    caption silently disappear on exactly the routines that have no results.
    """
    client = _client()
    rid = client.post("/api/routines", json=_body(intent=INTENT)).json()["id"]
    payload = client.get(f"/api/routines/{rid}/coverage").json()
    assert payload["reason"], "this fixture has no embeddings, so it must say why"
    for key in ("off_target_total", "missed_in_corpus_total",
                "missed_in_corpus_total_is_lower_bound"):
        assert key in payload, key
    assert payload["off_target_total"] == 0
    assert payload["missed_in_corpus_total"] == 0
    assert payload["missed_in_corpus_total_is_lower_bound"] is False


def test_the_cannot_see_sentence_is_the_modules_own():
    client = _client()
    rid = client.post("/api/routines", json=_body(intent=INTENT)).json()["id"]
    assert client.get(f"/api/routines/{rid}/coverage").json()["cannot_see"] == (
        coverage_audit.CANNOT_SEE
    )


def test_the_saved_routine_configuration_mirrors_the_intent():
    """A routine built from a saved configuration keeps what it was for.

    Every routine endpoint mirrors the row into ``saved_configurations`` with
    ``config_type='routine'``, and the editor's config loader hydrates a new
    routine from that payload. An intent missing from the mirror would be a
    second place the field appears not to work — the user writes one, duplicates
    the routine, and the copy is back to the circular comparison.
    """
    import json

    client = _client()
    rid = client.post("/api/routines", json=_body(intent=INTENT)).json()["id"]
    configs = [c for c in client.get("/api/configurations").json()
               if c.get("config_type") == "routine"]
    mirrors = []
    for row in configs:
        params = row.get("parameters")
        params = json.loads(params) if isinstance(params, str) else (params or {})
        if params.get("linked_routine_id") == rid:
            mirrors.append(params)
    assert mirrors, "the routine was not mirrored into saved_configurations"
    assert mirrors[0]["intent"] == INTENT
