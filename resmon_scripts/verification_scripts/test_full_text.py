"""Get the PDF end to end in the engine: a request, the caps, the pacing, the worker, the Library.

Against the loopback https server of ``tls_loopback`` with a test authority,
as ``test_fulltext_download.py`` is. Every paper and every copy is authored.
"""
from __future__ import annotations

import http.server
import os
import socket
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import sqlite3

import pytest

from implementation_scripts import database, full_text, fulltext_download as fd, library, open_access
from verification_scripts.tls_loopback import TEST_HOSTS, LoopbackHTTPS, pdf_body

HOSTS = (*TEST_HOSTS, "arxiv.org")


def _resolve(host, port, *args, **kwargs):
    if host not in HOSTS:
        raise socket.gaierror(f"{host} is not a test name")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    srv = LoopbackHTTPS(tmp_path_factory.mktemp("tls"), hosts=HOSTS)
    srv.start()
    yield srv
    srv.stop()


@pytest.fixture()
def db(tmp_path, server, monkeypatch):
    monkeypatch.setattr(fd, "_CA_BUNDLE", str(server.ca_path))
    monkeypatch.setattr(fd, "_LOOPBACK_TEST_HOSTS", frozenset(HOSTS))
    monkeypatch.setattr(fd, "_RESOLVE", _resolve)
    monkeypatch.setattr(full_text, "HOST_INTERVAL_SECONDS", 0.6)
    monkeypatch.setattr(full_text, "worker", full_text.Worker())
    server.routes.clear()
    server.requests.clear()
    path = tmp_path / "ft.db"
    database.init_db(path)
    conn = database.get_connection(path)
    full_text.worker.configure(lambda: database.get_connection(path))
    (tmp_path / "parent").mkdir()
    library.create_vault(conn, str(tmp_path / "parent"))
    yield conn
    full_text.worker.shutdown()
    conn.close()


