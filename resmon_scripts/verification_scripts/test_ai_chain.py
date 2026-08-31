# resmon_scripts/verification_scripts/test_ai_chain.py
"""Fallback chain execution (1.8b).

The test that matters most in this file is
``test_a_document_local_failure_does_not_cost_the_lane``. Everything else here
is bookkeeping; that one pins the distinction the whole feature is built on,
and getting it wrong in either direction is expensive:

* treat a context-window error as lane-fatal and one long abstract silently
  downgrades every summary after it,
* treat a rejected key as document-local and the run re-presents a dead
  credential once per paper.
"""

import sqlite3
import sys
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.ai_chain import ChainRunner  # noqa: E402
from implementation_scripts.ai_errors import classify_exception  # noqa: E402
from implementation_scripts.ai_lanes import AILane  # noqa: E402
from implementation_scripts.database import (  # noqa: E402
    get_execution_ai,
    init_db,
    insert_execution,
)


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

@pytest.fixture()
def conn(tmp_path):
    database = sqlite3.connect(str(tmp_path / "t.db"))
    database.row_factory = sqlite3.Row
    init_db(conn=database)
    yield database
    database.close()


@pytest.fixture()
def exec_id(conn):
    return insert_execution(conn, {
        "execution_type": "deep_sweep",
        "parameters": '{"query": "x"}',
        "start_time": "2026-08-30T00:00:00Z",
        "status": "running",
    })


def _http_error(status: int, body: str = "") -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://provider.example/v1/chat")
    response = httpx.Response(status, text=body, request=request)
    return httpx.HTTPStatusError("boom", request=request, response=response)


AUTH = lambda: classify_exception(_http_error(401))          # noqa: E731 — lane-fatal
CONTEXT = lambda: classify_exception(                        # noqa: E731 — document-local
    _http_error(400, "context_length_exceeded"))


class FakeClient:
    """Returns each scripted item in turn: a string, or an exception to raise."""

    def __init__(self, provider, model, script):
        self.provider = provider
        self.model = model
        self._script = list(script)
        self.calls = 0

    def summarize(self, text, prompt_params=None):
        self.calls += 1
        item = self._script.pop(0) if self._script else "fallback summary"
        if isinstance(item, BaseException):
            raise item
        return item


def _lane(provider, model="m", kind="api_key", alias=None):
    return AILane(kind=kind, provider=provider, model=model, credential_alias=alias)


def _runner(conn, exec_id, lanes, clients, monkeypatch, primary=None):
    """A ChainRunner whose lane clients come from *clients*, keyed by provider."""
    import implementation_scripts.llm_factory as factory

    monkeypatch.setattr(
        factory, "build_client_for_lane",
        lambda lane, ephemeral=None: clients.get(lane.provider),
    )
    return ChainRunner(
        lanes, db=conn, exec_id=exec_id,
        prompt_params={"_show_audit_prefix": False},
        primary_client=primary,
    )


# ---------------------------------------------------------------------------
# The distinction the feature exists for
# ---------------------------------------------------------------------------

def test_a_document_local_failure_does_not_cost_the_lane(conn, exec_id, monkeypatch):
    """Lane 1 chokes on one abstract. It must still handle the next one.

    If this regresses, a single over-long abstract quietly demotes the user's
    best provider for the rest of the run and every later summary comes from
    the fallback — with nothing on screen saying so.
    """
    primary = FakeClient("anthropic", "claude", [CONTEXT(), "primary again"])
    backup = FakeClient("local", "llama3", ["backup handled it"])
    runner = _runner(
        conn, exec_id,
        [_lane("anthropic"), _lane("local", kind="local")],
        {"anthropic": primary, "local": backup}, monkeypatch,
    )

    first, err1 = runner.summarize_document("doc one")
    second, err2 = runner.summarize_document("doc two")
    runner.finish()

    assert (first, err1) == ("backup handled it", None)
    assert (second, err2) == ("primary again", None), "the lane was wrongly demoted"

    rows = {r["provider"]: r for r in get_execution_ai(conn, exec_id)}
    assert rows["anthropic"]["docs_attempted"] == 2
    assert rows["anthropic"]["docs_succeeded"] == 1
    assert rows["anthropic"]["outcome"] == "partial"
    assert rows["local"]["docs_succeeded"] == 1


