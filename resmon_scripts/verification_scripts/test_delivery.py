"""Schema 21: the delivery record, the queue, and the two shipped channels.

Both channels are exercised against the real dependency, in process: a real
SMTP server on 127.0.0.1 that ``smtplib`` really connects to, greets, upgrades
to TLS and authenticates against, and a real directory on the filesystem. The
email path is where that matters most -- the pre-21 tests all patched
``send_routine_completion_email``, so nothing in the suite had ever established
that resmon's SMTP client and a server that refuses the connection produce a
recorded failure rather than a traceback.

What is *not* real here: the certificate is self-signed and generated per test,
and ``email_notifier`` is asked not to verify it. The server is otherwise the
one ``smtplib`` is talking to, including its refusals.

Denominators. ``delivery.ADAPTERS`` has 2 entries and
``database.DELIVERY_CHANNELS`` has 4; the two shipped ones are both driven
here, and ``test_every_shipped_channel_has_an_adapter_and_is_driven_here``
fails if a third ships without arriving in this file.
"""

from __future__ import annotations

import hashlib
import json
import socket
import ssl
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database, delivery  # noqa: E402
from implementation_scripts.credential_manager import store_credential  # noqa: E402


# ---------------------------------------------------------------------------
# A real SMTP server on the loopback
# ---------------------------------------------------------------------------