def _paper(conn, n: int, *, url: str | None = None, license: str | None = "cc-by",
           reported_by: str = "openalex", doi: str | None = None) -> int:
    cursor = conn.execute(
        "INSERT INTO documents (source_repository, external_id, doi, title, authors, publication_date, "
        "metadata_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("openalex", f"W{n}", doi, f"Authored fixture paper {n}", "Ada Fixture", "2026-01-01", f"h{n}"))
    document_id = cursor.lastrowid
    if url:
        open_access.record(conn, document_id, reported_by, [open_access.location(
            reported_by, pdf_url=url, license=license, version="publishedVersion")], [])
    conn.commit()
    return document_id


def _settle(conn, timeout: float = 20.0) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        busy = conn.execute(
            "SELECT count(*) FROM full_text_downloads WHERE state IN ('waiting', 'downloading')").fetchone()[0]
        if not busy and full_text.worker.idle():
            return
        time.sleep(0.05)
    raise AssertionError("downloads did not finish")


def _row(conn, download_id):
    return dict(conn.execute("SELECT * FROM full_text_downloads WHERE id = ?", (download_id,)).fetchone())


def _serve(server, path, size=6000, delay=0.0):
    body = pdf_body(size)

    def route(_handler):
        if delay:
            time.sleep(delay)
        return 200, {"Content-Type": "application/pdf"}, body
    server.routes[path] = route
    return body


def test_a_requested_pdf_lands_in_the_library_with_its_origin(db, server, tmp_path):
    body = _serve(server, "/a.pdf")
    server.routes["/start"] = lambda _h: (302, {"Location": server.url("/a.pdf", "mirror.resmon.test"),
                                                "Content-Length": "0"}, b"")
    paper = _paper(db, 1, url=server.url("/start"))
    asked = full_text.request(db, paper)
    assert asked["state"] == "waiting" and asked["license"] == "cc-by"
    _settle(db)
    row = _row(db, asked["id"])
    assert row["state"] == "stored"
    assert row["final_url"] == server.url("/a.pdf", "mirror.resmon.test")
    assert (row["license"], row["reported_by"], row["byte_size"]) == ("cc-by", "openalex", len(body))
    assert row["finished_at_utc"] and row["requested_by"] == "person"
    held = full_text.library_pdf(db, paper)
    assert held["file_id"] == row["file_id"]
    file = dict(db.execute("SELECT * FROM library_files WHERE file_id = ?", (row["file_id"],)).fetchone())
    assert file["media_type"] == "application/pdf" and file["original_name"].endswith(".pdf")
    vault = library.vault_row(db)
    assert (tmp_path / "parent" / f"resmon-library-{vault['vault_id']}" / file["relative_path"]).read_bytes() == body
    status = full_text.status_for(db, [paper])[0]
    assert status["in_library"]["file_id"] == row["file_id"] and status["download"]["state"] == "stored"
    # Asked again, the Library's copy is the answer and nothing new is recorded.
    again = full_text.request(db, paper)
    assert again["state"] == "stored" and again["reason"] == "already_in_library" and again["id"] is None


@pytest.mark.parametrize("setup, reason", [
    (dict(url=None), "no_open_copy"),
    (dict(license=None), "no_license"),
    (dict(license="publisher-specific-oa"), "no_license"),
    (dict(reported_by="core"), "refused_source"),
    (dict(url="https://link.springer.com/content/pdf/10.1007/x.pdf"), "refused_source"),
    (dict(url="https://bmcbioinformatics.biomedcentral.com/counter/pdf/10.1186/s12859-020-03566-9.pdf"),
     "refused_source"),
    (dict(url="https://www.nature.com/articles/s41586-020-2649-2.pdf"), "refused_source"),
])
def test_a_request_that_cannot_go_ahead_is_skipped_with_no_request_sent(db, server, setup, reason):
    _serve(server, "/a.pdf")
    fields = {"url": server.url("/a.pdf"), **setup}
    paper = _paper(db, 2, **fields)
    asked = full_text.request(db, paper)
    assert (asked["state"], asked["reason"]) == ("skipped", reason)
    assert asked["words"] == full_text.REASON_WORDS[reason]
    assert server.requests == []


def test_no_library_folder_is_a_reason_not_a_failure(db, server):
    db.execute("DELETE FROM library_vault")
    db.commit()
    paper = _paper(db, 3, url=server.url("/a.pdf"))
    assert full_text.request(db, paper)["reason"] == "no_library"


def test_the_daily_cap_counts_every_request_sent_in_24_hours(db, server, monkeypatch):
    monkeypatch.setattr(full_text, "DAILY_CAP", 3)
    _serve(server, "/a.pdf")
    paper = _paper(db, 4, url=server.url("/a.pdf"))
    now = datetime.now(timezone.utc)
    for when, state in ((now - timedelta(hours=2), "stored"), (now - timedelta(hours=3), "failed"),
                        (now - timedelta(hours=30), "stored"), (now - timedelta(hours=1), "skipped")):
        db.execute("INSERT INTO full_text_downloads (document_id, requested_by, state, reason, file_id, "
                   "final_url, license, requested_at_utc, finished_at_utc) VALUES (?, 'person', ?, ?, ?, ?, ?, ?, ?)",
                   (paper, state, None if state == "stored" else "x", "f" if state == "stored" else None,
                    "https://x/a.pdf" if state == "stored" else None, "cc-by" if state == "stored" else None,
                    when.isoformat(), when.isoformat()))
    db.commit()
    # Two sent in the last day (the 30-hour-old one and the skipped one do not count).
    assert full_text.attempted_today(db) == 2
    first = full_text.request(db, paper)
    assert first["state"] == "waiting"
    other = _paper(db, 5, url=server.url("/a.pdf"))
    assert full_text.request(db, other)["reason"] == "daily_cap"
    _settle(db)


def test_one_host_is_asked_one_at_a_time_and_at_its_pace(db, server):
    _serve(server, "/slow.pdf", delay=0.8)
    _serve(server, "/b.pdf")
    first = _paper(db, 6, url=server.url("/slow.pdf"))
    second = _paper(db, 7, url=server.url("/slow.pdf") + "?second")
    elsewhere = _paper(db, 8, url=server.url("/b.pdf", "mirror.resmon.test"))
    for paper in (first, second, elsewhere):
        full_text.request(db, paper)
    _settle(db)
    on_pdf = [r for r in server.requests if r["host"].startswith("pdf.resmon.test")]
    on_mirror = [r for r in server.requests if r["host"].startswith("mirror.resmon.test")]
    assert len(on_pdf) == 2 and len(on_mirror) == 1
    # The second request to the host began after the first was answered,
    # and at least the host's interval after the first began.
    assert on_pdf[1]["at"] >= on_pdf[0]["done"]
    assert on_pdf[1]["at"] - on_pdf[0]["at"] >= full_text.HOST_INTERVAL_SECONDS - 0.05
    # Another host did not wait for it.
    assert on_mirror[0]["at"] < on_pdf[0]["done"]
    states = {r[0] for r in db.execute("SELECT state FROM full_text_downloads")}
    assert states == {"stored"}


def test_the_database_holds_one_at_a_time_per_host_across_engines(db, server):
    """A row downloading from a host in another engine keeps this one's from starting."""
    _serve(server, "/a.pdf")
    paper = _paper(db, 9, url=server.url("/a.pdf"))
    now = datetime.now(timezone.utc).isoformat()
    db.execute("INSERT INTO full_text_downloads (document_id, requested_by, state, url, host, license, "
               "requested_at_utc, started_at_utc, claimed_by) VALUES (?, 'person', 'downloading', ?, "
               "'pdf.resmon.test', 'cc-by', ?, ?, 'another-engine')", (paper, server.url("/x.pdf"), now, now))
    other = _paper(db, 10, url=server.url("/a.pdf"))
    asked = full_text.request(db, other)
    time.sleep(1.0)
    assert _row(db, asked["id"])["state"] == "waiting" and server.requests == []
    db.execute("UPDATE full_text_downloads SET state = 'stored', file_id = 'f', final_url = 'https://x', "
               "finished_at_utc = ? WHERE claimed_by = 'another-engine'", (now,))
    db.commit()
    full_text.worker.wake()
    _settle(db)
    assert _row(db, asked["id"])["state"] == "stored"


def test_a_stale_download_is_read_as_interrupted_and_can_be_asked_again(db, server):
    _serve(server, "/a.pdf")
    paper = _paper(db, 11, url=server.url("/a.pdf"))
    old = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    db.execute("INSERT INTO full_text_downloads (document_id, requested_by, state, url, host, license, "
               "requested_at_utc, started_at_utc) VALUES (?, 'person', 'downloading', ?, 'pdf.resmon.test', "
               "'cc-by', ?, ?)", (paper, server.url("/a.pdf"), old, old))
    db.commit()
    assert full_text.status_for(db, [paper])[0]["download"]["reason"] == "interrupted"
    asked = full_text.request(db, paper)
    assert asked["state"] == "waiting"
    _settle(db)
    assert _row(db, asked["id"])["state"] == "stored"


def _ended_pid() -> int:
    """The pid of a process that has run and exited."""
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def _downloading(conn, paper: int, url: str, claimed_by: str) -> int:
    now = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        "INSERT INTO full_text_downloads (document_id, requested_by, state, url, host, license, "
        "requested_at_utc, started_at_utc, claimed_by) VALUES (?, 'person', 'downloading', ?, 'pdf.resmon.test', "
        "'cc-by', ?, ?, ?)", (paper, url, now, now, claimed_by))
    conn.commit()
    return int(cursor.lastrowid)


