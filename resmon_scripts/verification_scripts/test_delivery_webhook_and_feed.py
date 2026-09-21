"""The two channels PR two adds: a signed webhook envelope, and an Atom feed.

Both are driven against the real dependency, in process. The webhook receiver
is a real HTTPS server on 127.0.0.1 with a self-signed certificate, which
``httpx`` really connects to, negotiates TLS with and posts bytes to; the feed
is a real file on disk, parsed back by ``lxml`` in its strict mode. Nothing
here patches the adapter, the HTTP client or the filesystem.

What *is* not real: the certificate is generated per test and the TLS
verification is relaxed for it, exactly as ``test_delivery.py`` does for SMTP.
The alternative is a certificate authority, which is not a thing a hermetic
test can have.

Denominators. ``delivery.ADAPTERS`` and ``database.DELIVERY_CHANNELS`` both
have 4 entries; ``email`` and ``folder`` are driven end to end in
``test_delivery.py`` and the other two here, and
``test_every_shipped_channel_has_an_adapter_and_is_driven_somewhere`` in that
file fails if a fifth arrives with no case anywhere.
"""

from __future__ import annotations

import hashlib
import hmac
import http.server
import io
import json
import ssl
import sys
import threading
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import credential_manager, database, delivery  # noqa: E402
from implementation_scripts.credential_manager import store_credential  # noqa: E402

from test_delivery import SMTPStub, _self_signed, corpus, smtp_no_verify  # noqa: E402,F401


# ---------------------------------------------------------------------------
# A real HTTPS receiver on the loopback
# ---------------------------------------------------------------------------


class Receiver:
    """A webhook receiver: TLS, one handler, every request body kept.

    ``statuses`` is answered in order and the last one repeats, so "503 twice
    then 200" is written as ``[503, 503, 200]`` and a receiver that always
    fails is ``[500]``. ``delay`` makes it slow enough to time out.
    """

    def __init__(self, statuses=(200,), delay: float = 0.0) -> None:
        self.requests: list[dict] = []
        self._statuses = list(statuses)
        self._delay = delay
        cert, key = _self_signed()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        receiver = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):  # noqa: N802 - http.server's spelling
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                receiver.requests.append({
                    "body": body,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "path": self.path,
                })
                if receiver._delay:
                    time.sleep(receiver._delay)
                index = min(len(receiver.requests) - 1, len(receiver._statuses) - 1)
                status = receiver._statuses[index]
                self.send_response(status)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *args):  # keep the test output readable
                pass

        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.socket = context.wrap_socket(self._server.socket, server_side=True)
        self.port = self._server.server_address[1]
        assert self.port != 8742, "that port is the maintainer's live daemon"
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True, name="webhook-receiver")
        self._thread.start()

    @property
    def url(self) -> str:
        return f"https://127.0.0.1:{self.port}/hook"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


@pytest.fixture
def https_no_verify(monkeypatch):
    """Let ``httpx`` accept the receiver's self-signed certificate.

    The one production behaviour changed, and it is changed at the TLS context
    rather than by replacing the client: the connection, the request bytes, the
    headers, the status code and the failures are all the real ones.
    """
    original = ssl.create_default_context

    def lenient(*args, **kwargs):
        context = original(*args, **kwargs)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return context

    monkeypatch.setattr(ssl, "create_default_context", lenient)


@pytest.fixture
def base_url(monkeypatch):
    """A base URL for the envelope's links, without a serving backend.

    ``delivery.base_url`` reads the ``delivery_base_url`` setting first, which
    is the path a user with a receiver off this machine takes; using it here
    means the link in the envelope is built the same way it is in production.
    """
    return "https://resmon.example.invalid"


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


def _webhook_target(corpus, url: str, *, inline: bool = False, secret: str = "s3cret-not-real") -> int:
    conn = corpus["conn"]
    target = json.dumps({"url": url, "inline": True}) if inline else url
    target_id = delivery.add_target(
        conn, corpus["routine_id"], channel="webhook", target=target)
    store_credential(delivery.webhook_secret_name(target_id), secret)
    return target_id


