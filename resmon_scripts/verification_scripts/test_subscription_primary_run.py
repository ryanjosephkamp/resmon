"""A subscription-primary execution, driven through the real API (1.8.5 D1).

Everything here runs the actual wiring: ``PUT /api/settings/ai`` writes the
settings, ``_apply_ai_settings_to_engine`` resolves them into lanes,
``ChainRunner`` builds lane 0 from the lane, and a **real subprocess** is
spawned for the summary. The only stand-in is the CLI binary itself, which is
a shell script that prints what ``claude -p --output-format json`` prints.

That matters because of what shipped: until 1.8.5 the engine built lane 0 with
``build_llm_client_from_settings``, which has no subscription branch. It
returned ``None``, the engine announced *"AI skipped: API key missing"* — a
lane with no key to be missing — and then the chain drove the CLI anyway and
produced summaries. The warning was wrong about work the app was doing
correctly, on the route 1.8.5 makes primary.

No test could see it, because no test ran a subscription lane through the API.
"""

import json
import os
import stat
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient  # noqa: E402

import resmon as resmon_mod  # noqa: E402
from implementation_scripts.api_base import NormalizedResult  # noqa: E402
from implementation_scripts.database import get_execution_ai  # noqa: E402


# ---------------------------------------------------------------------------
# A CLI that is a real process
# ---------------------------------------------------------------------------