def _self_signed() -> tuple[str, str]:
    """A certificate and key for 127.0.0.1, written to a temp directory.

    ``email_notifier`` calls ``starttls()`` unconditionally -- resmon never
    speaks plaintext SMTP -- so a stub that cannot do TLS cannot stand in for a
    mail server at all. ``cryptography`` is already a pinned dependency
    (requirements.txt line 12), so this needs nothing new in the build.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(__import__("ipaddress").ip_address("127.0.0.1"))]),
            critical=False)
        .sign(key, hashes.SHA256())
    )
    tmp = Path(tempfile.mkdtemp(prefix="resmon_smtp_cert_"))
    (tmp / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (tmp / "key.pem").write_bytes(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption()))
    return str(tmp / "cert.pem"), str(tmp / "key.pem")


class SMTPStub:
    """Enough ESMTP for ``smtplib``: EHLO, STARTTLS, AUTH LOGIN, MAIL, DATA.

    ``refuse_first`` connections are accepted at the TCP level and then closed
    without a greeting, which is what a mail server under load or behind a
    flapping link does and what ``smtplib`` reports as a failure to connect.
    Every message that gets all the way through DATA is kept, so "exactly one
    message arrived" is counted rather than assumed.
    """

    def __init__(self, *, refuse_first: int = 0, refuse_recipients: bool = False) -> None:
        self.messages: list[str] = []
        self.refuse_first = refuse_first
        # ``refuse_recipients`` makes the server answer RCPT TO with 550, which
        # is what ``smtplib`` turns into ``SMTPRecipientsRefused`` -- an
        # exception whose text *contains the address*. That is the one SMTP
        # failure that could write a recipient into ``deliveries.last_error``,
        # so it is produced by a real server refusing a real RCPT rather than
        # by raising the exception by hand.
        self.refuse_recipients = refuse_recipients
        self.connections = 0
        self._cert, self._key = _self_signed()
        self._sock = socket.socket()
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(8)
        self.port = self._sock.getsockname()[1]
        assert self.port != 8742, "8742 is the maintainer's live daemon"
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True,
                                        name="smtp-stub")
        self._thread.start()

    # -- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        self._stop.set()
        try:
            self._sock.close()
        except OSError:
            pass
        self._thread.join(timeout=5)

    # -- the conversation --------------------------------------------------

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except OSError:
                return
            self.connections += 1
            try:
                if self.connections <= self.refuse_first:
                    conn.close()
                    continue
                self._session(conn)
            except Exception:
                pass
            finally:
                try:
                    conn.close()
                except OSError:
                    pass

    def _session(self, conn: socket.socket) -> None:
        conn.settimeout(10)
        stream = conn.makefile("rwb")

        def send(line: str) -> None:
            stream.write((line + "\r\n").encode()); stream.flush()

        send("220 127.0.0.1 resmon test server")
        secure = False
        while True:
            raw = stream.readline()
            if not raw:
                return
            line = raw.decode(errors="replace").strip()
            upper = line.upper()
            if upper.startswith("EHLO") or upper.startswith("HELO"):
                if secure:
                    send("250-127.0.0.1"); send("250 AUTH LOGIN PLAIN")
                else:
                    send("250-127.0.0.1"); send("250 STARTTLS")
            elif upper == "STARTTLS":
                send("220 Ready to start TLS")
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(self._cert, self._key)
                conn = context.wrap_socket(conn, server_side=True)
                stream = conn.makefile("rwb")
                secure = True
            elif upper.startswith("AUTH"):
                # Two challenges for AUTH LOGIN, one line for AUTH PLAIN. The
                # credential itself is never inspected: this file must not be
                # able to assert on a password even by accident.
                if "LOGIN" in upper and len(upper.split()) == 2:
                    send("334 VXNlcm5hbWU6"); stream.readline()
                    send("334 UGFzc3dvcmQ6"); stream.readline()
                send("235 Authentication successful")
            elif upper.startswith("RCPT TO") and self.refuse_recipients:
                address = line.partition(":")[2].strip().strip("<>")
                send(f"550 5.1.1 <{address}>: Recipient address rejected")
            elif upper.startswith("MAIL FROM") or upper.startswith("RCPT TO"):
                send("250 OK")
            elif upper == "DATA":
                send("354 End data with <CR><LF>.<CR><LF>")
                body: list[str] = []
                while True:
                    chunk = stream.readline()
                    if not chunk or chunk.strip() == b".":
                        break
                    body.append(chunk.decode(errors="replace"))
                self.messages.append("".join(body))
                send("250 Queued")
            elif upper in ("QUIT", "RSET"):
                send("221 Bye")
                return
            else:
                send("250 OK")


@pytest.fixture
def smtp_no_verify(monkeypatch):
    """Let ``smtplib`` accept the stub's self-signed certificate.

    The only production behaviour changed for these tests, and it is changed at
    the TLS context rather than by replacing the client: everything else --
    the greeting, STARTTLS, AUTH, MAIL/RCPT/DATA and the failures -- is real.
    """
    import smtplib

    original = smtplib.SMTP.starttls

    def lenient(self, *args, **kwargs):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return original(self, context=context)

    monkeypatch.setattr(smtplib.SMTP, "starttls", lenient)


# ---------------------------------------------------------------------------
# A corpus with one finished routine run
# ---------------------------------------------------------------------------


def _reset_state() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


@pytest.fixture
def corpus(tmp_path):
    """One routine, one completed execution, a real report file on disk."""
    _reset_state()
    conn = resmon_mod._get_db()
    routine_id = database.insert_routine(conn, {
        "name": "Diffusion watch",
        "schedule_cron": "0 8 * * *",
        "parameters": json.dumps({"query": "diffusion", "repositories": ["arxiv"]}),
        "is_active": 1, "email_enabled": 0, "email_ai_summary_enabled": 1,
        "ai_enabled": 0, "notify_on_complete": 0, "execution_location": "local",
    })
    report = tmp_path / "report_automated_sweep_1.md"
    report.write_text("# Diffusion watch\n\nTwo new papers.\n", encoding="utf-8")
    log = tmp_path / "log_automated_sweep_1.txt"
    log.write_text("started\nfinished\n", encoding="utf-8")
    exec_id = database.insert_execution(conn, {
        "execution_type": "automated_sweep",
        "routine_id": routine_id,
        "parameters": json.dumps({"query": "diffusion", "repositories": ["arxiv"]}),
        "start_time": database.utc_now_iso(),
    })
    database.update_execution_status(
        conn, exec_id, "completed",
        log_path=str(log), result_path=str(report),
    )
    return {
        "conn": conn, "routine_id": routine_id, "exec_id": exec_id,
        "report": report,
        "report_sha": hashlib.sha256(report.read_bytes()).hexdigest(),
    }


def _configure_smtp(conn, stub: SMTPStub, recipient: str = "reader@example.org") -> None:
    database.set_setting(conn, "smtp_server", "127.0.0.1")
    database.set_setting(conn, "smtp_port", str(stub.port))
    database.set_setting(conn, "smtp_username", "resmon@example.org")
    database.set_setting(conn, "smtp_to", recipient)
    # The keyring is conftest's in-memory one; no credential reaches a table.
    store_credential("smtp_password", "hunter2-not-real")


def _queue(now=None) -> delivery.DeliveryQueue:
    conn = resmon_mod._get_db()
    if now is None:
        return delivery.DeliveryQueue(lambda: conn)
    return delivery.DeliveryQueue(lambda: conn, now_fn=now)


def _enqueue(corpus) -> list[int]:
    conn = corpus["conn"]
    execution = database.get_execution_by_id(conn, corpus["exec_id"])
    routine = database.get_routine_by_id(conn, corpus["routine_id"])
    return delivery.enqueue_for_execution(conn, execution, routine)


# ---------------------------------------------------------------------------
# P1 -- both shipped channels, end to end
# ---------------------------------------------------------------------------


def test_both_shipped_channels_deliver_and_are_recorded(corpus, tmp_path, smtp_no_verify):
    """2 of 2 shipped channels (M from ``delivery.ADAPTERS``).

    One run, two destinations, one drain: the mail server receives exactly one
    message with the bundle attached, the folder holds the unpacked bundle with
    its ``delivery.json``, and both rows say ``delivered`` with the report's
    own sha256 -- not the zip's, and not a hash of whatever was to hand.
    """
    conn = corpus["conn"]
    stub = SMTPStub()
    try:
        _configure_smtp(conn, stub)
        database.update_routine(conn, corpus["routine_id"], {"email_enabled": 1})
        outbox = tmp_path / "Dropbox"
        outbox.mkdir()
        delivery.add_target(conn, corpus["routine_id"], channel="folder",
                            target=str(outbox))

        queued = _enqueue(corpus)
        assert len(queued) == 2, delivery.list_deliveries_for_execution(
            conn, corpus["exec_id"])
        assert _queue().drain(conn) == 2

        rows = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])
        assert {r["channel"] for r in rows} == {"email", "folder"}
        for row in rows:
            assert row["state"] == "delivered", row
            assert row["attempts"] == 1
            assert row["last_error"] is None
            assert row["delivered_at_utc"]
            assert row["artifact_sha256"] == corpus["report_sha"], row["channel"]
            assert row["owner_pid"] is None

        assert len(stub.messages) == 1, stub.messages
        message = stub.messages[0]
        assert "Diffusion watch" in message
        assert "reader@example.org" in message
        assert ".zip" in message, "the results bundle is attached"

        written = list((outbox / "resmon" / "diffusion-watch").iterdir())
        assert len(written) == 1, written
        bundle = written[0]
        assert not bundle.name.startswith("."), "no half-written directory is left"
        manifest = json.loads((bundle / "delivery.json").read_text())
        assert manifest["execution_id"] == corpus["exec_id"]
        assert manifest["report_sha256"] == corpus["report_sha"]
        assert manifest["files"], manifest
        inner = bundle / f"execution_{corpus['exec_id']}"
        assert (inner / corpus["report"].name).exists()
        assert (inner / "metadata.json").exists()
        # The asymmetry the map named: the email hook's zip used to lack these.
        assert (inner / "search-record.json").exists()
        assert (inner / "search-record.md").exists()
    finally:
        stub.close()


def test_the_email_bundle_carries_the_same_companions_the_export_route_does(
    corpus, tmp_path, smtp_no_verify,
):
    """One builder, one set of arguments, for the export route and the email.

    Checked by unpacking what the delivery path builds rather than by reading
    the call: before schema 21 the two differed and the difference was only
    visible inside the .zip a user received.
    """
    conn = corpus["conn"]
    out = tmp_path / "bundle"
    out.mkdir()
    row = database.get_execution_by_id(conn, corpus["exec_id"])
    import zipfile
    path = resmon_mod._delivery_bundle(conn, row, out)
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
    folder = f"execution_{corpus['exec_id']}"
    assert f"{folder}/search-record.json" in names, names
    assert f"{folder}/search-record.md" in names, names
    assert "manifest.json" in names


# ---------------------------------------------------------------------------
# P2 -- the backoff
# ---------------------------------------------------------------------------


def test_two_refusals_then_success_is_three_attempts_and_one_message(
    corpus, smtp_no_verify,
):
    """A mail server that refuses twice: 3 attempts, 2 errors, 1 message.

    The clock is injected rather than waited on -- ``now_fn`` moves forward by
    the backoff the drain has just written, which is the only way to assert
    that the second attempt really was gated on it. A drain reading the real
    clock finds nothing due between the attempts, which is the first thing
    asserted.
    """
    conn = corpus["conn"]
    stub = SMTPStub(refuse_first=2)
    try:
        _configure_smtp(conn, stub)
        database.update_routine(conn, corpus["routine_id"], {"email_enabled": 1})
        _enqueue(corpus)

        clock = {"now": datetime.now(timezone.utc)}
        queue = _queue(now=lambda: clock["now"])

        assert queue.run_once(conn) is True
        row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
        assert row["state"] == "failed" and row["attempts"] == 1
        first_error = row["last_error"]
        assert first_error, "a refused connection is recorded with its reason"
        assert row["next_attempt_at_utc"] == (
            clock["now"] + delivery.BACKOFF[0]).isoformat()

        # Nothing is due yet, on the real clock or the injected one.
        assert _queue().run_once(conn) is False
        assert queue.run_once(conn) is False

        clock["now"] += delivery.BACKOFF[0]
        assert queue.run_once(conn) is True
        row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
        assert row["state"] == "failed" and row["attempts"] == 2
        second_error = row["last_error"]
        assert second_error

        clock["now"] += delivery.BACKOFF[1]
        assert queue.run_once(conn) is True
        row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
        assert row["state"] == "delivered", row
        assert row["attempts"] == 3
        assert row["next_attempt_at_utc"] is None
        assert row["last_error"] is None

        assert len(stub.messages) == 1, stub.messages
        assert stub.connections == 3
    finally:
        stub.close()


def test_a_third_failure_stops_with_no_next_attempt(corpus, smtp_no_verify):
    """After ``MAX_ATTEMPTS`` the row stays failed and waits for a person."""
    conn = corpus["conn"]
    stub = SMTPStub(refuse_first=99)
    try:
        _configure_smtp(conn, stub)
        database.update_routine(conn, corpus["routine_id"], {"email_enabled": 1})
        _enqueue(corpus)
        clock = {"now": datetime.now(timezone.utc)}
        queue = _queue(now=lambda: clock["now"])
        for step in range(delivery.MAX_ATTEMPTS):
            assert queue.run_once(conn) is True
            clock["now"] += delivery.BACKOFF[step]
        row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
        assert row["attempts"] == delivery.MAX_ATTEMPTS == 3
        assert row["state"] == "failed"
        assert row["next_attempt_at_utc"] is None
        assert queue.run_once(conn) is False
        assert stub.messages == []

        # Retry is the human overruling that, and it is the only thing that can.
        assert delivery.retry(conn, row["id"]) is True
        row = delivery.get_delivery(conn, row["id"])
        assert row["state"] == "queued" and row["attempts"] == 0
    finally:
        stub.close()


# ---------------------------------------------------------------------------
# P3 -- never twice
# ---------------------------------------------------------------------------


def test_one_delivery_per_target_however_many_times_it_is_asked(corpus, tmp_path):
    """The same completion twice, and two drains racing, send once.

    ``UNIQUE(execution_id, target_id)`` answers the first; the claim's own
    ``WHERE state = ...`` answers the second. Both are asserted against the
    folder channel, where "arrived twice" is directly countable as two
    directories.
    """
    conn = corpus["conn"]
    outbox = tmp_path / "Drive"
    outbox.mkdir()
    delivery.add_target(conn, corpus["routine_id"], channel="folder",
                        target=str(outbox))

    assert len(_enqueue(corpus)) == 1
    # The restart path: the same execution completing again.
    assert _enqueue(corpus) == []
    assert len(delivery.list_deliveries_for_execution(conn, corpus["exec_id"])) == 1

    started = threading.Barrier(2)
    results: list[bool] = []

    def drain_once() -> None:
        own = resmon_mod._get_db()
        queue = delivery.DeliveryQueue(lambda: own)
        started.wait(timeout=10)
        results.append(queue.run_once(own))

    threads = [threading.Thread(target=drain_once) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert sorted(results) == [False, True], results
    written = list((outbox / "resmon" / "diffusion-watch").iterdir())
    assert len(written) == 1, written
    row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
    assert row["state"] == "delivered"
    assert row["attempts"] == 1, "the loser never claimed it, so never counted"


# ---------------------------------------------------------------------------
# P5 -- review mode
# ---------------------------------------------------------------------------


def test_a_review_target_waits_for_a_person_and_the_drain_never_touches_it(
    corpus, tmp_path,
):
    conn = corpus["conn"]
    outbox = tmp_path / "Review"
    outbox.mkdir()
    delivery.add_target(conn, corpus["routine_id"], channel="folder",
                        target=str(outbox), mode="review")
    _enqueue(corpus)
    row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
    assert row["state"] == "awaiting_review"

    # Every way the drain has of finding work, including a restart's re-queue.
    assert _queue().drain(conn) == 0
    assert delivery.requeue_orphaned(conn) == 0
    assert _queue().drain(conn) == 0
    assert delivery.get_delivery(conn, row["id"])["state"] == "awaiting_review"
    assert not (outbox / "resmon").exists()

    assert delivery.approve(conn, row["id"]) is True
    assert _queue().drain(conn) == 1
    assert delivery.get_delivery(conn, row["id"])["state"] == "delivered"
    assert len(list((outbox / "resmon" / "diffusion-watch").iterdir())) == 1


def test_skip_is_final_until_a_person_retries_it(corpus, tmp_path):
    conn = corpus["conn"]
    outbox = tmp_path / "Skipped"
    outbox.mkdir()
    delivery.add_target(conn, corpus["routine_id"], channel="folder",
                        target=str(outbox), mode="review")
    _enqueue(corpus)
    row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
    assert delivery.skip(conn, row["id"]) is True
    assert _queue().drain(conn) == 0
    assert delivery.approve(conn, row["id"]) is False, (
        "approve only ever moves a row that is awaiting review")
    assert delivery.get_delivery(conn, row["id"])["state"] == "skipped"
    assert not (outbox / "resmon").exists()


# ---------------------------------------------------------------------------
# P6 -- B4, the email a user already had
# ---------------------------------------------------------------------------


def test_a_pre_21_routine_with_email_enabled_still_emails_after_the_migration(
    tmp_path, smtp_no_verify,
):
    """A schema-20 database with ``email_enabled=1``, upgraded, delivers.

    The routine is written into a database at schema 20 -- before the delivery
    tables exist -- and the upgrade is one ``init_db``, exactly as a user's
    next launch does it. No edit is made to the routine afterwards.
    """
    import sqlite3
    legacy = tmp_path / "corpus.db"
    conn = sqlite3.connect(legacy)
    conn.row_factory = sqlite3.Row
    database.init_db(conn=conn)
    # Put it back to schema 20 with the delivery objects removed: this is what
    # a database written by the released 2.2 line looks like.
    conn.execute("DROP TABLE deliveries")
    conn.execute("DROP TABLE routine_delivery_targets")
    conn.execute("UPDATE app_settings SET value='20' WHERE key='schema_version'")
    routine_id = database.insert_routine(conn, {
        "name": "Legacy watch", "schedule_cron": "0 8 * * *",
        "parameters": "{}", "is_active": 1, "email_enabled": 1,
        "email_ai_summary_enabled": 0, "ai_enabled": 0,
        "notify_on_complete": 0, "execution_location": "local",
    })
    conn.commit()

    database.init_db(conn=conn)             # the user's upgrade, in one call
    assert database.get_schema_version(conn) == 21

    targets = delivery.list_targets(conn, routine_id)
    assert len(targets) == 1, targets
    assert targets[0]["channel"] == "email"
    assert targets[0]["mode"] == "automatic"
    assert targets[0]["enabled"] == 1
    assert targets[0]["target"] == "", (
        "the seeded target means the recipient in Settings -> Email, which is "
        "where the address came from before the upgrade")

    # Running twice must not seed a second one.
    database.init_db(conn=conn)
    assert len(delivery.list_targets(conn, routine_id)) == 1

    # And the delivery actually goes out, over a real SMTP conversation.
    stub = SMTPStub()
    try:
        database.set_setting(conn, "smtp_server", "127.0.0.1")
        database.set_setting(conn, "smtp_port", str(stub.port))
        database.set_setting(conn, "smtp_username", "resmon@example.org")
        database.set_setting(conn, "smtp_to", "legacy@example.org")
        store_credential("smtp_password", "hunter2-not-real")
        report = tmp_path / "report.md"
        report.write_text("# Legacy watch\n", encoding="utf-8")
        exec_id = database.insert_execution(conn, {
            "execution_type": "automated_sweep", "routine_id": routine_id,
            "parameters": "{}", "start_time": database.utc_now_iso(),
        })
        database.update_execution_status(conn, exec_id, "completed",
                                         result_path=str(report))
        execution = database.get_execution_by_id(conn, exec_id)
        routine = database.get_routine_by_id(conn, routine_id)
        assert delivery.enqueue_for_execution(conn, execution, routine)
        assert delivery.DeliveryQueue(lambda: conn).drain(conn) == 1
        row = delivery.list_deliveries_for_execution(conn, exec_id)[0]
        assert row["state"] == "delivered", row["last_error"]
        assert len(stub.messages) == 1
        assert "legacy@example.org" in stub.messages[0]
    finally:
        stub.close()
        conn.close()


def test_turning_the_routine_email_switch_off_stops_the_email(corpus, tmp_path):
    """``email_enabled`` is still the switch the Routines page toggles."""
    conn = corpus["conn"]
    database.update_routine(conn, corpus["routine_id"], {"email_enabled": 1})
    _enqueue(corpus)
    assert len(delivery.list_targets(conn, corpus["routine_id"])) == 1

    # A second execution, with the switch off.
    exec_id = database.insert_execution(conn, {
        "execution_type": "automated_sweep", "routine_id": corpus["routine_id"],
        "parameters": "{}", "start_time": database.utc_now_iso(),
    })
    database.update_execution_status(conn, exec_id, "completed")
    database.update_routine(conn, corpus["routine_id"], {"email_enabled": 0})
    execution = database.get_execution_by_id(conn, exec_id)
    routine = database.get_routine_by_id(conn, corpus["routine_id"])
    assert delivery.enqueue_for_execution(conn, execution, routine) == []
    assert delivery.list_deliveries_for_execution(conn, exec_id) == []


# ---------------------------------------------------------------------------
# Failures a user has to be able to read
# ---------------------------------------------------------------------------


def test_a_folder_target_that_is_not_there_says_so(corpus, tmp_path):
    conn = corpus["conn"]
    missing = tmp_path / "not-mounted"
    delivery.add_target(conn, corpus["routine_id"], channel="folder",
                        target=str(missing))
    _enqueue(corpus)
    assert _queue().drain(conn) == 1
    row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
    assert row["state"] == "failed"
    assert "not a directory resmon can see" in row["last_error"]
    assert row["artifact_sha256"] is None, (
        "nothing was written, so nothing is claimed to have been")


def test_a_folder_failure_never_writes_the_path_into_the_record(corpus, tmp_path):
    """R2-3: ``last_error`` is read back by MCP ``get_routine``, which promises
    the directory is never returned. An ``OSError`` carries the path it failed
    on, so the message is scrubbed and the destination is identified by
    ``target_id`` instead.

    Two failures are driven, because they raise through different paths: a
    directory that is not there (resmon's own refusal) and one that cannot be
    written (the OS's, with the path in ``exc``).
    """
    conn = corpus["conn"]
    secret = tmp_path / "Private-Research-Folder"
    delivery.add_target(conn, corpus["routine_id"], channel="folder",
                        target=str(secret))
    _enqueue(corpus)
    assert _queue().drain(conn) == 1
    row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
    assert row["state"] == "failed"
    assert "Private-Research-Folder" not in row["last_error"], row["last_error"]
    assert str(secret) not in row["last_error"]
    # The destination is still identified, by the row rather than by prose.
    assert row["target_id"] is not None
    assert delivery.get_target(conn, row["target_id"])["target"] == str(secret)

    # And the same for a directory that exists but refuses a write.
    locked = tmp_path / "locked"
    locked.mkdir(mode=0o500)
    try:
        delivery.update_target(conn, row["target_id"], {"target": str(locked)})
        assert delivery.retry(conn, row["id"]) is True
        # ``target_snapshot`` was taken at enqueue, so re-enqueue to pick the
        # new path up the way a fresh run would.
        conn.execute("UPDATE deliveries SET target_snapshot=? WHERE id=?",
                     (str(locked), row["id"]))
        conn.commit()
        assert _queue().drain(conn) == 1
        row = delivery.get_delivery(conn, row["id"])
        assert row["state"] == "failed"
        assert str(locked) not in row["last_error"], row["last_error"]
        assert "locked" not in row["last_error"], row["last_error"]
    finally:
        locked.chmod(0o700)


def test_the_mcp_delivery_summary_returns_no_address_and_no_path(corpus, tmp_path):
    """The amendment's claim, checked against the summary the tool returns."""
    conn = corpus["conn"]
    outbox = tmp_path / "Somewhere-Private"
    outbox.mkdir()
    delivery.add_target(conn, corpus["routine_id"], channel="folder",
                        target=str(outbox))
    delivery.add_target(conn, corpus["routine_id"], channel="email",
                        target="private@example.org")
    _enqueue(corpus)
    assert _queue().drain(conn) >= 1
    blob = json.dumps(delivery.routine_delivery_summary(conn, corpus["routine_id"]))
    assert str(outbox) not in blob
    assert "Somewhere-Private" not in blob
    assert "private@example.org" not in blob


def test_unconfigured_smtp_is_a_recorded_reason_not_a_silent_skip(corpus):
    """The pre-21 behaviour was ``logger.info`` and return. That is the bug."""
    conn = corpus["conn"]
    database.update_routine(conn, corpus["routine_id"], {"email_enabled": 1})
    _enqueue(corpus)
    assert _queue().drain(conn) == 1
    row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
    assert row["state"] == "failed"
    assert "SMTP is not fully configured" in row["last_error"]


def test_nothing_shaped_like_a_credential_is_written_to_the_record(corpus):
    """B12 at the one place this feature could leak one: ``last_error``."""
    scrubbed = delivery._scrub(
        "SMTP refused: password=hunter2 token: abc123 for user resmon")
    assert "hunter2" not in scrubbed
    assert "abc123" not in scrubbed
    assert "[REDACTED]" in scrubbed


# ---------------------------------------------------------------------------
# Restart safety, in process. The out-of-process half is
# ``test_delivery_restart_boundary.py``.
# ---------------------------------------------------------------------------


def test_a_delivering_row_is_adopted_only_when_its_owner_is_established_gone(
    corpus, tmp_path,
):
    conn = corpus["conn"]
    outbox = tmp_path / "Restart"
    outbox.mkdir()
    delivery.add_target(conn, corpus["routine_id"], channel="folder",
                        target=str(outbox))
    _enqueue(corpus)
    row_id = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]["id"]
    conn.execute(
        "UPDATE deliveries SET state='delivering', attempts=1, owner_pid=?, "
        "owner_runtime_id='a-process-that-is-gone' WHERE id=?",
        (424242, row_id))
    conn.commit()

    # An owner that answers is left alone, however long it has been.
    assert delivery.requeue_orphaned(conn, is_alive=lambda pid: True) == 0
    assert delivery.get_delivery(conn, row_id)["state"] == "delivering"
    assert _queue().drain(conn) == 0, "delivering is not a state the drain claims"

    assert delivery.requeue_orphaned(conn, is_alive=lambda pid: False) == 1
    row = delivery.get_delivery(conn, row_id)
    assert row["state"] == "queued"
    assert row["attempts"] == 1, "the attempt that was made is not un-made"
    assert row["owner_pid"] is None

    assert _queue().drain(conn) == 1
    assert delivery.get_delivery(conn, row_id)["state"] == "delivered"
    assert len(list((outbox / "resmon" / "diffusion-watch").iterdir())) == 1


def test_our_own_rows_are_never_adopted_out_from_under_us(corpus):
    """A live drain in this process owns its row; a restart hook must not take it."""
    conn = corpus["conn"]
    delivery.add_target(conn, corpus["routine_id"], channel="folder", target="/tmp")
    _enqueue(corpus)
    row_id = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]["id"]
    from implementation_scripts import runtime_identity
    conn.execute(
        "UPDATE deliveries SET state='delivering', owner_pid=?, owner_runtime_id=? "
        "WHERE id=?",
        (99999999, runtime_identity.current_runtime_id(), row_id))
    conn.commit()
    assert delivery.requeue_orphaned(conn, is_alive=lambda pid: False) == 0
    assert delivery.get_delivery(conn, row_id)["state"] == "delivering"