# ---------------------------------------------------------------------------
# P1 -- one signed envelope, and a link that opens the right bundle
# ---------------------------------------------------------------------------


def test_the_receiver_gets_exactly_one_signed_envelope(
    corpus, tmp_path, https_no_verify, base_url,
):
    """4 of 4 shipped channels (M from ``delivery.ADAPTERS``); this is one.

    The signature is recomputed here over the exact bytes the receiver was
    sent, with the secret from the keyring, which is the check a real receiver
    performs. The envelope's facts are compared against the corpus rather than
    against themselves.
    """
    conn = corpus["conn"]
    database.set_setting(conn, "delivery_base_url", base_url)
    receiver = Receiver()
    try:
        target_id = _webhook_target(corpus, receiver.url)
        _enqueue(corpus)
        assert _queue().drain(conn) == 1
    finally:
        receiver.close()

    row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
    assert row["state"] == "delivered", row["last_error"]
    assert row["attempts"] == 1
    assert row["artifact_sha256"] == corpus["report_sha"]

    assert len(receiver.requests) == 1
    sent = receiver.requests[0]
    secret = credential_manager.get_credential(
        delivery.webhook_secret_name(target_id))
    expected = "sha256=" + hmac.new(
        secret.encode(), sent["body"], hashlib.sha256).hexdigest()
    assert sent["headers"]["x-resmon-signature"] == expected
    assert sent["headers"]["x-resmon-delivery"] == str(row["id"])

    envelope = json.loads(sent["body"])
    assert envelope["envelope_version"] == 1
    assert envelope["execution_id"] == corpus["exec_id"]
    assert envelope["routine"]["name"] == "Diffusion watch"
    assert envelope["report_sha256"] == corpus["report_sha"]
    assert envelope["coverage_summary"]
    assert envelope["search_record_url"].startswith(base_url)
    assert envelope["bundle_url"].startswith(
        f"{base_url}/api/deliveries/{row['id']}/bundle")
    assert envelope["bundle_expires_at"]
    assert "bundle_base64" not in envelope
    # No credential travels with it, in either direction.
    assert secret not in sent["body"].decode()
    assert "password" not in sent["body"].decode().lower()


def test_the_bundle_link_opens_the_bundle_and_a_tampered_or_expired_one_does_not(
    corpus, tmp_path, https_no_verify, base_url,
):
    """The route's own check, over the link the receiver was actually handed.

    The 403 for a missing, wrong or expired signature is also established
    against a real backend over real HTTP in ``test_local_api_auth.py``, which
    is where the fact that this route answers *without the API token* lives.
    Here it is the signature arithmetic and the bundle's identity.
    """
    from fastapi import HTTPException

    conn = corpus["conn"]
    database.set_setting(conn, "delivery_base_url", base_url)
    receiver = Receiver()
    try:
        _webhook_target(corpus, receiver.url)
        _enqueue(corpus)
        assert _queue().drain(conn) == 1
    finally:
        receiver.close()
    envelope = json.loads(receiver.requests[0]["body"])
    row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]

    query = parse_qs(urlsplit(envelope["bundle_url"]).query)
    exp, sig = query["exp"][0], query["sig"][0]

    response = resmon_mod.delivery_bundle(int(row["id"]), exp=exp, sig=sig)
    assert response.media_type == "application/zip"
    assert response.body[:2] == b"PK"
    # The envelope promises ``report_sha256`` and not a hash of the zip: a zip
    # carries its own timestamps and is rebuilt on fetch, so what the receiver
    # checks is that the report inside is the one the envelope described.
    with zipfile.ZipFile(io.BytesIO(response.body)) as archive:
        names = archive.namelist()
        report = next(n for n in names if n.endswith(".md"))
        assert hashlib.sha256(archive.read(report)).hexdigest() == \
            envelope["report_sha256"] == corpus["report_sha"]
    assert "bundle_sha256" not in envelope, (
        "a linked bundle is not byte-reproducible; promising its hash would be "
        "a promise resmon cannot keep")

    for bad_exp, bad_sig, why in (
        (exp, sig[:-1] + ("0" if sig[-1] != "0" else "1"), "one hex digit changed"),
        (exp, "", "no signature at all"),
        (str(int(datetime.now(timezone.utc).timestamp()) - 1), sig, "expired"),
    ):
        with pytest.raises(HTTPException) as caught:
            resmon_mod.delivery_bundle(int(row["id"]), exp=bad_exp, sig=bad_sig)
        assert caught.value.status_code == 403, why
        assert caught.value.detail["reason"] == "signature_invalid"