def test_a_download_a_stopped_engine_left_is_interrupted_when_the_next_one_starts(db, server, monkeypatch):
    """A row a quit engine left ``downloading`` read "Getting the PDF" for ten minutes after a restart."""
    import resmon as resmon_mod

    _serve(server, "/b.pdf")
    left = _paper(db, 21, url=server.url("/left.pdf"))
    elsewhere = _paper(db, 22, url=server.url("/elsewhere.pdf"))
    # On another host: the live claim holds pdf.resmon.test, one download at a time.
    waiting = _paper(db, 23, url=server.url("/b.pdf", "mirror.resmon.test"))
    stopped = _downloading(db, left, server.url("/left.pdf"), f"{_ended_pid()}:{uuid.uuid4()}")
    # Claimed by a live process: another engine on this database may be downloading it.
    other = _downloading(db, elsewhere, server.url("/elsewhere.pdf"), f"{os.getppid()}:{uuid.uuid4()}")
    asked = full_text.request(db, waiting, wake=False)
    assert full_text.status_for(db, [left])[0]["download"]["state"] == "downloading"

    path = db.execute("PRAGMA database_list").fetchone()[2]
    monkeypatch.setattr(resmon_mod, "_get_db", lambda: db)
    monkeypatch.setattr(resmon_mod, "_open_connection", lambda: database.get_connection(path))
    resmon_mod._init_full_text_on_startup()

    row = _row(db, stopped)
    assert (row["state"], row["reason"]) == ("failed", "interrupted") and row["finished_at_utc"]
    said = full_text.status_for(db, [left])[0]["download"]
    assert said["words"] == "The engine stopped while this PDF was downloading."
    assert _row(db, other)["state"] == "downloading"
    # The worker was woken for what was waiting from before.
    end = time.monotonic() + 20
    while _row(db, asked["id"])["state"] in ("waiting", "downloading") and time.monotonic() < end:
        time.sleep(0.05)
    assert _row(db, asked["id"])["state"] == "stored"
    # Asked again, the interrupted paper waits its turn rather than reading as still downloading.
    again = full_text.request(db, left, wake=False)
    assert again["state"] == "waiting" and again["id"] != stopped
    db.execute("DELETE FROM full_text_downloads WHERE id IN (?, ?)", (other, again["id"]))
    db.commit()


