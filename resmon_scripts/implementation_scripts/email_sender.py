# resmon_scripts/implementation_scripts/email_sender.py
"""Routine completion email dispatch.

Thin facade over :mod:`email_notifier` that resolves SMTP configuration
from the application settings table and the OS keyring, composes a
routine-completion message via :func:`email_notifier.compose_notification`,
and sends it via :func:`email_notifier.send_email`. Credentials are read
through ``credential_manager`` so they never transit through DB rows or
APScheduler job kwargs (constitution §8).

Public entry point: :func:`send_routine_completion_email`.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from . import email_notifier
from .credential_manager import get_credential
from .database import get_connection, get_setting

logger = logging.getLogger(__name__)


def load_smtp_config(conn) -> Optional[dict[str, Any]]:
    """Return the SMTP dict expected by :func:`email_notifier.send_email`.

    Returns ``None`` when any required field is missing so the caller can
    log-and-skip rather than raise. The delivery queue asks for this directly
    rather than letting the send skip silently: "SMTP is not configured" is a
    reason a user can act on, and it belongs in ``deliveries.last_error``
    rather than only in a log file.
    """
    host = get_setting(conn, "smtp_server")
    username = get_setting(conn, "smtp_username")
    recipient = get_setting(conn, "smtp_to")
    port_raw = get_setting(conn, "smtp_port") or "587"
    sender = get_setting(conn, "smtp_from") or username

    if not host or not username or not recipient:
        return None

    password = get_credential("smtp_password")
    if not password:
        return None

    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        port = 587

    return {
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "recipient": recipient,
        "sender": sender,
    }


def send_routine_completion_email(
    *,
    routine: dict,
    execution: dict,
    include_ai_summary: bool = False,
    attachment_path: Optional[str] = None,
    smtp_config: Optional[dict[str, Any]] = None,
    db_conn=None,
) -> None:
    """Compose and send a completion email for a routine-fired execution.

    Parameters
    ----------
    routine : dict
        Row from the ``routines`` table (must contain ``name``).
    execution : dict
        Row from the ``executions`` table.
    include_ai_summary : bool
        If True, include the AI summary (when available on the execution
        record) in the message body.
    attachment_path : str, optional
        Path to a file (typically the execution results ``.zip``) to
        attach to the message. Used by the "Results in Email" routine
        option.
    smtp_config : dict, optional
        Pre-resolved SMTP config. When omitted, settings are pulled from
        the application DB.
    db_conn : sqlite3.Connection, optional
        Existing DB connection used to look up SMTP settings when
        ``smtp_config`` is not provided.
    """
    if smtp_config is None:
        conn = db_conn if db_conn is not None else get_connection()
        smtp_config = load_smtp_config(conn)
    if not smtp_config:
        logger.info(
            "Skipping routine completion email: SMTP not fully configured "
            "(routine_id=%s exec_id=%s)",
            routine.get("id"),
            execution.get("id"),
        )
        return

    ai_summary = execution.get("ai_summary") if include_ai_summary else None

    # ``execution`` is a row from the ``executions`` table and the column
    # there is ``new_result_count``; ``new_count`` is only what
    # ``sweep_engine._run``'s return dict calls the same number. Reading the
    # second name alone meant the key was never present on the row the
    # delivery queue loads, and ``.get(..., 0)`` turned that absence into a
    # confident zero — so every routine completion email resmon has sent said
    # "New results: 0" however many papers the run found. The webhook envelope
    # and the Atom feed both read the column and were always right. The column
    # is ``INTEGER DEFAULT 0``, so a row always carries a number; the fallback
    # is for a caller that hands over the engine's dict instead of the row.
    new_count = execution.get("new_result_count")
    if new_count is None:
        new_count = execution.get("new_count", 0)

    payload = {
        "routine_name": routine.get("name", "Unknown Routine"),
        "start_time": execution.get("start_time", "—"),
        "end_time": execution.get("end_time", "—"),
        "status": execution.get("status", "unknown"),
        "result_count": execution.get("result_count", 0),
        "new_count": new_count,
    }

    message = email_notifier.compose_notification(
        payload,
        ai_summary=ai_summary,
        recipient=smtp_config.get("recipient"),
        sender=smtp_config.get("sender") or smtp_config.get("username"),
        attachment_path=attachment_path,
    )
    email_notifier.send_email(smtp_config, message)


#: The name this function had before the delivery queue needed to call it from
#: outside the module. ``resmon.py``'s Settings -> Email test route imports it
#: under the old name.
_load_smtp_config = load_smtp_config