def test_an_expired_link_is_refused_the_second_after_it_expires(corpus):
    """The boundary itself, without a receiver: valid at the deadline, not after."""
    now = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)
    expires = int((now + timedelta(hours=24)).timestamp())
    sig = delivery.sign_bundle_link(7, expires, "shared-secret")
    assert delivery.bundle_link_is_valid(7, expires, sig, "shared-secret", now=now)
    assert delivery.bundle_link_is_valid(
        7, expires, sig, "shared-secret",
        now=datetime.fromtimestamp(expires, timezone.utc))
    assert not delivery.bundle_link_is_valid(
        7, expires, sig, "shared-secret",
        now=datetime.fromtimestamp(expires + 1, timezone.utc))
    # A link for one delivery does not open another's.
    assert not delivery.bundle_link_is_valid(8, expires, sig, "shared-secret", now=now)
    # And no secret is never a yes.
    assert not delivery.bundle_link_is_valid(7, expires, sig, None, now=now)


def test_inline_delivery_carries_the_bundle_and_no_link(
    corpus, tmp_path, https_no_verify, base_url,
):
    import base64

    conn = corpus["conn"]
    database.set_setting(conn, "delivery_base_url", base_url)
    receiver = Receiver()
    try:
        _webhook_target(corpus, receiver.url, inline=True)
        _enqueue(corpus)
        assert _queue().drain(conn) == 1
    finally:
        receiver.close()
    envelope = json.loads(receiver.requests[0]["body"])
    assert envelope["bundle_url"] is None
    blob = base64.b64decode(envelope["bundle_base64"])
    assert hashlib.sha256(blob).hexdigest() == envelope["bundle_sha256"]
    assert len(blob) == envelope["bundle_bytes"]
    assert blob[:2] == b"PK"


# ---------------------------------------------------------------------------
# P2 -- retries, and a failure that never names the URL
# ---------------------------------------------------------------------------


def test_two_refusals_then_success_is_three_attempts_and_one_delivery(
    corpus, https_no_verify, base_url,
):
    """A receiver answering 503, 503, 200. The clock is injected so the backoff
    is honoured rather than waited out: each drain runs at the time the
    previous one wrote into ``next_attempt_at_utc``, which is the only way to
    assert the second attempt really was gated on it."""
    conn = corpus["conn"]
    database.set_setting(conn, "delivery_base_url", base_url)
    receiver = Receiver(statuses=[503, 503, 200])
    moment = {"t": datetime(2026, 9, 21, 9, 0, tzinfo=timezone.utc)}
    try:
        _webhook_target(corpus, receiver.url)
        delivery_id = _enqueue(corpus)[0]
        queue = _queue(now=lambda: moment["t"])
        assert queue.drain(conn) == 1
        row = delivery.get_delivery(conn, delivery_id)
        assert (row["state"], row["attempts"]) == ("failed", 1)
        assert "503" in row["last_error"]

        for _ in range(2):
            moment["t"] = datetime.fromisoformat(row["next_attempt_at_utc"])
            assert queue.drain(conn) == 1
            row = delivery.get_delivery(conn, delivery_id)
    finally:
        receiver.close()

    assert row["state"] == "delivered"
    assert row["attempts"] == 3
    assert row["last_error"] is None
    assert len(receiver.requests) == 3, "one POST per attempt, no more"