def test_this_engines_own_download_is_left_downloading(db, server):
    paper = _paper(db, 24, url=server.url("/mine.pdf"))
    mine = _downloading(db, paper, server.url("/mine.pdf"), full_text.claimant())
    assert full_text.adopt_interrupted(db) == 0
    assert _row(db, mine)["state"] == "downloading"
    db.execute("DELETE FROM full_text_downloads WHERE id = ?", (mine,))
    db.commit()


@pytest.mark.parametrize("route, reason", [
    (lambda _h: (404, {"Content-Type": "text/plain"}, b"no"), "http_status"),
    (lambda _h: (200, {"Content-Type": "text/html"}, b"<html>"), "wrong_type"),
    (lambda _h: (200, {"Content-Type": "application/pdf"}, b"<html>sign in</html>"), "not_pdf"),
])
def test_a_failed_download_is_recorded_with_its_reason(db, server, route, reason):
    server.routes["/bad"] = route
    paper = _paper(db, 12, url=server.url("/bad"))
    asked = full_text.request(db, paper)
    _settle(db)
    row = _row(db, asked["id"])
    assert (row["state"], row["reason"]) == ("failed", reason) and row["detail"]
    assert full_text.library_pdf(db, paper) is None


def _watch_run(conn, *, pdfs: bool = True) -> tuple[int, int]:
    """A watch with its PDFs switch as given, and a completed run of it: their ids."""
    routine = database.insert_routine(conn, {
        "name": f"PDF watch {time.monotonic_ns()}", "schedule_cron": "0 7 * * 1",
        "parameters": '{"query": "x", "repositories": ["openalex"]}', "is_active": 0,
        "download_full_text": 1 if pdfs else 0})
    run = conn.execute("INSERT INTO executions (execution_type, routine_id, parameters, start_time, status) "
                       "VALUES ('automated_sweep', ?, '{}', '2026-11-05T00:00:00', 'completed')",
                       (routine,)).lastrowid
    conn.commit()
    return routine, run