def fake_claude(tmp_path, *, summary="A faithful summary of the abstract."):
    """A shell script that answers like ``claude -p --output-format json``.

    It also writes its own argv, one argument per line, to ``argv.txt`` beside
    itself — which is how the constitution-transmission checks read what the
    lane actually sent rather than what it meant to send.
    """
    argv_log = tmp_path / "argv.txt"
    script = tmp_path / "claude"
    script.write_text(
        "#!/bin/sh\n"
        f'for a in "$@"; do printf "%s\\n" "$a" >> {argv_log}; done\n'
        f"printf '%s' '{json.dumps({'is_error': False, 'subtype': 'success', 'result': summary})}'\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script, argv_log


def _mock_arxiv():
    client = MagicMock()
    client.get_name.return_value = "arxiv"
    client.search.return_value = [
        NormalizedResult(
            source_repository="arxiv", external_id="arxiv_1", doi=None,
            title="A paper", authors=["A. Author"],
            abstract="An abstract long enough to be worth summarizing.",
            publication_date="2026-04-10", url="https://example.com/1",
            categories=["cs.AI"],
        ),
        NormalizedResult(
            source_repository="arxiv", external_id="arxiv_2", doi=None,
            title="Another paper", authors=["B. Author"],
            abstract="A second abstract, also long enough.",
            publication_date="2026-04-11", url="https://example.com/2",
            categories=["cs.LG"],
        ),
    ]
    return client


@pytest.fixture(autouse=True)
def only_the_fake_cli_is_reachable(monkeypatch):
    """Nothing but an explicitly configured path may resolve to a CLI.

    Without this the developer machine's own ``claude`` is found through the
    known-install-locations table and these tests spawn the **real** CLI —
    which was observed, cost 45 seconds, and would have made the mutation
    checks below meaningless. A hermetic test that can reach a real agent
    session is not hermetic.
    """
    monkeypatch.setenv("PATH", "/nonexistent-resmon-test-dir")
    monkeypatch.setattr(
        "implementation_scripts.ai_cli._KNOWN_LOCATIONS",
        {"darwin": {"claude_code": (), "codex": ()},
         "linux": {"claude_code": (), "codex": ()},
         "win32": {"claude_code": (), "codex": ()}},
    )


@pytest.fixture
def client(tmp_path):
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from resmon import app
    return TestClient(app)


def _run_subscription_dive(client, tmp_path, cli_path, *, extra_settings=None):
    settings = {
        "ai_provider": "claude_code",
        "ai_cli_path": str(cli_path),
        "ai_summary_length": "standard",
        "ai_tone": "technical",
    }
    settings.update(extra_settings or {})
    assert client.put("/api/settings/ai", json={"settings": settings}).status_code == 200

    reports = tmp_path / "reports"
    reports.mkdir(exist_ok=True)
    with (
        patch("implementation_scripts.sweep_engine.get_client", return_value=_mock_arxiv()),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", reports),
    ):
        resp = client.post("/api/search/dive", json={
            "repository": "arxiv",
            "query": "neural networks",
            "max_results": 2,
            "ai_enabled": True,
        })
        assert resp.status_code == 200
        exec_id = resp.json()["execution_id"]

        import time as _t
        for _ in range(120):
            ex = client.get(f"/api/executions/{exec_id}").json()
            if ex["status"] in ("completed", "failed", "cancelled"):
                break
            _t.sleep(0.25)
    assert ex["status"] == "completed", ex
    return exec_id


def _events(client, exec_id):
    return client.get(f"/api/executions/{exec_id}/progress/events").json()


# ---------------------------------------------------------------------------
# P1 — the configured path reaches the lane
# ---------------------------------------------------------------------------

def test_the_configured_cli_path_reaches_the_resolved_lane(client, tmp_path):
    """P1, third clause: ``engine.ai_lane.binary_path`` is what was PUT.

    The endpoint honouring ``ai_cli_path`` and the *engine* honouring it are
    two different things: they read through different key lists, and until
    1.8.5 the key was missing from both.
    """
    script, _ = fake_claude(tmp_path)
    captured = {}
    real_apply = resmon_mod._apply_ai_settings_to_engine

    def _spy(engine, exec_id, conn, ephemeral):
        real_apply(engine, exec_id, conn, ephemeral)
        captured["lane"] = engine.ai_lane
        captured["llm_client"] = engine.llm_client

    with patch.object(resmon_mod, "_apply_ai_settings_to_engine", _spy):
        _run_subscription_dive(client, tmp_path, script)

    lane = captured["lane"]
    assert lane is not None
    assert lane.kind == "subscription"
    assert lane.binary_path == str(script)
    # No prebuilt client: lane 0 is built from the lane, by the only builder
    # that knows what a subscription lane is.
    assert captured["llm_client"] is None


# ---------------------------------------------------------------------------
# P2 — no false warning, and the row says the lane ran
# ---------------------------------------------------------------------------

def test_a_subscription_primary_run_emits_no_ai_skipped_warning(client, tmp_path):
    script, _ = fake_claude(tmp_path)
    exec_id = _run_subscription_dive(client, tmp_path, script)

    skipped = [
        e for e in _events(client, exec_id)
        if e.get("type") == "log_entry" and "AI skipped" in (e.get("message") or "")
    ]
    assert not skipped, f"a working subscription lane was reported as skipped: {skipped}"


def test_the_lane_row_records_a_subscription_lane_that_ran(client, tmp_path):
    script, _ = fake_claude(tmp_path)
    exec_id = _run_subscription_dive(client, tmp_path, script)

    conn = resmon_mod._get_db()
    try:
        rows = get_execution_ai(conn, exec_id)
    finally:
        resmon_mod._close_db(conn)

    assert len(rows) == 1, rows
    row = rows[0]
    assert row["lane_kind"] == "subscription"
    assert row["provider"] == "claude_code"
    assert row["outcome"] != "skipped"
    assert row["outcome"] == "ok"
    assert row["docs_attempted"] == 2
    assert row["docs_succeeded"] == 2
    assert row["credential_alias"] is None


def test_the_summaries_reach_the_documents(client, tmp_path):
    """The lane produced text, not just a green row."""
    script, _ = fake_claude(tmp_path, summary="Sentinel summary text.")
    exec_id = _run_subscription_dive(client, tmp_path, script)

    report = client.get(f"/api/executions/{exec_id}/report")
    assert report.status_code == 200
    assert "Sentinel summary text." in report.text
