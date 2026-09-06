"""Storage for the embedded assistant's conversations — schema 12.

A conversation is a row in ``assistant_sessions`` and a row per turn in
``assistant_messages``. Nothing here talks to a model, a CLI or the network;
this module's whole job is that a conversation survives the app closing.

Three decisions worth the reader's time.

**resmon owns the session id, and hands it to the runtime.** A UUID generated
here goes to the CLI as ``--session-id``; a later turn resumes with
``--resume <that same uuid>``. The alternative — let the CLI mint one and store
the mapping — is one more pair of identifiers to keep in step, and the failure
mode is a resume that silently starts a fresh conversation the user believes is
their old one. ``cli_session_id`` is nullable because "this runtime cannot
resume" is a real state the panel reports rather than papers over.

**Tool results are stored exactly as returned.** That is safe by construction
rather than by care: no tool on the surface returns a credential value — a
contract v2 guarantee asserted against a real backend — so a transcript has no
class of secret to accumulate. It is worth writing down *why* it is safe,
because "we store what the model saw" is otherwise the sort of decision that
ages badly the first time a tool starts returning something sensitive.

**Cost and tokens are recorded per message, and are nullable.** A runtime that
does not report them stores ``NULL``, and the panel renders "not reported"
rather than a zero. Zero and unknown are different facts, and the one thing this
app does not do is show a number it did not measure.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any, Optional

__all__ = [
    "MAX_TITLE_LENGTH",
    "add_message",
    "create_session",
    "delete_session",
    "get_session",
    "list_messages",
    "list_sessions",
    "new_cli_session_id",
    "session_totals",
    "set_cli_session_id",
    "title_from",
    "touch_session",
]

# Long enough to tell two conversations apart in a list, short enough not to
# reflow the panel. The full first message is still the first row of the
# transcript, so nothing is lost by truncating here.
MAX_TITLE_LENGTH = 60


def new_cli_session_id() -> str:
    """A fresh session id for a runtime that takes one.

    ``claude`` requires a valid UUID for ``--session-id`` and rejects anything
    else, so this is not decoration.
    """
    return str(uuid.uuid4())


def title_from(text: str) -> str:
    """A session title taken from its first message.

    Whitespace-collapsed and truncated on a word boundary where one is near
    enough. Deliberately not a model-generated summary: naming a conversation
    would be a second inference to be wrong about, and the user's own first
    sentence is both cheaper and more recognisable.
    """
    collapsed = " ".join(str(text or "").split())
    if not collapsed:
        return "New conversation"
    if len(collapsed) <= MAX_TITLE_LENGTH:
        return collapsed
    cut = collapsed[:MAX_TITLE_LENGTH]
    space = cut.rfind(" ")
    if space >= MAX_TITLE_LENGTH - 15:
        cut = cut[:space]
    return cut.rstrip(" ,.;:") + "…"


def create_session(
    conn: sqlite3.Connection,
    *,
    runtime: str,
    cli_session_id: Optional[str] = None,
    model: Optional[str] = None,
    title: Optional[str] = None,
) -> int:
    cur = conn.execute(
        "INSERT INTO assistant_sessions (runtime, cli_session_id, model, title) "
        "VALUES (?, ?, ?, ?)",
        (runtime, cli_session_id, model, title),
    )
    conn.commit()
    return int(cur.lastrowid)


def set_cli_session_id(
    conn: sqlite3.Connection, session_id: int, cli_session_id: Optional[str],
) -> None:
    conn.execute(
        "UPDATE assistant_sessions SET cli_session_id = ?, "
        "updated_at = datetime('now') WHERE id = ?",
        (cli_session_id, session_id),
    )
    conn.commit()


def touch_session(
    conn: sqlite3.Connection, session_id: int, *, title: Optional[str] = None,
) -> None:
    """Bump ``updated_at``, and set the title if it does not have one yet.

    The title is set once, from the first user message, and never rewritten —
    a conversation whose name changes under the user as it goes on is one they
    cannot find again.
    """
    if title:
        conn.execute(
            "UPDATE assistant_sessions SET updated_at = datetime('now'), "
            "title = COALESCE(NULLIF(title, ''), ?) WHERE id = ?",
            (title, session_id),
        )
    else:
        conn.execute(
            "UPDATE assistant_sessions SET updated_at = datetime('now') WHERE id = ?",
            (session_id,),
        )
    conn.commit()


def add_message(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    role: str,
    content: str = "",
    tool_calls: Optional[list] = None,
    tool_results: Optional[list] = None,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    cost_usd: Optional[float] = None,
) -> int:
    cur = conn.execute(
        "INSERT INTO assistant_messages "
        "(session_id, role, content, tool_calls, tool_results, "
        " input_tokens, output_tokens, cost_usd) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            session_id, role, content or "",
            json.dumps(tool_calls, default=str) if tool_calls else None,
            json.dumps(tool_results, default=str) if tool_results else None,
            input_tokens, output_tokens, cost_usd,
        ),
    )
    conn.commit()
    return int(cur.lastrowid)


def _session_row(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "runtime": row["runtime"],
        "cli_session_id": row["cli_session_id"],
        "model": row["model"],
        "title": row["title"] or "New conversation",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def get_session(conn: sqlite3.Connection, session_id: int) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM assistant_sessions WHERE id = ?", (session_id,)
    ).fetchone()
    return _session_row(row) if row else None


def list_sessions(conn: sqlite3.Connection, limit: int = 50) -> list[dict]:
    """Newest activity first, with each session's message count and cost."""
    rows = conn.execute(
        "SELECT s.*, "
        "       (SELECT COUNT(*) FROM assistant_messages m "
        "         WHERE m.session_id = s.id) AS message_count, "
        "       (SELECT SUM(m.cost_usd) FROM assistant_messages m "
        "         WHERE m.session_id = s.id) AS cost_usd "
        "  FROM assistant_sessions s "
        " ORDER BY s.updated_at DESC, s.id DESC LIMIT ?",
        (max(1, int(limit)),),
    ).fetchall()
    out = []
    for row in rows:
        entry = _session_row(row)
        entry["message_count"] = row["message_count"]
        # SUM over no rows, or over rows that all reported nothing, is NULL.
        # Kept as None: "this conversation cost nothing" and "nobody told us
        # what it cost" are different claims and the panel renders them
        # differently.
        entry["cost_usd"] = row["cost_usd"]
        out.append(entry)
    return out


