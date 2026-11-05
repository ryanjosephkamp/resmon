"""Get the PDF: open-access copies into the Library, on request or for a watch's new papers.

A request is a row in ``full_text_downloads`` (schema 27), written before
anything is fetched, so what was asked for, by whom, and what came of it is a
record rather than a log line. A request that cannot go ahead is recorded as
``skipped`` with its reason and makes no request at all: no open copy, no
license stated, a refused source, no Library folder, the paper already in the
Library, or a cap reached. One that can waits for the worker, which fetches it
(``fulltext_download``), keeps it through the Library's own import, and records
it as ``stored`` with its file, the address it came from after every redirect,
its license, and when, or as ``failed`` with the reason.

**The limits.** At most ``PER_RUN_CAP`` PDFs for one watch run, and
``DAILY_CAP`` in any 24 hours, everything counted; one download at a time from
each host, and ``HOST_INTERVAL_SECONDS`` between requests to it, every redirect
included; ``fulltext_download.MAX_BYTES`` a file. One at a time per host is
held by the database (a row is claimed only while no other row from its host is
downloading), so two engines on one database keep it too.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from . import fulltext_download, library, open_access
from .api_base import RateLimiter, reset_search_outcome, safe_request

logger = logging.getLogger(__name__)

PER_RUN_CAP = 20
DAILY_CAP = 100
HOST_INTERVAL_SECONDS = 3.0
#: How many downloads run at once, each from a different host.
MAX_PARALLEL = 3
#: A row left ``downloading`` this long belongs to an engine that stopped; it
#: no longer holds its host, and the paper can be asked for again.
STALE_SECONDS = 600
#: Tries at the Library's import while another import holds its lock.
_IMPORT_TRIES = 20

#: What each reason a request did not produce a PDF means, in the words a
#: person reads. ``fulltext_download.DownloadRefused`` supplies its own
#: sentence for the reasons it raises; these are the rest.
REASON_WORDS = {
    "no_open_copy": "No source resmon asked has reported an open copy of this paper.",
    "no_pdf": "The open copies sources reported are web pages, not PDFs.",
    "no_license": "No source states an open license for a copy of this paper, so resmon does not download it.",
    "refused_source": "The only open copies are at sources resmon does not download from.",
    "no_library": "Set up the Library folder first, in Library or Settings › Library.",
    "library_unavailable": "The Library folder could not be used.",
    "already_in_library": "This paper's PDF is already in the Library.",
    "daily_cap": f"resmon downloads at most {DAILY_CAP} PDFs in any 24 hours, and that many have been asked for.",
    "run_cap": f"A watch run downloads at most {PER_RUN_CAP} PDFs.",
    "unknown_paper": "That paper is not in this collection's database.",
    "interrupted": "The engine stopped while this PDF was downloading.",
    "library_refused": "The Library did not keep the file.",
    "error": "The download failed in a way resmon did not expect.",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _since(seconds: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


# ---------------------------------------------------------------------------
# What is known about a paper
# ---------------------------------------------------------------------------


def library_pdf(conn: sqlite3.Connection, document_id: int) -> dict | None:
    """The PDF the Library holds for this paper, linked to it, or None."""
    row = conn.execute(
        "SELECT f.file_id, f.version_id, f.vault_id, f.byte_size FROM library_file_documents l "
        "JOIN library_files f ON f.file_id = l.file_id WHERE l.document_id = ? "
        "AND f.media_type = 'application/pdf' ORDER BY f.id DESC LIMIT 1", (int(document_id),)).fetchone()
    return dict(row) if row else None


def _vault_id(conn: sqlite3.Connection) -> str | None:
    row = conn.execute("SELECT vault_id FROM library_vault WHERE singleton=1").fetchone()
    return row[0] if row else None


def _latest(conn: sqlite3.Connection, document_id: int) -> dict | None:
    row = conn.execute(
        "SELECT * FROM full_text_downloads WHERE document_id = ? ORDER BY id DESC LIMIT 1",
        (int(document_id),)).fetchone()
    return _projection(dict(row)) if row else None


def _projection(row: dict) -> dict:
    """A request as the routes return it, with a stale download read as interrupted."""
    state = row["state"]
    reason = row.get("reason")
    if state == "downloading" and (row.get("started_at_utc") or "") < _since(STALE_SECONDS):
        state, reason = "failed", "interrupted"
    return {
        "id": int(row["id"]),
        "document_id": int(row["document_id"]),
        "execution_id": row.get("execution_id"),
        "requested_by": row["requested_by"],
        "state": state,
        "reason": reason,
        "words": (row.get("detail") or REASON_WORDS.get(reason or "")) if reason else None,
        "url": row.get("url"),
        "final_url": row.get("final_url"),
        "host": row.get("host"),
        "license": row.get("license"),
        "license_words": open_access.license_words(row.get("license")),
        "version": row.get("version"),
        "reported_by": row.get("reported_by"),
        "file_id": row.get("file_id"),
        "byte_size": row.get("byte_size"),
        "requested_at_utc": row["requested_at_utc"],
        "finished_at_utc": row.get("finished_at_utc"),
    }


def _copy_projection(row: dict | None) -> dict | None:
    if row is None:
        return None
    return {
        "reported_by": row["reported_by"],
        "pdf_url": row.get("pdf_url"),
        "landing_url": row.get("landing_url"),
        "host": row.get("host"),
        "license": row.get("license"),
        "license_words": open_access.license_words(row.get("license")),
        "license_basis": row.get("license_basis"),
        "version": row.get("version"),
        "license_to_be_read": open_access.needs_license_lookup(row),
    }


def status_for(conn: sqlite3.Connection, document_ids: list[int]) -> list[dict]:
    """For each paper: its open copies, the one resmon would get, its latest request, and its Library PDF."""
    out = []
    for document_id in document_ids:
        if not conn.execute("SELECT 1 FROM documents WHERE id = ?", (int(document_id),)).fetchone():
            continue
        copies = open_access.copies_of(conn, document_id)
        rows = open_access.locations_for(conn, copies)
        summary = open_access.summary(rows)
        out.append({
            "document_id": int(document_id),
            "downloadable": summary["downloadable"],
            "why_not": summary["why_not"],
            "why_not_words": REASON_WORDS.get(summary["why_not"] or "") if summary["why_not"] else None,
            "best": _copy_projection(summary["best"]),
            "copies": [_copy_projection(r) for r in rows],
            "download": _latest(conn, document_id),
            "in_library": library_pdf(conn, document_id),
        })
    return out


def rules() -> dict:
    """The limits and the license rule, as Settings states them."""
    return {
        "per_run_cap": PER_RUN_CAP,
        "daily_cap": DAILY_CAP,
        "host_interval_seconds": HOST_INTERVAL_SECONDS,
        "one_at_a_time_per_host": True,
        "max_bytes": fulltext_download.MAX_BYTES,
        "https_only": True,
        "open_licenses": [{"license": k, "words": v} for k, v in open_access.OPEN_LICENSES.items()],
        "refused_sources": [{"source": k, "name": name, "why": open_access.refused_why(k)}
                            for k, name in open_access.REFUSED_NAMES.items()],
    }


# ---------------------------------------------------------------------------
# Asking for a PDF
# ---------------------------------------------------------------------------


def _record(conn: sqlite3.Connection, document_id: int, requested_by: str,
            execution_id: int | None, state: str, *, reason: str | None = None,
            copy: dict | None = None) -> dict:
    now = utc_now()
    cursor = conn.execute(
        "INSERT INTO full_text_downloads (document_id, execution_id, requested_by, state, reason, "
        "url, host, license, version, reported_by, requested_at_utc, finished_at_utc) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (int(document_id), execution_id, requested_by, state, reason,
         (copy or {}).get("pdf_url"), (copy or {}).get("host") or open_access.host_of((copy or {}).get("pdf_url")),
         (copy or {}).get("license"), (copy or {}).get("version"), (copy or {}).get("reported_by"),
         now, None if state in ("waiting", "downloading") else now))
    conn.commit()
    row = conn.execute("SELECT * FROM full_text_downloads WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _projection(dict(row))


def attempted_today(conn: sqlite3.Connection) -> int:
    """Requests in the last 24 hours that were or will be sent: waiting, downloading, stored, failed."""
    return int(conn.execute(
        "SELECT count(*) FROM full_text_downloads WHERE requested_at_utc >= ? "
        "AND state IN ('waiting', 'downloading', 'stored', 'failed')", (_since(86400),)).fetchone()[0])


def request(conn: sqlite3.Connection, document_id: int, *, requested_by: str = "person",
            execution_id: int | None = None, wake: bool = True, over_run_cap: bool = False) -> dict:
    """Ask for this paper's PDF. Returns the request as recorded; never raises for a refusal.

    A request already waiting or downloading for the paper is returned as it is
    rather than asked twice. A paper whose PDF the Library holds is answered
    with that file and, asked by a person, records nothing new.
    """
    document_id = int(document_id)
    if not conn.execute("SELECT 1 FROM documents WHERE id = ?", (document_id,)).fetchone():
        raise LookupError("unknown_paper")
    pending = conn.execute(
        "SELECT * FROM full_text_downloads WHERE document_id = ? AND state IN ('waiting', 'downloading') "
        "ORDER BY id DESC LIMIT 1", (document_id,)).fetchone()
    if pending is not None:
        projected = _projection(dict(pending))
        if projected["state"] in ("waiting", "downloading"):
            return projected
        conn.execute("UPDATE full_text_downloads SET state = 'failed', reason = 'interrupted', "
                     "finished_at_utc = ? WHERE id = ? AND state = 'downloading'", (utc_now(), pending["id"]))
        conn.commit()
    held = library_pdf(conn, document_id)
    if held is not None:
        if requested_by == "person":
            return {"id": None, "document_id": document_id, "execution_id": None, "requested_by": requested_by,
                    "state": "stored", "reason": "already_in_library", "words": REASON_WORDS["already_in_library"],
                    "url": None, "final_url": None, "host": None, "license": None, "license_words": None,
                    "version": None, "reported_by": None, "file_id": held["file_id"],
                    "byte_size": held["byte_size"], "requested_at_utc": utc_now(), "finished_at_utc": None}
        return _record(conn, document_id, requested_by, execution_id, "skipped", reason="already_in_library")
    if _vault_id(conn) is None:
        return _record(conn, document_id, requested_by, execution_id, "skipped", reason="no_library")
    rows = open_access.locations_for(conn, open_access.copies_of(conn, document_id))
    summary = open_access.summary(rows)
    if not summary["downloadable"]:
        return _record(conn, document_id, requested_by, execution_id, "skipped", reason=summary["why_not"])
    if over_run_cap:
        return _record(conn, document_id, requested_by, execution_id, "skipped", reason="run_cap",
                       copy=summary["best"])
    if attempted_today(conn) >= DAILY_CAP:
        return _record(conn, document_id, requested_by, execution_id, "skipped", reason="daily_cap",
                       copy=summary["best"])
    row = _record(conn, document_id, requested_by, execution_id, "waiting", copy=summary["best"])
    if wake:
        worker.wake()
    return row


def for_watch_run(conn: sqlite3.Connection, execution_id: int) -> dict:
    """A watch run with the opt-in: ask for its new papers' PDFs, up to the run's cap.

    The new papers in the order the run linked them; past ``PER_RUN_CAP``
    asked-for PDFs, the rest that could have been fetched are recorded as
    skipped for the cap, and the rest that could not with their own reason, so
    the run's page can say what was not fetched and why.
    """
    new_ids = [int(r[0]) for r in conn.execute(
        "SELECT document_id FROM execution_documents WHERE execution_id = ? AND is_new = 1 "
        "ORDER BY rowid", (int(execution_id),))]
    asked = 0
    for document_id in new_ids:
        row = request(conn, document_id, requested_by="watch", execution_id=execution_id, wake=False,
                      over_run_cap=asked >= PER_RUN_CAP)
        if row["state"] in ("waiting", "downloading"):
            asked += 1
    if asked:
        worker.wake()
    return for_execution(conn, execution_id)


def for_execution(conn: sqlite3.Connection, execution_id: int) -> dict:
    """What a run asked for: every request, and how many came to each state."""
    rows = [_projection(dict(r)) for r in conn.execute(
        "SELECT * FROM full_text_downloads WHERE execution_id = ? ORDER BY id", (int(execution_id),))]
    counts = {state: 0 for state in ("waiting", "downloading", "stored", "skipped", "failed")}
    for row in rows:
        counts[row["state"]] += 1
    return {"execution_id": int(execution_id), "requests": rows, "counts": counts,
            "per_run_cap": PER_RUN_CAP}


# ---------------------------------------------------------------------------
# arXiv's license, read when its PDF is asked for
# ---------------------------------------------------------------------------

_ARXIV_OAI = "https://export.arxiv.org/oai2"
_OAI_ARXIV = "{http://arxiv.org/OAI/arXiv/}"


def arxiv_license(arxiv_id: str) -> str | None:
    """The license arXiv records for a paper, read from its OAI-PMH record; None when it records none.

    Through arXiv's own pace (``api_arxiv._RATE_LIMITER``), the limiter every
    request to export.arxiv.org shares. Papers before 2004 may carry no
    license in the record, and are then not downloaded.
    """
    from . import api_arxiv  # noqa: PLC0415

    reset_search_outcome()
    response = safe_request(
        "GET", _ARXIV_OAI, rate_limiter=api_arxiv._RATE_LIMITER,
        params={"verb": "GetRecord", "identifier": f"oai:arXiv.org:{arxiv_id}", "metadataPrefix": "arXiv"},
        max_retries=1)
    if response.status_code != 200:
        raise fulltext_download.DownloadRefused(
            "http_status", f"arXiv answered HTTP {response.status_code} when asked for the paper's license.")
    try:
        root = ET.fromstring(response.text)
    except ET.ParseError:
        raise fulltext_download.DownloadRefused(
            "error", "arXiv's record of the paper's license could not be read.") from None
    found = root.find(f".//{_OAI_ARXIV}license")
    if found is None or not (found.text or "").strip():
        return None
    return open_access.normalize_license(found.text)


# ---------------------------------------------------------------------------
# The worker
# ---------------------------------------------------------------------------


def _file_name(conn: sqlite3.Connection, document_id: int) -> str:
    row = conn.execute("SELECT title, authors, publication_date FROM documents WHERE id = ?",
                       (int(document_id),)).fetchone()
    title = re.sub(r"\s+", " ", str(row["title"] if row else "Paper")).strip()
    first = str((row["authors"] if row else "") or "").split(",")[0].strip().split(" ")[-1]
    year = str((row["publication_date"] if row else "") or "")[:4]
    lead = " ".join(part for part in (first, year) if part)
    name = f"{lead} - {title}" if lead else title
    name = re.sub(r"[\\/\x00-\x1f\x7f]", " ", name)
    name = re.sub(r"[^\w\s.,;:()'&+-]", "", name, flags=re.UNICODE).strip(" .") or f"Paper {document_id}"
    return name[:180].rstrip(" .") + ".pdf"


class Worker:
    """Fetches waiting requests: up to ``MAX_PARALLEL`` at once, one per host, each host paced."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._active: dict[int, threading.Thread] = {}
        self._limiters: dict[str, RateLimiter] = {}
        self._connect: Callable[[], sqlite3.Connection] | None = None
        self._me = f"{os.getpid()}"

    def configure(self, connect: Callable[[], sqlite3.Connection]) -> None:
        """Where the worker gets a database connection from: one per thread it runs."""
        self._connect = connect

    def limiter(self, host: str) -> RateLimiter:
        with self._lock:
            found = self._limiters.get(host)
            if found is None:
                found = self._limiters[host] = RateLimiter(requests_per_second=1.0 / HOST_INTERVAL_SECONDS)
            return found

    def wake(self) -> None:
        if self._connect is None:
            return
        with self._lock:
            # Set under the lock the loop takes to stop, so a request made as
            # the loop finds nothing to do either keeps that loop going or
            # starts the next one.
            self._wake.set()
            if self._thread is None or not self._thread.is_alive():
                self._stop.clear()
                self._thread = threading.Thread(target=self._loop, daemon=True, name="full-text")
                self._thread.start()

    def shutdown(self, timeout: float = 5.0) -> None:
        self._stop.set()
        self._wake.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout)
        for active in list(self._active.values()):
            active.join(timeout)

    def idle(self) -> bool:
        with self._lock:
            return not any(t.is_alive() for t in self._active.values())

    def _claim(self, conn: sqlite3.Connection) -> dict | None:
        """The oldest waiting request whose host has nothing downloading, claimed atomically."""
        stale = _since(STALE_SECONDS)
        for row in conn.execute(
                "SELECT id, host FROM full_text_downloads WHERE state = 'waiting' ORDER BY id LIMIT 50").fetchall():
            cursor = conn.execute(
                "UPDATE full_text_downloads SET state = 'downloading', started_at_utc = ?, claimed_by = ? "
                "WHERE id = ? AND state = 'waiting' AND NOT EXISTS (SELECT 1 FROM full_text_downloads o "
                "WHERE o.host = ? AND o.state = 'downloading' AND o.started_at_utc >= ?)",
                (utc_now(), self._me, row["id"], row["host"], stale))
            conn.commit()
            if cursor.rowcount == 1:
                return dict(conn.execute("SELECT * FROM full_text_downloads WHERE id = ?", (row["id"],)).fetchone())
        return None

    def _loop(self) -> None:
        conn = self._connect()
        try:
            while not self._stop.is_set():
                self._wake.clear()
                with self._lock:
                    self._active = {k: t for k, t in self._active.items() if t.is_alive()}
                    room = MAX_PARALLEL - len(self._active)
                claimed = self._claim(conn) if room > 0 else None
                if claimed is not None:
                    thread = threading.Thread(target=self._run, args=(claimed,), daemon=True,
                                              name=f"full-text-{claimed['id']}")
                    with self._lock:
                        self._active[int(claimed["id"])] = thread
                    thread.start()
                    continue
                waiting = conn.execute(
                    "SELECT count(*) FROM full_text_downloads WHERE state = 'waiting'").fetchone()[0]
                with self._lock:
                    busy = any(t.is_alive() for t in self._active.values())
                if not waiting and not busy:
                    with self._lock:
                        if self._wake.is_set():
                            continue
                        self._thread = None
                        return
                self._wake.wait(timeout=1.0)
        finally:
            conn.close()

    def _run(self, row: dict) -> None:
        conn = self._connect()
        staging = Path(tempfile.mkdtemp(prefix="resmon-download-"))
        try:
            self._download(conn, row, staging)
        except Exception:
            logger.exception("Download %s failed unexpectedly", row["id"])
            self._finish(conn, row["id"], "failed", reason="error")
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            conn.close()
            self._wake.set()

    def _finish(self, conn: sqlite3.Connection, download_id: int, state: str, **fields) -> None:
        sets = ["state = ?", "finished_at_utc = ?"]
        values: list = [state, utc_now()]
        for name, value in fields.items():
            sets.append(f"{name} = ?")
            values.append(value)
        values.append(int(download_id))
        conn.execute(f"UPDATE full_text_downloads SET {', '.join(sets)} WHERE id = ?", values)
        conn.commit()

    def _download(self, conn: sqlite3.Connection, row: dict, staging: Path) -> None:
        url, license_slug = row["url"], row["license"]
        if license_slug is None:
            arxiv_id = open_access.bare_arxiv_id(url or "")
            if not arxiv_id or open_access.host_of(url) != "arxiv.org":
                self._finish(conn, row["id"], "skipped", reason="no_license")
                return
            try:
                license_slug = arxiv_license(arxiv_id)
            except fulltext_download.DownloadRefused as refused:
                self._finish(conn, row["id"], "failed", reason=refused.reason, detail=refused.detail)
                return
            except Exception as exc:  # noqa: BLE001 - a transport failure, said plainly
                self._finish(conn, row["id"], "failed", reason="connection_failed",
                             detail=f"arXiv could not be asked for the paper's license: {exc}")
                return
            for location in open_access.locations_for(conn, [row["document_id"]]):
                if location["pdf_url"] == url and location["license"] is None and license_slug:
                    open_access.set_license(conn, location["id"], license_slug, "host_record")
            if not open_access.is_open(license_slug):
                self._finish(conn, row["id"], "skipped", reason="no_license", license=None)
                return
            conn.execute("UPDATE full_text_downloads SET license = ? WHERE id = ?", (license_slug, row["id"]))
            conn.commit()
        target = staging / "download.pdf"
        try:
            fetched = fulltext_download.fetch_pdf(
                url, target, before_request=lambda host: self.limiter(host).acquire())
        except fulltext_download.DownloadRefused as refused:
            self._finish(conn, row["id"], "failed", reason=refused.reason, detail=refused.detail)
            return
        vault = _vault_id(conn)
        if vault is None:
            self._finish(conn, row["id"], "failed", reason="no_library")
            return
        name = _file_name(conn, row["document_id"])
        for attempt in range(_IMPORT_TRIES):
            try:
                with library.Import(conn, vault, name, document_id=int(row["document_id"])) as receipt, \
                        open(target, "rb") as source:
                    while True:
                        chunk = source.read(fulltext_download.CHUNK_BYTES)
                        if not chunk:
                            break
                        receipt.write(chunk)
                    kept = receipt.finish()
                break
            except library.LibraryError as exc:
                if exc.reason == "busy" and attempt + 1 < _IMPORT_TRIES:
                    time.sleep(0.25)
                    continue
                self._finish(conn, row["id"], "failed", reason="library_refused", detail=str(exc))
                return
        self._finish(conn, row["id"], "stored", file_id=kept["file"]["file_id"],
                     final_url=fetched.final_url, byte_size=fetched.byte_size)


worker = Worker()
