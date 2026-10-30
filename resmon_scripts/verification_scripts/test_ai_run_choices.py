"""What a run summarizes with: the stored lanes, or the ones a run or a watch chose.

A run's ``ai_settings`` (a search's own choices, or a watch's) is merged over
what Settings › AI stores. Once a chain was stored, an override that named a
provider changed nothing: ``resolve_chain`` prefers a chain to the single
provider keys, so the stored lanes ran and the provider the run asked for was
ignored, with nothing on the run to say so. These tests drive the merge, a
real run against an OpenAI-compatible provider on loopback, and the record a
run now keeps of what it was set to do: its ``ai_choice`` event and the lanes
``GET /api/executions/{id}`` reports.

The same loopback provider answers the key test, which can now test the key
already stored for a provider rather than only one typed in.
"""

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient  # noqa: E402

import resmon as resmon_mod  # noqa: E402
from implementation_scripts.ai_lanes import resolve_chain  # noqa: E402
from implementation_scripts.api_base import NormalizedResult  # noqa: E402

STORED_CHAIN = json.dumps([
    {"kind": "api_key", "provider": "openai", "model": "gpt-4o-mini"},
    {"kind": "local", "provider": "local", "model": "llama3", "endpoint": "http://127.0.0.1:9"},
])
STORED = {"ai_provider": "openai", "ai_model": "gpt-4o-mini", "ai_chain": STORED_CHAIN,
          "ai_cli_path": "/opt/claude", "ai_effort": "high"}


def _lanes(persisted: dict, override: dict) -> list:
    merged = resmon_mod._merge_ai_override(persisted, resmon_mod._normalize_ai_override(override))
    return resolve_chain(merged)


# ---------------------------------------------------------------------------
# The merge
# ---------------------------------------------------------------------------

def test_an_override_naming_a_provider_is_the_one_lane_a_run_uses():
    lanes = _lanes(STORED, {"provider": "anthropic", "model": "claude-haiku"})
    assert [(lane.kind, lane.provider, lane.model) for lane in lanes] == [("api_key", "anthropic", "claude-haiku")]


def test_an_override_for_another_provider_does_not_inherit_the_stored_model():
    lanes = _lanes(STORED, {"provider": "anthropic"})
    assert len(lanes) == 1
    assert lanes[0].provider == "anthropic"
    # Left without a model, the lane is skipped with that reason when it runs,
    # rather than sending OpenAI's model name to Anthropic.
    assert lanes[0].model is None


def test_an_override_for_the_stored_provider_keeps_its_stored_model():
    lanes = _lanes({"ai_provider": "openai", "ai_model": "gpt-4o-mini", "ai_chain": STORED_CHAIN}, {"provider": "openai"})
    assert [(lane.provider, lane.model) for lane in lanes] == [("openai", "gpt-4o-mini")]


def test_a_command_override_does_not_borrow_another_commands_path():
    stored = {"ai_provider": "claude_code", "ai_cli_path": "/opt/claude", "ai_effort": "high"}
    lanes = _lanes(stored, {"provider": "codex", "model": "gpt-5"})
    assert lanes[0].provider == "codex"
    assert lanes[0].binary_path is None
    assert lanes[0].effort is None


def test_an_ollama_override_runs_the_model_it_names():
    lanes = _lanes({**STORED, "ai_local_model": "old-model"}, {"provider": "local", "model": "qwen3"})
    assert [(lane.kind, lane.model) for lane in lanes] == [("local", "qwen3")]


def test_an_override_chain_is_the_chain():
    chain = json.dumps([{"kind": "api_key", "provider": "custom", "model": "m", "base_url": "http://127.0.0.1:1/v1"}])
    lanes = _lanes(STORED, {"provider": "custom", "model": "m", "chain": chain})
    assert [(lane.provider, lane.base_url) for lane in lanes] == [("custom", "http://127.0.0.1:1/v1")]


def test_an_override_of_the_wording_alone_keeps_the_stored_lanes():
    lanes = _lanes(STORED, {"length": "brief", "tone": "neutral"})
    assert [lane.provider for lane in lanes] == ["openai", "local"]


# ---------------------------------------------------------------------------
# A real run, against a provider on loopback
# ---------------------------------------------------------------------------

