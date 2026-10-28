"""The theme and the accent color, kept by the engine.

Two claims. **A choice survives**: what a PUT stores is what the next GET
answers, which is the whole reason this lives in the engine rather than in the
renderer's localStorage (whose origin moves with the renderer's port on every
launch). **Nothing else can reach it**: it is not a settings group, so
``update_settings`` has no path to it, and a value the engine did not write
reads as unset instead of reaching the interface.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient      # noqa: E402

import mcp_server as mcp                        # noqa: E402
import resmon as resmon_mod                     # noqa: E402
from implementation_scripts.database import set_setting  # noqa: E402


@pytest.fixture
def client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    return TestClient(resmon_mod.app)


def _get(client: TestClient) -> dict:
    response = client.get("/api/appearance")
    assert response.status_code == 200, response.text
    return response.json()


def test_a_fresh_install_follows_the_system_and_has_no_accent(client):
    assert _get(client) == {"theme": "system", "accent": None}


@pytest.mark.parametrize("theme", ["system", "light", "dark"])
def test_what_a_put_stores_is_what_the_next_get_answers(client, theme):
    sent = {"theme": theme, "accent": "#3d8aff"}
    response = client.put("/api/appearance", json=sent)
    assert response.status_code == 200, response.text
    assert response.json() == sent
    assert _get(client) == sent


def test_the_accent_is_stored_lowercase_and_the_put_says_so(client):
    response = client.put("/api/appearance", json={"theme": "dark", "accent": "#FF8A3D"})
    assert response.json() == {"theme": "dark", "accent": "#ff8a3d"}
    assert _get(client)["accent"] == "#ff8a3d"


def test_a_null_accent_goes_back_to_the_interfaces_default(client):
    client.put("/api/appearance", json={"theme": "light", "accent": "#123456"})
    response = client.put("/api/appearance", json={"theme": "light", "accent": None})
    assert response.json() == {"theme": "light", "accent": None}
    assert _get(client) == {"theme": "light", "accent": None}


@pytest.mark.parametrize("body", [
    {"theme": "sepia", "accent": None},
    {"theme": "dark", "accent": "orange"},
    {"theme": "dark", "accent": "#ff8a3"},
    {"theme": "dark", "accent": "#ff8a3d00"},
    {"theme": "dark", "accent": "ff8a3d"},
    {"theme": "dark"},
    {"accent": "#ff8a3d"},
])
def test_a_value_the_interface_could_not_draw_is_refused_and_nothing_is_stored(client, body):
    client.put("/api/appearance", json={"theme": "light", "accent": "#123456"})
    response = client.put("/api/appearance", json=body)
    assert response.status_code == 422, response.text
    assert _get(client) == {"theme": "light", "accent": "#123456"}


@pytest.mark.parametrize("stored_theme, stored_accent", [
    ("sepia", "#12345"),
    ("", "rgb(1,2,3)"),
    ("DARK", "#GGGGGG"),
])
def test_a_stored_value_the_engine_did_not_write_reads_as_unset(client, stored_theme, stored_accent):
    _get(client)  # creates the database
    conn = resmon_mod._get_db()
    try:
        set_setting(conn, resmon_mod._APPEARANCE_THEME_KEY, stored_theme)
        set_setting(conn, resmon_mod._APPEARANCE_ACCENT_KEY, stored_accent)
    finally:
        resmon_mod._close_db(conn)
    assert _get(client) == {"theme": "system", "accent": None}


def test_reset_settings_clears_the_appearance_with_everything_else(client):
    client.put("/api/appearance", json={"theme": "dark", "accent": "#3d8aff"})
    response = client.post("/api/admin/reset-settings", json={"confirm": "CONFIRM"})
    assert response.status_code == 200, response.text
    assert _get(client) == {"theme": "system", "accent": None}


def test_the_assistant_has_no_path_to_the_appearance():
    """Not a settings group, so ``update_settings`` cannot name it."""
    keys = {resmon_mod._APPEARANCE_THEME_KEY, resmon_mod._APPEARANCE_ACCENT_KEY}
    for group, group_keys in resmon_mod._SETTINGS_GROUPS.items():
        assert not keys & set(group_keys), group
    assert "appearance" not in mcp.SETTINGS_GROUPS
    result = mcp.call_tool(
        "update_settings", {"group": "appearance", "settings": {"ui_theme": "dark"}})
    assert result["isError"]
