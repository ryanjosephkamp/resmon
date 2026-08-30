# resmon_scripts/verification_scripts/test_ai_lanes.py
"""Lane resolution, error classification, and the execution_ai record (1.8a).

The tests that matter most here are the ones pinning behaviour that is
expensive to get wrong rather than merely wrong:

* a pre-1.8 configuration must resolve to exactly the lane it always used,
* lane-fatal and document-local must not drift into each other,
* and nothing in this path may ever carry a credential value.
"""

import sqlite3
import sys
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.ai_errors import (  # noqa: E402
    AIError,
    AIErrorKind,
    LANE_FATAL_KINDS,
    classify_exception,
    sanitize,
)
from implementation_scripts.ai_lanes import (  # noqa: E402
    AILane,
    chain_to_json,
    credential_alias_for,
    parse_chain,
    resolve_chain,
)
from implementation_scripts.database import (  # noqa: E402
    finish_ai_lane,
    get_execution_ai,
    init_db,
    insert_execution,
    start_ai_lane,
)


# ---------------------------------------------------------------------------
# Backward compatibility — the standing rule this PR is most able to break
# ---------------------------------------------------------------------------

def test_legacy_api_key_settings_resolve_to_one_lane():
    """A pre-1.8 provider configuration is a one-lane chain, unchanged."""
    lanes = resolve_chain({"ai_provider": "anthropic", "ai_model": "claude-3-5-sonnet"})
    assert len(lanes) == 1
    lane = lanes[0]
    assert lane.kind == "api_key"
    assert lane.provider == "anthropic"
    assert lane.model == "claude-3-5-sonnet"
    assert lane.credential_alias == "anthropic_api_key"


def test_legacy_local_settings_resolve_to_a_local_lane():
    lanes = resolve_chain({
        "ai_provider": "local",
        "ai_local_model": "llama3",
        "ai_local_endpoint": "http://localhost:11434",
    })
    assert [l.kind for l in lanes] == ["local"]
    assert lanes[0].model == "llama3"
    assert lanes[0].endpoint == "http://localhost:11434"
    assert lanes[0].credential_alias is None


def test_legacy_local_falls_back_to_ai_model():
    """``ai_local_model`` empty but ``ai_model`` set is a real stored state."""
    lanes = resolve_chain({"ai_provider": "local", "ai_model": "mistral"})
    assert lanes[0].model == "mistral"


def test_unconfigured_resolves_to_an_empty_chain():
    """"AI unconfigured" stays a silent no-op branch, not an error."""
    assert resolve_chain({}) == []
    assert resolve_chain({"ai_provider": ""}) == []


def test_custom_provider_carries_its_base_url_and_alias():
    lanes = resolve_chain({
        "ai_provider": "custom",
        "ai_model": "some-model",
        "ai_custom_base_url": "https://llm.example.com/v1",
    })
    assert lanes[0].base_url == "https://llm.example.com/v1"
    assert lanes[0].credential_alias == "custom_llm_api_key"


# ---------------------------------------------------------------------------
# Explicit chains
# ---------------------------------------------------------------------------

def test_explicit_chain_wins_over_legacy_keys_and_keeps_order():
    chain = chain_to_json([
        AILane(kind="api_key", provider="anthropic", model="claude-3-5-sonnet"),
        AILane(kind="local", provider="local", model="llama3"),
    ])
    lanes = resolve_chain({
        "ai_chain": chain,
        "ai_provider": "openai",     # must be ignored
        "ai_model": "gpt-4o-mini",
    })
    assert [l.provider for l in lanes] == ["anthropic", "local"]


def test_malformed_chain_falls_back_rather_than_losing_ai():
    """A corrupted blob must not cost the user the setup they already had."""
    lanes = resolve_chain({
        "ai_chain": "{not json",
        "ai_provider": "openai",
        "ai_model": "gpt-4o-mini",
    })
    assert [l.provider for l in lanes] == ["openai"]


def test_one_bad_lane_does_not_discard_the_others():
    lanes = parse_chain([
        {"kind": "api_key", "provider": "openai", "model": "gpt-4o-mini"},
        {"kind": "nonsense", "provider": "openai"},
        {"kind": "local", "provider": "local", "model": "llama3"},
        "not even an object",
    ])
    assert [l.provider for l in lanes] == ["openai", "local"]


def test_unknown_lane_kind_is_rejected_at_construction():
    with pytest.raises(ValueError, match="Unknown lane kind"):
        AILane(kind="telepathy", provider="openai")


