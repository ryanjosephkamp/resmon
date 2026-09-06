"""The assistant's conversation store — schema 12.

Boundary: a **real SQLite database**, built by ``init_db``, with the real
schema. Nothing here is doubled, because everything under test is what the
database does — cascade, NULL versus zero, ordering, the CHECK constraint.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import assistant_store as store  # noqa: E402
from implementation_scripts import database  # noqa: E402


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "resmon.db"
    database.init_db(str(path))
    connection = database.get_connection(str(path))
    yield connection
    connection.close()


def test_schema_12_creates_the_assistant_tables(conn):
    assert database.SCHEMA_VERSION == 12
    assert database.get_schema_version(conn) == 12
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"assistant_sessions", "assistant_messages"} <= tables


def test_a_session_round_trips_with_its_messages(conn):
    cli_id = store.new_cli_session_id()
    sid = store.create_session(conn, runtime="claude_cli", cli_session_id=cli_id,
                               model="opus", title="Weekly arXiv")
    store.add_message(conn, sid, role="user", content="set one up")
    store.add_message(conn, sid, role="assistant", content="done",
                      tool_calls=[{"name": "create_routine", "input": {"name": "x"}}],
                      tool_results=[{"routine": {"id": 3}}],
                      input_tokens=120, output_tokens=40, cost_usd=0.012)

    session = store.get_session(conn, sid)
    assert session["cli_session_id"] == cli_id
    assert session["runtime"] == "claude_cli"

    messages = store.list_messages(conn, sid)
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert messages[1]["tool_calls"][0]["name"] == "create_routine"
    assert messages[1]["tool_results"][0]["routine"]["id"] == 3
    assert messages[1]["cost_usd"] == pytest.approx(0.012)


def test_history_survives_the_connection_closing(tmp_path):
    """P10's storage half: the transcript is on disk, not in a process.

    A backend restart is a new process and a new connection, which is what this
    reopens. What it cannot see is the runtime half — whether the *CLI* can
    resume the conversation afterwards — and that is checked against a real CLI
    elsewhere.
    """
    path = tmp_path / "resmon.db"
    database.init_db(str(path))
    first = database.get_connection(str(path))
    sid = store.create_session(first, runtime="claude_cli", cli_session_id="abc")
    store.add_message(first, sid, role="user", content="remember this")
    first.close()

    second = database.get_connection(str(path))
    assert store.get_session(second, sid)["cli_session_id"] == "abc"
    assert [m["content"] for m in store.list_messages(second, sid)] == ["remember this"]
    second.close()


def test_an_unreported_cost_stays_null_rather_than_becoming_zero(conn):
    """Zero and unknown are different facts, and one of them is a claim."""
    sid = store.create_session(conn, runtime="claude_cli")
    store.add_message(conn, sid, role="assistant", content="a")           # not reported
    store.add_message(conn, sid, role="assistant", content="b", cost_usd=0.5)

    messages = store.list_messages(conn, sid)
    assert messages[0]["cost_usd"] is None
    assert messages[0]["input_tokens"] is None

    totals = store.session_totals(conn, sid)
    assert totals["turns"] == 2
    assert totals["reported_turns"] == 1, (
        "a total over one of two turns must be visible as such"
    )
    assert totals["cost_usd"] == pytest.approx(0.5)


def test_a_session_with_nothing_reported_totals_to_none_not_zero(conn):
    sid = store.create_session(conn, runtime="claude_cli")
    store.add_message(conn, sid, role="assistant", content="a")
    assert store.session_totals(conn, sid)["cost_usd"] is None
    assert store.list_sessions(conn)[0]["cost_usd"] is None


def test_sessions_list_newest_activity_first(conn):
    first = store.create_session(conn, runtime="claude_cli", title="older")
    second = store.create_session(conn, runtime="claude_cli", title="newer")
    # ``updated_at`` has second resolution, so ordering ties are broken by id.
    # Asserted rather than assumed: two conversations started in the same second
    # is the normal case, not an edge one.
    conn.execute("UPDATE assistant_sessions SET updated_at = ? WHERE id = ?",
                 ("2020-01-01 00:00:00", first))
    conn.commit()
    assert [s["id"] for s in store.list_sessions(conn)] == [second, first]


def test_the_title_is_set_once_and_never_rewritten(conn):
    """A conversation whose name changes as it goes on cannot be found again."""
    sid = store.create_session(conn, runtime="claude_cli")
    store.touch_session(conn, sid, title="first thing they asked")
    store.touch_session(conn, sid, title="a later thing")
    assert store.get_session(conn, sid)["title"] == "first thing they asked"


def test_a_title_is_the_users_own_words_shortened_on_a_word_boundary():
    assert store.title_from("  set up   a routine ") == "set up a routine"
    assert store.title_from("") == "New conversation"
    long = "please set up a weekly monitoring routine on arXiv for graphene superconductivity"
    title = store.title_from(long)
    assert len(title) <= store.MAX_TITLE_LENGTH + 1     # the ellipsis
    assert title.endswith("…")
    assert not title.endswith(" …"), "truncation left a dangling space"
    assert long.startswith(title[:-1])


def test_deleting_a_session_takes_its_messages_with_it(conn):
    sid = store.create_session(conn, runtime="claude_cli")
    store.add_message(conn, sid, role="user", content="x")
    assert store.delete_session(conn, sid) is True
    assert store.get_session(conn, sid) is None
    assert conn.execute(
        "SELECT COUNT(*) FROM assistant_messages WHERE session_id = ?", (sid,)
    ).fetchone()[0] == 0
    assert store.delete_session(conn, sid) is False


def test_the_role_column_refuses_a_role_the_panel_cannot_render(conn):
    """A CHECK constraint, because an unrecognised role is a rendering bug.

    The panel switches on three roles. A fourth written by some future path
    would reach the renderer as an unhandled case; failing at the write is the
    cheaper place to find out.
    """
    sid = store.create_session(conn, runtime="claude_cli")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO assistant_messages (session_id, role) VALUES (?, 'tool')",
            (sid,),
        )


def test_an_unreadable_structured_column_is_reported_rather_than_crashing(conn):
    """A row from a future version must not take the whole transcript down."""
    sid = store.create_session(conn, runtime="claude_cli")
    conn.execute(
        "INSERT INTO assistant_messages (session_id, role, content, tool_calls) "
        "VALUES (?, 'assistant', 'hi', 'not json')", (sid,))
    conn.commit()
    message = store.list_messages(conn, sid)[0]
    assert message["content"] == "hi"
    assert message["tool_calls"] == {"unreadable": True}
