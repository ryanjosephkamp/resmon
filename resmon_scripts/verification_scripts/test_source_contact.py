"""The contact address resmon gives Crossref and OpenAlex: only one the person set, and only to them.

Both were sent ``resmon@example.com``, a placeholder that named nobody, by
every copy of resmon. These tests pin that nothing is sent until an address is
set in Settings › Sources, that a set address goes to those two sources and no
other, and that the placeholder is gone from the engine.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import resmon as resmon_mod
from implementation_scripts import api_crossref, api_openalex, lifecycle, source_contact
from implementation_scripts.database import get_connection, init_db, set_setting

SCRIPTS = Path(__file__).resolve().parent.parent


class _Answer:
    status_code = 200
    headers: dict = {}

    def __init__(self, body: dict) -> None:
        self._body = body
        self.content = b"{}"
        self.text = "{}"

    def json(self) -> dict:
        return self._body


def _capture(monkeypatch: pytest.MonkeyPatch, module, body: dict) -> list[dict]:
    sent: list[dict] = []

    def safe_request(method, url, **kwargs):
        sent.append(kwargs)
        return _Answer(body)

    monkeypatch.setattr(module, "safe_request", safe_request)
    return sent


@pytest.fixture
def conn(tmp_path: Path):
    db = tmp_path / "resmon.db"
    init_db(str(db))
    connection = get_connection(str(db))
    yield connection
    connection.close()


def test_an_address_is_trimmed_and_checked_and_an_empty_one_is_none() -> None:
    assert source_contact.normalized("  ada@example.org ") == "ada@example.org"
    assert source_contact.normalized("") is None and source_contact.normalized(None) is None
    for bad in ("ada", "ada@", "ada @example.org", "@example.org", "a@b", "<a@b.c>"):
        with pytest.raises(ValueError):
            source_contact.normalized(bad)


def test_nothing_is_sent_until_an_address_is_set(conn) -> None:
    assert source_contact.read(conn) is None
    assert source_contact.client_options("crossref", conn) == {}
    set_setting(conn, source_contact.SETTING, "ada@example.org")
    assert source_contact.client_options("crossref", conn) == {"mailto": "ada@example.org"}
    assert source_contact.client_options("openalex", conn) == {"mailto": "ada@example.org"}
    # No other source is given it.
    assert source_contact.client_options("arxiv", conn) == {}
    assert source_contact.client_options("pubmed", conn) == {}


def test_an_address_stored_by_hand_that_is_not_one_is_not_sent(conn) -> None:
    set_setting(conn, source_contact.SETTING, "not an address")
    assert source_contact.client_options("crossref", conn) == {}


@pytest.mark.parametrize("module,client,body", [
    (api_crossref, api_crossref.CrossrefClient, {"message": {"items": []}}),
    (api_openalex, api_openalex.OpenAlexClient, {"results": [], "meta": {"count": 0}}),
])
def test_a_search_sends_the_address_only_when_it_has_one(monkeypatch, module, client, body) -> None:
    sent = _capture(monkeypatch, module, body)
    client().search("graphene", max_results=5)
    assert "mailto" not in sent[0]["params"]
    client(mailto="ada@example.org").search("graphene", max_results=5)
    assert sent[1]["params"]["mailto"] == "ada@example.org"


def test_the_lifecycle_check_sends_the_address_only_when_it_has_one(monkeypatch) -> None:
    sent = _capture(monkeypatch, lifecycle, {"message": {"items": []}})
    lifecycle.CrossrefLifecycleProvider().fetch(["10.1/a"])
    assert "mailto" not in sent[0]["params"] and "headers" not in sent[0]
    lifecycle.CrossrefLifecycleProvider(mailto="ada@example.org").fetch(["10.1/a"])
    assert sent[1]["params"]["mailto"] == "ada@example.org"
    assert sent[1]["headers"] == {"User-Agent": "resmon (mailto:ada@example.org)"}


def test_settings_sets_reads_refuses_and_clears_the_address() -> None:
    from fastapi.testclient import TestClient

    client = TestClient(resmon_mod.create_app())
    assert client.put("/api/settings/sources", json={"contact_email": None}).status_code == 200
    assert client.get("/api/settings/sources").json() == {"contact_email": None, "sent_to": ["crossref", "openalex"]}
    saved = client.put("/api/settings/sources", json={"contact_email": " ada@example.org "})
    assert saved.status_code == 200 and saved.json()["contact_email"] == "ada@example.org"
    refused = client.put("/api/settings/sources", json={"contact_email": "ada at example"})
    assert refused.status_code == 422 and "not an email address" in refused.text
    assert client.get("/api/settings/sources").json()["contact_email"] == "ada@example.org"
    assert client.put("/api/settings/sources", json={"contact_email": ""}).json()["contact_email"] is None


def test_the_placeholder_address_is_gone_from_the_engine() -> None:
    for path in (SCRIPTS / "implementation_scripts").glob("*.py"):
        assert "resmon@example.com" not in path.read_text(encoding="utf-8"), path.name
