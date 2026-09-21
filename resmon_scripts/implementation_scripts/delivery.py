# resmon_scripts/implementation_scripts/delivery.py
"""Where a routine's report goes, and whether it got there.

Before schema 21 the only delivery resmon had was an email sent inline from
the execution worker's ``finally`` block, and it recorded nothing: a refused
SMTP connection, a wrong password or a laptop with no network produced one log
line in a file nobody reads and no trace in the corpus at all. A user whose
completion emails silently stopped arriving had no way to find that out from
resmon, which is the exact failure mode this application exists to prevent.

The shape here is a queue with a record:

* the completion hook **enqueues** one ``deliveries`` row per enabled target
  and wakes the drain -- it never sends anything itself, so a slow SMTP server
  can no longer hold an execution's worker thread (or its admission slot) open;
* one **drain** thread claims a due row by compare-and-swap, runs the channel
  adapter, and writes back ``delivered`` or a failure with the reason and the
  time of the next attempt;
* ``UNIQUE(execution_id, target_id)`` plus that CAS is what makes "delivered
  exactly once" a fact the database enforces rather than something the drain
  believes because it looked first.

Two channels ship: ``email`` (the existing sender, now recorded and retried)
and ``folder`` (the bundle written into a directory the user chose, which is
what turns iCloud, Dropbox or a shared drive into a delivery destination with
no code of ours on the wire). ``webhook`` and ``feed`` are in the schema's
CHECK and have no adapter yet; asking for one is a refusal with a reason, not
a crash.

Credentials never appear here. The SMTP password is read through
``credential_manager`` inside the email adapter and is scrubbed out of any
error text before it reaches ``deliveries.last_error``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

from . import runtime_identity
from .database import DELIVERY_TARGET_MODES, utc_now_iso

logger = logging.getLogger(__name__)

#: The channels that have an adapter behind them today. The other two values
#: in ``DELIVERY_CHANNELS`` are the schema's vocabulary for PR two; a target
#: naming one is refused with that said plainly rather than queued forever.
SHIPPED_CHANNELS = ("email", "folder")

#: How long to wait before each retry, indexed by the number of attempts
#: already made. Three entries, so a row that has failed three times has no
#: next attempt and stays ``failed`` until a human presses Retry. The numbers
#: are the ones a person would pick looking at the failures this sees: a
#: minute for a laptop that has just woken with no network yet, five for a
#: mail server that is briefly refusing, twenty-five for an outage.
BACKOFF = (timedelta(minutes=1), timedelta(minutes=5), timedelta(minutes=25))

#: After this many attempts the drain stops on its own.
MAX_ATTEMPTS = len(BACKOFF)

#: How long the drain sleeps when it has nothing due. A backoff of one minute
#: is the shortest wait it has to honour, so half of that is the longest it may
#: sleep without making that minute mean something longer.
IDLE_POLL_SECONDS = 30.0


class DeliveryError(Exception):
    """A delivery attempt that failed for a reason worth recording.

    Raised by a channel adapter. The message is written to
    ``deliveries.last_error`` verbatim, so it is addressed to the user: it says
    what resmon tried and what stopped it, and never contains a credential.
    """


# ---------------------------------------------------------------------------
# The bundle
# ---------------------------------------------------------------------------
#
# Building the export bundle lives in ``resmon.py`` (``_build_execution_zip``),
# which imports this module -- so the builder is handed *in* rather than
# imported, and this module has no opinion about how a bundle is made beyond
# its signature. ``resmon`` registers it at import time; a test can register
# its own.

BundleBuilder = Callable[[sqlite3.Connection, dict, Path], Path]

_bundle_builder: Optional[BundleBuilder] = None


def set_bundle_builder(builder: Optional[BundleBuilder]) -> None:
    """Register the function that writes an execution's bundle ``.zip``."""
    global _bundle_builder
    _bundle_builder = builder


def _build_bundle(conn: sqlite3.Connection, execution: dict, out_dir: Path) -> Path:
    if _bundle_builder is None:
        raise DeliveryError(
            "resmon cannot build the report bundle in this process; the "
            "delivery was left queued rather than reported as sent."
        )
    return _bundle_builder(conn, execution, out_dir)