def test_a_receiver_that_never_answers_fails_three_times_without_naming_the_url(
    corpus, monkeypatch, https_no_verify, base_url,
):
    """A URL is the destination of a person's research and does not belong in a
    column the MCP ``get_routine`` summary reads back. Every httpx exception's
    text carries it, so the record keeps the exception class and the timeout."""
    conn = corpus["conn"]
    database.set_setting(conn, "delivery_base_url", base_url)
    monkeypatch.setattr(delivery, "WEBHOOK_TIMEOUT_SECONDS", 0.5)
    receiver = Receiver(delay=5.0)
    secret_url = receiver.url
    moment = {"t": datetime(2026, 9, 21, 9, 0, tzinfo=timezone.utc)}
    try:
        _webhook_target(corpus, secret_url)
        delivery_id = _enqueue(corpus)[0]
        queue = _queue(now=lambda: moment["t"])
        for _ in range(delivery.MAX_ATTEMPTS):
            assert queue.drain(conn) == 1
            row = delivery.get_delivery(conn, delivery_id)
            if row["next_attempt_at_utc"]:
                moment["t"] = datetime.fromisoformat(row["next_attempt_at_utc"])
    finally:
        receiver.close()

    assert row["state"] == "failed"
    assert row["attempts"] == delivery.MAX_ATTEMPTS
    assert row["next_attempt_at_utc"] is None, "the backoff has given up"
    assert "could not be reached" in row["last_error"]
    assert secret_url not in row["last_error"], row["last_error"]
    assert "127.0.0.1" not in row["last_error"], row["last_error"]
    assert str(receiver.port) not in row["last_error"], row["last_error"]


def test_a_webhook_with_no_secret_is_refused_before_anything_is_sent(
    corpus, https_no_verify, base_url,
):
    """resmon signs every envelope. An unsigned one is not a fallback."""
    conn = corpus["conn"]
    database.set_setting(conn, "delivery_base_url", base_url)
    receiver = Receiver()
    try:
        target_id = delivery.add_target(conn, corpus["routine_id"],
                                        channel="webhook", target=receiver.url)
        # The in-memory keyring outlives one test; make the absence explicit
        # rather than depending on which tests ran before this one.
        credential_manager.delete_credential(
            delivery.webhook_secret_name(target_id))
        _enqueue(corpus)
        assert _queue().drain(conn) == 1
    finally:
        receiver.close()
    row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
    assert row["state"] == "failed"
    assert "no shared secret saved" in row["last_error"]
    assert receiver.requests == [], "nothing left this machine"


@pytest.mark.parametrize("url", [
    "http://example.org/hook",
    "ftp://example.org/hook",
    "example.org/hook",
    "https://",
    "",
])
def test_a_destination_that_is_not_https_is_refused_when_it_is_added(corpus, url):
    with pytest.raises(ValueError):
        delivery.add_target(corpus["conn"], corpus["routine_id"],
                            channel="webhook", target=url)


def test_a_loopback_receiver_may_be_plain_http(corpus):
    """The one carve-out, and the reason it exists: there is no certificate
    authority that will issue for 127.0.0.1, and nothing leaves the machine."""
    target_id = delivery.add_target(
        corpus["conn"], corpus["routine_id"], channel="webhook",
        target="http://127.0.0.1:9/hook")
    assert delivery.get_target(corpus["conn"], target_id)["channel"] == "webhook"


# ---------------------------------------------------------------------------
# P3 -- the feed
# ---------------------------------------------------------------------------


def _parse_strict(path: Path):
    """Parse with lxml in its strict mode: no recovery, no HTML fallback."""
    from lxml import etree

    parser = etree.XMLParser(recover=False, resolve_entities=False, no_network=True)
    return etree.parse(str(path), parser)


ATOM = "{http://www.w3.org/2005/Atom}"