def test_lane_gets_a_human_label_automatically():
    lane = AILane(kind="api_key", provider="anthropic", model="claude-3-5-sonnet")
    assert lane.label == "Anthropic · claude-3-5-sonnet"


def test_subscription_provider_resolves_without_a_credential_alias():
    """A subscription lane uses an installed CLI, so it needs no keyring slot."""
    lanes = resolve_chain({"ai_provider": "claude_code", "ai_cli_path": "/opt/claude"})
    assert lanes[0].kind == "subscription"
    assert lanes[0].credential_alias is None
    assert lanes[0].binary_path == "/opt/claude"


# ---------------------------------------------------------------------------
# Classification — the distinction the chain is built on
# ---------------------------------------------------------------------------

def _http_error(status: int, body: str = "") -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://provider.example/v1/chat")
    response = httpx.Response(status, text=body, request=request)
    return httpx.HTTPStatusError("boom", request=request, response=response)


@pytest.mark.parametrize("status,expected", [
    (401, AIErrorKind.AUTH),
    (403, AIErrorKind.AUTH),
    (429, AIErrorKind.QUOTA),
    (404, AIErrorKind.UNSUPPORTED),
])
def test_status_codes_that_kill_a_lane(status, expected):
    error = classify_exception(_http_error(status))
    assert error.kind is expected
    assert error.lane_fatal is True


def test_a_context_error_is_document_local_not_lane_fatal():
    """The expensive mistake in one direction: losing a working lane."""
    error = classify_exception(_http_error(400, "context_length_exceeded"))
    assert error.kind is AIErrorKind.CONTEXT
    assert error.lane_fatal is False


def test_a_server_error_does_not_kill_the_lane():
    """A single 5xx is transient more often than not; the counts show a real outage."""
    error = classify_exception(_http_error(503))
    assert error.kind is AIErrorKind.UNKNOWN
    assert error.lane_fatal is False


def test_an_unreachable_provider_kills_the_lane():
    """The expensive mistake in the other direction: retrying a dead endpoint per paper."""
    error = classify_exception(httpx.ConnectError("connection refused"))
    assert error.kind is AIErrorKind.NETWORK
    assert error.lane_fatal is True


def test_retry_after_is_captured_for_quota_errors():
    request = httpx.Request("POST", "https://provider.example/v1/chat")
    response = httpx.Response(429, headers={"retry-after": "30"}, request=request)
    error = classify_exception(
        httpx.HTTPStatusError("slow down", request=request, response=response)
    )
    assert error.kind is AIErrorKind.QUOTA
    assert error.retry_after == 30.0


def test_context_marker_beats_the_status_code():
    """A context error arrives as a 400 and must not fall into the generic branch."""
    error = classify_exception(_http_error(400, "prompt is too long for this model"))
    assert error.kind is AIErrorKind.CONTEXT


def test_classification_is_idempotent_and_fills_in_lane_context():
    first = classify_exception(_http_error(401))
    second = classify_exception(first, lane_label="Anthropic · x", provider="anthropic")
    assert second is first
    assert second.lane_label == "Anthropic · x"
    assert second.provider == "anthropic"


def test_every_kind_is_classified_as_exactly_one_of_the_two():
    for kind in AIErrorKind:
        error = AIError(kind=kind, message="x")
        assert error.lane_fatal == (kind in LANE_FATAL_KINDS)


def test_ai_error_is_a_runtime_error():
    """The remote client raised RuntimeError before 1.8; callers keep working."""
    assert issubclass(AIError, RuntimeError)


# ---------------------------------------------------------------------------
# Nothing here may carry a credential
# ---------------------------------------------------------------------------

def test_the_exact_key_is_stripped_from_a_message():
    secret = "sk-verysecretvalue1234567890"
    error = classify_exception(Exception(f"rejected key {secret}"), secret=secret)
    assert secret not in error.message
    assert "[REDACTED]" in error.message


@pytest.mark.parametrize("leaked", [
    "sk-abcdefghijklmnopqrstuvwxyz",
    "sk-ant-abcdefghijklmnopqrstuvwxyz",
    "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
    "xai-abcdefghijklmnopqrstuvwxyz",
])
def test_key_shapes_are_stripped_even_when_the_secret_is_unknown(leaked):
    """An upstream echoing a key back is redacted without the caller knowing it."""
    error = classify_exception(Exception(f"upstream said: {leaked}"))
    assert leaked not in error.message
    assert "[REDACTED]" in error.message


def test_sanitize_handles_none_and_non_strings():
    assert sanitize(None) == ""
    assert sanitize(404) == "404"


