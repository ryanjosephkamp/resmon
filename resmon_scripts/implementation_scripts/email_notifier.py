# resmon_scripts/implementation_scripts/email_notifier.py
"""SMTP email notification system for sweep results."""

import logging
import mimetypes
import re
import smtplib
import socket
import ssl
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders
from pathlib import Path

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Compose
# ---------------------------------------------------------------------------

#: What a count line says when the composer was not given the count.
#:
#: ``execution_data.get("new_count", 0)`` turned a caller's silence into the
#: sentence "New results: 0", which is a finding resmon had no basis for -- and
#: is indistinguishable from the real finding that a run turned up nothing new.
#: That is not academic: ``email_sender`` read ``new_count`` where the
#: ``executions`` column is ``new_result_count``, so the key was absent on every
#: real send and every completion email reported zero. Fixing that caller did
#: not remove the default that made its mistake silent.
#:
#: ``delivery._atom_feed`` renders the same absence as "an unrecorded number";
#: this is the same statement in a ``Label: value`` line.
UNRECORDED_COUNT = "not recorded"


def _count(execution_data: dict, key: str) -> object:
    """A count for the body: the number if there is one, else a label.

    ``None`` is handled beside the missing key on purpose. A row loaded from
    SQLite carries ``None`` for a null column rather than omitting the key, so
    a fix that only changed ``dict.get``'s default would ship the line
    "New results: None" to a user.
    """
    value = execution_data.get(key)
    return UNRECORDED_COUNT if value is None else value


def compose_notification(
    execution_data: dict,
    ai_summary: str | None = None,
    *,
    recipient: str | None = None,
    sender: str | None = None,
    attachment_path: str | Path | None = None,
) -> MIMEMultipart:
    """Build a MIME email message from execution results.

    *execution_data* should contain at least: ``routine_name``,
    ``start_time``, ``end_time``, ``status``, ``result_count``,
    ``new_count``. A count that is missing or ``None`` is reported as
    ``not recorded``; see :data:`UNRECORDED_COUNT`.

    When *attachment_path* is provided and points to an existing file,
    the file is attached to the outgoing message. Used by the
    "Results in Email" routine option to ship the full execution ``.zip``
    bundle alongside the completion notice.
    """
    routine_name = execution_data.get("routine_name", "Unknown watch")
    status = execution_data.get("status", "unknown")
    result_count = _count(execution_data, "result_count")
    new_count = _count(execution_data, "new_count")
    start_time = execution_data.get("start_time", "—")
    end_time = execution_data.get("end_time", "—")

    status_word = "canceled" if status == "cancelled" else status
    subject = f"[resmon] {routine_name} - {status_word}"

    body_lines = [
        f"Watch: {routine_name}",
        f"Status: {status_word}",
        f"Start: {start_time}",
        f"End: {end_time}",
        f"Total results: {result_count}",
        f"New results: {new_count}",
    ]

    if ai_summary:
        body_lines.append("")
        body_lines.append("--- AI Summary ---")
        body_lines.append(ai_summary)

    if attachment_path is not None:
        body_lines.append("")
        body_lines.append(
            f"Full results bundle attached: {Path(attachment_path).name}"
        )

    body = "\n".join(body_lines)

    msg = MIMEMultipart()
    msg["Subject"] = subject
    msg["From"] = sender or "resmon@localhost"
    msg["To"] = recipient or ""
    msg.attach(MIMEText(body, "plain"))

    if attachment_path is not None:
        path = Path(attachment_path)
        if path.is_file():
            ctype, encoding = mimetypes.guess_type(str(path))
            if ctype is None or encoding is not None:
                ctype = "application/octet-stream"
            maintype, subtype = ctype.split("/", 1)
            try:
                with path.open("rb") as fp:
                    part = MIMEBase(maintype, subtype)
                    part.set_payload(fp.read())
                encoders.encode_base64(part)
                part.add_header(
                    "Content-Disposition",
                    "attachment",
                    filename=path.name,
                )
                msg.attach(part)
            except OSError as exc:
                logger.warning(
                    "Failed to attach %s to notification: %s", path, exc,
                )
        else:
            logger.warning(
                "Attachment path %s does not exist; skipping attachment.",
                path,
            )

    return msg


# ---------------------------------------------------------------------------
# Send
# ---------------------------------------------------------------------------

#: The port for SMTP over implicit TLS (RFC 8314 section 3.3): the connection
#: is encrypted from its first byte. Every other port starts in plain text and
#: is upgraded with STARTTLS before anything is sent, so a password never
#: crosses the network unencrypted on either.
IMPLICIT_TLS_PORT = 465

#: How long a connection, and each reply on it, is waited for.
SMTP_TIMEOUT_S = 30