class _Provider:
    """An OpenAI-compatible provider on loopback that records what it was sent."""

    def __init__(self, status: int = 200):
        self.calls: list[dict] = []
        self.status = status
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self, body: dict) -> None:
                outer.calls.append({
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "body": body,
                })
                payload = json.dumps({
                    "choices": [{"message": {"role": "assistant", "content": "An authored summary."}}],
                    "data": [{"id": "authored-model"}],
                }).encode()
                self.send_response(outer.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):  # noqa: N802 - the stdlib's name
                self._answer({})

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                self._answer(json.loads(self.rfile.read(length) or b"{}"))

            def log_message(self, *args):  # quiet
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def provider():
    endpoint = _Provider()
    yield endpoint
    endpoint.close()


@pytest.fixture
def client():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from resmon import app
    return TestClient(app)


def _mock_arxiv():
    source = MagicMock()
    source.get_name.return_value = "arxiv"
    source.search.return_value = [
        NormalizedResult(
            source_repository="arxiv", external_id=f"arxiv_choice_{n}", doi=None,
            title=f"An authored paper {n}", authors=["A. Author"],
            abstract="An abstract long enough to be worth summarizing.",
            publication_date="2026-10-01", url=f"https://example.com/{n}",
            categories=["cs.AI"],
        )
        for n in (1, 2)
    ]
    return source


def _settle(client, start, tmp_path) -> int:
    reports = tmp_path / "reports"
    reports.mkdir(exist_ok=True)
    with (
        patch("implementation_scripts.sweep_engine.get_client", return_value=_mock_arxiv()),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", reports),
    ):
        exec_id = start()
        for _ in range(120):
            run = client.get(f"/api/executions/{exec_id}").json()
            if run["status"] in ("completed", "failed", "cancelled"):
                break
            time.sleep(0.25)
    assert run["status"] == "completed", run
    return exec_id


def _dive(client, tmp_path, **body) -> int:
    def start() -> int:
        resp = client.post("/api/search/dive", json={
            "repository": "arxiv", "query": "graphs", "max_results": 2, **body,
        })
        assert resp.status_code == 200, resp.text
        return resp.json()["execution_id"]
    return _settle(client, start, tmp_path)


def _choice(client, exec_id) -> dict:
    events = client.get(f"/api/executions/{exec_id}/progress/events").json()
    choices = [e for e in events if e.get("type") == "ai_choice"]
    assert len(choices) == 1, events
    return choices[0]


def _store_custom(client, provider_url: str) -> None:
    assert client.put("/api/settings/ai", json={"settings": {
        "ai_provider": "openai", "ai_model": "gpt-4o-mini", "ai_chain": STORED_CHAIN,
        "ai_custom_base_url": provider_url,
    }}).status_code == 200
    assert client.put("/api/credentials/custom_llm_api_key", json={"value": "test-key-loopback"}).status_code == 200


def test_a_run_set_to_another_lane_summarizes_with_it_and_says_so(client, provider, tmp_path):
    _store_custom(client, provider.url)
    exec_id = _dive(client, tmp_path, ai_enabled=True, ai_settings={
        "provider": "custom", "model": "authored-model", "temperature": "0.7", "length": "brief",
    })

    completions = [c for c in provider.calls if c["path"].endswith("/chat/completions")]
    assert len(completions) == 2, provider.calls
    assert {c["body"]["model"] for c in completions} == {"authored-model"}
    assert {c["body"]["temperature"] for c in completions} == {0.7}
    assert {c["authorization"] for c in completions} == {"Bearer test-key-loopback"}

    run = client.get(f"/api/executions/{exec_id}").json()
    assert [(lane["provider"], lane["model"], lane["outcome"], lane["docs_succeeded"]) for lane in run["ai_lanes"]] \
        == [("custom", "authored-model", "ok", 2)]

    choice = _choice(client, exec_id)
    assert choice["enabled"] is True
    assert choice["lane_source"] == "run"
    assert [lane["label"] for lane in choice["lanes"]] == ["Custom endpoint · authored-model"]
    assert set(choice["adjusted"]) == {"temperature", "length"}
    assert choice["length"] == "brief"


def test_a_run_with_summaries_off_says_so_and_tried_no_lane(client, provider, tmp_path):
    _store_custom(client, provider.url)
    exec_id = _dive(client, tmp_path, ai_enabled=False)

    assert provider.calls == []
    assert client.get(f"/api/executions/{exec_id}").json()["ai_lanes"] == []
    choice = _choice(client, exec_id)
    assert choice["enabled"] is False
    assert choice["lanes"] == []
    assert choice["message"] == "AI summaries: off for this run."


