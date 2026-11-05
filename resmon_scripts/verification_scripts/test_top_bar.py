"""The top bar's arrangement, kept by the engine.

Three claims. **A choice survives**: what a PUT stores is what the next GET
answers, as with the theme. **An order is always whole**: a section an older
build's stored order lacks comes back after the section it follows by default,
shown, so a section a newer build adds is never lost. **Only what the
interface can draw is kept**: an unknown or repeated section, or a page the
window has no address for, is refused, and a stored value the engine did not
write reads as the default rather than reaching the interface.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient      # noqa: E402

import mcp_server as mcp                        # noqa: E402
import resmon as resmon_mod                     # noqa: E402
from implementation_scripts.database import set_setting  # noqa: E402

DEFAULT_ORDER = ["today", "watches", "search", "runs", "library", "ask", "health"]
DEFAULT = {"order": DEFAULT_ORDER, "hidden": [], "start": "/today", "lockup": None}


@pytest.fixture
def client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    return TestClient(resmon_mod.app)


def _get(client: TestClient) -> dict:
    response = client.get("/api/top-bar")
    assert response.status_code == 200, response.text
    return response.json()


def _put(client: TestClient, body: dict) -> dict:
    response = client.put("/api/top-bar", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _store(key: str, value: str) -> None:
    conn = resmon_mod._get_db()
    try:
        set_setting(conn, key, value)
    finally:
        resmon_mod._close_db(conn)


def test_a_fresh_install_shows_every_section_in_the_default_order_and_opens_on_today(client):
    assert _get(client) == DEFAULT


def test_what_a_put_stores_is_what_the_next_get_answers(client):
    arranged = {
        "order": ["search", "today", "library", "runs", "watches", "health", "ask"],
        "hidden": ["health", "watches"],
        "start": "/search/saved",
        "lockup": "/library",
    }
    answered = _put(client, arranged)
    # Hidden is answered in the bar's order, whatever order it was sent in.
    assert answered == {**arranged, "hidden": ["watches", "health"]}
    assert _get(client) == answered


def test_every_section_can_be_hidden_and_the_lockup_can_follow_the_start_page(client):
    every = {"order": DEFAULT_ORDER, "hidden": list(DEFAULT_ORDER), "start": "/health/watchdog", "lockup": None}
    assert _put(client, every) == every
    assert _get(client) == every


def test_a_section_a_put_leaves_out_goes_back_after_the_one_it_follows_by_default(client):
    answered = _put(client, {"order": ["health", "ask", "today", "watches", "search", "library"],
                             "hidden": [], "start": "/today", "lockup": None})
    assert answered["order"] == ["health", "ask", "today", "watches", "search", "runs", "library"]
    # An empty order is the default one.
    assert _put(client, {"order": [], "hidden": [], "start": "/today", "lockup": None}) == DEFAULT


def test_an_order_an_older_build_stored_gets_a_newer_section_back_shown(client):
    """The stored order of a build that had no Runs tab, read by one that does."""
    _get(client)  # creates the database
    _store(resmon_mod._TOP_BAR_ORDER_KEY, json.dumps(["ask", "today", "watches", "search", "library", "health"]))
    _store(resmon_mod._TOP_BAR_HIDDEN_KEY, json.dumps(["health"]))
    assert _get(client) == {
        "order": ["ask", "today", "watches", "search", "runs", "library", "health"],
        "hidden": ["health"],
        "start": "/today",
        "lockup": None,
    }


def test_missing_sections_come_back_in_default_order_even_with_no_neighbor_left(client):
    _get(client)
    _store(resmon_mod._TOP_BAR_ORDER_KEY, json.dumps(["health", "ask", "library"]))
    assert _get(client)["order"] == ["today", "watches", "search", "runs", "health", "ask", "library"]


@pytest.mark.parametrize("body", [
    {"order": ["today", "dashboard"], "hidden": [], "start": "/today", "lockup": None},
    {"order": ["today", "today"], "hidden": [], "start": "/today", "lockup": None},
    {"order": [], "hidden": ["ask", "ask"], "start": "/today", "lockup": None},
    {"order": [], "hidden": ["settings"], "start": "/today", "lockup": None},
    {"order": [], "hidden": [], "start": "/settings", "lockup": None},
    {"order": [], "hidden": [], "start": "/runs/12", "lockup": None},
    {"order": [], "hidden": [], "start": "/watches/new", "lockup": None},
    {"order": [], "hidden": [], "start": "today", "lockup": None},
    {"order": [], "hidden": [], "start": "/today", "lockup": "/nowhere"},
    {"order": [], "hidden": [], "start": "/today"},
    {"order": [], "hidden": [], "lockup": None},
    {"hidden": [], "start": "/today", "lockup": None},
    {"order": [], "start": "/today", "lockup": None},
    {"order": "today", "hidden": [], "start": "/today", "lockup": None},
])
def test_what_the_interface_could_not_draw_is_refused_and_nothing_is_stored(client, body):
    kept = {"order": DEFAULT_ORDER[::-1], "hidden": ["ask"], "start": "/search", "lockup": "/runs"}
    _put(client, kept)
    response = client.put("/api/top-bar", json=body)
    assert response.status_code == 422, response.text
    assert _get(client) == kept


@pytest.mark.parametrize("order, hidden, start, lockup", [
    ("not json", "{", "", ""),
    ('{"today": 1}', '"ask"', "/settings", "/papers/3"),
    ('["dashboard", 7, "today", "today"]', '["dashboard", null]', "today", "/today/"),
])
def test_a_stored_value_the_engine_did_not_write_reads_as_the_default(client, order, hidden, start, lockup):
    _get(client)
    _store(resmon_mod._TOP_BAR_ORDER_KEY, order)
    _store(resmon_mod._TOP_BAR_HIDDEN_KEY, hidden)
    _store(resmon_mod._TOP_BAR_START_KEY, start)
    _store(resmon_mod._TOP_BAR_LOCKUP_KEY, lockup)
    assert _get(client) == DEFAULT


def test_reset_settings_puts_the_default_bar_back(client):
    _put(client, {"order": DEFAULT_ORDER[::-1], "hidden": ["today"], "start": "/ask", "lockup": "/health"})
    response = client.post("/api/admin/reset-settings", json={"confirm": "CONFIRM"})
    assert response.status_code == 200, response.text
    assert _get(client) == DEFAULT


def test_the_assistant_has_no_path_to_the_top_bar():
    """Not a settings group, so ``update_settings`` cannot name it."""
    keys = {resmon_mod._TOP_BAR_ORDER_KEY, resmon_mod._TOP_BAR_HIDDEN_KEY,
            resmon_mod._TOP_BAR_START_KEY, resmon_mod._TOP_BAR_LOCKUP_KEY}
    for group, group_keys in resmon_mod._SETTINGS_GROUPS.items():
        assert not keys & set(group_keys), group
    assert "top_bar" not in mcp.SETTINGS_GROUPS
    result = mcp.call_tool(
        "update_settings", {"group": "top_bar", "settings": {"ui_start_page": "/ask"}})
    assert result["isError"]