# ---------------------------------------------------------------------------
# The denominator
# ---------------------------------------------------------------------------


def test_every_shipped_channel_has_an_adapter_and_is_driven_somewhere():
    """M is the CHECK's four, and all four now ship.

    ``email`` and ``folder`` are driven end to end in this file;
    ``webhook`` and ``feed`` in ``test_delivery_webhook_and_feed.py``. The two
    sets are named here so a fifth channel cannot ship with no case at all --
    this fails rather than the suite quietly covering four of five.
    """
    assert set(delivery.ADAPTERS) == set(delivery.SHIPPED_CHANNELS)
    assert set(delivery.SHIPPED_CHANNELS) == set(database.DELIVERY_CHANNELS)
    assert len(database.DELIVERY_CHANNELS) == 4
    driven_here = {"email", "folder"}
    driven_next_door = {"webhook", "feed"}
    assert driven_here | driven_next_door == set(delivery.SHIPPED_CHANNELS), (
        "a newly shipped channel needs its own end-to-end case in one of the "
        "two delivery test files")


def test_a_channel_outside_the_schemas_vocabulary_is_refused_when_it_is_added(corpus):
    conn = corpus["conn"]
    with pytest.raises(ValueError) as caught:
        delivery.add_target(conn, corpus["routine_id"], channel="carrier-pigeon",
                            target="loft 4")
    assert "channel must be one of" in str(caught.value)
