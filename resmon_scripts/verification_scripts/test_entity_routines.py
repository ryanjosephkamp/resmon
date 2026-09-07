"""P13 — a routine can watch a person, and the two modes really reach the engine.

The spine of 2.1 built the matcher, the profile store and the engine's watch
branch, and **nothing could reach any of it**: `parameters.entity` was neither
validated nor read, so no routine could be pointed at a profile. This file is
the property that the path from a saved routine to a match row exists and is
closed at both ends.

Two boundaries, and the row in the ledger says which is which:

* **real dependency, in-process** for the API half — a real FastAPI app over a
  real database, so a refusal is the status code a caller really gets.
* **real dependency, in-process** for the fire half — a real `SweepEngine`, a
  real corpus and a real lifecycle table, with a loopback source class. The
  thing under test is *what ends up in the database after a routine fires*, and
  a test that stubbed the engine would assert its own arrangement.

The failure this file exists to prevent is the silent one: a routine whose
profile id names nothing is accepted, scheduled, and fires every morning into a
run that cannot do anything. Nothing about that looks broken from outside.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient      # noqa: E402

import resmon as resmon_mod                     # noqa: E402
from implementation_scripts import (            # noqa: E402
    lifecycle as lifecycle_module,
    sweep_engine as se,
    watch_profiles as wp,
)
from implementation_scripts.api_base import (   # noqa: E402
    Author, BaseAPIClient, NormalizedResult,
)
from implementation_scripts.database import init_db   # noqa: E402
from implementation_scripts.sweep_engine import SweepEngine   # noqa: E402

ORCID = "0000-0002-1825-0097"


# ---------------------------------------------------------------------------
# The API half
# ---------------------------------------------------------------------------

@pytest.fixture
def client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    return TestClient(resmon_mod.app)


def _profile_over_api(client: TestClient, **body) -> dict:
    body.setdefault("kind", "person")
    body.setdefault("display_name", "Jane Doe")
    response = client.post("/api/profiles", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _routine_body(profile_id: int, mode: str = "new_papers", **params) -> dict:
    parameters = {"repositories": ["arxiv"], "keywords": [], "query": "",
                  "max_results": 25,
                  "entity": {"profile_id": profile_id, "mode": mode}}
    parameters.update(params)
    return {"name": "Watch Jane", "schedule_cron": "0 8 * * *",
            "parameters": parameters, "is_active": False}


def test_a_routine_can_be_created_that_watches_a_profile(client):
    profile = _profile_over_api(client)
    response = client.post("/api/routines", json=_routine_body(profile["id"]))
    assert response.status_code == 201, response.text
    assert response.json()["entity"] == {"profile_id": profile["id"],
                                         "mode": "new_papers"}


def test_a_routine_naming_a_profile_that_does_not_exist_is_refused(client):
    """The whole reason this validation is at the seam.

    Stored, it would be scheduled and would fire into a run that cannot do
    anything, for ever, with nothing looking broken.
    """
    response = client.post("/api/routines", json=_routine_body(9999))
    assert response.status_code == 400
    assert "9999" in response.json()["detail"]


def test_an_unknown_mode_is_refused_and_the_message_names_the_real_ones(client):
    profile = _profile_over_api(client)
    response = client.post("/api/routines",
                           json=_routine_body(profile["id"], mode="retraction"))
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "new_papers" in detail and "retractions" in detail


def test_a_planned_mode_is_refused_by_name_rather_than_as_a_typo(client):
    """`institution_output` is in the plan and not in the build.

    "Unknown mode" would be a false sentence: the mode is known, and what is
    true is that it needs affiliation matching, which is 2.1b. A person who
    asked for it deserves the second sentence.
    """
    profile = _profile_over_api(client)
    response = client.post(
        "/api/routines",
        json=_routine_body(profile["id"], mode="institution_output"))
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "2.1.1" in detail
    assert "not a watch mode" not in detail


def test_a_routine_cannot_watch_an_institution_profile_yet(client):
    profile = _profile_over_api(client, kind="institution",
                                display_name="Example University")
    response = client.post("/api/routines", json=_routine_body(profile["id"]))
    assert response.status_code == 400
    assert "institution" in response.json()["detail"]


def test_an_entity_with_no_mode_is_refused(client):
    profile = _profile_over_api(client)
    body = _routine_body(profile["id"])
    body["parameters"]["entity"] = {"profile_id": profile["id"]}
    response = client.post("/api/routines", json=body)
    assert response.status_code == 400
    assert "entity.mode" in response.json()["detail"]


def test_an_entity_that_is_not_an_object_is_refused(client):
    body = _routine_body(1)
    body["parameters"]["entity"] = "Jane Doe"
    response = client.post("/api/routines", json=body)
    assert response.status_code == 400
    assert "profile_id" in response.json()["detail"]


def test_updating_a_routine_onto_a_dead_profile_is_refused_too(client):
    """The update path is the one an editor uses, and it validated nothing."""
    profile = _profile_over_api(client)
    created = client.post("/api/routines",
                          json=_routine_body(profile["id"])).json()
    response = client.put(
        f"/api/routines/{created['id']}",
        json={"parameters": _routine_body(9999)["parameters"]})
    assert response.status_code == 400


def test_a_keyword_routine_is_untouched_by_any_of_this(client):
    """No `entity` key, no validation. The ordinary path is the default."""
    response = client.post("/api/routines", json={
        "name": "Keywords", "schedule_cron": "0 8 * * *",
        "parameters": {"repositories": ["arxiv"], "keywords": ["x"],
                       "query": "x"}, "is_active": False})
    assert response.status_code == 201
    assert "entity" not in response.json()


def test_a_watch_routine_over_sources_that_cannot_be_asked_says_so_at_creation(client):
    """Said before the first run, not only after it comes back empty.

    bioRxiv and medRxiv have no author query of any kind, so this routine would
    run correctly and find nothing for ever. It is still created — sources gain
    capabilities and it is the user's call — and the sentence is in the reply.
    """
    profile = _profile_over_api(client)
    body = _routine_body(profile["id"], repositories=["biorxiv", "medrxiv"])
    response = client.post("/api/routines", json=body)
    assert response.status_code == 201
    assert "entity_warning" in response.json()


def test_a_watch_routine_over_a_source_that_can_be_asked_carries_no_warning(client):
    profile = _profile_over_api(client)
    body = _routine_body(profile["id"], repositories=["biorxiv", "arxiv"])
    response = client.post("/api/routines", json=body)
    assert response.status_code == 201
    assert "entity_warning" not in response.json()


def test_deleting_a_profile_names_the_routines_left_pointing_at_it(client):
    """No foreign key can cascade into a JSON blob, so the deletion says so."""
    profile = _profile_over_api(client)
    client.post("/api/routines", json=_routine_body(profile["id"]))
    response = client.delete(f"/api/profiles/{profile['id']}")
    assert response.status_code == 200
    body = response.json()
    assert [r["name"] for r in body["routines_watching"]] == ["Watch Jane"]
    assert "Watch Jane" in body["detail"]


# ---------------------------------------------------------------------------
# The fire half — a real engine, a real corpus
# ---------------------------------------------------------------------------

class _EntitySource(BaseAPIClient):
    """One real match and one decoy, exactly as `test_entity_sweep` does."""

    def get_name(self) -> str:
        return "fixture"

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        return []

    def search_entity(self, profile, date_from=None, date_to=None,
                      max_results=100, **kwargs):
        return [
            NormalizedResult(
                source_repository="fixture", external_id="hers",
                doi=None, title="A paper by the person watched",
                authors=[Author("Jane Doe", orcid=ORCID)],
                abstract="An abstract.", publication_date="2026-01-01",
                url="https://example.invalid/1", categories="cs.AI"),
            NormalizedResult(
                source_repository="fixture", external_id="decoy",
                doi=None, title="A paper by somebody else entirely",
                authors=[Author("John Smith")],
                abstract="Another abstract.", publication_date="2026-01-02",
                url="https://example.invalid/2", categories="cs.AI"),
        ]


@pytest.fixture
def fired(tmp_path, monkeypatch):
    """A real app whose routine fires synchronously into a real engine.

    `_dispatch_routine_fire` is the production path — the scheduler and
    `POST /api/routines/{id}/run` both go through it — so the routine really is
    what starts this, rather than a hand-built `query_params` dict. The launch
    is made synchronous so the assertion can read the corpus afterwards.
    """
    database = tmp_path / "corpus.db"
    resmon_mod._db_path = str(database)
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    monkeypatch.setattr(se, "get_client", lambda _name: _EntitySource())
    monkeypatch.setattr(se, "_REQUIRED_CREDENTIALS", {})
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")

    def _sync_launch(engine, exec_id, conn, ephemeral_credentials=None):
        try:
            engine.run_prepared(exec_id)
        except Exception:
            # Exactly what the production launcher does: the engine has already
            # written status='failed' and emitted the error event, and a raise
            # off the end of its background thread would only be a traceback in
            # the log. Swallowing it here keeps this double honest — a stub that
            # let the exception through would make the failed-execution row look
            # unreachable.
            pass

    monkeypatch.setattr(resmon_mod, "_launch_execution", _sync_launch)
    return TestClient(resmon_mod.app)


def _conn(client: TestClient) -> sqlite3.Connection:
    return resmon_mod._get_db()


def test_firing_a_watch_routine_writes_the_verified_match_and_not_the_decoy(fired):
    """The whole path: profile → routine → fire → engine → match row."""
    profile = _profile_over_api(fired, identifiers={"orcid": {"value": ORCID}})
    routine = fired.post("/api/routines", json=_routine_body(
        profile["id"], repositories=["fixture"])).json()

    response = fired.post(f"/api/routines/{routine['id']}/run")
    assert response.status_code == 200, response.text

    conn = _conn(fired)
    try:
        rows = conn.execute(
            "SELECT m.basis, d.external_id FROM watch_profile_matches m "
            "JOIN documents d ON d.id = m.document_id "
            "WHERE m.profile_id = ?", (profile["id"],)).fetchall()
        assert [(r["basis"], r["external_id"]) for r in rows] == [
            ("identifier", "hers")]
    finally:
        resmon_mod._close_db(conn)


def test_a_routine_whose_profile_was_deleted_fails_loudly_rather_than_quietly(fired):
    """The one thing worse than a broken routine is one that looks fine.

    With no profile the run can match nothing, so it would report zero results
    and no reason. It fails instead, with the sentence on the execution row
    where Results and the Monitor both read it.
    """
    profile = _profile_over_api(fired, identifiers={"orcid": {"value": ORCID}})
    routine = fired.post("/api/routines", json=_routine_body(
        profile["id"], repositories=["fixture"])).json()
    fired.delete(f"/api/profiles/{profile['id']}")

    fired.post(f"/api/routines/{routine['id']}/run")

    conn = _conn(fired)
    try:
        row = conn.execute(
            "SELECT status, error_message FROM executions "
            "ORDER BY id DESC LIMIT 1").fetchone()
        assert row["status"] == "failed"
        assert "no longer exists" in row["error_message"]
    finally:
        resmon_mod._close_db(conn)


def test_the_retractions_mode_queries_no_source_at_all(fired, monkeypatch):
    """A join over what resmon holds. Asking a source would be a new claim.

    The counter lives on a client this test installs itself, *over* the
    fixture's — the first version of this test defined a loud client and never
    installed one, so its empty list was the fixture's silence rather than the
    branch's. It passed against the mutation that removes the branch entirely,
    which is how it was caught.
    """
    asked: list = []

    class _Loud(_EntitySource):
        def search(self, query, date_from=None, date_to=None,
                   max_results=100, **kwargs):
            asked.append(("search", query))
            return []

        def search_entity(self, profile, **kwargs):
            asked.append(("search_entity", profile))
            return []

    monkeypatch.setattr(se, "get_client", lambda _name: _Loud())

    profile = _profile_over_api(fired, identifiers={"orcid": {"value": ORCID}})
    routine = fired.post("/api/routines", json=_routine_body(
        profile["id"], mode="retractions", repositories=["fixture"])).json()
    fired.post(f"/api/routines/{routine['id']}/run")
    assert asked == []

    # And the run does not *announce* sources it never touched: the Monitor
    # renders the repository list off the execution row.
    conn = _conn(fired)
    try:
        row = conn.execute("SELECT parameters FROM executions "
                           "ORDER BY id DESC LIMIT 1").fetchone()
        sources = conn.execute(
            "SELECT COUNT(*) FROM execution_sources").fetchone()[0]
    finally:
        resmon_mod._close_db(conn)
    assert json.loads(row["parameters"])["repositories"] == []
    assert sources == 0


def test_a_new_papers_routine_does_ask_the_source(fired, monkeypatch):
    """The negative control for the test above.

    Without it, "no source was queried" would also pass if the fixture's client
    were never reached for any reason at all.
    """
    asked: list = []

    class _Loud(_EntitySource):
        def search_entity(self, profile, **kwargs):
            asked.append(profile["display_name"])
            return []

    monkeypatch.setattr(se, "get_client", lambda _name: _Loud())

    profile = _profile_over_api(fired, identifiers={"orcid": {"value": ORCID}})
    routine = fired.post("/api/routines", json=_routine_body(
        profile["id"], mode="new_papers", repositories=["fixture"])).json()
    fired.post(f"/api/routines/{routine['id']}/run")
    assert asked == ["Jane Doe"]


def test_the_retractions_mode_surfaces_the_findings_on_this_profiles_papers(fired, monkeypatch):
    """Findings already in `document_lifecycle`, restricted by the join.

    No provider is called: the check finds nothing due, because the seeded
    paper is recorded as checked. What the run reports is what resmon already
    holds — which is the entire design of decision 6.
    """
    profile = _profile_over_api(fired, identifiers={"orcid": {"value": ORCID}})
    conn = _conn(fired)
    try:
        conn.execute(
            "INSERT INTO documents (source_repository, external_id, title, "
            "metadata_hash) VALUES ('fixture', 'hers', 'Her paper', 'hers')")
        doc = conn.execute(
            "SELECT id FROM documents WHERE external_id = 'hers'").fetchone()["id"]
        conn.execute(
            "INSERT INTO watch_profile_matches (document_id, profile_id, basis, "
            "matched_author) VALUES (?, ?, 'identifier', 'Jane Doe')",
            (doc, profile["id"]))
        conn.execute(
            "INSERT INTO document_lifecycle (document_id, kind, severity, "
            "notice_key, label, notice_doi, notice_url, notice_date, provider, "
            "provider_source) VALUES (?, 'retraction', 'critical', 'n1', "
            "'Retraction', '10.1/n', 'https://doi.org/10.1/n', '2026-02-02', "
            "'crossref', 'Retraction Watch')", (doc,))
        conn.execute(
            "INSERT INTO document_lifecycle_checks (document_id, checked_at, "
            "status) VALUES (?, datetime('now'), 'ok')", (doc,))
        conn.commit()
    finally:
        resmon_mod._close_db(conn)

    routine = fired.post("/api/routines", json=_routine_body(
        profile["id"], mode="retractions", repositories=["fixture"])).json()
    fired.post(f"/api/routines/{routine['id']}/run")

    conn = _conn(fired)
    try:
        row = conn.execute(
            "SELECT status, result_count, result_path FROM executions "
            "ORDER BY id DESC LIMIT 1").fetchone()
    finally:
        resmon_mod._close_db(conn)
    assert row["status"] == "completed"
    assert row["result_count"] == 1
    report = Path(row["result_path"]).read_text(encoding="utf-8")
    assert "Retraction" in report
    assert "Her paper" in report
    # The basis travels with the finding into a document that can be mailed.
    assert "matched by identifier" in report
    assert "Retraction Watch" in report


def test_a_retractions_report_never_says_nothing_has_happened(fired):
    """Zero findings is a claim about the record, not about the world."""
    profile = _profile_over_api(fired, identifiers={"orcid": {"value": ORCID}})
    routine = fired.post("/api/routines", json=_routine_body(
        profile["id"], mode="retractions", repositories=["fixture"])).json()
    fired.post(f"/api/routines/{routine['id']}/run")

    conn = _conn(fired)
    try:
        row = conn.execute("SELECT result_path FROM executions "
                           "ORDER BY id DESC LIMIT 1").fetchone()
    finally:
        resmon_mod._close_db(conn)
    report = Path(row["result_path"]).read_text(encoding="utf-8")
    assert "not a statement that nothing has happened" in report
    assert "have been through a lifecycle check" in report


def test_a_cancelled_retractions_run_stops_before_it_asks_anybody(fired, monkeypatch):
    """The Cancel button does something on this branch, and the log says what.

    Everything before the checkpoint reads the local database; everything after
    it is one bounded lifecycle pass that cannot be interrupted part-way, the
    same shape `check_corpus` has. A cancel raised before the pass must stop the
    run there rather than making the request anyway.
    """
    checked: list = []
    from implementation_scripts import lifecycle as lifecycle_real  # noqa: PLC0415
    monkeypatch.setattr(
        lifecycle_real, "check_documents",
        lambda *a, **k: checked.append(True) or {"checked_now": 0, "eligible": 0,
                                                 "selected": 0, "errors": [],
                                                 "checked_at": ""})

    profile = _profile_over_api(fired, identifiers={"orcid": {"value": ORCID}})
    routine = fired.post("/api/routines", json=_routine_body(
        profile["id"], mode="retractions", repositories=["fixture"])).json()

    from implementation_scripts.progress import progress_store  # noqa: PLC0415
    original = progress_store.should_cancel
    monkeypatch.setattr(progress_store, "should_cancel", lambda _exec_id: True)
    try:
        fired.post(f"/api/routines/{routine['id']}/run")
    finally:
        monkeypatch.setattr(progress_store, "should_cancel", original)

    assert checked == [], "the run asked a provider after being cancelled"

    conn = _conn(fired)
    try:
        status = conn.execute("SELECT status FROM executions "
                              "ORDER BY id DESC LIMIT 1").fetchone()["status"]
    finally:
        resmon_mod._close_db(conn)
    assert status == "cancelled"


# ---------------------------------------------------------------------------
# The lifecycle restriction the retractions mode rests on
# ---------------------------------------------------------------------------

@pytest.fixture
def corpus(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "c.db"), check_same_thread=False)
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    yield connection
    connection.close()


def _paper(conn, external_id: str) -> int:
    conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, "
        "metadata_hash) VALUES ('fixture', ?, ?, ?)",
        (external_id, external_id, external_id))
    conn.commit()
    return conn.execute("SELECT id FROM documents WHERE external_id = ?",
                        (external_id,)).fetchone()["id"]


def test_a_restricted_check_selects_only_the_documents_it_was_given(corpus):
    mine, theirs = _paper(corpus, "mine"), _paper(corpus, "theirs")
    due = lifecycle_module.documents_due(corpus, document_ids=[mine])
    assert [d["id"] for d in due] == [mine]
    assert theirs not in [d["id"] for d in due]


def test_a_restricted_check_is_a_restriction_and_never_a_widening(corpus):
    """A named paper that is not due is still not checked.

    Without this a watch routine firing daily would re-ask Crossref about the
    same papers every morning, which is a rate-limit problem and a rudeness.
    """
    doc = _paper(corpus, "checked")
    corpus.execute(
        "INSERT INTO document_lifecycle_checks (document_id, checked_at, status) "
        "VALUES (?, datetime('now'), 'ok')", (doc,))
    corpus.commit()
    assert lifecycle_module.documents_due(corpus, document_ids=[doc]) == []


def test_an_empty_set_selects_nothing_rather_than_the_whole_corpus(corpus):
    """The failure a bare `IN ()` or a falsy check would produce.

    A profile with no matches asking to check "its" papers must check none of
    them, not all of them.
    """
    _paper(corpus, "somebody-elses")
    assert lifecycle_module.documents_due(corpus, document_ids=[]) == []


def test_the_summary_separates_nothing_due_from_nothing_matched(corpus):
    doc = _paper(corpus, "checked")
    corpus.execute(
        "INSERT INTO document_lifecycle_checks (document_id, checked_at, status) "
        "VALUES (?, datetime('now'), 'ok')", (doc,))
    corpus.commit()

    up_to_date = lifecycle_module.check_documents(corpus, [doc])
    nothing_matched = lifecycle_module.check_documents(corpus, [])
    assert (up_to_date["eligible"], up_to_date["selected"]) == (1, 0)
    assert (nothing_matched["eligible"], nothing_matched["selected"]) == (0, 0)


def test_matched_document_ids_are_this_profiles_and_in_match_order(corpus):
    profile = wp.create_profile(corpus, {"display_name": "Jane Doe"})
    other = wp.create_profile(corpus, {"display_name": "Somebody Else"})
    first, second, theirs = (_paper(corpus, "a"), _paper(corpus, "b"),
                             _paper(corpus, "c"))
    for doc, owner, seen in ((first, profile, "2026-01-01"),
                             (second, profile, "2026-02-01"),
                             (theirs, other, "2026-01-01")):
        corpus.execute(
            "INSERT INTO watch_profile_matches (document_id, profile_id, basis, "
            "matched_author, first_seen_at) VALUES (?, ?, 'name_only', 'x', ?)",
            (doc, owner["id"], seen))
    corpus.commit()
    assert wp.matched_document_ids(corpus, profile["id"]) == [first, second]


# ---------------------------------------------------------------------------
# The denominator
# ---------------------------------------------------------------------------

def test_every_mode_the_module_offers_is_reachable_from_a_routine(client):
    """`AVAILABLE_ENTITY_MODES` is the denominator, and it is in the code.

    A third mode added to that tuple without a routine path fails here rather
    than shipping as a mode nothing can select — the shape `routes.ts` and
    `mcp_server.TOOLS` both exist to prevent.
    """
    profile = _profile_over_api(client)
    for mode in wp.AVAILABLE_ENTITY_MODES:
        response = client.post("/api/routines",
                               json=_routine_body(profile["id"], mode=mode))
        assert response.status_code == 201, f"{mode}: {response.text}"
        assert response.json()["entity"]["mode"] == mode


def test_a_mode_in_the_plan_but_not_the_build_is_in_exactly_one_of_the_lists():
    """The two tuples are a plan and a build, and the difference is deliberate."""
    planned = set(wp.ENTITY_MODES) - set(wp.AVAILABLE_ENTITY_MODES)
    assert planned == {"institution_output"}


# ---------------------------------------------------------------------------
# The query a client is handed is the query it sends
# ---------------------------------------------------------------------------

def test_arxiv_does_not_wrap_a_field_query_in_its_default_field():
    """The defect the first live `search_entity` case found, guarded hermetically.

    `api_base.search_entity` asks a source by putting the catalog's own syntax
    into the query string, on the assumption that `search()` sends the string it
    is given. arXiv's client did not: it wrapped `au:"Yoshua Bengio"` into
    `all:au:"Yoshua Bengio"`, which arXiv answers **HTTP 400**. The client logs
    the status and returns `[]`, so every watch routine over arXiv reported that
    the person had published nothing — silent, plausible and wrong.

    The live case in `test_entity_search_live.py` is what found it and is the
    only thing that can find it *again* against a real arXiv. This guard is the
    deterministic half: it asserts the string that leaves the client, with no
    socket, so the regression cannot come back unnoticed between weekly runs.
    """
    from implementation_scripts import api_arxiv  # noqa: PLC0415

    sent: list[dict] = []

    class _Recorded:
        status_code = 200
        text = "<feed xmlns='http://www.w3.org/2005/Atom'></feed>"

    def _record(method, url, **kwargs):
        sent.append(dict(kwargs.get("params") or {}))
        return _Recorded()

    original = api_arxiv.safe_request
    api_arxiv.safe_request = _record
    try:
        client = api_arxiv.ArxivClient()
        client.search_entity(
            {"kind": "person", "display_name": "Yoshua Bengio",
             "names": [{"value": "Yoshua Bengio"}], "identifiers": {},
             "affiliations": []}, max_results=5)
        # A keyword search is unchanged, which is the other half of the property:
        # the fix must not turn an ordinary search into a field search.
        client.search("graph neural network", max_results=5)
    finally:
        api_arxiv.safe_request = original

    assert sent, "the client made no request at all"
    entity_query = sent[0]["search_query"]
    assert entity_query == 'au:"Yoshua Bengio"', (
        f"arXiv was asked {entity_query!r}; anything with 'all:' in front of a "
        f"field prefix is the HTTP 400 this guard exists for"
    )
    assert sent[1]["search_query"] == "all:graph neural network"


def test_no_askable_client_rewrites_the_query_it_is_handed():
    """The general form of the same defect, across every source asked by field.

    Thirteen sources are asked by putting a syntax into the query string, and
    each of them is a client that could quietly transform it. The check is the
    generic contract itself: the syntax the catalog cites must survive into the
    request. arXiv was the one that did not, and one is enough to want the rest
    under a check rather than under an assumption.

    Hermetic, and it drives every one of the thirteen — the denominator is the
    capability table.
    """
    from implementation_scripts import api_registry  # noqa: PLC0415
    from implementation_scripts.repo_catalog import REPOSITORY_CATALOG  # noqa: PLC0415
    from implementation_scripts import api_base  # noqa: PLC0415

    by_field = [e for e in REPOSITORY_CATALOG
                if e.entity_search.author_query == "field"]
    assert len(by_field) >= 10, "the capability table lost its field-query sources"

    profile = {"kind": "person", "display_name": "Ada Lovelace",
               "names": [{"value": "Ada Lovelace"}], "identifiers": {},
               "affiliations": []}

    missing = []
    for entry in by_field:
        expected = entry.entity_search.author_syntax.format(name="Ada Lovelace")
        seen: list[str] = []

        class _Recorded:
            status_code = 200
            text = "{}"
            def json(self):  # noqa: D102
                return {}

        def _record(method, url, **kwargs):
            # The URL as well as the parameters: DOAJ puts the query in the path
            # rather than in a query string, and a recorder that read only
            # `params` would have reported it as dropping the syntax.
            payload = {**(kwargs.get("params") or {}), **(kwargs.get("json") or {})}
            seen.append(str(url))
            seen.extend(str(v) for v in payload.values())
            return _Recorded()

        module = __import__(
            f"implementation_scripts.api_{entry.slug}", fromlist=["x"])
        original = getattr(module, "safe_request", None)
        if original is None:
            continue
        module.safe_request = _record
        try:
            api_registry.get_client(entry.slug).search_entity(
                profile, max_results=3)
        except Exception:
            # A client that raises on an empty body is not what this is about;
            # what was sent has already been recorded.
            pass
        finally:
            module.safe_request = original

        # **The field and the name must both survive**, rather than the byte
        # string. A client may legitimately reformat: INSPIRE parenthesises when
        # a date is present, and NDL canonicalises `creator="X"` into CQL's
        # `creator = "X"`. What must never happen is the arXiv and NDL defect —
        # the field being swallowed, so the query silently becomes a search of
        # some other field or of the whole record.
        field = expected.split(":")[0].split("=")[0].strip()
        wanted = [part for part in (field, "Ada Lovelace") if part]
        if not any(all(part in value for part in wanted) for value in seen):
            missing.append(
                f"{entry.slug}: expected the field {field!r} and the name "
                f"together in one value; sent {seen}")

    assert not missing, (
        "these clients did not send the author syntax their catalog entry "
        "cites, which is the arXiv defect's general form:\n  "
        + "\n  ".join(missing)
    )