def test_a_watch_run_asks_for_its_new_papers_up_to_its_cap(db, server, monkeypatch):
    monkeypatch.setattr(full_text, "PER_RUN_CAP", 3)
    _serve(server, "/a.pdf")
    _routine, run = _watch_run(db)
    papers = [_paper(db, 20 + n, url=server.url(f"/a.pdf?{n}")) for n in range(5)]
    papers.append(_paper(db, 30, url=None))
    known = _paper(db, 31, url=server.url("/a.pdf?known"))
    for paper in papers:
        db.execute("INSERT INTO execution_documents (execution_id, document_id, is_new) VALUES (?, ?, 1)",
                   (run, paper))
    db.execute("INSERT INTO execution_documents (execution_id, document_id, is_new) VALUES (?, ?, 0)",
               (run, known))
    db.commit()
    result = full_text.for_watch_run(db, run)
    _settle(db)
    result = full_text.for_execution(db, run)
    by_paper = {r["document_id"]: r for r in result["requests"]}
    assert [by_paper[p]["state"] for p in papers[:3]] == ["stored"] * 3
    assert [by_paper[p]["reason"] for p in papers[3:5]] == ["run_cap", "run_cap"]
    # A paper with no open copy is skipped for that, and does not use the cap.
    assert by_paper[papers[5]]["reason"] == "no_open_copy"
    # A paper the run did not find new is not asked for.
    assert known not in by_paper
    assert result["counts"]["stored"] == 3 and result["counts"]["skipped"] == 3
    assert all(r["requested_by"] == "watch" and r["execution_id"] == run for r in result["requests"])


@pytest.mark.parametrize("change, reason", [
    (lambda conn, routine: database.update_routine(conn, routine, {"download_full_text": 0}), "watch_off"),
    (lambda conn, routine: database.delete_routine(conn, routine), "watch_gone"),
])
def test_a_watchs_waiting_pdfs_are_not_fetched_once_it_no_longer_wants_them(db, server, change, reason):
    """Before, a watch's queued PDFs kept downloading after its switch was turned off or it was deleted."""
    _serve(server, "/w.pdf")
    routine, run = _watch_run(db)
    papers = [_paper(db, 40 + n, url=server.url(f"/w.pdf?{n}")) for n in range(3)]
    for paper in papers:
        db.execute("INSERT INTO execution_documents (execution_id, document_id, is_new) VALUES (?, ?, 1)",
                   (run, paper))
    db.commit()
    # Asked for, and not yet fetched.
    asked = [full_text.request(db, p, requested_by="watch", execution_id=run, wake=False) for p in papers]
    assert {a["state"] for a in asked} == {"waiting"}
    # A person's request for another paper is not the watch's to withdraw.
    mine = full_text.request(db, _paper(db, 49, url=server.url("/w.pdf?mine")), wake=False)
    change(db, routine)
    full_text.worker.wake()
    _settle(db)
    for a in asked:
        row = _row(db, a["id"])
        assert (row["state"], row["reason"]) == ("skipped", reason)
        assert full_text.for_execution(db, run)["requests"][0]["words"] == full_text.REASON_WORDS[reason]
    assert _row(db, mine["id"])["state"] == "stored"
    assert [r["path"] for r in server.requests] == ["/w.pdf?mine"]


def test_a_watch_request_claimed_before_its_switch_went_off_is_not_fetched(db, server, tmp_path):
    _serve(server, "/c.pdf")
    routine, run = _watch_run(db)
    paper = _paper(db, 50, url=server.url("/c.pdf"))
    asked = full_text.request(db, paper, requested_by="watch", execution_id=run, wake=False)
    claimed = full_text.worker._claim(db)
    assert claimed["id"] == asked["id"]
    database.update_routine(db, routine, {"download_full_text": 0})
    full_text.worker._download(db, claimed, tmp_path)
    assert (_row(db, asked["id"])["state"], _row(db, asked["id"])["reason"]) == ("skipped", "watch_off")
    assert server.requests == []


