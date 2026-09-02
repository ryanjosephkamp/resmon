"""Driving an agent CLI as a summarization lane (1.8c).

Two things are being pinned here.

**Extraction never guesses.** An agent CLI emits banners, progress and prose
around its answer. When the structured route does not produce a usable summary,
the client must raise — a salvaged fragment stored as a paper's summary is the
exact failure this product cannot afford, and it is invisible once written.

**The CLI is run with no tools and no context.** Abstracts are untrusted text
from the internet and the CLI can execute commands, so the argv is part of the
security boundary rather than a formatting detail.

The auth-failure payload in ``_CLAUDE_AUTH_FAILURE`` is real: it was captured
from ``claude -p --output-format json`` against an expired session. Note that
``subtype`` reads ``"success"`` while ``is_error`` is true — which is why the
client keys on ``is_error``.
"""

import json
import subprocess

import pytest

from implementation_scripts.ai_errors import AIError, AIErrorKind
from implementation_scripts.llm_subscription import SubscriptionLLMClient


_CLAUDE_AUTH_FAILURE = {
    "is_error": True,
    "subtype": "success",
    "terminal_reason": "api_error",
    "result": "Failed to authenticate: OAuth session expired and could not be refreshed",
    "type": "result",
}


class _FakeCompleted:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


@pytest.fixture
def runs(monkeypatch):
    """Capture every subprocess invocation and script its result."""
    calls = []
    scripted = {"result": _FakeCompleted(), "raises": None, "writes": None}

    def _run(argv, **kwargs):
        calls.append({"argv": argv, "kwargs": kwargs})
        if scripted["raises"] is not None:
            raise scripted["raises"]
        if scripted["writes"] is not None:
            # Mimic codex's -o file, which is how its output is collected.
            out_index = argv.index("-o") + 1
            with open(argv[out_index], "w", encoding="utf-8") as handle:
                handle.write(scripted["writes"])
        return scripted["result"]

    monkeypatch.setattr(subprocess, "run", _run)
    return {"calls": calls, "script": scripted}


def _claude(**kw):
    return SubscriptionLLMClient("claude_code", "/fake/claude", **kw)


def _codex(**kw):
    return SubscriptionLLMClient("codex", "/fake/codex", **kw)


# ---------------------------------------------------------------------------
# The happy path
# ---------------------------------------------------------------------------

def test_claude_code_returns_the_result_field(runs):
    runs["script"]["result"] = _FakeCompleted(
        stdout=json.dumps({"is_error": False, "result": "A tidy summary."}),
    )
    assert _claude().summarize("abstract text") == "A tidy summary."


def test_codex_returns_the_final_message_file(runs):
    runs["script"]["writes"] = "A tidy summary.\n"
    runs["script"]["result"] = _FakeCompleted(stdout="banner noise\ntokens used\n42\n")
    assert _codex().summarize("abstract text") == "A tidy summary."


def test_codex_ignores_stdout_entirely(runs):
    """The banner must never reach a summary, even when the answer is empty."""
    runs["script"]["writes"] = "Real answer."
    runs["script"]["result"] = _FakeCompleted(
        stdout="OpenAI Codex v0.150\nworkdir: /tmp/x\nmodel: gpt-5\n",
    )
    assert _codex().summarize("t") == "Real answer."


# ---------------------------------------------------------------------------
# Authentication — the lane-fatal case the plan names
# ---------------------------------------------------------------------------

def test_claude_code_auth_failure_is_lane_fatal(runs):
    runs["script"]["result"] = _FakeCompleted(
        stdout=json.dumps(_CLAUDE_AUTH_FAILURE), returncode=1,
    )
    with pytest.raises(AIError) as excinfo:
        _claude().summarize("t")

    error = excinfo.value
    assert error.kind is AIErrorKind.CLI_AUTH
    assert error.lane_fatal is True


def test_is_error_is_honoured_even_though_subtype_says_success(runs):
    """The trap: subtype reads 'success' on a failed authentication."""
    payload = dict(_CLAUDE_AUTH_FAILURE)
    assert payload["subtype"] == "success"
    runs["script"]["result"] = _FakeCompleted(stdout=json.dumps(payload))

    with pytest.raises(AIError):
        _claude().summarize("t")


def test_the_error_message_is_not_the_summary(runs):
    """An is_error payload must raise, never return its result text."""
    runs["script"]["result"] = _FakeCompleted(stdout=json.dumps(_CLAUDE_AUTH_FAILURE))
    with pytest.raises(AIError) as excinfo:
        _claude().summarize("t")
    assert "Failed to authenticate" in str(excinfo.value)


def test_codex_login_prompt_is_classified_as_auth(runs):
    runs["script"]["result"] = _FakeCompleted(
        stderr="You are not logged in. Run `codex login` to continue.",
        returncode=1,
    )
    with pytest.raises(AIError) as excinfo:
        _codex().summarize("t")
    assert excinfo.value.kind is AIErrorKind.CLI_AUTH


# ---------------------------------------------------------------------------
# Missing binary and quota
# ---------------------------------------------------------------------------

def test_missing_binary_is_cli_missing_and_lane_fatal(runs):
    runs["script"]["raises"] = FileNotFoundError()
    with pytest.raises(AIError) as excinfo:
        _claude().summarize("t")
    assert excinfo.value.kind is AIErrorKind.CLI_MISSING
    assert excinfo.value.lane_fatal is True


def test_permission_denied_is_cli_missing(runs):
    runs["script"]["raises"] = PermissionError()
    with pytest.raises(AIError) as excinfo:
        _claude().summarize("t")
    assert excinfo.value.kind is AIErrorKind.CLI_MISSING