def test_a_run_from_the_settings_names_the_stored_lanes(client, provider, tmp_path):
    _store_custom(client, provider.url)
    exec_id = _dive(client, tmp_path, ai_enabled=True)

    choice = _choice(client, exec_id)
    assert choice["lane_source"] == "settings"
    assert [lane["provider"] for lane in choice["lanes"]] == ["openai", "local"]
    # No OpenAI key is stored, and nothing answers on port 9: both lanes are
    # tried and recorded, and neither reached the loopback provider.
    lanes = client.get(f"/api/executions/{exec_id}").json()["ai_lanes"]
    assert [lane["provider"] for lane in lanes] == ["openai", "local"]
    assert all(lane["docs_succeeded"] == 0 for lane in lanes)
    assert provider.calls == []


def test_a_watch_set_to_its_own_lane_runs_with_it(client, provider, tmp_path):
    _store_custom(client, provider.url)
    made = client.post("/api/routines", json={
        "name": "Graphs", "schedule_cron": "0 8 * * *", "is_active": False,
        "parameters": {"repositories": ["arxiv"], "keywords": ["graphs"], "query": "graphs", "max_results": 2},
        "ai_enabled": True, "ai_settings": {"provider": "custom", "model": "authored-model"},
    })
    assert made.status_code == 201, made.text
    routine_id = made.json()["id"]

    def start() -> int:
        resp = client.post(f"/api/routines/{routine_id}/run")
        assert resp.status_code in (200, 202), resp.text
        return resp.json()["execution_id"]

    exec_id = _settle(client, start, tmp_path)
    assert {c["body"]["model"] for c in provider.calls if c["path"].endswith("/chat/completions")} == {"authored-model"}
    choice = _choice(client, exec_id)
    assert choice["lane_source"] == "run"
    assert [lane["provider"] for lane in client.get(f"/api/executions/{exec_id}").json()["ai_lanes"]] == ["custom"]


# ---------------------------------------------------------------------------
# Testing a key
# ---------------------------------------------------------------------------

def _save_endpoint(client, url: str) -> None:
    assert client.put("/api/settings/ai", json={"settings": {"ai_custom_base_url": url}}).status_code == 200


def test_the_stored_key_is_tested_without_being_sent_from_the_screen(client, provider):
    assert client.put("/api/credentials/custom_llm_api_key", json={"value": "test-key-loopback"}).status_code == 200
    _save_endpoint(client, provider.url)
    resp = client.post("/api/credentials/validate", json={"provider": "custom", "base_url": provider.url})
    assert resp.status_code == 200
    body = resp.json()
    assert body["valid"] is True
    assert body["outcome"] == "accepted"
    assert "test-key-loopback" not in json.dumps(body)
    assert provider.calls[-1]["path"] == "/v1/models"
    assert provider.calls[-1]["authorization"] == "Bearer test-key-loopback"


def test_a_refused_key_and_an_unreachable_provider_read_differently(client):
    refusing = _Provider(status=401)
    try:
        assert client.put("/api/credentials/custom_llm_api_key", json={"value": "test-key-loopback"}).status_code == 200
        _save_endpoint(client, refusing.url)
        refused = client.post("/api/credentials/validate", json={"provider": "custom", "base_url": refusing.url}).json()
    finally:
        refusing.close()
    assert (refused["valid"], refused["outcome"], refused["http_status"]) == (False, "refused", 401)

    _save_endpoint(client, "http://127.0.0.1:9/v1")
    unreachable = client.post("/api/credentials/validate", json={"provider": "custom", "base_url": "http://127.0.0.1:9/v1"}).json()
    assert (unreachable["valid"], unreachable["outcome"]) == (False, "unreachable")
    assert "could not reach" in unreachable["detail"]


def test_a_key_is_never_sent_in_plain_text_to_another_computer(client, provider):
    assert client.put("/api/credentials/custom_llm_api_key", json={"value": "test-key-loopback"}).status_code == 200
    before = len(provider.calls)
    resp = client.post("/api/credentials/validate",
                       json={"provider": "custom", "base_url": "http://models.example.org/v1"})
    assert resp.status_code == 400
    assert "must use HTTPS" in resp.json()["detail"]
    typed = client.post("/api/credentials/validate",
                        json={"provider": "custom", "key": "typed-key", "base_url": "http://models.example.org/v1"})
    assert typed.status_code == 400
    assert len(provider.calls) == before


def test_with_no_key_stored_there_is_nothing_to_test(client):
    client.delete("/api/credentials/anthropic_api_key")
    resp = client.post("/api/credentials/validate", json={"provider": "anthropic"})
    assert resp.status_code == 400
    assert "No key is stored" in resp.json()["detail"]


def test_a_source_key_is_tested_only_when_typed(client):
    resp = client.post("/api/credentials/validate", json={"provider": "core"})
    assert resp.status_code == 400