#: Test-only. Product code never sets it. A test that stands up an SMTP server
#: on loopback points it at the certificate authority that signed that server's
#: certificate. Verification is never turned off: the test's certificate is
#: checked against the test's authority, as a real one is against certifi's.
_CA_BUNDLE: str | None = None


def _tls_context() -> ssl.SSLContext:
    """The TLS context every SMTP connection uses: the server's certificate is
    verified, against certifi's authorities, for the server's name, at TLS 1.2
    or later.

    ``smtplib`` left to itself uses ``ssl._create_unverified_context()`` for
    both ``starttls()`` and ``SMTP_SSL``, which encrypts but checks nothing, so
    anyone between resmon and the mail server could read the app password.
    certifi is the bundle the PDF downloader verifies against
    (``fulltext_download._ssl_context``), so one set of authorities serves both.
    """
    if _CA_BUNDLE:
        context = ssl.create_default_context(cafile=_CA_BUNDLE)
    else:
        import certifi  # noqa: PLC0415 - httpx's own bundle, already installed

        context = ssl.create_default_context(cafile=certifi.where())
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


class EmailSendError(RuntimeError):
    """A send that failed, with a reason a person can act on.

    The text never holds the password or an email address: the server's own
    reply is kept, because it is usually the most precise statement of what
    went wrong, but scrubbed first (:func:`failure_reason`).
    """


_ADDRESS = re.compile(r"[^\s<>()\[\]\\,;:\"']+@[^\s<>()\[\]\\,;:\"']+")


def _scrubbed(text: str, password: str, addresses: tuple[str, ...]) -> str:
    """*text* on one line, without the password, the configured addresses, or
    anything else shaped like an address, in the placeholders ``delivery``
    writes to a delivery's recorded error. Longest first and in any case, as
    a server may echo an address in a spelling the client never sent."""
    if password:
        text = text.replace(password, "[REDACTED]")
    for value in sorted({a for a in addresses if a}, key=len, reverse=True):
        text = re.sub(re.escape(value), "<address>", text, flags=re.IGNORECASE)
    text = _ADDRESS.sub("<address>", text)
    return " ".join(text.split())[:600]


def _reply(exc: smtplib.SMTPResponseException) -> str:
    """The server's reply in an SMTP exception: its code and its own words."""
    said = exc.smtp_error.decode("utf-8", "replace") if isinstance(exc.smtp_error, bytes) else str(exc.smtp_error)
    return f"{exc.smtp_code} {said}".strip()


def failure_reason(exc: BaseException, smtp_config: dict) -> str:
    """Why a send failed, in words, with the server's reply where it gave one.

    The password, the account, the From and the To are scrubbed from every
    part, and so is anything else shaped like an address, since a server's
    refusal often quotes one. The server's name and port are kept: they are
    what the person typed and what they would check.
    """
    host = str(smtp_config.get("host") or "")
    port = int(smtp_config.get("port") or 587)
    addresses = tuple(part.strip() for k in ("username", "sender", "recipient")
                      for part in re.split(r"[,;]", str(smtp_config.get(k) or "")) if part.strip())
    where = f"{host} on port {port}"
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        said = (f"The server refused the sign-in ({_reply(exc)}). Check the username, and use an app "
                "password where the provider asks for one: Gmail and iCloud Mail do not accept the "
                "account's own password here.")
    elif isinstance(exc, smtplib.SMTPSenderRefused):
        said = f"The server refused the From address ({_reply(exc)}). Use the account's own address, or one it may send as."
    elif isinstance(exc, smtplib.SMTPRecipientsRefused):
        replies = "; ".join(
            f"{code} {(text.decode('utf-8', 'replace') if isinstance(text, bytes) else str(text))}"
            for code, text in exc.recipients.values())
        said = f"The server refused the To address ({replies})."
    elif isinstance(exc, smtplib.SMTPNotSupportedError):
        said = (f"{where} does not offer STARTTLS, so nothing was sent unencrypted. If the server "
                f"encrypts from the start, use port {IMPLICIT_TLS_PORT}.")
    elif isinstance(exc, smtplib.SMTPServerDisconnected):
        said = (f"{where} closed the connection ({exc or 'no reason given'}). Port {IMPLICIT_TLS_PORT} is "
                "encrypted from the start and port 587 upgrades with STARTTLS; check that the port is "
                "the one the provider gives for its server.")
    elif isinstance(exc, smtplib.SMTPResponseException):
        said = f"The server refused the message ({_reply(exc)})."
    elif isinstance(exc, socket.gaierror):
        said = f"No server named {host} could be found. Check the server's name and this computer's connection."
    elif isinstance(exc, (TimeoutError, socket.timeout)):
        said = f"{where} did not answer within {SMTP_TIMEOUT_S} seconds."
    elif isinstance(exc, ssl.SSLCertVerificationError):
        said = (f"The server's certificate could not be verified ({exc.verify_message or exc.reason or exc}), "
                f"so nothing was sent to {where}. resmon sends only to a server whose certificate a known "
                "authority signed for its name; check that the server's name is the one the provider gives.")
    elif isinstance(exc, ssl.SSLError):
        said = (f"The encrypted connection to {where} failed ({exc.reason or exc}). Port {IMPLICIT_TLS_PORT} is "
                "encrypted from the start and port 587 upgrades with STARTTLS; check that the port is "
                "the one the provider gives.")
    elif isinstance(exc, ConnectionRefusedError):
        said = f"{where} refused the connection. Check the server's name and port."
    elif isinstance(exc, smtplib.SMTPConnectError):
        said = f"{where} would not start a session ({_reply(exc)})."
    elif isinstance(exc, OSError):
        said = f"{where} could not be reached ({exc.strerror or exc})."
    else:
        said = f"{exc.__class__.__name__}: {exc}"
    return _scrubbed(said, str(smtp_config.get("password") or ""), addresses)


