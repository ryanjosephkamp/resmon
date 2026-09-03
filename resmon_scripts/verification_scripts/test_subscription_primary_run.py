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


_FAKE_CLI_SOURCE = """#!{python}
import json, re, sys

# Count this invocation. The engine-level claim "one process for ten
# documents" is about processes, so it is counted at a real fork/exec.
with open({counter!r}, "a") as handle:
    handle.write("x\\n")
with open({argv_log!r}, "a") as handle:
    handle.write("\\n".join(sys.argv[1:]) + "\\n--\\n")

prompt = sys.argv[-1]
indices = [int(m) for m in re.findall(r"^===== DOCUMENT (\\d+) =====$", prompt, re.M)]
if not indices:
    print(json.dumps({{"is_error": False, "result": {single!r}}}))
    sys.exit(0)
print(json.dumps({{
    "is_error": False,
    "subtype": "success",
    "structured_output": {{
        "summaries": [
            {{"index": i, "summary": "Batched summary %d." % i}} for i in indices
        ],
    }},
}}))
"""


def batching_fake_claude(tmp_path, *, single="A single summary.", sleep=0.0):
    """A CLI that answers ``--json-schema`` with one entry per document.

    Written in Python rather than shell because it has to parse the prompt it
    was handed: a batch of three answers for three and a batch of one answers
    for one, so the same script serves the batched path and the per-document
    fallback path without the test choosing which is which.

    It counts its own invocations in a file. That is the boundary the "one
    process for the whole batch" claim has to be checked at — a real
    fork/exec, not a counter on a double, which is a double that could not
    fail the way a process fails.
    """
    counter = tmp_path / "spawns.txt"
    argv_log = tmp_path / "argv.txt"
    script = tmp_path / "claude"
    source = _FAKE_CLI_SOURCE.format(
        python=sys.executable,
        counter=str(counter),
        argv_log=str(argv_log),
        single=single,
    )
    if sleep:
        # A batch that takes a while, so a cancel can arrive during it. This
        # is the only way to observe that cancellation reaches *inside* a
        # call rather than only between calls -- with an instant CLI the
        # distinction is invisible.
        source = source.replace(
            "prompt = sys.argv[-1]",
            f"import time as _t; _t.sleep({sleep!r})\nprompt = sys.argv[-1]",
        )
    script.write_text(source)
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script, counter


def spawn_count(counter) -> int:
    try:
        return len([line for line in counter.read_text().splitlines() if line])
    except OSError:
        return 0


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


# ---------------------------------------------------------------------------
# P3 / P7 at the engine boundary — real processes, real progress events
# ---------------------------------------------------------------------------

def _mock_arxiv_n(count: int):
    client = MagicMock()
    client.get_name.return_value = "arxiv"
    client.search.return_value = [
        NormalizedResult(
            source_repository="arxiv", external_id=f"arxiv_{i}", doi=None,
            title=f"Paper {i}", authors=["A. Author"],
            abstract=f"Abstract {i}, long enough to be worth summarizing.",
            publication_date="2026-04-10", url=f"https://example.com/{i}",
            categories=["cs.AI"],
        )
        for i in range(count)
    ]
    return client


def _run_dive(client, tmp_path, cli_path, *, papers, settings_extra=None):
    settings = {
        "ai_provider": "claude_code",
        "ai_cli_path": str(cli_path),
        "ai_summary_length": "standard",
    }
    settings.update(settings_extra or {})
    assert client.put("/api/settings/ai", json={"settings": settings}).status_code == 200

    reports = tmp_path / "reports"
    reports.mkdir(exist_ok=True)
    with (
        patch("implementation_scripts.sweep_engine.get_client",
              return_value=_mock_arxiv_n(papers)),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", reports),
    ):
        resp = client.post("/api/search/dive", json={
            "repository": "arxiv",
            "query": "neural networks",
            "max_results": papers,
            "ai_enabled": True,
        })
        assert resp.status_code == 200
        exec_id = resp.json()["execution_id"]

        import time as _t
        for _ in range(240):
            ex = client.get(f"/api/executions/{exec_id}").json()
            if ex["status"] in ("completed", "failed", "cancelled"):
                break
            _t.sleep(0.25)
    return exec_id, ex


