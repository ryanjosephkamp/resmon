"""The contact address resmon gives Crossref, OpenAlex, and PubMed: only one the person set, and only to them.

These tests pin that nothing is sent until an address is set in Settings ›
Sources, that a set address goes to those three sources and no other, and that
the placeholder ``resmon@example.com``, which named nobody, is not in the engine.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import resmon as resmon_mod
from implementation_scripts import api_crossref, api_openalex, api_pubmed, lifecycle, source_contact
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
    assert source_contact.client_options("pubmed", conn) == {"mailto": "ada@example.org"}
    # No other source is given it.
    assert source_contact.client_options("arxiv", conn) == {}
    assert source_contact.client_options("europepmc", conn) == {}


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


def test_pubmed_names_resmon_always_and_sends_the_address_only_when_it_has_one(monkeypatch) -> None:
    """E-utilities' ``tool`` is always sent, its ``email`` only once the person set an address, to esearch and efetch alike."""
    monkeypatch.setattr(api_pubmed, "get_credential_for", lambda *a: None)
    sent = _capture(monkeypatch, api_pubmed, {"esearchresult": {"idlist": ["1"]}})
    api_pubmed.PubmedClient().search("graphene", max_results=5)
    api_pubmed.PubmedClient(mailto="ada@example.org").search("graphene", max_results=5)
    esearch = [s["params"] for s in sent if "term" in s["params"]]
    efetch = [s["params"] for s in sent if "id" in s["params"]]
    assert len(esearch) == 2 and len(efetch) == 2
    for params in (esearch[0], efetch[0]):
        assert params["tool"] == "resmon" and "email" not in params
    for params in (esearch[1], efetch[1]):
        assert params["tool"] == "resmon" and params["email"] == "ada@example.org"


def test_the_pubmed_address_is_not_written_into_the_run_record() -> None:
    described = api_pubmed.PubmedClient.describe_request(
        api_pubmed._ESEARCH_URL, {"term": "graphene", "tool": "resmon", "email": "ada@example.org"}, None)
    assert described is not None and "ada@example.org" not in described and "resmon" not in described


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
    assert client.get("/api/settings/sources").json() == {"contact_email": None, "sent_to": ["crossref", "openalex", "pubmed"]}
    saved = client.put("/api/settings/sources", json={"contact_email": " ada@example.org "})
    assert saved.status_code == 200 and saved.json()["contact_email"] == "ada@example.org"
    refused = client.put("/api/settings/sources", json={"contact_email": "ada at example"})
    assert refused.status_code == 422 and "not an email address" in refused.text
    assert client.get("/api/settings/sources").json()["contact_email"] == "ada@example.org"
    assert client.put("/api/settings/sources", json={"contact_email": ""}).json()["contact_email"] is None


def test_the_placeholder_address_is_gone_from_the_engine() -> None:
    for path in (SCRIPTS / "implementation_scripts").glob("*.py"):
        assert "resmon@example.com" not in path.read_text(encoding="utf-8"), path.name