def test_usage_limit_is_quota_and_lane_fatal(runs):
    runs["script"]["result"] = _FakeCompleted(
        stdout=json.dumps({
            "is_error": True,
            "result": "You have reached your usage limit. Resets at 4pm.",
        }),
        returncode=1,
    )
    with pytest.raises(AIError) as excinfo:
        _claude().summarize("t")
    assert excinfo.value.kind is AIErrorKind.QUOTA
    assert excinfo.value.lane_fatal is True


def test_timeout_is_document_local_not_lane_fatal(runs):
    """One slow paper must not retire a working lane for the whole run."""
    runs["script"]["raises"] = subprocess.TimeoutExpired(cmd="claude", timeout=300)
    with pytest.raises(AIError) as excinfo:
        _claude().summarize("t")
    assert excinfo.value.lane_fatal is False


# ---------------------------------------------------------------------------
# Unusable output — the honest failure
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("stdout", [
    "",
    "I'll help you summarize that! Here is my answer:",   # prose, not JSON
    "[1, 2, 3]",                                          # JSON, wrong shape
    json.dumps({"is_error": False, "result": ""}),        # empty result
    json.dumps({"is_error": False}),                      # no result at all
])
def test_unusable_claude_output_raises_rather_than_salvaging(runs, stdout):
    runs["script"]["result"] = _FakeCompleted(stdout=stdout)
    with pytest.raises(AIError) as excinfo:
        _claude().summarize("t")
    assert "could not use" in str(excinfo.value)


def test_codex_with_no_final_message_raises(runs):
    """No -o file written means the run never answered."""
    runs["script"]["result"] = _FakeCompleted(stdout="banner only", returncode=1)
    with pytest.raises(AIError) as excinfo:
        _codex().summarize("t")
    assert "could not use" in str(excinfo.value)


def test_unusable_output_is_document_local(runs):
    """One malformed reply is not evidence the lane is dead."""
    runs["script"]["result"] = _FakeCompleted(stdout="not json")
    with pytest.raises(AIError) as excinfo:
        _claude().summarize("t")
    assert excinfo.value.lane_fatal is False


# ---------------------------------------------------------------------------
# The security boundary: untrusted abstracts must not reach tools
# ---------------------------------------------------------------------------

def test_claude_code_is_invoked_with_no_tools(runs):
    runs["script"]["result"] = _FakeCompleted(
        stdout=json.dumps({"is_error": False, "result": "s"}),
    )
    _claude().summarize("t")
    argv = runs["calls"][0]["argv"]

    assert "--tools" in argv
    assert argv[argv.index("--tools") + 1] == ""
    assert "--strict-mcp-config" in argv
    assert "--disable-slash-commands" in argv


def test_claude_code_never_uses_bare_mode(runs):
    """--bare makes the CLI read ANTHROPIC_API_KEY only, defeating the lane."""
    runs["script"]["result"] = _FakeCompleted(
        stdout=json.dumps({"is_error": False, "result": "s"}),
    )
    _claude().summarize("t")
    assert "--bare" not in runs["calls"][0]["argv"]


def test_codex_pins_the_sandbox_read_only(runs):
    """Pinned regardless of the user's own config, which may allow anything."""
    runs["script"]["writes"] = "s"
    _codex().summarize("t")
    argv = runs["calls"][0]["argv"]

    assert argv[argv.index("-s") + 1] == "read-only"
    assert "--dangerously-bypass-approvals-and-sandbox" not in argv


def test_each_call_runs_in_a_fresh_empty_directory(runs):
    """No repository, no CLAUDE.md, nothing for an injected instruction to read."""
    runs["script"]["writes"] = "s"
    client = _codex()
    client.summarize("first")
    client.summarize("second")

    first, second = runs["calls"][0]["kwargs"]["cwd"], runs["calls"][1]["kwargs"]["cwd"]
    assert first != second


def test_stdin_is_closed(runs):
    """Both CLIs otherwise block reading a prompt that will never come."""
    runs["script"]["result"] = _FakeCompleted(
        stdout=json.dumps({"is_error": False, "result": "s"}),
    )
    _claude().summarize("t")
    assert runs["calls"][0]["kwargs"]["stdin"] is subprocess.DEVNULL


def test_a_timeout_is_always_applied(runs):
    runs["script"]["result"] = _FakeCompleted(
        stdout=json.dumps({"is_error": False, "result": "s"}),
    )
    _claude(timeout=42).summarize("t")
    assert runs["calls"][0]["kwargs"]["timeout"] == 42


# ---------------------------------------------------------------------------
# Prompt and model plumbing
# ---------------------------------------------------------------------------

def test_the_abstract_reaches_the_prompt(runs):
    runs["script"]["result"] = _FakeCompleted(
        stdout=json.dumps({"is_error": False, "result": "s"}),
    )
    _claude().summarize("a distinctive abstract phrase")
    assert any(
        "a distinctive abstract phrase" in str(arg)
        for arg in runs["calls"][0]["argv"]
    )


def test_the_model_is_passed_when_set_and_omitted_when_not(runs):
    runs["script"]["result"] = _FakeCompleted(
        stdout=json.dumps({"is_error": False, "result": "s"}),
    )
    _claude(model="opus").summarize("t")
    argv = runs["calls"][0]["argv"]
    assert argv[argv.index("--model") + 1] == "opus"

    runs["calls"].clear()
    _claude().summarize("t")
    assert "--model" not in runs["calls"][0]["argv"]


def test_client_exposes_the_pipeline_contract():
    """SummarizationPipeline reads .model and .provider off the client."""
    client = _claude(model="opus")
    assert client.provider == "claude_code"
    assert client.model == "opus"
    assert callable(client.summarize)
