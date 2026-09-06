"""The permission broker — the gate itself, at unit scale.

The broker is the resmon-side half of ``--permission-prompt-tool``. Its whole
job is that a decision exists before a write does, so these tests are about the
*direction* of every failure: everything that is not an explicit allow denies,
and each denial says which kind it was.

The end-to-end round trip — a real subprocess asking, a real SSE stream showing
the card, a real answer, and a real database that did or did not change — is in
``test_assistant_api.py``. This file cannot see any of that and does not claim
to.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.assistant_permissions import PermissionBroker  # noqa: E402


def wait(broker: PermissionBroker, request, timeout: float = 5.0):
    """Run the broker's coroutine on a throwaway loop.

    ``asyncio.run`` rather than a pytest-asyncio dependency: since Python 3.10
    an ``asyncio.Event`` created outside a loop binds to none, so an answer
    recorded before this call is already visible to the ``wait_for`` inside it.
    The app ships a bundled interpreter and every dev dependency is one more
    thing to keep working across three Python versions.
    """
    return asyncio.run(broker.wait(request, timeout=timeout))


def _broker() -> PermissionBroker:
    return PermissionBroker()


def _open(broker: PermissionBroker, session_id: int = 1, tool: str = "run_sweep"):
    return broker.open(session_id=session_id, tool_name=tool,
                       tool_input={"query": "x"}, tool_use_id="toolu_1")


def test_an_allowed_request_returns_allow():
    broker = _broker()
    request = _open(broker)
    assert broker.answer(request.id, allow=True) is True
    assert wait(broker, request)[0] == "allow"


def test_a_denied_request_carries_the_reason_it_was_given():
    broker = _broker()
    request = _open(broker)
    broker.answer(request.id, allow=False, reason="Not on that source.")
    decision, message = wait(broker, request)
    assert decision == "deny"
    assert message == "Not on that source."


def test_a_request_nobody_answers_is_denied_and_says_it_timed_out():
    """A gate that opens because nobody was looking is not a gate."""
    broker = _broker()
    request = _open(broker)
    decision, message = wait(broker, request, timeout=0.05)
    assert decision == "deny"
    assert "answered" in message and "no" in message
    assert broker.get(request.id) is None, "a resolved request must not leak"


def test_a_second_answer_cannot_overturn_the_first():
    """Two taps on a card must not turn a deny into an allow."""
    broker = _broker()
    request = _open(broker)
    assert broker.answer(request.id, allow=False, reason="no") is True
    assert broker.answer(request.id, allow=True) is False
    assert wait(broker, request)[0] == "deny"


def test_answering_something_that_does_not_exist_says_so():
    assert _broker().answer("nope", allow=True) is False


def test_cancelling_a_session_denies_everything_it_had_pending():
    """A card for a conversation that has ended is a question with no asker."""
    broker = _broker()
    mine = [_open(broker, session_id=1), _open(broker, session_id=1)]
    theirs = _open(broker, session_id=2)

    assert broker.cancel_session(1) == 2
    for request in mine:
        assert wait(broker, request)[0] == "deny"
    assert broker.get(theirs.id) is not None, "another session's card was answered"


def test_pending_is_scoped_to_its_session():
    broker = _broker()
    _open(broker, session_id=1)
    _open(broker, session_id=2)
    assert len(broker.pending_for(1)) == 1
    assert len(broker.pending_for(2)) == 1
    assert broker.pending_for(3) == []


def test_the_card_the_panel_sees_is_the_call_that_would_run():
    """A gate that showed one thing and ran another would be worse than none."""
    broker = _broker()
    request = broker.open(session_id=1, tool_name="mcp__resmon__update_settings",
                          tool_input={"group": "ai", "settings": {"ai_effort": "low"}},
                          tool_use_id="t")
    event = request.to_event()
    assert event["type"] == "permission_request"
    assert event["tool_name"] == "mcp__resmon__update_settings"
    assert event["input"] == {"group": "ai", "settings": {"ai_effort": "low"}}
    assert event["request_id"] == request.id