def test_asking_again_for_a_paper_skipped_for_the_same_reason_records_nothing_new(db, server):
    """Each click on a card whose paper could not be fetched recorded another skipped row."""
    paper = _paper(db, 60, url=None)
    first = full_text.request(db, paper)
    again = full_text.request(db, paper)
    assert (first["state"], first["reason"]) == ("skipped", "no_open_copy")
    assert again["id"] == first["id"]
    assert db.execute("SELECT count(*) FROM full_text_downloads WHERE document_id = ?", (paper,)).fetchone()[0] == 1
    # A new reason is a new answer, and is recorded.
    open_access.record(db, paper, "openalex", [open_access.location(
        "openalex", pdf_url=server.url("/x.pdf"), license="publisher-specific-oa")], [])
    db.commit()
    changed = full_text.request(db, paper)
    assert changed["reason"] == "no_license" and changed["id"] != first["id"]
    # A watch run's skip is its own, so its run's page lists it.
    _routine, run = _watch_run(db)
    watched = full_text.request(db, paper, requested_by="watch", execution_id=run, wake=False)
    assert watched["id"] != changed["id"] and watched["execution_id"] == run


def test_the_database_holds_one_waiting_or_downloading_request_a_paper(db, server):
    paper = _paper(db, 70, url=server.url("/one.pdf"))
    copy = {"pdf_url": server.url("/one.pdf"), "license": "cc-by", "reported_by": "openalex"}
    full_text._record(db, paper, "person", None, "waiting", copy=copy)
    with pytest.raises(sqlite3.IntegrityError):
        full_text._record(db, paper, "watch", None, "waiting", copy=copy)
    db.rollback()
    # A finished request is not in the way of the next.
    full_text._record(db, paper, "person", None, "skipped", reason="daily_cap", copy=copy)
    assert db.execute("SELECT count(*) FROM full_text_downloads WHERE document_id = ?", (paper,)).fetchone()[0] == 2


def test_two_requests_for_one_paper_at_once_make_one(db, server, monkeypatch):
    """``request`` checks for a pending request and then writes one; another can go in between."""
    paper = _paper(db, 71, url=server.url("/race.pdf"))
    path = db.execute("PRAGMA database_list").fetchone()[2]
    looked = full_text.library_pdf

    def meanwhile(conn, document_id):
        # Another window's request for the same paper lands after this one looked.
        other = database.get_connection(path)
        try:
            full_text._record(other, document_id, "person", None, "waiting",
                              copy={"pdf_url": server.url("/race.pdf"), "license": "cc-by", "reported_by": "openalex"})
        finally:
            other.close()
        monkeypatch.setattr(full_text, "library_pdf", looked)
        return looked(conn, document_id)

    monkeypatch.setattr(full_text, "library_pdf", meanwhile)
    asked = full_text.request(db, paper, wake=False)
    rows = db.execute("SELECT id, state FROM full_text_downloads WHERE document_id = ?", (paper,)).fetchall()
    assert [tuple(r) for r in rows] == [(asked["id"], "waiting")]


def test_a_paper_the_library_got_meanwhile_is_not_downloaded_again(db, server, tmp_path):
    _serve(server, "/later.pdf")
    paper = _paper(db, 72, url=server.url("/later.pdf"))
    asked = full_text.request(db, paper, wake=False)
    vault = library.vault_row(db)["vault_id"]
    with library.Import(db, vault, "by hand.pdf", document_id=paper) as receipt:
        receipt.write(pdf_body(2000))
        receipt.finish()
    claimed = full_text.worker._claim(db)
    full_text.worker._download(db, claimed, tmp_path)
    assert (_row(db, asked["id"])["state"], _row(db, asked["id"])["reason"]) == ("skipped", "already_in_library")
    assert server.requests == []


def _vault_root(conn, tmp_path):
    return tmp_path / "parent" / f"resmon-library-{library.vault_row(conn)['vault_id']}"