def report_sha256(execution: dict) -> Optional[str]:
    """The hash of the execution's Markdown report, or None if there is none.

    None is the honest answer for a run that produced no report file -- a
    failed sweep, or a corpus whose reports directory has been moved out from
    under it. ``deliveries.artifact_sha256`` stays NULL there rather than
    carrying the hash of something else that happened to be at hand.
    """
    path = execution.get("result_path")
    if not path:
        return None
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------


def list_targets(conn: sqlite3.Connection, routine_id: int) -> list[dict]:
    """Every delivery target of one routine, oldest first."""
    rows = conn.execute(
        "SELECT * FROM routine_delivery_targets WHERE routine_id = ? ORDER BY id",
        (int(routine_id),),
    ).fetchall()
    return [dict(row) for row in rows]


def get_target(conn: sqlite3.Connection, target_id: int) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM routine_delivery_targets WHERE id = ?", (int(target_id),)
    ).fetchone()
    return dict(row) if row else None


def add_target(
    conn: sqlite3.Connection,
    routine_id: int,
    *,
    channel: str,
    target: str,
    mode: str = "automatic",
    enabled: bool = True,
) -> int:
    """Add one destination to a routine. Returns its id.

    Validation is here rather than only in the route because the CHECK
    constraints say which values exist and this says which ones resmon can
    actually act on -- a ``webhook`` target would satisfy the database and
    then fail every delivery.
    """
    if channel not in SHIPPED_CHANNELS:
        raise ValueError(
            f"channel must be one of {', '.join(SHIPPED_CHANNELS)}; "
            f"{channel!r} is in the schema's vocabulary but has no adapter yet."
        )
    if mode not in DELIVERY_TARGET_MODES:
        raise ValueError(f"mode must be one of {', '.join(DELIVERY_TARGET_MODES)}")
    stamp = utc_now_iso()
    cursor = conn.execute(
        "INSERT INTO routine_delivery_targets "
        "(routine_id, channel, target, enabled, mode, created_at_utc, updated_at_utc) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (int(routine_id), channel, target or "", 1 if enabled else 0, mode,
         stamp, stamp),
    )
    conn.commit()
    return int(cursor.lastrowid)


def update_target(conn: sqlite3.Connection, target_id: int, updates: dict) -> None:
    """Change ``target``, ``mode`` or ``enabled`` on one destination.

    ``channel`` is deliberately not updatable: a target's channel is what its
    already-recorded deliveries were attempted over, and editing it in place
    would make that history read as if they had been sent somewhere else.
    """
    allowed = {"target", "mode", "enabled"}
    filtered = {k: v for k, v in updates.items() if k in allowed}
    if not filtered:
        return
    if "mode" in filtered and filtered["mode"] not in DELIVERY_TARGET_MODES:
        raise ValueError(f"mode must be one of {', '.join(DELIVERY_TARGET_MODES)}")
    if "enabled" in filtered:
        filtered["enabled"] = 1 if filtered["enabled"] else 0
    sets = ", ".join(f"{col} = ?" for col in filtered)
    params: list = list(filtered.values())
    params.append(utc_now_iso())
    params.append(int(target_id))
    conn.execute(
        f"UPDATE routine_delivery_targets SET {sets}, updated_at_utc = ? WHERE id = ?",
        params,
    )
    conn.commit()


def delete_target(conn: sqlite3.Connection, target_id: int) -> bool:
    """Remove a destination. Its deliveries keep their ``target_snapshot``.

    The FK is ``ON DELETE SET NULL`` rather than CASCADE on purpose: a record
    of where a report was sent does not stop being true when the user stops
    sending there.
    """
    cursor = conn.execute(
        "DELETE FROM routine_delivery_targets WHERE id = ?", (int(target_id),)
    )
    conn.commit()
    return cursor.rowcount > 0


# ---------------------------------------------------------------------------
# Enqueue
# ---------------------------------------------------------------------------


