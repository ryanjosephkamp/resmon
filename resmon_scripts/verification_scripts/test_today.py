"""Today: the papers resmon collected since the person last looked, by watch.

The claims, each tested against rows written here:

- **New means first collected after the last look**, whatever the paper's
  publication date, and with no look recorded the window is seven days and
  says so rather than inventing a visit.
- **Reading Today marks nothing**; only the explicit look does.
- **A paper sits in every watch whose runs returned it**, and papers no routine
  returned are counted as the person's own searches.
- **A watch's source problems come from its last run's recorded outcomes**, and
  only the problems: a source that answered is not mentioned.
- **No summary is offered.** The abstract's opening is, and only that.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient      # noqa: E402

import resmon as resmon_mod                     # noqa: E402
from implementation_scripts import today        # noqa: E402
from implementation_scripts.database import (   # noqa: E402
    insert_document, insert_execution, insert_routine, link_execution_document,
    record_execution_source, set_setting, update_execution_status,
)


@pytest.fixture
def client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    return TestClient(resmon_mod.app)


def _sqlite(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _paper(conn, key: str, seen: datetime, *, abstract: str | None = "A short abstract.",
           published: str = "2019-01-01") -> int:
    doc_id = insert_document(conn, {
        "source_repository": "arxiv", "external_id": key, "title": f"Paper {key}",
        "authors": "Ada Lovelace, Alan Turing", "abstract": abstract,
        "publication_date": published, "metadata_hash": key,
    })
    conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (_sqlite(seen), doc_id))
    conn.commit()
    return int(doc_id)


def _routine(conn, name: str, active: bool = True) -> int:
    return insert_routine(conn, {
        "name": name, "schedule_cron": "0 2 * * *",
        "parameters": json.dumps({"repositories": ["arxiv", "dblp"], "query": name}),
        "is_active": int(active),
    })


def _run(conn, routine_id: int | None, papers: list[int], when: datetime,
         sources: dict[str, tuple[str, int, str | None]] | None = None) -> int:
    exec_id = insert_execution(conn, {
        "execution_type": "automated_sweep" if routine_id else "deep_sweep",
        "routine_id": routine_id,
        "parameters": json.dumps({"repositories": list((sources or {"arxiv": None}).keys())}),
        "start_time": _sqlite(when),
    })
    for doc_id in papers:
        link_execution_document(conn, exec_id, doc_id)
    for source, (status, count, reason) in (sources or {}).items():
        record_execution_source(conn, exec_id, source, status, result_count=count, zero_reason=reason)
    update_execution_status(conn, exec_id, "completed", end_time=_sqlite(when + timedelta(minutes=3)),
                            result_count=len(papers), new_result_count=len(papers))
    return exec_id


NOW = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)


def test_with_no_look_recorded_the_window_is_seven_days_and_says_so(client):
    conn = resmon_mod._get_db()
    recent = _paper(conn, "recent", NOW - timedelta(days=2))
    _paper(conn, "old", NOW - timedelta(days=9))
    answer = today.build(conn, {}, now=NOW)
    assert answer["window"] == "first_look"
    assert answer["since"] == "2026-10-21T12:00:00Z"
    assert [p["id"] for p in answer["papers"]] == [recent] and answer["total"] == 1


def test_new_means_first_collected_after_the_last_look_whatever_the_publication_date(client):
    conn = resmon_mod._get_db()
    set_setting(conn, today.LOOKED_KEY, _sqlite(NOW - timedelta(hours=10)))
    found_last_night = _paper(conn, "found", NOW - timedelta(hours=4), published="1998-05-01")
    _paper(conn, "had", NOW - timedelta(hours=20), published="2026-10-27")
    answer = today.build(conn, {}, now=NOW)
    assert answer["window"] == "since_last_look"
    assert answer["since"] == "2026-10-28T02:00:00Z"
    assert [p["id"] for p in answer["papers"]] == [found_last_night]


def test_reading_today_marks_nothing_and_a_look_moves_the_window(client):
    conn = resmon_mod._get_db()
    _paper(conn, "a", datetime.now(timezone.utc) - timedelta(hours=1))
    first = client.get("/api/today").json()
    assert first["window"] == "first_look" and first["total"] == 1
    assert client.get("/api/today").json()["window"] == "first_look"

    looked = client.post("/api/today/looked")
    assert looked.status_code == 200, looked.text
    after = client.get("/api/today").json()
    assert after["window"] == "since_last_look"
    assert after["since"] == looked.json()["looked_at"]
    assert after["total"] == 0


def test_a_paper_sits_in_every_watch_that_returned_it(client):
    conn = resmon_mod._get_db()
    agents, protein = _routine(conn, "Agents"), _routine(conn, "Protein")
    both = _paper(conn, "both", NOW - timedelta(hours=3))
    only_agents = _paper(conn, "agents", NOW - timedelta(hours=3))
    mine = _paper(conn, "mine", NOW - timedelta(hours=2))
    _run(conn, agents, [both, only_agents], NOW - timedelta(hours=3))
    _run(conn, protein, [both], NOW - timedelta(hours=3))
    _run(conn, None, [mine], NOW - timedelta(hours=2))

    answer = today.build(conn, {}, now=NOW)
    by_id = {p["id"]: p for p in answer["papers"]}
    assert by_id[both]["watches"] == sorted([agents, protein])
    assert by_id[only_agents]["watches"] == [agents]
    assert by_id[mine]["watches"] == []
    assert answer["from_searches"] == 1
    counts = {w["name"]: w["new_count"] for w in answer["watches"]}
    assert counts == {"Agents": 2, "Protein": 1}


def test_a_watch_carries_every_paper_it_ever_returned_for_its_outline(client):
    conn = resmon_mod._get_db()
    agents = _routine(conn, "Agents")
    old = _paper(conn, "old", NOW - timedelta(days=200))
    new = _paper(conn, "new", NOW - timedelta(hours=2))
    _run(conn, agents, [old], NOW - timedelta(days=200))
    _run(conn, agents, [new], NOW - timedelta(hours=2))
    [entry] = today.build(conn, {}, now=NOW)["watches"]
    assert entry["members"] == sorted([old, new]) and entry["new_count"] == 1


def test_a_watch_names_only_the_sources_that_did_not_answer_on_its_last_run(client):
    conn = resmon_mod._get_db()
    watch = _routine(conn, "Agents")
    paper = _paper(conn, "p", NOW - timedelta(hours=3))
    _run(conn, watch, [], NOW - timedelta(days=1),
         sources={"arxiv": ("error", 0, None)})  # an older run's outage is not today's
    _run(conn, watch, [paper], NOW - timedelta(hours=3),
         sources={"arxiv": ("ok", 1, None), "dblp": ("ok", 0, "upstream_failure")})

    [entry] = today.build(conn, {}, now=NOW)["watches"]
    problems = entry["last_run"]["sources_not_answered"]
    assert [p["source"] for p in problems] == ["dblp"]
    assert problems[0]["label"] == "did not answer" and problems[0]["note"]
    # The sentence names the source as people know it; the key stays the slug.
    assert "DBLP" in problems[0]["note"] and "dblp" not in problems[0]["note"]
    assert (entry["last_run"]["sources_answered"], entry["last_run"]["sources_total"]) == (1, 2)


def test_an_inactive_watch_appears_only_when_it_found_something(client):
    conn = resmon_mod._get_db()
    quiet = _routine(conn, "Quiet", active=False)
    found = _routine(conn, "Found", active=False)
    paper = _paper(conn, "p", NOW - timedelta(hours=1))
    _run(conn, found, [paper], NOW - timedelta(hours=1))
    names = [w["name"] for w in today.build(conn, {}, now=NOW)["watches"]]
    assert names == ["Found"] and quiet


def test_the_next_fire_is_what_the_store_holds(client):
    conn = resmon_mod._get_db()
    watch = _routine(conn, "Agents")
    fire = datetime(2026, 10, 29, 6, 0, tzinfo=timezone.utc).timestamp()
    [entry] = today.build(conn, {str(watch): fire}, now=NOW)["watches"]
    assert entry["next_fire_at"] == "2026-10-29T06:00:00Z"
    [entry] = today.build(conn, {}, now=NOW)["watches"]
    assert entry["next_fire_at"] is None


def test_the_list_is_capped_and_the_total_is_not(client, monkeypatch):
    conn = resmon_mod._get_db()
    monkeypatch.setattr(today, "PAPER_LIMIT", 3)
    for n in range(5):
        _paper(conn, f"p{n}", NOW - timedelta(minutes=10 + n))
    answer = today.build(conn, {}, now=NOW)
    assert answer["total"] == 5 and len(answer["papers"]) == 3
    # Newest first.
    seen = [p["first_seen_at"] for p in answer["papers"]]
    assert seen == sorted(seen, reverse=True)


def test_the_abstract_opening_is_whole_sentences_and_never_a_summary(client):
    long_sentence = "word " * 120
    assert today.lede("First point. Second point. " + long_sentence) == "First point. Second point."
    cut = today.lede(long_sentence.strip() + ".")
    assert cut.endswith("…") and len(cut) <= today.LEDE_CHARS + 1
    assert today.lede(None) is None and today.lede("   ") is None
    conn = resmon_mod._get_db()
    _paper(conn, "x", NOW - timedelta(hours=1), abstract="It works. It is fast.")
    [paper] = today.build(conn, {}, now=NOW)["papers"]
    assert paper["abstract_lede"] == "It works. It is fast."
    assert "summary" not in paper


def test_a_look_resmon_did_not_write_is_no_record_of_a_visit(client):
    conn = resmon_mod._get_db()
    set_setting(conn, today.LOOKED_KEY, "yesterday-ish")
    assert today.build(conn, {}, now=NOW)["window"] == "first_look"


def test_reset_settings_forgets_the_last_look(client):
    client.post("/api/today/looked")
    assert client.get("/api/today").json()["window"] == "since_last_look"
    response = client.post("/api/admin/reset-settings", json={"confirm": "CONFIRM"})
    assert response.status_code == 200, response.text
    assert client.get("/api/today").json()["window"] == "first_look"


def test_the_route_reports_saved_papers(client):
    conn = resmon_mod._get_db()
    doc = _paper(conn, "saved", datetime.now(timezone.utc) - timedelta(hours=1))
    response = client.post("/api/reading-queue", json={"document_id": doc})
    assert response.status_code in (200, 201), response.text
    [paper] = client.get("/api/today").json()["papers"]
    assert paper["queue_status"] is not None


def test_briefs_answer_in_the_order_asked_and_leave_out_unknown_ids(client):
    conn = resmon_mod._get_db()
    a = _paper(conn, "a", NOW - timedelta(hours=1))
    b = _paper(conn, "b", NOW - timedelta(hours=2))
    response = client.post("/api/documents/briefs", json={"ids": [b, 999999, a, b]})
    assert response.status_code == 200, response.text
    assert [x["id"] for x in response.json()] == [b, a]
    assert response.json()[0]["title"] == "Paper b"


def test_briefs_refuse_more_than_the_limit(client):
    response = client.post("/api/documents/briefs", json={"ids": list(range(today.BRIEF_LIMIT + 1))})
    assert response.status_code == 422