def send_email(smtp_config: dict, message: MIMEMultipart) -> None:
    """Send a MIME message over SMTP, encrypted before anything is sent.

    *smtp_config* keys: ``host``, ``port``, ``username``, ``password``,
    ``recipient``, and ``sender`` (the From address; the account when
    absent). Port :data:`IMPLICIT_TLS_PORT` is encrypted from the start;
    any other port is upgraded with STARTTLS. Either way the server's
    certificate is verified before anything is sent. The envelope sender is the
    account, which is what a provider authenticates; the From header is
    ``sender``. A failure raises :class:`EmailSendError`, whose text never
    holds the password or an address (constitution §8).
    """
    host = smtp_config["host"]
    port = int(smtp_config.get("port", 587))
    username = smtp_config["username"]
    password = smtp_config["password"]
    recipient = smtp_config["recipient"]
    sender = smtp_config.get("sender") or username

    # The ``recipient`` setting is a free-form string that users are
    # encouraged to fill with multiple comma- or semicolon-separated
    # addresses on the Settings → Email page. Split it into a real list
    # for ``SMTP.sendmail`` so every recipient receives the message; the
    # RFC-5322 ``To`` header carries the full comma-separated list so all
    # recipients are visible to each other (standard "To" semantics).
    recipient_list = [
        addr.strip()
        for addr in re.split(r"[,;]", recipient or "")
        if addr.strip()
    ]
    to_header = ", ".join(recipient_list)

    # Replace (rather than append) the To/From headers so we never emit a
    # message with duplicate headers. Gmail rejects RFC-5322-noncompliant
    # messages with a 550 5.7.1 when multiple To headers are present.
    if message["To"]:
        message.replace_header("To", to_header)
    else:
        message["To"] = to_header
    if not message["From"] or message["From"] == "resmon@localhost":
        if message["From"]:
            message.replace_header("From", sender)
        else:
            message["From"] = sender

    try:
        # Both ways in verify the server's certificate before the password is sent (`_tls_context`).
        if port == IMPLICIT_TLS_PORT:
            session = smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT_S, context=_tls_context())
        else:
            session = smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT_S)
        with session as server:
            server.ehlo()
            if port != IMPLICIT_TLS_PORT:
                server.starttls(context=_tls_context())
                server.ehlo()
            server.login(username, password)
            server.sendmail(username, recipient_list, message.as_string())
        logger.info("Email sent to %d recipient(s) via %s:%d", len(recipient_list), host, port)
    except Exception as exc:
        reason = failure_reason(exc, smtp_config)
        logger.error("Email send failed: %s", reason)
        raise EmailSendError(reason) from None


# ---------------------------------------------------------------------------
# Test email
# ---------------------------------------------------------------------------

def send_test_email(smtp_config: dict) -> bool:
    """Send a simple test email to verify SMTP configuration.

    It goes from the configured From address (the account when none is set),
    as a watch's report does. Returns True once the server accepts it, and
    raises :class:`EmailSendError` with the reason when it does not.
    """
    test_data = {
        "routine_name": "SMTP Configuration Test",
        "start_time": "—",
        "end_time": "—",
        "status": "test",
        "result_count": 0,
        "new_count": 0,
    }
    message = compose_notification(
        test_data,
        ai_summary=None,
        recipient=smtp_config.get("recipient"),
        sender=smtp_config.get("sender") or smtp_config.get("username"),
    )
    send_email(smtp_config, message)
    return True
