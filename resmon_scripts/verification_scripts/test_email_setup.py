"""Settings › Email's test send, against a real SMTP server on the loopback.

The server is ``test_delivery.SMTPStub``: ``smtplib`` really connects to it,
greets it, encrypts, signs in and sends. What is established here:

- port 465 is encrypted from the start (implicit TLS), and other ports are
  upgraded with STARTTLS, so both of the ports a provider gives work;
- either way the server's certificate is verified before the password is sent:
  a server whose certificate no trusted authority signed is refused, with a
  plain reason, and nothing is sent to it;
- the test message goes from the configured From address, as a watch's report
  does, while the envelope stays the signed-in account;
- a refused test says why, in the server's own words, with no password and no
  address in it.

No real mail account is used, and nothing leaves 127.0.0.1.
"""

from __future__ import annotations

import smtplib
import socket
import ssl
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from implementation_scripts import database, email_notifier  # noqa: E402
from implementation_scripts.credential_manager import store_credential  # noqa: E402
from test_delivery import SMTPStub, smtp_trusted  # noqa: E402,F401

PASSWORD = "hunter2-not-real"


def _config(stub: SMTPStub, port: int | None = None, **over) -> dict:
    return {
        "host": "127.0.0.1", "port": port or stub.port, "username": "resmon@example.org",
        "password": PASSWORD, "recipient": "reader@example.org", "sender": "lab-reports@example.org",
        **over,
    }


@pytest.fixture
def stubs():
    made: list[SMTPStub] = []

    def make(**kwargs) -> SMTPStub:
        stub = SMTPStub(**kwargs)
        made.append(stub)
        return stub

    yield make
    for stub in made:
        stub.close()


def test_port_465_is_encrypted_from_the_start(stubs, monkeypatch, smtp_trusted):  # noqa: F811
    stub = stubs(implicit_tls=True)
    # The stub listens on a free port; the client treats it as 465.
    monkeypatch.setattr(email_notifier, "IMPLICIT_TLS_PORT", stub.port)
    assert email_notifier.send_test_email(_config(stub)) is True
    assert len(stub.messages) == 1


@pytest.mark.parametrize("implicit", [False, True], ids=["starttls", "implicit-tls"])
def test_a_certificate_no_trusted_authority_signed_is_refused(stubs, monkeypatch, smtp_trusted, implicit):  # noqa: F811
    stub = stubs(untrusted=True, implicit_tls=implicit)
    if implicit:
        monkeypatch.setattr(email_notifier, "IMPLICIT_TLS_PORT", stub.port)
    with pytest.raises(email_notifier.EmailSendError) as caught:
        email_notifier.send_test_email(_config(stub))
    reason = str(caught.value)
    assert reason.startswith("The server's certificate could not be verified (")
    assert f"nothing was sent to 127.0.0.1 on port {stub.port}" in reason
    assert PASSWORD not in reason and "example.org" not in reason
    assert stub.messages == [] and stub.envelope_senders == []


def test_without_the_test_authority_certifi_decides_and_refuses_it(stubs, monkeypatch):
    # The product's own trust: certifi's authorities, which never signed the stub's.
    monkeypatch.setattr(email_notifier, "_CA_BUNDLE", None)
    stub = stubs()
    with pytest.raises(email_notifier.EmailSendError) as caught:
        email_notifier.send_test_email(_config(stub))
    assert str(caught.value).startswith("The server's certificate could not be verified (")
    assert stub.messages == []


def test_the_context_verifies_and_never_turns_verification_off():
    context = email_notifier._tls_context()
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True
    assert context.minimum_version >= ssl.TLSVersion.TLSv1_2


def test_587_upgrades_with_starttls_and_the_test_goes_from_the_from_address(stubs, smtp_trusted):  # noqa: F811
    stub = stubs()
    assert email_notifier.send_test_email(_config(stub)) is True
    [message] = stub.messages
    assert "From: lab-reports@example.org" in message
    assert "To: reader@example.org" in message
    # The envelope is the account a provider signed in.
    assert stub.envelope_senders == ["resmon@example.org"]


def test_with_no_from_the_test_goes_from_the_account(stubs, smtp_trusted):  # noqa: F811
    stub = stubs()
    email_notifier.send_test_email(_config(stub, sender=None))
    assert "From: resmon@example.org" in stub.messages[0]


def test_a_refused_sign_in_says_so_in_the_servers_words_without_secrets(stubs, smtp_trusted):  # noqa: F811
    stub = stubs(refuse_auth=True)
    with pytest.raises(email_notifier.EmailSendError) as caught:
        email_notifier.send_test_email(_config(stub))
    reason = str(caught.value)
    assert reason.startswith("The server refused the sign-in (535 5.7.8 Username and Password not accepted")
    assert "app password" in reason
    assert PASSWORD not in reason
    assert "example.org" not in reason
    assert "<address>" in reason
    assert stub.messages == []


def test_a_server_without_starttls_is_never_sent_to_in_plain_text(stubs, smtp_trusted):  # noqa: F811
    stub = stubs(offer_starttls=False)
    with pytest.raises(email_notifier.EmailSendError) as caught:
        email_notifier.send_test_email(_config(stub))
    assert f"127.0.0.1 on port {stub.port} does not offer STARTTLS" in str(caught.value)
    assert "port 465" in str(caught.value)
    assert stub.messages == []


def test_unreachable_servers_are_named_with_the_reason():
    # A port nothing listens on: bound, then closed, so the refusal is immediate.
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    reason = email_notifier.failure_reason(ConnectionRefusedError(61, "Connection refused"),
                                           {"host": "127.0.0.1", "port": port})
    assert reason == f"127.0.0.1 on port {port} refused the connection. Check the server's name and port."
    assert email_notifier.failure_reason(socket.gaierror(8, "nodename nor servname provided"),
                                         {"host": "smtp.example.invalid", "port": 587}) \
        == "No server named smtp.example.invalid could be found. Check the server's name and this computer's connection."
    refused = smtplib.SMTPRecipientsRefused({"Reader@Example.org": (550, b"5.1.1 <Reader@Example.org>: no such user")})
    reason = email_notifier.failure_reason(refused, {"host": "h", "port": 587, "recipient": "reader@example.org"})
    assert reason == "The server refused the To address (550 5.1.1 <<address>>: no such user)."


def test_the_route_returns_the_reason(stubs, smtp_trusted):  # noqa: F811
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    conn = resmon_mod._get_db()
    stub = stubs(refuse_auth=True)
    for key, value in (("smtp_server", "127.0.0.1"), ("smtp_port", str(stub.port)),
                       ("smtp_username", "resmon@example.org"), ("smtp_from", "lab@example.org"),
                       ("smtp_to", "reader@example.org, second@example.org")):
        database.set_setting(conn, key, value)
    store_credential("smtp_password", PASSWORD)
    answer = TestClient(resmon_mod.app).post("/api/settings/email/test")
    assert answer.status_code == 400
    detail = answer.json()["detail"]
    assert detail.startswith("The test email was not sent. The server refused the sign-in (535 5.7.8")
    assert PASSWORD not in detail and "example.org" not in detail

    stub_ok = stubs()
    database.set_setting(conn, "smtp_port", str(stub_ok.port))
    answer = TestClient(resmon_mod.app).post("/api/settings/email/test")
    assert answer.status_code == 200, answer.text
    assert answer.json() == {"success": True, "recipient": "reader@example.org"}
    assert "From: lab@example.org" in stub_ok.messages[0]
