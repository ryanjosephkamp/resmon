# resmon_scripts/implementation_scripts/email_notifier.py
"""SMTP email notification system for sweep results."""

import logging
import mimetypes
import re
import smtplib
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders
from pathlib import Path

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Compose
# ---------------------------------------------------------------------------

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
    ``new_count``.

    When *attachment_path* is provided and points to an existing file,
    the file is attached to the outgoing message. Used by the
    "Results in Email" routine option to ship the full execution ``.zip``
    bundle alongside the completion notice.
    """
    routine_name = execution_data.get("routine_name", "Unknown Routine")
    status = execution_data.get("status", "unknown")
    result_count = execution_data.get("result_count", 0)
    new_count = execution_data.get("new_count", 0)
    start_time = execution_data.get("start_time", "—")
    end_time = execution_data.get("end_time", "—")

    subject = f"[resmon] {routine_name} - {status}"

    body_lines = [
        f"Routine: {routine_name}",
        f"Status: {status}",
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

def send_email(smtp_config: dict, message: MIMEMultipart) -> None:
    """Send a MIME message via SMTP with STARTTLS.

    *smtp_config* keys: ``host``, ``port``, ``username``, ``password``,
    ``recipient``.  The password is never logged or included in error
    messages (constitution §8).
    """
    host = smtp_config["host"]
    port = int(smtp_config.get("port", 587))
    username = smtp_config["username"]
    password = smtp_config["password"]
    recipient = smtp_config["recipient"]

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
            message.replace_header("From", username)
        else:
            message["From"] = username

    try:
        with smtplib.SMTP(host, port, timeout=30) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(username, password)
            server.sendmail(username, recipient_list, message.as_string())
        logger.info(
            "Email sent to %d recipient(s) (%s) via %s:%d",
            len(recipient_list), to_header, host, port,
        )
    except smtplib.SMTPAuthenticationError:
        logger.error("SMTP authentication failed for %s (credentials redacted).", host)
        raise RuntimeError(
            f"SMTP authentication failed for {host}. Check username and password."
        ) from None
    except Exception as exc:
        # Sanitize: ensure password never leaks
        safe_msg = str(exc)
        if password and password in safe_msg:
            safe_msg = safe_msg.replace(password, "[REDACTED]")
        logger.error("Email send failed: %s", safe_msg)
        raise RuntimeError(f"Email send failed: {safe_msg}") from None


# ---------------------------------------------------------------------------
# Test email
# ---------------------------------------------------------------------------

def send_test_email(smtp_config: dict) -> bool:
    """Send a simple test email to verify SMTP configuration.

    Returns True on success, False on failure.
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
        sender=smtp_config.get("username"),
    )
    try:
        send_email(smtp_config, message)
        return True
    except RuntimeError:
        return False