def test_a_lane_never_holds_a_credential_value():
    """Lanes name a keyring slot; they never carry what is in it."""
    lane = resolve_chain({"ai_provider": "openai", "ai_model": "gpt-4o-mini"})[0]
    assert lane.credential_alias == "openai_api_key"
    assert "sk-" not in chain_to_json([lane])


def test_credential_alias_for_known_providers():
    assert credential_alias_for("anthropic") == "anthropic_api_key"
    assert credential_alias_for("custom") == "custom_llm_api_key"
    assert credential_alias_for("local") is None
    assert credential_alias_for("claude_code") is None
    assert credential_alias_for("") is None


# ---------------------------------------------------------------------------
# The execution_ai record
# ---------------------------------------------------------------------------

@pytest.fixture()
def conn(tmp_path):
    database = sqlite3.connect(str(tmp_path / "t.db"))
    database.row_factory = sqlite3.Row
    init_db(conn=database)
    yield database
    database.close()


def _an_execution(database) -> int:
    return insert_execution(database, {
        "execution_type": "deep_sweep",
        "parameters": '{"query": "x"}',
        "start_time": "2026-08-30T00:00:00Z",
        "status": "running",
    })


def test_a_lane_is_recorded_as_running_before_it_finishes(conn):
    """A row left at 'running' is the evidence a crash mid-run leaves behind."""
    exec_id = _an_execution(conn)
    start_ai_lane(
        conn, exec_id, 0,
        lane_label="Anthropic · claude-3-5-sonnet", lane_kind="api_key",
        provider="anthropic", model="claude-3-5-sonnet",
        credential_alias="anthropic_api_key",
    )
    rows = get_execution_ai(conn, exec_id)
    assert len(rows) == 1
    assert rows[0]["outcome"] == "running"
    assert rows[0]["ended_at"] is None


def test_finishing_a_lane_stores_counts_and_the_classified_error(conn):
    exec_id = _an_execution(conn)
    start_ai_lane(conn, exec_id, 0, lane_label="L", lane_kind="api_key",
                  provider="openai", model="gpt-4o-mini")
    error = classify_exception(_http_error(429))
    finish_ai_lane(
        conn, exec_id, 0, outcome="partial",
        docs_attempted=10, docs_succeeded=7, **error.to_record(),
    )
    row = get_execution_ai(conn, exec_id)[0]
    assert row["outcome"] == "partial"
    assert (row["docs_attempted"], row["docs_succeeded"]) == (10, 7)
    assert row["error_kind"] == "quota"
    assert row["http_status"] == 429
    assert row["ended_at"] is not None


def test_lanes_come_back_in_the_order_they_were_tried(conn):
    exec_id = _an_execution(conn)
    for index, provider in enumerate(["anthropic", "openai", "local"]):
        start_ai_lane(conn, exec_id, index, lane_label=provider,
                      lane_kind="api_key" if provider != "local" else "local",
                      provider=provider)
    assert [r["provider"] for r in get_execution_ai(conn, exec_id)] == [
        "anthropic", "openai", "local",
    ]