def enqueue_for_execution(
    conn: sqlite3.Connection, execution: dict, routine: dict
) -> list[int]:
    """Queue one delivery per enabled target of *routine*. Returns the ids.

    ``INSERT OR IGNORE`` against ``UNIQUE(execution_id, target_id)``: the same
    execution completing twice -- which the restart path can produce -- adds
    nothing the second time, and the drain therefore cannot be handed a second
    copy of a delivery it has already made.

    ``email_enabled`` is still the routine-level switch the Routines page
    toggles. A routine that has it on and no email target gets one created
    here, so a routine created before its first run behaves exactly as it did
    before schema 21; a routine that has it off does not enqueue its email
    targets at all, which is what turning the switch off has always meant.
    """
    exec_id = int(execution["id"])
    routine_id = int(routine["id"])
    email_on = bool(routine.get("email_enabled"))
    targets = list_targets(conn, routine_id)
    if email_on and not any(t["channel"] == "email" for t in targets):
        add_target(conn, routine_id, channel="email", target="")
        targets = list_targets(conn, routine_id)

    queued: list[int] = []
    stamp = utc_now_iso()
    for target in targets:
        if not target["enabled"]:
            continue
        if target["channel"] == "email" and not email_on:
            continue
        state = "awaiting_review" if target["mode"] == "review" else "queued"
        cursor = conn.execute(
            "INSERT OR IGNORE INTO deliveries "
            "(execution_id, target_id, channel, target_snapshot, state, "
            " attempts, queued_at_utc) "
            "VALUES (?, ?, ?, ?, ?, 0, ?)",
            (exec_id, int(target["id"]), target["channel"], target["target"],
             state, stamp),
        )
        if cursor.rowcount > 0:
            queued.append(int(cursor.lastrowid))
    conn.commit()
    return queued


# ---------------------------------------------------------------------------
# Reading the record
# ---------------------------------------------------------------------------


def get_delivery(conn: sqlite3.Connection, delivery_id: int) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM deliveries WHERE id = ?", (int(delivery_id),)
    ).fetchone()
    return dict(row) if row else None


def list_deliveries_for_execution(
    conn: sqlite3.Connection, execution_id: int
) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM deliveries WHERE execution_id = ? ORDER BY id",
        (int(execution_id),),
    ).fetchall()
    return [dict(row) for row in rows]


def list_deliveries_for_routine(
    conn: sqlite3.Connection, routine_id: int, *, limit: int = 100
) -> list[dict]:
    """The routine's deliveries, newest first, across all of its executions."""
    rows = conn.execute(
        "SELECT d.* FROM deliveries d JOIN executions e ON e.id = d.execution_id "
        "WHERE e.routine_id = ? ORDER BY d.id DESC LIMIT ?",
        (int(routine_id), int(limit)),
    ).fetchall()
    return [dict(row) for row in rows]


def routine_delivery_summary(conn: sqlite3.Connection, routine_id: int) -> dict:
    """``{targets: {channel: n}, last: {...}|None, awaiting_review: n}``.

    What a screen and the MCP ``get_routine`` tool render. Counts come from the
    rows themselves, so a routine with no targets answers with empty counts
    rather than with an absent key -- "none configured" and "this backend
    cannot tell you" are different facts.
    """
    targets: dict[str, int] = {}
    for row in conn.execute(
        "SELECT channel, COUNT(*) AS n FROM routine_delivery_targets "
        "WHERE routine_id = ? AND enabled = 1 GROUP BY channel",
        (int(routine_id),),
    ):
        targets[row["channel"]] = int(row["n"])
    recent = list_deliveries_for_routine(conn, routine_id, limit=1)
    awaiting = conn.execute(
        "SELECT COUNT(*) AS n FROM deliveries d "
        "JOIN executions e ON e.id = d.execution_id "
        "WHERE e.routine_id = ? AND d.state = 'awaiting_review'",
        (int(routine_id),),
    ).fetchone()
    last = None
    if recent:
        last = {
            "id": recent[0]["id"],
            "execution_id": recent[0]["execution_id"],
            "channel": recent[0]["channel"],
            "state": recent[0]["state"],
            "attempts": recent[0]["attempts"],
            "last_error": recent[0]["last_error"],
            "delivered_at_utc": recent[0]["delivered_at_utc"],
        }
    return {
        "targets": targets,
        "enabled_target_count": sum(targets.values()),
        "awaiting_review": int(awaiting["n"] or 0),
        "last": last,
    }


# ---------------------------------------------------------------------------
# The three decisions only a person makes
# ---------------------------------------------------------------------------


def approve(conn: sqlite3.Connection, delivery_id: int) -> bool:
    """Move an ``awaiting_review`` row to ``queued``. Nothing else may.

    There is deliberately no automatic promotion anywhere in this module: a
    target in review mode waits until a person says so, however long that is.
    """
    cursor = conn.execute(
        "UPDATE deliveries SET state = 'queued', next_attempt_at_utc = NULL, "
        "last_error = NULL WHERE id = ? AND state = 'awaiting_review'",
        (int(delivery_id),),
    )
    conn.commit()
    return cursor.rowcount > 0