def _json_or_none(value: Any) -> Any:
    if value is None:
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        # A row written by a future version, or a hand-edited database. The
        # message is still shown; the structured part is reported as
        # unreadable rather than dropped silently or crashing the transcript.
        return {"unreadable": True}


def list_messages(conn: sqlite3.Connection, session_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM assistant_messages WHERE session_id = ? ORDER BY id",
        (session_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "role": row["role"],
            "content": row["content"],
            "tool_calls": _json_or_none(row["tool_calls"]),
            "tool_results": _json_or_none(row["tool_results"]),
            "input_tokens": row["input_tokens"],
            "output_tokens": row["output_tokens"],
            "cost_usd": row["cost_usd"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def session_totals(conn: sqlite3.Connection, session_id: int) -> dict:
    """What the conversation has cost so far, and what was never reported.

    ``reported_turns`` against ``turns`` is the honesty column: a total over
    three of five turns is not a total, and the panel says which it is showing.
    """
    row = conn.execute(
        "SELECT COUNT(*) AS turns, "
        "       SUM(input_tokens) AS input_tokens, "
        "       SUM(output_tokens) AS output_tokens, "
        "       SUM(cost_usd) AS cost_usd, "
        "       SUM(CASE WHEN cost_usd IS NULL THEN 0 ELSE 1 END) AS reported_turns "
        "  FROM assistant_messages "
        " WHERE session_id = ? AND role = 'assistant'",
        (session_id,),
    ).fetchone()
    return {
        "turns": row["turns"] or 0,
        "reported_turns": row["reported_turns"] or 0,
        "input_tokens": row["input_tokens"],
        "output_tokens": row["output_tokens"],
        "cost_usd": row["cost_usd"],
    }


def delete_session(conn: sqlite3.Connection, session_id: int) -> bool:
    """Remove a conversation and its messages.

    The messages go through the foreign key's ``ON DELETE CASCADE``, which
    needs ``PRAGMA foreign_keys=ON`` — ``get_connection`` sets it, and the
    explicit delete below means this is still correct on a connection that
    does not.
    """
    conn.execute("DELETE FROM assistant_messages WHERE session_id = ?", (session_id,))
    cur = conn.execute("DELETE FROM assistant_sessions WHERE id = ?", (session_id,))
    conn.commit()
    return cur.rowcount > 0
