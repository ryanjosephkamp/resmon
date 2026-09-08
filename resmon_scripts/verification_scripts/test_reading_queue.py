"""The reading queue, over a real backend on a real socket.

Boundary: an isolated resmon backend, started as its own process on an
ephemeral port over an authored synthetic database, spoken to with real HTTP.
No provider or model is called; every record here was written by ``seed`` in
this file. Port 8742 is never bound and never probed — the assertion is in
``boundary`` — and the real corpus is never opened.

What is under test is what the feature promises a user:

* a paper saved from a run's results is *that* paper, by the id the rest of
  resmon uses, and a later run finding the same record again does not disturb
  the state the user gave it;
* every control's effect is the effect it claims — including the ones that must
  do nothing, which is where a queue quietly lies;
* removing an entry removes membership and nothing else, while the one route
  that does delete papers takes the queue rows with it;
* the export is the existing shared serializer over the selected ids, with the
  union, ordering and output-wide key allocation phase 2.1a established.

The ``seed`` / ``snapshot`` / ``seed-queue`` CLI modes at the bottom are what
the Electron spec uses to build and read the same database without adding a
fixture endpoint to the product.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "resmon_scripts"))
import httpx  # noqa: E402
from implementation_scripts import database as db, reading_queue, reference_export  # noqa: E402

#: How many papers the big run holds. Above the default page of 50 on purpose:
#: an off-by-one in the pager is invisible at 50 and a paper the user cannot
#: reach is the failure that matters.
BIG_RUN_SIZE = 51


def snapshot(path: Path) -> dict:
    """Corpus, authorship and provenance, row by row.

    Deliberately excludes ``reading_queue``: this is the "what the queue must
    never touch" snapshot, and a check that included the queue's own table
    could not tell a save from a corpus edit.
    """
    with sqlite3.connect(path) as conn:
        tables = [
            r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")
            if (r[0] == "documents" or r[0].startswith(("document_", "execution")))
            and not r[0].startswith("documents_fts")
        ]
        return {table: conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
                for table in sorted(tables)}


def seed(path: Path) -> dict:
    """An authored corpus with the three identity cases the feature turns on.

    * ``BIG_RUN_SIZE`` papers in one run, so the default page has to be crossed.
    * One paper found by two runs, which is rediscovery of the same stored id.
    * Two *different* papers whose titles, authors and years coincide, so
      "distinct ids stay distinct" is a claim with something to be wrong about
      — and so the BibTeX key allocator has a collision to resolve.
    """
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    db.init_db(conn=conn)

    big = []
    for n in range(1, BIG_RUN_SIZE + 1):
        big.append(db.insert_document(conn, {
            "source_repository": "arxiv", "external_id": f"synthetic-queue-{n:03d}",
            "title": f"Synthetic queue paper {n:03d}",
            "authors": "Ada Lovelace, Alan Turing",
            "abstract": f"Authored reading-queue fixture {n}; no provider request.",
            "doi": f"10.0000/synthetic-queue-{n:03d}" if n % 2 else None,
            "url": f"https://example.invalid/queue/{n}",
            "publication_date": "2026-09-01", "categories": "fixture",
            "metadata_hash": f"queue-{n:03d}",
        }))

    # Two separate records that a person would read as the same work. resmon
    # links near-duplicates and never merges them, and the queue must make the
    # same claim: two ids, two entries, two BibTeX keys.
    twins = [
        db.insert_document(conn, {
            "source_repository": source, "external_id": f"synthetic-twin-{source}",
            "title": "Identical Titles Considered Separately",
            "authors": "Grace Hopper", "abstract": "Authored twin fixture.",
            "doi": None, "url": f"https://example.invalid/twin/{source}",
            "publication_date": "2026-08-01", "categories": "fixture",
            "metadata_hash": f"twin-{source}",
        })
        for source in ("arxiv", "openalex")
    ]

    runs = []
    for index, members in enumerate(
        # The second run rediscovers the first paper of the big run: the same
        # stored id arriving again, which is what a weekly routine does.
        (big, [big[0]] + twins, []), 1,
    ):
        run = db.insert_execution(conn, {
            "execution_type": "deep_dive", "status": "completed",
            "start_time": f"2026-09-0{index}T12:00:00",
            "parameters": json.dumps({"keywords": ["Synthetic"], "repositories": ["arxiv"]}),
        })
        for doc in members:
            db.link_execution_document(conn, run, doc, is_new=index == 1)
        db.update_execution_status(conn, run, "completed", result_count=len(members),
                                   new_result_count=len(members) if index == 1 else 0,
                                   end_time=f"2026-09-0{index}T12:01:00")
        runs.append(run)
    conn.close()
    return {
        "big_run_id": runs[0], "rediscovery_run_id": runs[1], "empty_run_id": runs[2],
        "big_document_ids": big, "twin_document_ids": twins,
        "shared_document_id": big[0],
        "big_run_size": BIG_RUN_SIZE, "record_count": len(big) + len(twins),
        "marker": "synthetic-queue-001",
    }


def seed_queue(path: Path, document_ids: list[int]) -> dict:
    """Put ids straight into the queue, for a check about *paging* the list."""
    conn = db.get_connection(str(path))
    try:
        for document_id in document_ids:
            reading_queue.save(conn, document_id)
        return reading_queue.counts(conn)
    finally:
        conn.close()


@pytest.fixture(scope="module")
def boundary(tmp_path_factory):
    """A real backend process over the seeded database, on a free port."""
    state = tmp_path_factory.mktemp("reading-queue")
    path = state / "corpus.db"
    fixture = seed(path)
    before = snapshot(path)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port != 8742, "the launchd daemon's port is never bound by a test"
    env = {**os.environ, "RESMON_STATE_DIR": str(state), "RESMON_DB_PATH": str(path),
           "RESMON_REPORTS_DIR": str(state / "reports"),
           "RESMON_PORT_FILE": str(state / "backend.port"),
           "RESMON_CHROMIUM_PROFILE": str(state / "chromium"),
           "RESMON_DISABLE_SCHEDULER": "1", "PYTHONDONTWRITEBYTECODE": "1",
           "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring"}
    with (state / "backend.log").open("w") as log:
        proc = subprocess.Popen(
            [sys.executable, str(ROOT / "resmon_scripts/resmon.py"), str(port)],
            cwd=state, env=env, stdout=log, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{port}"
        try:
            for _ in range(150):
                assert proc.poll() is None, (state / "backend.log").read_text()
                try:
                    health = httpx.get(base + "/api/health", timeout=1).json()
                    break
                except (httpx.HTTPError, ValueError):
                    time.sleep(0.2)
            else:
                pytest.fail("isolated backend did not start")
            assert health["pid"] == proc.pid, "this test drove its own process"
            assert (state / "backend.port").read_text().strip() == str(port)
            print("INSTANCE", json.dumps({
                "base": base, "state": str(state), "database": str(path),
                "owned_pid": proc.pid, "health": health, "fixture_counts": {
                    "records": fixture["record_count"], "big_run": fixture["big_run_size"]}}))
            yield base, path, fixture
            assert snapshot(path) == before, (
                "the reading queue changed the corpus or a run's provenance")
            print("PRESERVATION", json.dumps({"tables": sorted(before), "unchanged": True}))
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)


@pytest.fixture
def clean_queue(boundary):
    """Each test starts from an empty queue and leaves one behind."""
    base, path, fixture = boundary
    with sqlite3.connect(path) as conn:
        conn.execute("DELETE FROM reading_queue")
        conn.commit()
    yield base, path, fixture
    with sqlite3.connect(path) as conn:
        conn.execute("DELETE FROM reading_queue")
        conn.commit()


def entries_of(payload: dict) -> list[int]:
    return [e["document_id"] for e in payload["entries"]]


# ---------------------------------------------------------------------------
# P1 — the id a user clicks is the paper that is saved
# ---------------------------------------------------------------------------


def test_a_paper_read_out_of_a_run_saves_under_that_same_stored_id(clean_queue):
    base, path, fixture = clean_queue
    page = httpx.get(f"{base}/api/executions/{fixture['big_run_id']}/documents",
                     params={"limit": 3}).json()
    assert page["total"] == fixture["big_run_size"]
    assert [p["queue_status"] for p in page["papers"]] == [None, None, None]

    paper = page["papers"][0]
    saved = httpx.post(base + "/api/reading-queue", json={"document_id": paper["id"]})
    assert saved.status_code == 201
    assert saved.json()["document_id"] == paper["id"]

    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM reading_queue").fetchall()
    assert [dict(r)["document_id"] for r in rows] == [paper["id"]]

    listed = httpx.get(base + "/api/reading-queue").json()
    assert entries_of(listed) == [paper["id"]]
    # The queue renders the paper, not a copy of it.
    assert listed["entries"][0]["document"]["title"] == paper["title"]
    assert listed["entries"][0]["document"]["external_id"] == paper["external_id"]

    # And the run's own view now agrees, because it reads the same table.
    again = httpx.get(f"{base}/api/executions/{fixture['big_run_id']}/documents",
                      params={"limit": 3}).json()
    assert again["papers"][0]["queue_status"] == "to_read"
    print("P1_SAVE", json.dumps({"document_id": paper["id"],
                                 "external_id": paper["external_id"]}))


def test_rediscovery_of_the_same_id_keeps_the_state_the_user_gave_it(clean_queue):
    """The regression a weekly routine would otherwise cause every week."""
    base, _, fixture = clean_queue
    shared = fixture["shared_document_id"]
    httpx.post(base + "/api/reading-queue", json={"document_id": shared})
    httpx.put(f"{base}/api/reading-queue/{shared}", json={"status": "read"})
    first = httpx.get(base + "/api/reading-queue", params={"status": "read"}).json()
    saved_at = first["entries"][0]["saved_at"]

    # The second run found the same stored record. Saving from *its* Papers tab
    # must not put a paper the user has read back on the to-read pile.
    rediscovered = httpx.get(
        f"{base}/api/executions/{fixture['rediscovery_run_id']}/documents").json()
    assert shared in [p["id"] for p in rediscovered["papers"]]
    assert next(p for p in rediscovered["papers"] if p["id"] == shared)["queue_status"] == "read"

    again = httpx.post(base + "/api/reading-queue", json={"document_id": shared})
    assert again.status_code == 201
    assert again.json()["status"] == "read"
    assert again.json()["saved_at"] == saved_at, "an idempotent save moved the save time"
    assert httpx.get(base + "/api/reading-queue",
                     params={"status": "to_read"}).json()["total"] == 0


def test_two_records_that_look_alike_stay_two_entries(clean_queue):
    """Same title, same author, same year, two ids — and two rows here."""
    base, _, fixture = clean_queue
    first, second = fixture["twin_document_ids"]
    assert first != second
    httpx.post(base + "/api/reading-queue", json={"document_id": first})
    httpx.put(f"{base}/api/reading-queue/{first}", json={"status": "read"})
    httpx.post(base + "/api/reading-queue", json={"document_id": second})

    listed = httpx.get(base + "/api/reading-queue").json()
    assert sorted(entries_of(listed)) == sorted([first, second])
    states = {e["document_id"]: e["status"] for e in listed["entries"]}
    assert states == {first: "read", second: "to_read"}
    titles = {e["document"]["title"] for e in listed["entries"]}
    assert len(titles) == 1, "the fixture's two records really do share a title"


# ---------------------------------------------------------------------------
# P3 — every control's effect is the effect it claims
# ---------------------------------------------------------------------------


def test_the_state_controls_do_what_they_say_and_nothing_more(clean_queue):
    base, path, fixture = clean_queue
    doc = fixture["big_document_ids"][5]
    httpx.post(base + "/api/reading-queue", json={"document_id": doc})

    read = httpx.put(f"{base}/api/reading-queue/{doc}", json={"status": "read"}).json()
    assert read["status"] == "read" and read["read_at"] is not None

    unread = httpx.put(f"{base}/api/reading-queue/{doc}", json={"status": "to_read"}).json()
    assert unread["status"] == "to_read"
    assert unread["read_at"] is None, "an unread paper must not carry a read date"
    assert unread["saved_at"] == read["saved_at"]

    counts = httpx.get(base + "/api/reading-queue").json()["counts"]
    assert counts == {"to_read": 1, "read": 0, "all": 1}


def test_a_state_request_that_changes_nothing_writes_nothing(clean_queue):
    """No manufactured activity: `updated_at` records changes, not requests.

    Measured at the database rather than by comparing timestamps, because
    `datetime('now')` has one-second resolution and two writes inside the same
    second would look identical to a timestamp comparison — exactly the failure
    this is meant to catch.
    """
    base, path, fixture = clean_queue
    doc = fixture["big_document_ids"][6]
    httpx.post(base + "/api/reading-queue", json={"document_id": doc})
    httpx.put(f"{base}/api/reading-queue/{doc}", json={"status": "read"})

    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        before_row = dict(conn.execute(
            "SELECT * FROM reading_queue WHERE document_id = ?", (doc,)).fetchone())
        before_changes = conn.total_changes

    repeated = httpx.put(f"{base}/api/reading-queue/{doc}", json={"status": "read"}).json()
    resaved = httpx.post(base + "/api/reading-queue", json={"document_id": doc}).json()
    assert repeated["updated_at"] == before_row["updated_at"]
    assert resaved["saved_at"] == before_row["saved_at"]

    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        after_row = dict(conn.execute(
            "SELECT * FROM reading_queue WHERE document_id = ?", (doc,)).fetchone())
        # A fresh connection's counter starts at zero; what is compared is that
        # neither request left a changed row behind.
        assert conn.total_changes == before_changes
    assert after_row == before_row


def test_concurrent_saves_of_the_same_paper_make_one_entry(clean_queue):
    base, path, fixture = clean_queue
    doc = fixture["big_document_ids"][7]
    results: list[int] = []
    barrier = threading.Barrier(8)

    def save():
        barrier.wait()
        results.append(httpx.post(base + "/api/reading-queue",
                                  json={"document_id": doc}).status_code)

    threads = [threading.Thread(target=save) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert results == [201] * 8
    with sqlite3.connect(path) as conn:
        rows = conn.execute(
            "SELECT document_id, saved_at FROM reading_queue").fetchall()
    assert len(rows) == 1 and rows[0][0] == doc
    print("P3_CONCURRENT", json.dumps({"requests": len(results), "rows": len(rows)}))


def test_bad_input_is_refused_rather_than_answered(clean_queue):
    base, _, fixture = clean_queue
    doc = fixture["big_document_ids"][8]

    assert httpx.post(base + "/api/reading-queue",
                      json={"document_id": 999999}).status_code == 404
    assert httpx.put(f"{base}/api/reading-queue/{doc}",
                     json={"status": "read"}).status_code == 404, \
        "a paper that was never saved cannot be marked read"
    assert httpx.delete(f"{base}/api/reading-queue/{doc}").status_code == 404

    httpx.post(base + "/api/reading-queue", json={"document_id": doc})
    bad_status = httpx.put(f"{base}/api/reading-queue/{doc}", json={"status": "skimmed"})
    assert bad_status.status_code == 400
    assert "skimmed" in bad_status.json()["detail"]
    assert httpx.get(base + "/api/reading-queue",
                     params={"status": "skimmed"}).status_code == 400
    assert httpx.get(base + "/api/reading-queue", params={"limit": 0}).status_code == 400
    assert httpx.get(base + "/api/reading-queue", params={"limit": 201}).status_code == 400
    assert httpx.get(base + "/api/reading-queue", params={"offset": -1}).status_code == 400
    # The refusals left the entry exactly as it was.
    assert httpx.get(base + "/api/reading-queue").json()["counts"] == {
        "to_read": 1, "read": 0, "all": 1}

    assert httpx.get(f"{base}/api/executions/999999/documents").status_code == 404
    assert httpx.get(f"{base}/api/executions/{fixture['big_run_id']}/documents",
                     params={"limit": 500}).status_code == 400
    empty = httpx.get(f"{base}/api/executions/{fixture['empty_run_id']}/documents").json()
    assert empty == {"papers": [], "total": 0, "limit": 50, "offset": 0, "only_new": False}


def test_removing_an_entry_removes_membership_and_nothing_else(clean_queue):
    """The distinction the interface has to keep: a queue is not a corpus."""
    base, path, fixture = clean_queue
    doc = fixture["big_document_ids"][9]
    before = snapshot(path)

    httpx.post(base + "/api/reading-queue", json={"document_id": doc})
    httpx.put(f"{base}/api/reading-queue/{doc}", json={"status": "read"})
    removed = httpx.delete(f"{base}/api/reading-queue/{doc}")
    assert removed.status_code == 200 and removed.json()["removed"] is True

    assert snapshot(path) == before, "removing a queue entry touched the corpus"
    assert httpx.get(base + "/api/reading-queue").json()["total"] == 0
    still_there = httpx.get(f"{base}/api/documents/{doc}/why").json()
    assert still_there["document"]["id"] == doc

    # Saving it again starts fresh rather than restoring what was removed.
    again = httpx.post(base + "/api/reading-queue", json={"document_id": doc}).json()
    assert again["status"] == "to_read" and again["read_at"] is None


def test_paging_the_queue_shows_every_entry_exactly_once(clean_queue):
    base, path, fixture = clean_queue
    ids = fixture["big_document_ids"][:BIG_RUN_SIZE]
    seed_queue(path, ids)

    first = httpx.get(base + "/api/reading-queue", params={"limit": 50}).json()
    second = httpx.get(base + "/api/reading-queue",
                       params={"limit": 50, "offset": 50}).json()
    assert first["total"] == second["total"] == BIG_RUN_SIZE
    assert len(first["entries"]) == 50 and len(second["entries"]) == 1
    seen = entries_of(first) + entries_of(second)
    assert sorted(seen) == sorted(ids)
    assert len(set(seen)) == BIG_RUN_SIZE, "a paper appeared on two pages"

    # A filter that matches nothing is an empty page, not an error and not the
    # unfiltered list.
    assert httpx.get(base + "/api/reading-queue",
                     params={"status": "read"}).json() == {
        "entries": [], "total": 0, "limit": 50, "offset": 0, "status": "read",
        "counts": {"to_read": BIG_RUN_SIZE, "read": 0, "all": BIG_RUN_SIZE}}
    beyond = httpx.get(base + "/api/reading-queue",
                       params={"limit": 50, "offset": 500}).json()
    assert beyond["entries"] == [] and beyond["total"] == BIG_RUN_SIZE


def test_deleting_a_run_leaves_the_papers_the_user_saved(clean_queue, tmp_path):
    """Provenance goes; membership stays. Two different kinds of record.

    Against a copy of the seeded database rather than the shared one, because
    deleting a run is destructive and the module's preservation check is over
    the original.
    """
    base, path, fixture = clean_queue
    copy = tmp_path / "run-delete.db"
    copy.write_bytes(path.read_bytes())
    conn = db.get_connection(str(copy))
    try:
        doc = fixture["big_document_ids"][0]
        reading_queue.save(conn, doc)
        reading_queue.set_status(conn, doc, "read")
        conn.execute("DELETE FROM executions WHERE id = ?", (fixture["big_run_id"],))
        conn.commit()

        assert conn.execute("SELECT COUNT(*) FROM execution_documents WHERE execution_id = ?",
                            (fixture["big_run_id"],)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] \
            == fixture["record_count"]
        entry = reading_queue.get_entry(conn, doc)
        assert entry is not None and entry["status"] == "read"
    finally:
        conn.close()


def test_the_owner_operated_corpus_erase_takes_the_queue_with_it(clean_queue, tmp_path):
    """Settings → Advanced is the only thing that deletes a paper.

    When it does, a queue row pointing at a paper that no longer exists would
    be a saved paper the user could never open. The cascade is the reason it
    cannot happen, and this exercises the real ``DELETE FROM documents`` that
    ``/api/admin/erase-app-data`` runs — against a copy, never the fixture.
    """
    base, path, fixture = clean_queue
    copy = tmp_path / "erase.db"
    copy.write_bytes(path.read_bytes())
    conn = db.get_connection(str(copy))
    try:
        for doc in fixture["big_document_ids"][:5]:
            reading_queue.save(conn, doc)
        assert reading_queue.counts(conn)["all"] == 5

        conn.execute("DELETE FROM documents")
        conn.commit()

        assert conn.execute("SELECT COUNT(*) FROM reading_queue").fetchone()[0] == 0, \
            "erasing the corpus left orphaned queue rows"
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# P5 — the export is the existing one, over the selected ids
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fmt", ["bibtex", "ris", "csv"])
def test_the_queue_exports_through_the_shared_serializer(clean_queue, fmt):
    base, path, fixture = clean_queue
    selection = fixture["twin_document_ids"] + fixture["big_document_ids"][:3]
    seed_queue(path, selection)

    response = httpx.post(base + "/api/export/references",
                          json={"document_ids": selection, "format": fmt})
    response.raise_for_status()
    assert response.headers["X-Resmon-Document-Count"] == str(len(selection))

    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        documents = db.get_documents_by_ids(conn, selection)
    # One call to the real serializer: this is not a queue-shaped re-render.
    assert response.text == reference_export.render(documents, fmt)[0]

    # Selection order does not change the file, and a repeated id is one entry.
    repeated = httpx.post(base + "/api/export/references",
                          json={"document_ids": selection[::-1] + selection, "format": fmt})
    assert repeated.text == response.text

    if fmt == "bibtex":
        keys = re.findall(r"^@\w+\{([^,]+),", response.text, re.M)
        assert len(keys) == len(set(keys)) == len(selection), \
            "two distinct papers shared a citation key"
        # The twins are the collision: same surname, same year, same first long
        # word. They must differ by a suffix rather than by being merged.
        hopper = [k for k in keys if k.startswith("hopper2026")]
        assert len(hopper) == 2 and hopper[0] != hopper[1]
    elif fmt == "ris":
        assert response.text.count("TY  - ") == len(selection)
    else:
        assert response.text.strip().count("\n") == len(selection)
    print("P5_EXPORT", json.dumps({
        "format": fmt, "selected": len(selection),
        "sha256": hashlib.sha256(response.content).hexdigest()}))


def test_an_export_failure_is_reported_rather_than_saved(clean_queue):
    base, path, fixture = clean_queue
    seed_queue(path, fixture["big_document_ids"][:2])
    bad = httpx.post(base + "/api/export/references",
                     json={"document_ids": fixture["big_document_ids"][:2],
                           "format": "endnote"})
    assert bad.status_code == 400
    assert "endnote" in bad.json()["detail"]


# ---------------------------------------------------------------------------
# P2 — the state survives a restart, with the same values
# ---------------------------------------------------------------------------


def _start_backend(state: Path, path: Path) -> tuple[subprocess.Popen, str]:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port != 8742
    env = {**os.environ, "RESMON_STATE_DIR": str(state), "RESMON_DB_PATH": str(path),
           "RESMON_REPORTS_DIR": str(state / "reports"),
           "RESMON_PORT_FILE": str(state / "backend.port"),
           "RESMON_DISABLE_SCHEDULER": "1", "PYTHONDONTWRITEBYTECODE": "1",
           "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring"}
    log = (state / f"backend-{port}.log").open("w")
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "resmon_scripts/resmon.py"), str(port)],
        cwd=state, env=env, stdout=log, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(150):
        assert proc.poll() is None, (state / f"backend-{port}.log").read_text()
        try:
            assert httpx.get(base + "/api/health", timeout=1).json()["pid"] == proc.pid
            return proc, base
        except (httpx.HTTPError, ValueError, AssertionError):
            time.sleep(0.2)
    pytest.fail("isolated backend did not start")


def _stop(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


def test_the_queue_survives_a_backend_restart_unchanged(tmp_path):
    """Two processes, one database, and the same rows on the other side."""
    state = tmp_path / "restart"
    state.mkdir()
    path = state / "corpus.db"
    fixture = seed(path)

    proc, base = _start_backend(state, path)
    try:
        kept = fixture["big_document_ids"][:3]
        for doc in kept:
            assert httpx.post(base + "/api/reading-queue",
                              json={"document_id": doc}).status_code == 201
        httpx.put(f"{base}/api/reading-queue/{kept[1]}", json={"status": "read"})
        before = httpx.get(base + "/api/reading-queue", params={"status": "all"}).json()
    finally:
        _stop(proc)

    with sqlite3.connect(path) as conn:
        rows_on_disk = conn.execute(
            "SELECT document_id, status, saved_at, updated_at, read_at "
            "FROM reading_queue ORDER BY document_id").fetchall()

    proc, base = _start_backend(state, path)
    try:
        after = httpx.get(base + "/api/reading-queue", params={"status": "all"}).json()
        assert after["counts"] == {"to_read": 2, "read": 1, "all": 3}
        # Row values, not just counts: a restart that rewrote a timestamp would
        # pass a count check and lose the user's history.
        assert [(e["document_id"], e["status"], e["saved_at"], e["updated_at"],
                 e["read_at"]) for e in
                sorted(after["entries"], key=lambda e: e["document_id"])] == \
            [tuple(r) for r in rows_on_disk]
        assert entries_of(after) == entries_of(before)
        assert database_version(path) == 14
        print("P2_RESTART", json.dumps({"entries": after["counts"], "rows": len(rows_on_disk)}))
    finally:
        _stop(proc)


def database_version(path: Path) -> int:
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        return db.get_schema_version(conn)


def test_a_fresh_database_carries_the_queue_from_the_first_launch(tmp_path):
    path = tmp_path / "fresh.db"
    db.init_db(str(path))
    conn = db.get_connection(str(path))
    try:
        assert db.get_schema_version(conn) == 14
        assert reading_queue.counts(conn) == {"to_read": 0, "read": 0, "all": 0}
        columns = {r[1] for r in conn.execute("PRAGMA table_info(reading_queue)")}
        assert columns == {"document_id", "status", "saved_at", "updated_at", "read_at"}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# The database's own invariants, in-process against real SQLite
# ---------------------------------------------------------------------------


def test_the_table_refuses_a_state_it_cannot_justify(tmp_path):
    """The CHECKs, exercised directly: a promise the schema keeps, not the code."""
    path = tmp_path / "checks.db"
    db.init_db(str(path))
    conn = db.get_connection(str(path))
    try:
        doc = db.insert_document(conn, {
            "source_repository": "arxiv", "external_id": "check-1", "title": "T",
            "metadata_hash": "check-1"})
        conn.execute("INSERT INTO reading_queue (document_id) VALUES (?)", (doc,))
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE reading_queue SET status = 'skimmed'")
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE reading_queue SET status = 'read'")   # no read_at
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "UPDATE reading_queue SET read_at = datetime('now')")  # still to_read
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO reading_queue (document_id) VALUES (999999)")
    finally:
        conn.close()


if __name__ == "__main__":
    mode, target, *extra = sys.argv[1:]
    if mode == "seed":
        result = seed(Path(target))
    elif mode == "seed-queue":
        result = seed_queue(Path(target), json.loads(extra[0]))
    else:
        result = snapshot(Path(target))
    print(json.dumps(result))
