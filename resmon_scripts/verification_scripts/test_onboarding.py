"""The first-run card's facts — P15a and P15c.

What the card renders is decided here, not in the renderer, so this is where the
two claims live: **it shows only on a fresh install**, and **it never says a lane
works**.

The second is the one worth guarding. Every other surface in resmon that talks
about AI configuration has had to learn the same lesson: resmon cannot know
whether a CLI is signed in or a key is accepted without spending one, so
"found" and "configured" are the strongest true words, and a keyring that will
not answer is a third state rather than a "no".
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient      # noqa: E402

import resmon as resmon_mod                     # noqa: E402


@pytest.fixture
def client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    return TestClient(resmon_mod.app)


def _state(client: TestClient) -> dict:
    response = client.get("/api/onboarding")
    assert response.status_code == 200, response.text
    return response.json()


def test_a_fresh_install_is_shown_the_card(client):
    state = _state(client)
    assert state["show"] is True
    assert state["dismissed"] is False
    assert state["counts"] == {"documents": 0, "executions": 0, "routines": 0}


def test_every_step_carries_a_state_and_a_sentence(client):
    """Three steps, each with a `done` and a detail a person can read."""
    steps = _state(client)["steps"]
    assert [s["id"] for s in steps] == ["agent_cli", "ai_key", "repository_key"]
    for step in steps:
        assert step["done"] in (True, False, None)
        assert step["detail"].strip()


def test_no_step_claims_anything_works(client):
    """P15c. `found` and `configured`, never `ready`, `working` or `connected`.

    An assertion on the words rather than on the shape, because the failure this
    guards is a sentence someone writes later that sounds more helpful.
    """
    forbidden = ("ready", "working", "connected", "verified", "valid",
                 "signed in", "logged in", "you can now")
    for step in _state(client)["steps"]:
        lowered = step["detail"].lower()
        assert not any(word in lowered for word in forbidden), (
            f"{step['id']} claims more than resmon checked: {step['detail']!r}")


def test_running_anything_at_all_retires_the_card(client):
    """History, not configuration, is what makes a run no longer the first.

    Asserted one column at a time: any of the three ending the card is the
    claim, and a check that only ever seeded documents would pass while the
    other two did nothing.
    """
    conn = resmon_mod._get_db()
    try:
        for table, insert in (
            ("routines",
             "INSERT INTO routines (name, schedule_cron, parameters) "
             "VALUES ('r', '0 9 * * 1', '{}')"),
            ("executions",
             "INSERT INTO executions "
             "(execution_type, status, parameters, start_time) "
             "VALUES ('deep_sweep', 'completed', '{}', datetime('now'))"),
        ):
            assert _state(client)["show"] is True, f"already hidden before {table}"
            conn.execute(insert)
            conn.commit()
            assert _state(client)["show"] is False, (
                f"a row in {table} did not retire the card")
            conn.execute(f"DELETE FROM {table}")
            conn.commit()
    finally:
        resmon_mod._close_db(conn)

    assert _state(client)["show"] is True, "the card came back wrongly"


def test_dismissing_it_is_permanent_and_survives_the_endpoint_being_asked_again(client):
    assert client.post("/api/onboarding/dismiss").json() == {"dismissed": True}
    state = _state(client)
    assert state["dismissed"] is True
    assert state["show"] is False


def test_dismissal_is_not_a_settings_group_the_assistant_can_reach():
    """The assistant must not be able to put away the user's own card.

    ``update_settings`` reaches settings *groups*; this key is deliberately not
    in one, so there is no path to it rather than a rule saying not to.
    ``test_no_settings_group_the_app_has_is_silently_reachable`` makes the
    opposite mistake visible too: a group added here would have to be decided.
    """
    import mcp_server                            # noqa: PLC0415

    for group in resmon_mod._SETTINGS_GROUPS.values():
        assert resmon_mod._ONBOARDING_DISMISSED_KEY not in group
    for group in mcp_server.SETTINGS_GROUPS:
        keys = resmon_mod._SETTINGS_GROUPS.get(group, [])
        assert resmon_mod._ONBOARDING_DISMISSED_KEY not in keys


def test_an_unreadable_keyring_is_not_reported_as_a_missing_key(client, monkeypatch):
    """`done: null` is a third state, and it exists for a real failure.

    An unsigned macOS build is denied the keychain items an earlier build
    stored. Reporting that as "no key" tells someone to add a key they already
    have — and the credentials endpoint learned the same lesson in 1.9.
    """
    monkeypatch.setattr(resmon_mod, "probe_credential", lambda _name: "absent")
    monkeypatch.setattr(resmon_mod, "keyring_is_responsive", lambda: False)
    by_id = {s["id"]: s for s in _state(client)["steps"]}
    assert by_id["ai_key"]["done"] is None
    assert by_id["repository_key"]["done"] is None
    # The CLI step does not read the keyring at all, so it still answers.
    assert by_id["agent_cli"]["done"] in (True, False)


def test_a_present_key_is_reported_as_present(client, monkeypatch):
    monkeypatch.setattr(resmon_mod, "probe_credential",
                        lambda name: "present" if name == "openai_api_key" else "absent")
    by_id = {s["id"]: s for s in _state(client)["steps"]}
    assert by_id["ai_key"]["done"] is True
    assert by_id["repository_key"]["done"] is False