def test_the_feed_is_valid_atom_and_links_to_the_folder_bundle(corpus, tmp_path):
    """Real files, a strict parser, and a link that resolves to a directory
    that is actually on disk."""
    conn = corpus["conn"]
    outbox = tmp_path / "outbox"
    outbox.mkdir()
    delivery.add_target(conn, corpus["routine_id"], channel="folder",
                        target=str(outbox))
    delivery.add_target(conn, corpus["routine_id"], channel="feed",
                        target=str(outbox))
    _enqueue(corpus)
    assert _queue().drain(conn) == 2

    feed_path = outbox / "resmon" / "diffusion-watch" / "feed.xml"
    assert feed_path.is_file()
    tree = _parse_strict(feed_path)
    root = tree.getroot()
    assert root.tag == f"{ATOM}feed"
    assert root.findtext(f"{ATOM}title") == "Diffusion watch"
    assert root.findtext(f"{ATOM}id") == f"urn:resmon:routine:{corpus['routine_id']}"
    assert root.findtext(f"{ATOM}updated")
    entries = root.findall(f"{ATOM}entry")
    assert len(entries) == 1
    entry = entries[0]
    assert str(corpus["exec_id"]) in entry.findtext(f"{ATOM}id")
    assert entry.findtext(f"{ATOM}summary")
    link = entry.find(f"{ATOM}link").get("href")
    assert link.startswith("file://")
    assert Path(link[len("file://"):]).is_dir()
    # No script, no tracker, no secret-bearing link (PRODUCT-VISION.md:199).
    text = feed_path.read_text(encoding="utf-8")
    assert "<script" not in text.lower()
    assert "sig=" not in text
    without_namespace = text.replace("http://www.w3.org/2005/Atom", "")
    assert "http://" not in without_namespace
    assert "https://" not in without_namespace


def test_a_feed_without_a_folder_target_carries_the_summary_only(corpus, tmp_path):
    conn = corpus["conn"]
    outbox = tmp_path / "feedonly"
    outbox.mkdir()
    delivery.add_target(conn, corpus["routine_id"], channel="feed",
                        target=str(outbox))
    _enqueue(corpus)
    assert _queue().drain(conn) == 1
    feed_path = outbox / "resmon" / "diffusion-watch" / "feed.xml"
    entry = _parse_strict(feed_path).getroot().find(f"{ATOM}entry")
    assert entry.find(f"{ATOM}link") is None
    assert entry.findtext(f"{ATOM}summary")


def test_the_feed_keeps_the_newest_fifty_entries_newest_first(corpus, tmp_path):
    """Sixty runs delivered to one feed target; the file holds fifty of them,
    newest first, and a run delivered twice appears once."""
    conn = corpus["conn"]
    outbox = tmp_path / "many"
    outbox.mkdir()
    target_id = delivery.add_target(conn, corpus["routine_id"], channel="feed",
                                    target=str(outbox))
    routine = database.get_routine_by_id(conn, corpus["routine_id"])

    exec_ids = [corpus["exec_id"]]
    for _ in range(59):
        exec_ids.append(database.insert_execution(conn, {
            "execution_type": "automated_sweep",
            "routine_id": corpus["routine_id"],
            "parameters": json.dumps({"query": "diffusion", "repositories": ["arxiv"]}),
            "start_time": database.utc_now_iso(),
        }))
    for exec_id in exec_ids:
        database.update_execution_status(conn, exec_id, "completed")
        execution = database.get_execution_by_id(conn, exec_id)
        delivery.enqueue_for_execution(conn, execution, routine)
        assert _queue().drain(conn) == 1

    feed_path = outbox / "resmon" / "diffusion-watch" / "feed.xml"
    root = _parse_strict(feed_path).getroot()
    entries = root.findall(f"{ATOM}entry")
    assert len(entries) == delivery.FEED_ENTRIES == 50
    ids = [int(e.findtext(f"{ATOM}id").rsplit("/", 1)[1]) for e in entries]
    assert ids == sorted(ids, reverse=True), "newest first"
    assert ids == sorted(exec_ids, reverse=True)[:50]
    assert len(set(ids)) == len(ids)

    # And a run delivered twice -- a retry after a partial write -- is one entry.
    row = conn.execute(
        "SELECT id FROM deliveries WHERE target_id = ? AND execution_id = ?",
        (target_id, exec_ids[-1]),
    ).fetchone()
    # What a crash between the temp file and the rename leaves behind: the row
    # failed, the file may or may not have been replaced. A person presses
    # Retry and the feed is rewritten -- with the same entry, not a second one.
    conn.execute("UPDATE deliveries SET state = 'failed' WHERE id = ?",
                 (int(row["id"]),))
    conn.commit()
    assert delivery.retry(conn, int(row["id"])) is True
    assert _queue().drain(conn) == 1
    entries = _parse_strict(feed_path).getroot().findall(f"{ATOM}entry")
    again = [int(e.findtext(f"{ATOM}id").rsplit("/", 1)[1]) for e in entries]
    assert again == ids