def test_a_sweep_of_ten_papers_spawns_one_cli_process(client, tmp_path):
    """P3 at the boundary that matters: a real fork/exec, counted.

    Ten papers, one process. Before batching this was ten processes, each
    starting a session and reading the constitution, which is the whole reason
    the lane was capped at 25 documents and kept out of the default.
    """
    script, counter = batching_fake_claude(tmp_path)
    exec_id, ex = _run_dive(client, tmp_path, script, papers=10)

    assert ex["status"] == "completed", ex
    assert spawn_count(counter) == 1, (
        f"ten papers spawned {spawn_count(counter)} CLI processes"
    )

    report = client.get(f"/api/executions/{exec_id}/report").text
    for i in range(10):
        assert f"Batched summary {i}." in report


def test_the_batch_size_is_what_slices_the_run(client, tmp_path):
    """Twenty-five papers at ten per call is three processes, not twenty-five."""
    script, counter = batching_fake_claude(tmp_path)
    _, ex = _run_dive(
        client, tmp_path, script, papers=25,
        settings_extra={"ai_subscription_doc_cap": "25"},
    )
    assert ex["status"] == "completed", ex
    assert spawn_count(counter) == 3


def test_the_live_log_announces_the_batch_and_then_each_paper(client, tmp_path):
    """The renderer's ai_progress consumer is unchanged, so both must arrive."""
    script, _ = batching_fake_claude(tmp_path)
    exec_id, ex = _run_dive(client, tmp_path, script, papers=10)
    assert ex["status"] == "completed", ex

    messages = [
        e.get("message") or ""
        for e in _events(client, exec_id)
        if e.get("type") == "ai_progress"
    ]
    assert any("papers 1–10 of 10 in one call" in m for m in messages), messages
    # And the per-document completions the existing consumer counts on.
    assert sum(1 for m in messages if "Summarizing document" in m) == 10


def test_the_lane_row_counts_documents_not_calls(client, tmp_path):
    script, _ = batching_fake_claude(tmp_path)
    exec_id, ex = _run_dive(client, tmp_path, script, papers=10)
    assert ex["status"] == "completed", ex

    conn = resmon_mod._get_db()
    try:
        row = get_execution_ai(conn, exec_id)[0]
    finally:
        resmon_mod._close_db(conn)

    assert row["docs_attempted"] == 10, "one call, ten documents"
    assert row["docs_succeeded"] == 10
    assert row["outcome"] == "ok"


def test_cancelling_during_a_batch_terminates_the_cli(client, tmp_path):
    """P7: the process holding ten documents is killed, not waited out.

    A batched call is one long silence where ten short ones used to be, so a
    cancel honoured only between calls would make the user sit through the
    whole batch. The assertion is on the clock as well as the status: a
    30-second CLI, cancelled, must not take 30 seconds to stop.
    """
    import time as _t

    script, counter = batching_fake_claude(tmp_path, sleep=30.0)
    settings = {"ai_provider": "claude_code", "ai_cli_path": str(script)}
    assert client.put("/api/settings/ai", json={"settings": settings}).status_code == 200

    reports = tmp_path / "reports"
    reports.mkdir(exist_ok=True)
    with (
        patch("implementation_scripts.sweep_engine.get_client",
              return_value=_mock_arxiv_n(10)),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", reports),
    ):
        resp = client.post("/api/search/dive", json={
            "repository": "arxiv", "query": "q", "max_results": 10,
            "ai_enabled": True,
        })
        exec_id = resp.json()["execution_id"]

        # Wait until the CLI is actually running, then cancel.
        for _ in range(120):
            if spawn_count(counter) >= 1:
                break
            _t.sleep(0.25)
        assert spawn_count(counter) == 1, "the batch never started"

        cancelled_at = _t.monotonic()
        assert client.post(f"/api/executions/{exec_id}/cancel").status_code == 200

        for _ in range(80):
            ex = client.get(f"/api/executions/{exec_id}").json()
            if ex["status"] in ("completed", "failed", "cancelled"):
                break
            _t.sleep(0.25)

    elapsed = _t.monotonic() - cancelled_at
    assert ex["status"] == "cancelled", ex
    assert elapsed < 20, (
        f"cancellation took {elapsed:.1f}s against a 30s CLI call — it waited "
        f"the batch out instead of terminating it"
    )
    assert spawn_count(counter) == 1, "no further batch may be spawned after cancel"