def test_an_unknown_outcome_is_rejected_by_the_schema(conn):
    exec_id = _an_execution(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO execution_ai (execution_id, lane_index, lane_label, "
            "lane_kind, provider, outcome) VALUES (?, 0, 'L', 'api_key', 'openai', ?)",
            (exec_id, "probably_fine"),
        )


def test_an_unknown_lane_kind_is_rejected_by_the_schema(conn):
    exec_id = _an_execution(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO execution_ai (execution_id, lane_index, lane_label, "
            "lane_kind, provider, outcome) VALUES (?, 0, 'L', ?, 'openai', 'ok')",
            (exec_id, "telepathy"),
        )


def test_records_are_removed_with_their_execution(conn):
    """No orphan AI rows after the Danger Zone erases executions."""
    exec_id = _an_execution(conn)
    start_ai_lane(conn, exec_id, 0, lane_label="L", lane_kind="api_key",
                  provider="openai")
    conn.execute("DELETE FROM executions WHERE id = ?", (exec_id,))
    conn.commit()
    assert get_execution_ai(conn, exec_id) == []


# ---------------------------------------------------------------------------
# The wiring — does a real run actually write the record?
# ---------------------------------------------------------------------------
#
# The tests above prove the pieces work. This one proves they are connected,
# which is the failure the others cannot see: a perfectly correct classifier
# and a perfectly correct table, joined by a line nobody called.

def _mock_source(name: str = "arxiv"):
    from unittest.mock import MagicMock
    from implementation_scripts.api_base import NormalizedResult

    client = MagicMock()
    client.get_name.return_value = name
    client.search.return_value = [
        NormalizedResult(
            source_repository=name, external_id=f"{name}_1", doi=None,
            title="A paper", authors=["A. Author"],
            abstract="An abstract long enough to be summarised.",
            publication_date="2026-04-10", url="https://example.com/1",
            categories=["cs.AI"],
        ),
        NormalizedResult(
            source_repository=name, external_id=f"{name}_2", doi=None,
            title="Another paper", authors=["B. Author"],
            abstract="A second abstract.",
            publication_date="2026-04-11", url="https://example.com/2",
            categories=["cs.LG"],
        ),
    ]
    return client


def _run_dive_with_llm(conn, tmp_path, llm_client, lane):
    from unittest.mock import patch
    from implementation_scripts.sweep_engine import SweepEngine

    engine = SweepEngine(
        db_conn=conn,
        config={"ai_enabled": True, "ai_prompt_params": {"_show_audit_prefix": False}},
        llm_client=llm_client,
    )
    engine.ai_lane = lane
    reports = tmp_path / "reports"
    reports.mkdir(exist_ok=True)
    with (
        patch("implementation_scripts.sweep_engine.get_client", return_value=_mock_source()),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", reports),
    ):
        return engine.execute_dive("arxiv", {"query": "neural networks", "max_results": 2})


def test_a_failing_lane_is_recorded_on_a_real_run(conn, tmp_path):
    """Every summary failed — the row must say so, and say why.

    This is the watchdog blind spot 1.8a exists to close: before it, a run
    where the AI failed on every document completed and looked healthy.
    """
    from unittest.mock import MagicMock

    llm = MagicMock()
    llm.provider, llm.model = "anthropic", "claude-3-5-sonnet"
    llm.summarize.side_effect = classify_exception(_http_error(401))

    lane = AILane(kind="api_key", provider="anthropic",
                  model="claude-3-5-sonnet", credential_alias="anthropic_api_key")
    result = _run_dive_with_llm(conn, tmp_path, llm, lane)

    rows = get_execution_ai(conn, result["execution_id"])
    assert len(rows) == 1, "the lane attempt was not recorded at all"
    row = rows[0]
    assert row["outcome"] == "failed"
    assert row["error_kind"] == "auth"
    assert row["http_status"] == 401
    assert row["docs_attempted"] == 2
    assert row["docs_succeeded"] == 0
    assert row["credential_alias"] == "anthropic_api_key"
    assert row["lane_label"] == "Anthropic · claude-3-5-sonnet"
    assert row["ended_at"] is not None


def test_a_working_lane_is_recorded_as_ok(conn, tmp_path):
    from unittest.mock import MagicMock

    llm = MagicMock()
    llm.provider, llm.model = "local", "llama3"
    llm.summarize.return_value = "A summary."

    lane = AILane(kind="local", provider="local", model="llama3")
    result = _run_dive_with_llm(conn, tmp_path, llm, lane)

    row = get_execution_ai(conn, result["execution_id"])[0]
    assert row["outcome"] == "ok"
    assert row["docs_attempted"] == row["docs_succeeded"] == 2
    assert row["error_kind"] is None
    assert row["credential_alias"] is None


def test_one_bad_document_is_partial_not_failed(conn, tmp_path):
    """Partial and failed are held apart: one awkward abstract is a normal day."""
    from unittest.mock import MagicMock

    llm = MagicMock()
    llm.provider, llm.model = "openai", "gpt-4o-mini"
    llm.summarize.side_effect = [
        classify_exception(_http_error(400, "context_length_exceeded")),
        "A summary.",
    ]

    lane = AILane(kind="api_key", provider="openai", model="gpt-4o-mini")
    result = _run_dive_with_llm(conn, tmp_path, llm, lane)

    row = get_execution_ai(conn, result["execution_id"])[0]
    assert row["outcome"] == "partial"
    assert (row["docs_attempted"], row["docs_succeeded"]) == (2, 1)
    assert row["error_kind"] == "context"


def test_no_record_when_ai_is_off(conn, tmp_path):
    """A run with AI disabled writes nothing — absent, not zero."""
    from unittest.mock import patch
    from implementation_scripts.sweep_engine import SweepEngine

    engine = SweepEngine(db_conn=conn, config={"ai_enabled": False})
    reports = tmp_path / "reports2"
    reports.mkdir(exist_ok=True)
    with (
        patch("implementation_scripts.sweep_engine.get_client", return_value=_mock_source()),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", reports),
    ):
        result = engine.execute_dive("arxiv", {"query": "x", "max_results": 2})

    assert get_execution_ai(conn, result["execution_id"]) == []