def test_source_text_in_a_routine_name_is_escaped_not_executed(corpus, tmp_path):
    """A feed is rendered by somebody else's reader over text resmon fetched
    from the internet. The boundary is escaping, and it is checked by parsing
    the file back rather than by looking at the string."""
    conn = corpus["conn"]
    outbox = tmp_path / "escaped"
    outbox.mkdir()
    hostile = 'Watch & <script>alert("x")</script> \'stuff\''
    database.update_routine(conn, corpus["routine_id"], {"name": hostile})
    delivery.add_target(conn, corpus["routine_id"], channel="feed",
                        target=str(outbox))
    _enqueue(corpus)
    assert _queue().drain(conn) == 1
    feed_path = next((outbox / "resmon").glob("*/feed.xml"))
    text = feed_path.read_text(encoding="utf-8")
    assert "<script>" not in text
    root = _parse_strict(feed_path).getroot()
    assert root.findtext(f"{ATOM}title") == hostile


def test_a_feed_folder_that_is_not_there_never_names_itself_in_the_record(
    corpus, tmp_path,
):
    conn = corpus["conn"]
    missing = tmp_path / "Private-Feed-Folder"
    delivery.add_target(conn, corpus["routine_id"], channel="feed",
                        target=str(missing))
    _enqueue(corpus)
    assert _queue().drain(conn) == 1
    row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
    assert row["state"] == "failed"
    assert "not a directory resmon can see" in row["last_error"]
    assert str(missing) not in row["last_error"]
    assert "Private-Feed-Folder" not in row["last_error"]


# ---------------------------------------------------------------------------
# P4 -- the address scrub
# ---------------------------------------------------------------------------


def test_a_refused_recipient_never_reaches_the_record(corpus, smtp_no_verify):
    """``SMTPRecipientsRefused`` carries the address it refused, inside the
    exception. A real server answering 550 to a real RCPT is what produces it
    here, because a hand-raised exception could not have failed this way."""
    conn = corpus["conn"]
    stub = SMTPStub(refuse_recipients=True)
    try:
        database.set_setting(conn, "smtp_server", "127.0.0.1")
        database.set_setting(conn, "smtp_port", str(stub.port))
        database.set_setting(conn, "smtp_username", "resmon@example.org")
        database.set_setting(conn, "smtp_to", "fallback@example.org")
        store_credential("smtp_password", "hunter2-not-real")
        database.update_routine(conn, corpus["routine_id"], {"email_enabled": 1})
        delivery.add_target(conn, corpus["routine_id"], channel="email",
                            target="private@example.org")
        _enqueue(corpus)
        assert _queue().drain(conn) == 1
    finally:
        stub.close()

    row = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])[0]
    assert row["state"] == "failed"
    error = row["last_error"]
    assert "private@example.org" not in error, error
    assert "fallback@example.org" not in error, error
    assert "resmon@example.org" not in error, error
    assert "<address>" in error, error
    # The failure is still identifiable: what the server said, and which
    # destination it was said about.
    assert "550" in error and "Recipient address rejected" in error
    assert row["target_id"] is not None
    assert delivery.get_target(conn, row["target_id"])["target"] == "private@example.org"