def test_a_lane_fatal_failure_demotes_for_the_whole_run(conn, exec_id, monkeypatch):
    """A rejected key is presented once, not once per paper."""
    primary = FakeClient("anthropic", "claude", [AUTH(), AUTH(), AUTH()])
    backup = FakeClient("local", "llama3", ["b1", "b2", "b3"])
    runner = _runner(
        conn, exec_id,
        [_lane("anthropic", alias="anthropic_api_key"), _lane("local", kind="local")],
        {"anthropic": primary, "local": backup}, monkeypatch,
    )

    for text in ("one", "two", "three"):
        summary, err = runner.summarize_document(text)
        assert err is None and summary.startswith("b")
    runner.finish()

    assert primary.calls == 1, "a demoted lane was retried"
    rows = {r["provider"]: r for r in get_execution_ai(conn, exec_id)}
    assert rows["anthropic"]["outcome"] == "failed"
    assert rows["anthropic"]["docs_attempted"] == 1
    assert rows["anthropic"]["error_kind"] == "auth"
    assert rows["anthropic"]["credential_alias"] == "anthropic_api_key"
    assert rows["local"]["docs_succeeded"] == 3


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------

def test_a_lane_never_reached_is_recorded_as_skipped(conn, exec_id, monkeypatch):
    """"Not needed" and "not configured" are different facts; store both."""
    primary = FakeClient("anthropic", "claude", ["fine", "fine"])
    backup = FakeClient("local", "llama3", [])
    runner = _runner(
        conn, exec_id,
        [_lane("anthropic"), _lane("local", kind="local")],
        {"anthropic": primary, "local": backup}, monkeypatch,
    )
    runner.summarize_document("one")
    runner.finish()

    rows = get_execution_ai(conn, exec_id)
    assert len(rows) == 2, "an unreached lane was omitted rather than recorded"
    assert rows[1]["outcome"] == "skipped"
    assert rows[1]["docs_attempted"] == 0
    assert backup.calls == 0


def test_an_unbuildable_lane_records_why(conn, exec_id, monkeypatch):
    """A lane with no key says so, by name, without reading the key."""
    runner = _runner(
        conn, exec_id,
        [_lane("openai", alias="openai_api_key"), _lane("local", kind="local")],
        {"openai": None, "local": FakeClient("local", "llama3", ["ok"])},
        monkeypatch,
    )
    summary, err = runner.summarize_document("one")
    runner.finish()

    assert summary == "ok" and err is None
    row = get_execution_ai(conn, exec_id)[0]
    assert row["outcome"] == "skipped"
    assert "openai_api_key" in (row["safe_message"] or "")


def test_lanes_are_recorded_in_configured_order(conn, exec_id, monkeypatch):
    lanes = [_lane("anthropic"), _lane("openai"), _lane("local", kind="local")]
    clients = {p: FakeClient(p, "m", ["s"]) for p in ("anthropic", "openai", "local")}
    runner = _runner(conn, exec_id, lanes, clients, monkeypatch)
    runner.summarize_document("one")
    runner.finish()

    rows = get_execution_ai(conn, exec_id)
    assert [r["lane_index"] for r in rows] == [0, 1, 2]
    assert [r["provider"] for r in rows] == ["anthropic", "openai", "local"]


def test_finish_is_idempotent(conn, exec_id, monkeypatch):
    runner = _runner(conn, exec_id, [_lane("anthropic")],
                     {"anthropic": FakeClient("anthropic", "m", ["s"])}, monkeypatch)
    runner.summarize_document("one")
    runner.finish()
    runner.finish()
    assert len(get_execution_ai(conn, exec_id)) == 1


# ---------------------------------------------------------------------------
# When everything fails
# ---------------------------------------------------------------------------