def test_an_engine_stopping_before_the_import_puts_the_pdf_back_to_wait(db, server, tmp_path, monkeypatch):
    """The worker's threads never looked at the stop, so a quit could cut an import short."""
    _serve(server, "/stop.pdf")
    paper = _paper(db, 80, url=server.url("/stop.pdf"))
    asked = full_text.request(db, paper, wake=False)
    claimed = full_text.worker._claim(db)
    fetch = fd.fetch_pdf

    def fetched_then_stopped(*args, **kwargs):
        got = fetch(*args, **kwargs)
        full_text.worker._stop.set()
        return got

    monkeypatch.setattr(fd, "fetch_pdf", fetched_then_stopped)
    full_text.worker._download(db, claimed, tmp_path)
    row = _row(db, asked["id"])
    assert (row["state"], row["started_at_utc"], row["claimed_by"]) == ("waiting", None, None)
    assert full_text.library_pdf(db, paper) is None
    assert not (_vault_root(db, tmp_path) / ".import.lock").exists()


def test_a_stopping_engine_waits_for_a_pdf_going_into_the_library(db, server, tmp_path, monkeypatch):
    """Shutdown waited five seconds for nothing in particular; an import cut short left its lock behind."""
    _serve(server, "/slow.pdf")
    paper = _paper(db, 81, url=server.url("/slow.pdf"))
    finish = library.Import.finish
    importing = threading.Event()

    def slow_finish(self):
        importing.set()
        time.sleep(1.0)
        return finish(self)

    monkeypatch.setattr(library.Import, "finish", slow_finish)
    asked = full_text.request(db, paper)
    assert importing.wait(20)
    full_text.worker.shutdown(timeout=0.05)
    assert _row(db, asked["id"])["state"] == "stored"
    assert not (_vault_root(db, tmp_path) / ".import.lock").exists()


def test_staging_folders_a_stopped_engine_left_are_removed_at_the_start(tmp_path):
    gone = tmp_path / f"{full_text.STAGING_PREFIX}{_ended_pid()}-abc"
    mine = tmp_path / f"{full_text.STAGING_PREFIX}{os.getpid()}-def"
    running = tmp_path / f"{full_text.STAGING_PREFIX}{os.getppid()}-ghi"
    other = tmp_path / f"{full_text.STAGING_PREFIX}notapid"
    for folder in (gone, mine, running, other):
        folder.mkdir()
        (folder / "download.pdf").write_bytes(b"%PDF-1.7")
    assert full_text.clear_stale_staging(tmp_path) == [gone.name]
    assert not gone.exists() and mine.exists() and running.exists() and other.exists()


def test_an_import_lock_left_by_a_stopped_import_is_removed_when_the_next_engine_starts(db, tmp_path, monkeypatch):
    """The Library read busy for good after a quit in the middle of an import."""
    import resmon as resmon_mod

    root = _vault_root(db, tmp_path)
    (root / ".import.lock").write_bytes(b"")
    (root / ".staging-00000000-0000-4000-8000-000000000000").write_bytes(b"%PDF-1.7 half")
    old = time.time() - 3600
    for name in (".import.lock", ".staging-00000000-0000-4000-8000-000000000000"):
        os.utime(root / name, (old, old))
    assert library.status(db)["status"] == "busy"
    monkeypatch.setattr(resmon_mod, "_get_db", lambda: db)
    resmon_mod._recover_library_on_startup(time.time() - 60)
    assert sorted(p.name for p in root.iterdir()) == ["files", "vault.json"]
    assert library.status(db)["status"] == "ready"
    vault = library.vault_row(db)["vault_id"]
    with library.Import(db, vault, "after.pdf") as receipt:
        receipt.write(pdf_body(1000))
        receipt.finish()


def test_an_import_lock_this_engine_may_hold_is_left(db, tmp_path):
    root = _vault_root(db, tmp_path)
    vault = library.vault_row(db)["vault_id"]
    # Newer than the engine's start: an import that may still be going wrote it.
    (root / ".import.lock").write_bytes(b"")
    assert library.recover_stale_import_lock(db, time.time() - 60) == []
    assert (root / ".import.lock").exists()
    (root / ".import.lock").unlink()
    # An import running in this process holds it, however old the start says it is.
    with library.Import(db, vault, "held.pdf") as receipt:
        assert library.imports_running() == 1
        assert library.recover_stale_import_lock(db, time.time() + 60) == []
        assert (root / ".import.lock").exists()
        receipt.write(pdf_body(1000))
        receipt.finish()
    assert library.imports_running() == 0 and not (root / ".import.lock").exists()