def skip(conn: sqlite3.Connection, delivery_id: int) -> bool:
    """Decide not to send one delivery. Only from a state that has not sent."""
    cursor = conn.execute(
        "UPDATE deliveries SET state = 'skipped', next_attempt_at_utc = NULL "
        "WHERE id = ? AND state IN ('awaiting_review', 'queued', 'failed')",
        (int(delivery_id),),
    )
    conn.commit()
    return cursor.rowcount > 0


def retry(conn: sqlite3.Connection, delivery_id: int) -> bool:
    """Put a ``failed`` or ``skipped`` row back in the queue, attempts reset.

    The backoff gives up after three attempts; this is the human overruling
    that, which is a different decision and so a different entry point. The
    attempt counter goes back to zero because the user is starting the attempt
    sequence again -- ``last_error`` is kept until the next attempt writes one,
    so the screen still says why it had stopped.
    """
    cursor = conn.execute(
        "UPDATE deliveries SET state = 'queued', attempts = 0, "
        "next_attempt_at_utc = NULL WHERE id = ? AND state IN ('failed', 'skipped')",
        (int(delivery_id),),
    )
    conn.commit()
    return cursor.rowcount > 0


# ---------------------------------------------------------------------------
# Restart safety
# ---------------------------------------------------------------------------