def test_every_lane_failing_returns_no_summary_and_says_why(conn, exec_id, monkeypatch):
    """There is no summariser of last resort, and the rows must not imply one."""
    runner = _runner(
        conn, exec_id,
        [_lane("anthropic", alias="anthropic_api_key"), _lane("openai")],
        {
            "anthropic": FakeClient("anthropic", "m", [AUTH()]),
            "openai": FakeClient("openai", "m", [CONTEXT()]),
        },
        monkeypatch,
    )
    summary, err = runner.summarize_document("one")
    runner.finish()

    assert summary == ""
    assert err is not None and err.kind.value == "context"
    outcomes = {r["provider"]: r["outcome"] for r in get_execution_ai(conn, exec_id)}
    assert outcomes == {"anthropic": "failed", "openai": "failed"}


def test_an_empty_completion_is_not_treated_as_success(conn, exec_id, monkeypatch):
    """A provider returning "" has not summarised anything."""
    runner = _runner(
        conn, exec_id,
        [_lane("anthropic"), _lane("local", kind="local")],
        {
            "anthropic": FakeClient("anthropic", "m", ["   "]),
            "local": FakeClient("local", "llama3", ["real summary"]),
        },
        monkeypatch,
    )
    summary, err = runner.summarize_document("one")
    runner.finish()

    assert summary == "real summary" and err is None
    rows = {r["provider"]: r for r in get_execution_ai(conn, exec_id)}
    assert rows["anthropic"]["docs_succeeded"] == 0
    # Not demoted: an empty completion is not evidence the lane is broken.
    assert rows["anthropic"]["outcome"] == "failed"


# ---------------------------------------------------------------------------
# Backward compatibility — the standing rule
# ---------------------------------------------------------------------------

def test_a_one_lane_chain_behaves_exactly_as_before(conn, exec_id, monkeypatch):
    client = FakeClient("anthropic", "claude", ["a", "b"])
    runner = _runner(conn, exec_id, [_lane("anthropic")],
                     {"anthropic": client}, monkeypatch)
    assert runner.summarize_document("one") == ("a", None)
    assert runner.summarize_document("two") == ("b", None)
    runner.finish()

    rows = get_execution_ai(conn, exec_id)
    assert len(rows) == 1
    assert rows[0]["outcome"] == "ok"
    assert rows[0]["docs_attempted"] == rows[0]["docs_succeeded"] == 2


def test_a_prebuilt_primary_client_is_used_for_lane_zero(conn, exec_id, monkeypatch):
    """The engine has accepted an llm_client since long before lanes existed."""
    prebuilt = FakeClient("anthropic", "claude", ["from the prebuilt client"])
    runner = _runner(
        conn, exec_id, [_lane("anthropic")],
        {"anthropic": FakeClient("anthropic", "claude", ["from the factory"])},
        monkeypatch, primary=prebuilt,
    )
    summary, _ = runner.summarize_document("one")
    runner.finish()
    assert summary == "from the prebuilt client"
    assert prebuilt.calls == 1


# ---------------------------------------------------------------------------
# The label the report prints
# ---------------------------------------------------------------------------

def test_the_report_names_the_lane_that_did_the_work(conn, exec_id, monkeypatch):
    """A report saying "anthropic" when Ollama produced the summaries is a lie."""
    runner = _runner(
        conn, exec_id,
        [_lane("anthropic", model="claude"), _lane("local", model="llama3", kind="local")],
        {
            "anthropic": FakeClient("anthropic", "claude", [AUTH()]),
            "local": FakeClient("local", "llama3", ["done"]),
        },
        monkeypatch,
    )
    runner.summarize_document("one")
    runner.finish()
    assert runner.active_label == "Ollama · llama3"


def test_usable_goes_false_once_every_lane_is_demoted(conn, exec_id, monkeypatch):
    runner = _runner(
        conn, exec_id, [_lane("anthropic")],
        {"anthropic": FakeClient("anthropic", "m", [AUTH()])}, monkeypatch,
    )
    assert runner.usable is True
    runner.summarize_document("one")
    assert runner.usable is False
    runner.finish()
