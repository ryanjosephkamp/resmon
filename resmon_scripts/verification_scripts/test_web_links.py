"""Where a web link opens, and what the link window's address field searches with.

Kept by the engine for the appearance's reason (the renderer's storage moves
with its port on every launch). Three claims: a fresh install opens links in
resmon's browser, in a window, and searches with DuckDuckGo; what a PUT stores
is what the next GET answers; and a value the engine did not write reads as
the default rather than reaching the main process.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import get_args

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient      # noqa: E402

import resmon as resmon_mod                     # noqa: E402
from implementation_scripts import response_models  # noqa: E402
from implementation_scripts.database import set_setting  # noqa: E402

DEFAULT = {"open_in": "resmon", "new": "window", "search": "duckduckgo"}


@pytest.fixture
def client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    return TestClient(resmon_mod.app)


def _get(client: TestClient) -> dict:
    response = client.get("/api/web-links")
    assert response.status_code == 200, response.text
    return response.json()


def test_a_fresh_install_opens_links_in_resmon_in_a_window_and_searches_duckduckgo(client):
    assert _get(client) == DEFAULT


@pytest.mark.parametrize("search", get_args(response_models.WebLinkSearch))
def test_what_a_put_stores_is_what_the_next_get_answers(client, search):
    sent = {"open_in": "browser", "new": "tab", "search": search}
    response = client.put("/api/web-links", json=sent)
    assert response.status_code == 200, response.text
    assert response.json() == sent
    assert _get(client) == sent


@pytest.mark.parametrize("body", [
    {"open_in": "chrome", "new": "window", "search": "google"},
    {"open_in": "resmon", "new": "pane", "search": "google"},
    {"open_in": "resmon", "new": "window", "search": "askjeeves"},
    {"open_in": "resmon", "new": "window"},
])
def test_a_choice_the_engine_does_not_offer_is_refused_and_nothing_changes(client, body):
    response = client.put("/api/web-links", json=body)
    assert response.status_code == 422
    assert _get(client) == DEFAULT


def test_a_stored_value_the_engine_did_not_write_reads_as_the_default(client):
    conn = resmon_mod._get_db()
    try:
        set_setting(conn, "ui_links_open_in", "netscape")
        set_setting(conn, "ui_links_new", "popup")
        set_setting(conn, "ui_links_search", "altavista")
    finally:
        resmon_mod._close_db(conn)
    assert _get(client) == DEFAULT