def _owner_process_is_alive(pid: object) -> bool:
    """Whether ``pid`` names a live process, erring towards alive.

    The same one-sided rule as ``resmon._owner_process_is_alive`` and
    ``selected_evidence_runtime._startup``, restated here rather than imported
    because ``resmon`` imports this module and not the other way round. Only
    ``ProcessLookupError`` -- the kernel being certain -- reads as dead. The
    cost of being wrong towards alive is a delivery that waits for the next
    restart; the cost in the other direction is sending a report twice.
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def requeue_orphaned(
    conn: sqlite3.Connection,
    *,
    is_alive: Callable[[object], bool] = _owner_process_is_alive,
) -> int:
    """Re-queue ``delivering`` rows whose owner can be established to be gone.

    Called at startup, before the drain begins. A row left ``delivering`` by a
    backend that was SIGKILLed is not evidence that the report was not sent --
    the process may have died between the send and the write -- so this is the
    one place resmon can choose which way to be wrong. It chooses to send
    again, because a user who sees the same report twice knows what happened,
    and a user who never receives it does not.

    ``attempts`` is left where it is: an attempt was made, and resetting the
    counter would let a row that keeps killing the backend retry forever.
    """
    rows = conn.execute(
        "SELECT id, owner_pid, owner_runtime_id FROM deliveries "
        "WHERE state = 'delivering'"
    ).fetchall()
    current = runtime_identity.current_runtime_id()
    requeued = 0
    for row in rows:
        if row["owner_runtime_id"] == current:
            continue
        if row["owner_pid"] is not None and is_alive(row["owner_pid"]):
            continue
        if row["owner_pid"] is None and row["owner_runtime_id"] is not None:
            # An owner was recorded but no pid to ask about: no liveness fact
            # at all, so leave it. Every row this module writes carries both.
            continue
        conn.execute(
            "UPDATE deliveries SET state = 'queued', next_attempt_at_utc = NULL, "
            "owner_pid = NULL, owner_runtime_id = NULL WHERE id = ? "
            "AND state = 'delivering'",
            (int(row["id"]),),
        )
        requeued += 1
    conn.commit()
    return requeued


# ---------------------------------------------------------------------------
# Channels
# ---------------------------------------------------------------------------
#
# An adapter is handed the execution, the routine, the address or directory
# recorded on the target, and a callable that materialises the bundle .zip on
# demand -- the folder channel always needs it, the email channel needs it only
# when the routine attaches results, and building it copies every report and
# renders a PDF.


def _deliver_email(
    conn: sqlite3.Connection,
    *,
    execution: dict,
    routine: dict,
    target: str,
    bundle: Callable[[], Path],
) -> None:
    """Send the completion email, recording why if it does not go.

    This is the pre-21 hook, moved behind the adapter with two changes: an
    unconfigured or refusing SMTP server now raises rather than logging and
    returning, so the reason reaches ``deliveries.last_error``; and the
    attached bundle carries the search-record companions, which the export
    route has always included and the email hook silently did not.
    """
    from . import email_sender

    smtp_config = email_sender.load_smtp_config(conn)
    if not smtp_config:
        raise DeliveryError(
            "SMTP is not fully configured. Fill in the server, username and "
            "recipient under Settings -> Email, and save the password, then "
            "retry this delivery."
        )
    if target:
        # A target address overrides the one in Settings. The rest of the
        # configuration -- server, port, credentials -- is still the user's
        # single SMTP account; this is a different recipient, not a different
        # mail server.
        smtp_config = dict(smtp_config)
        smtp_config["recipient"] = target

    attachment: Optional[Path] = None
    try:
        if routine.get("email_ai_summary_enabled"):
            attachment = bundle()
        email_sender.send_routine_completion_email(
            routine=routine,
            execution=execution,
            include_ai_summary=False,
            attachment_path=str(attachment) if attachment else None,
            smtp_config=smtp_config,
        )
    except DeliveryError:
        raise
    except Exception as exc:
        # ``email_notifier.send_email`` already scrubs the password out of the
        # text it raises; scrubbing again here is the belt to that braces,
        # because this string is written to a table the user can read.
        raise DeliveryError(_scrub(str(exc) or exc.__class__.__name__)) from None


_SECRET_PATTERN = re.compile(
    r"(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+", re.IGNORECASE
)


def _scrub(text: str) -> str:
    """Remove anything shaped like a credential from a message we persist."""
    return _SECRET_PATTERN.sub(r"\1=[REDACTED]", text)[:1000]


def _slug(value: str) -> str:
    """A routine name as a directory name: lowercase, ASCII-safe, non-empty."""
    cleaned = re.sub(r"[^A-Za-z0-9]+", "-", (value or "").strip()).strip("-").lower()
    return cleaned[:60] or "routine"


def _without_path(text: str, root: Path) -> str:
    """The message with the user's directory replaced by ``<target>``.

    ``deliveries.last_error`` is read back by the MCP ``get_routine`` summary,
    and that amendment says the address and the directory are never returned --
    where a person has their research sent is theirs. An ``OSError`` carries the
    path it failed on, so a folder failure was quietly the one way a path could
    reach an assistant's transcript. The row still says *which* destination this
    was: ``deliveries.target_id`` names it, and the app resolves that to the
    path locally, where the user is already looking at their own folder.
    """
    out = text
    for form in {str(root), str(root.expanduser()), str(root.resolve())
                 if root.exists() else str(root)}:
        if form:
            out = out.replace(form, "<target>")
    return out


def _deliver_folder(
    conn: sqlite3.Connection,
    *,
    execution: dict,
    routine: dict,
    target: str,
    bundle: Callable[[], Path],
) -> None:
    """Write the bundle into the user's directory, atomically.

    The destination is ``<target>/resmon/<routine slug>/<execution id>-<stamp>/``
    and it appears in one step: the bundle is unpacked into a sibling
    ``.incomplete`` directory and renamed into place, so a sync client watching
    the folder -- which is the whole point of this channel -- never uploads a
    half-written report and never sees a directory that is about to grow.

    A target that is not an existing, writable directory is refused with that
    said, rather than created: resmon is not the right thing to be creating
    folders inside somebody's Dropbox, and a mistyped path that silently
    succeeds is worse than one that reports itself.
    """
    if not target:
        raise DeliveryError(
            "This folder destination has no directory set. Choose one in the "
            "routine's Delivery list."
        )
    root = Path(target).expanduser()
    # None of these messages names the directory. See ``_without_path``: this
    # text is read back through the MCP surface, which promises not to say
    # where a person's research is sent.
    if not root.is_dir():
        raise DeliveryError(
            "That folder is not a directory resmon can see. It may be on a "
            "drive that is not mounted, or in a synced folder that is not "
            "signed in."
        )
    if not os.access(root, os.W_OK | os.X_OK):
        raise DeliveryError("That folder exists but resmon cannot write to it.")

    exec_id = int(execution["id"])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    parent = root / "resmon" / _slug(str(routine.get("name") or ""))
    final = parent / f"{exec_id}-{stamp}"
    staging = parent / f".{exec_id}-{stamp}.incomplete"
    try:
        parent.mkdir(parents=True, exist_ok=True)
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir()
    except OSError as exc:
        raise DeliveryError(
            _without_path(f"Could not prepare the delivery folder: {exc}", root)
        ) from None

    try:
        zip_path = bundle()
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(staging)
        manifest = {
            "execution_id": exec_id,
            "routine_id": routine.get("id"),
            "routine_name": routine.get("name"),
            "status": execution.get("status"),
            "start_time": execution.get("start_time"),
            "end_time": execution.get("end_time"),
            "report_sha256": report_sha256(execution),
            "delivered_at_utc": utc_now_iso(),
            "files": sorted(
                str(p.relative_to(staging))
                for p in staging.rglob("*") if p.is_file()
            ),
        }
        (staging / "delivery.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8",
        )
        if final.exists():
            # Only reachable when a delivery is retried inside the same second
            # as a previous one; the record is per (execution, target), so the
            # newer bundle is the one to keep.
            shutil.rmtree(final, ignore_errors=True)
        os.replace(staging, final)
    except DeliveryError:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(staging, ignore_errors=True)
        raise DeliveryError(_scrub(_without_path(
            f"Could not write the report to that folder: {exc}", root))) from None


#: Channel name -> adapter. The keys are the denominator every "N of M
#: channels" claim in this module's tests is taken from.
ADAPTERS: dict[str, Callable[..., None]] = {
    "email": _deliver_email,
    "folder": _deliver_folder,
}


# ---------------------------------------------------------------------------
# The drain
# ---------------------------------------------------------------------------


class DeliveryQueue:
    """One thread, one connection, one delivery at a time.

    Serial on purpose. The two shipped channels are a mail server and a synced
    folder, and neither is made faster by resmon asking it two things at once;
    what serial buys is that a failure has one owner and the record has one
    writer. ``conn_factory`` is called on the drain thread so the connection
    belongs to it (BUG-020), and ``now_fn`` is injectable so the backoff can be
    tested without waiting twenty-five minutes for it.
    """

    def __init__(
        self,
        conn_factory: Callable[[], sqlite3.Connection],
        *,
        now_fn: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        close: Optional[Callable[[sqlite3.Connection], None]] = None,
    ) -> None:
        self._conn_factory = conn_factory
        self._close = close
        self._now = now_fn
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="delivery-drain", daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        self._wake.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout)

    def wake(self) -> None:
        """Tell the drain there may be something due. Never blocks."""
        self._wake.set()

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # -- the loop ----------------------------------------------------------

    def _run(self) -> None:
        conn = self._conn_factory()
        try:
            while not self._stop.is_set():
                try:
                    worked = self.run_once(conn)
                except Exception:
                    # A drain that dies stops every future delivery silently,
                    # which is the failure this whole module exists to remove.
                    logger.exception("Delivery drain iteration failed")
                    worked = False
                if worked:
                    continue
                self._wake.wait(IDLE_POLL_SECONDS)
                self._wake.clear()
        finally:
            if self._close is not None:
                try:
                    self._close(conn)
                except Exception:
                    logger.exception("Closing the delivery drain connection failed")

    def run_once(self, conn: sqlite3.Connection) -> bool:
        """Claim and deliver at most one due row. True if one was claimed."""
        row = self._claim(conn)
        if row is None:
            return False
        self._deliver(conn, row)
        return True

    def drain(self, conn: sqlite3.Connection, *, limit: int = 100) -> int:
        """Deliver everything due right now. Returns how many were attempted.

        The synchronous form of the loop, for a caller that wants the queue
        emptied before it looks at the record -- the tests, and a shutdown that
        would rather finish than abandon.
        """
        done = 0
        while done < limit and self.run_once(conn):
            done += 1
        return done

    # -- claim and record --------------------------------------------------

    def _claim(self, conn: sqlite3.Connection) -> Optional[dict]:
        """Take ownership of one due row, or return None.

        Two states are due. ``queued`` is a delivery that has never been
        attempted or that a person has just approved or retried; ``failed``
        with a ``next_attempt_at_utc`` in the past is the backoff's own retry,
        and ``failed`` with none is where a row stops. Keeping the failure
        visible between attempts is deliberate: a user looking at the screen
        during a mail outage sees *failed, retrying at ...*, not a row that
        claims to be queued with no reason attached.

        The UPDATE carries its own ``WHERE state = ...`` so two drains, or a
        drain and a second wake, cannot both take the same row -- the second
        one updates nothing and looks again.
        """
        now = self._now().isoformat()
        for _ in range(8):
            candidate = conn.execute(
                "SELECT id, state FROM deliveries WHERE "
                "(state = 'queued' AND (next_attempt_at_utc IS NULL "
                "                       OR next_attempt_at_utc <= ?)) "
                "OR (state = 'failed' AND next_attempt_at_utc IS NOT NULL "
                "    AND next_attempt_at_utc <= ?) "
                "ORDER BY id LIMIT 1",
                (now, now),
            ).fetchone()
            if candidate is None:
                return None
            cursor = conn.execute(
                "UPDATE deliveries SET state = 'delivering', attempts = attempts + 1, "
                "owner_pid = ?, owner_runtime_id = ? WHERE id = ? AND state = ?",
                (os.getpid(), runtime_identity.current_runtime_id(),
                 int(candidate["id"]), candidate["state"]),
            )
            conn.commit()
            if cursor.rowcount > 0:
                return get_delivery(conn, int(candidate["id"]))
        return None

    def _deliver(self, conn: sqlite3.Connection, row: dict) -> None:
        from .database import get_execution_by_id, get_routine_by_id

        execution = get_execution_by_id(conn, int(row["execution_id"]))
        if execution is None:
            self._record_failure(
                conn, row,
                "The execution this delivery belongs to no longer exists.",
                terminal=True,
            )
            return
        routine = (
            get_routine_by_id(conn, int(execution["routine_id"]))
            if execution.get("routine_id") is not None else None
        )
        if routine is None:
            self._record_failure(
                conn, row,
                "The routine this delivery belongs to no longer exists.",
                terminal=True,
            )
            return

        adapter = ADAPTERS.get(row["channel"])
        if adapter is None:
            self._record_failure(
                conn, row,
                f"resmon has no way to deliver over {row['channel']} yet.",
                terminal=True,
            )
            return

        staging = tempfile.TemporaryDirectory(prefix="resmon_delivery_")
        built: dict[str, Path] = {}

        def bundle() -> Path:
            if "path" not in built:
                built["path"] = _build_bundle(conn, execution, Path(staging.name))
            return built["path"]

        try:
            adapter(conn, execution=execution, routine=routine,
                    target=row["target_snapshot"], bundle=bundle)
        except DeliveryError as exc:
            self._record_failure(conn, row, str(exc))
        except Exception as exc:  # an adapter bug, recorded like any failure
            logger.exception("Delivery %s raised", row["id"])
            self._record_failure(
                conn, row, _scrub(f"{exc.__class__.__name__}: {exc}"))
        else:
            conn.execute(
                "UPDATE deliveries SET state = 'delivered', delivered_at_utc = ?, "
                "next_attempt_at_utc = NULL, last_error = NULL, "
                "artifact_sha256 = ?, owner_pid = NULL, owner_runtime_id = NULL "
                "WHERE id = ?",
                (self._now().isoformat(), report_sha256(execution), int(row["id"])),
            )
            conn.commit()
        finally:
            staging.cleanup()

    def _record_failure(
        self, conn: sqlite3.Connection, row: dict, reason: str, *,
        terminal: bool = False,
    ) -> None:
        """Write why it did not go, and when -- or whether -- to try again."""
        # ``row`` was read back *after* the claim, so ``attempts`` already
        # counts the attempt that has just failed. The backoff is indexed by
        # attempts made: the first failure waits BACKOFF[0].
        attempts = int(row["attempts"])
        if terminal or attempts >= MAX_ATTEMPTS:
            next_at = None
        else:
            next_at = (self._now() + BACKOFF[attempts - 1]).isoformat()
        conn.execute(
            "UPDATE deliveries SET state = 'failed', last_error = ?, "
            "next_attempt_at_utc = ?, owner_pid = NULL, owner_runtime_id = NULL "
            "WHERE id = ?",
            (_scrub(reason), next_at, int(row["id"])),
        )
        conn.commit()


# The process-wide drain. ``resmon`` starts it after the scheduler and stops it
# on the way out; everything else asks for it by name so a wake from the
# completion hook reaches whichever drain is running.
queue: Optional[DeliveryQueue] = None


def set_queue(instance: Optional[DeliveryQueue]) -> None:
    global queue
    queue = instance


def wake() -> None:
    """Wake the running drain, if there is one. Safe to call from any thread."""
    instance = queue
    if instance is not None:
        instance.wake()