def test_the_mcp_summary_names_no_address_url_or_path_on_any_channel(
    corpus, tmp_path, smtp_no_verify, https_no_verify, base_url,
):
    """All 4 of 4 shipped channels' failure paths, in one summary.

    M is ``delivery.ADAPTERS``; each channel is given a destination that will
    fail and the whole summary is searched for every private string.
    """
    conn = corpus["conn"]
    database.set_setting(conn, "delivery_base_url", base_url)
    database.update_routine(conn, corpus["routine_id"], {"email_enabled": 1})
    stub = SMTPStub(refuse_recipients=True)
    receiver = Receiver(statuses=[500])
    folder = tmp_path / "Somewhere-Private"
    feed_folder = tmp_path / "Another-Private-Place"
    try:
        database.set_setting(conn, "smtp_server", "127.0.0.1")
        database.set_setting(conn, "smtp_port", str(stub.port))
        database.set_setting(conn, "smtp_username", "resmon@example.org")
        database.set_setting(conn, "smtp_to", "private@example.org")
        store_credential("smtp_password", "hunter2-not-real")
        delivery.add_target(conn, corpus["routine_id"], channel="email",
                            target="private@example.org")
        delivery.add_target(conn, corpus["routine_id"], channel="folder",
                            target=str(folder))
        delivery.add_target(conn, corpus["routine_id"], channel="feed",
                            target=str(feed_folder))
        _webhook_target(corpus, receiver.url, secret="secret-not-real")
        _enqueue(corpus)
        assert _queue().drain(conn) == 4
    finally:
        stub.close()
        receiver.close()

    rows = delivery.list_deliveries_for_execution(conn, corpus["exec_id"])
    assert {r["channel"] for r in rows} == set(delivery.ADAPTERS) == set(
        database.DELIVERY_CHANNELS)
    assert all(r["state"] == "failed" for r in rows), [
        (r["channel"], r["state"]) for r in rows]

    blob = json.dumps({
        "summary": delivery.routine_delivery_summary(conn, corpus["routine_id"]),
        "errors": [r["last_error"] for r in rows],
    })
    for private in ("private@example.org", "resmon@example.org",
                    str(folder), "Somewhere-Private",
                    str(feed_folder), "Another-Private-Place",
                    receiver.url, str(receiver.port), "secret-not-real",
                    "hunter2-not-real"):
        assert private not in blob, f"{private!r} reached the MCP surface"


# ---------------------------------------------------------------------------
# P5 -- the secret lives in the keyring and nowhere else
# ---------------------------------------------------------------------------


def test_a_webhook_secret_is_an_allowed_credential_name_and_a_near_miss_is_not():
    assert credential_manager.is_allowed_credential_name("webhook_secret_1")
    assert credential_manager.is_allowed_credential_name("webhook_secret_99999")
    for bad in ("webhook_secret_", "webhook_secret_x", "webhook_secret_1a",
                "webhook_secret", "webhook_secret_1/2", "smtp_passwordx"):
        assert not credential_manager.is_allowed_credential_name(bad), bad


def test_the_secret_is_never_written_to_the_corpus(corpus, https_no_verify, base_url):
    """It is set through the keyring and read back through the keyring; no
    table, setting or delivery row ever holds it (B12)."""
    conn = corpus["conn"]
    database.set_setting(conn, "delivery_base_url", base_url)
    receiver = Receiver()
    secret = "a-very-distinctive-secret-value"
    try:
        target_id = _webhook_target(corpus, receiver.url, secret=secret)
        _enqueue(corpus)
        assert _queue().drain(conn) == 1
    finally:
        receiver.close()

    assert credential_manager.get_credential(
        delivery.webhook_secret_name(target_id)) == secret
    tables = [r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'")]
    assert tables
    for table in tables:
        for row in conn.execute(f"SELECT * FROM {table}"):
            assert secret not in json.dumps(
                {k: str(row[k]) for k in row.keys()}), table