class _OAI(http.server.BaseHTTPRequestHandler):
    answers: dict[str, str] = {}

    def log_message(self, *args):
        return

    def do_GET(self):  # noqa: N802
        identifier = self.path.split("identifier=", 1)[-1].split("&", 1)[0].replace("%3A", ":").replace("%2F", "/")
        license_url = self.answers.get(identifier)
        inner = f"<license>{license_url}</license>" if license_url else ""
        body = (f'<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><GetRecord><record><metadata>'
                f'<arXiv xmlns="http://arxiv.org/OAI/arXiv/"><id>x</id>{inner}</arXiv>'
                f'</metadata></record></GetRecord></OAI-PMH>').encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture()
def oai(monkeypatch):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _OAI)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(full_text, "_ARXIV_OAI", f"http://127.0.0.1:{srv.server_address[1]}/oai2")
    from implementation_scripts import api_arxiv
    monkeypatch.setattr(api_arxiv, "_RATE_LIMITER", api_arxiv.RateLimiter(requests_per_second=100))
    yield _OAI.answers
    srv.shutdown()
    srv.server_close()


def test_an_arxiv_copy_is_fetched_once_arxiv_states_its_license(db, server, oai):
    oai["oai:arXiv.org:2601.00001"] = "http://creativecommons.org/licenses/by/4.0/"
    oai["oai:arXiv.org:2601.00002"] = "http://arxiv.org/licenses/nonexclusive-distrib/1.0/"
    _serve(server, "/pdf/2601.00001")
    _serve(server, "/pdf/2601.00002")
    _serve(server, "/pdf/2601.00003")
    papers = []
    for n in (1, 2, 3):
        paper = _paper(db, 40 + n)
        open_access.record(db, paper, "arxiv", [], [("arxiv", f"2601.0000{n}")])
        db.commit()
        papers.append(paper)
    # The arXiv copy's address is arXiv's own; the test resolver sends it to loopback.
    db.execute("UPDATE document_open_access SET pdf_url = replace(pdf_url, 'https://arxiv.org/', ?)",
               (f"https://arxiv.org:{server.port}/",))
    db.commit()
    asked = [full_text.request(db, p) for p in papers]
    assert all(a["state"] == "waiting" and a["license"] is None for a in asked)
    _settle(db)
    rows = [_row(db, a["id"]) for a in asked]
    assert (rows[0]["state"], rows[0]["license"]) == ("stored", "cc-by")
    assert (rows[1]["state"], rows[1]["license"]) == ("stored", "arxiv-nonexclusive")
    # No license in arXiv's record: not downloaded, and nothing was sent to arxiv.org for it.
    assert (rows[2]["state"], rows[2]["reason"]) == ("skipped", "no_license")
    assert not any(r["path"] == "/pdf/2601.00003" for r in server.requests)
    stored = open_access.locations_for(db, [papers[0]])[0]
    assert (stored["license"], stored["license_basis"]) == ("cc-by", "host_record")


def test_the_rules_state_the_caps_and_the_license_rule():
    rules = full_text.rules()
    assert rules["per_run_cap"] == full_text.PER_RUN_CAP and rules["daily_cap"] == full_text.DAILY_CAP
    assert rules["max_bytes"] == fd.MAX_BYTES == library.MAX_FILE_BYTES
    assert [(r["source"], r["name"]) for r in rules["refused_sources"]] == [
        ("nasa_ads", "NASA ADS"), ("springer", "Springer"), ("core", "CORE"), ("bmc", "BMC"),
        ("nature", "nature.com")]
    assert all(r["why"] for r in rules["refused_sources"])
    assert {r["license"] for r in rules["open_licenses"]} == set(open_access.OPEN_LICENSES)
