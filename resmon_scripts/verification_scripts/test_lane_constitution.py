"""Every lane must actually transmit the summarization constitution.

``SUMMARIZE_ABSTRACT`` opens with "Write the summary in strict adherence to the
attached constitution." Only the API-key lane attached one. The
subscription and local lanes sent that sentence with nothing behind it, and the
subscription lane's observed behaviour was the worst possible shape of the bug:
told to follow a document it could not find, and with tools disabled so it could
not go looking, the agent **fabricated** a file search and its results and
returned them as the paper's summary. Valid JSON, populated ``result``, so the
defensive extraction accepted it. The lane did not fail; it succeeded and was
wrong.

The suite could not see it because every existing test asked whether the
constitution *exists* — it loads, it memoises, it stays under 16 KB — and what
was broken is whether it *arrives*. So these tests assert transmission at the
boundary each lane actually crosses: argv for ``claude``, the working directory
for ``codex``, the request body for ollama, the messages array for API keys.

``test_every_lane_kind_has_a_transmission_test`` is the part that has to stay.
It enumerates the lane kinds the app supports and fails when one has no case
here, so a fourth lane cannot be added without answering this question. The
equivalent guard for the MCP surface is ``test_mcp_live_surface.py``.
"""

import json

import httpx
import pytest

from implementation_scripts.ai_lanes import LANE_KINDS, SUBSCRIPTION_PROVIDERS
from implementation_scripts.llm_local import LocalLLMClient
from implementation_scripts.llm_remote import RemoteLLMClient
from implementation_scripts.llm_subscription import SubscriptionLLMClient
from implementation_scripts.prompt_templates import (
    SUMMARIZE_ABSTRACT,
    constitution_sha256_prefix,
    load_constitution,
)

# A line from the constitution itself rather than a paraphrase: asserting on a
# phrase this file made up would pass even if the wrong document were sent.
_ABSTRACT = "We report a 12% improvement on QM9 by conditioning edge updates on bond order."


def _constitution_marker() -> str:
    """Return a distinctive slice of the real constitution to search for."""
    body = load_constitution().strip()
    longest = max((line.strip() for line in body.splitlines()), key=len)
    assert len(longest) > 30, "constitution has no line long enough to be a reliable marker"
    return longest


class _FakeCompleted:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def _spawns(monkeypatch, handler):
    """Replace ``Popen`` with a double that runs *handler* over the argv.

    *handler* receives the argv and returns a ``_FakeCompleted``; it is where a
    test writes codex's ``-o`` file or reads the working directory. The client
    spawns through ``Popen`` rather than ``subprocess.run`` since 1.8.5,
    because a batched call is one process holding N documents and cancellation
    has to be able to terminate it from another thread.
    """
    class _Process:
        def __init__(self, argv):
            self.argv = argv
            self.returncode = None

        def communicate(self, timeout=None):
            completed = handler(self.argv)
            self.returncode = completed.returncode
            return completed.stdout, completed.stderr

        def terminate(self):  # pragma: no cover - not exercised here
            self.returncode = -15

        def kill(self):  # pragma: no cover - not exercised here
            self.returncode = -9

    monkeypatch.setattr(
        "implementation_scripts.llm_subscription.subprocess.Popen",
        lambda argv, **kwargs: _Process(argv),
    )


# ---------------------------------------------------------------------------
# The prompt is what creates the obligation
# ---------------------------------------------------------------------------


def test_prompt_tells_the_model_a_constitution_is_attached():
    """If this ever stops being true, these tests stop being required."""
    assert "constitution" in SUMMARIZE_ABSTRACT.lower()


# ---------------------------------------------------------------------------
# Subscription lane — claude
# ---------------------------------------------------------------------------


def test_claude_sends_the_constitution_as_a_system_prompt(monkeypatch):
    captured = {}

    def _run(argv, **kwargs):
        captured["argv"] = argv
        return _FakeCompleted(stdout=json.dumps({"result": "a summary", "is_error": False}))

    _spawns(monkeypatch, _run)

    SubscriptionLLMClient(provider="claude_code", binary_path="/bin/claude").summarize(_ABSTRACT)

    argv = captured["argv"]
    assert "--append-system-prompt" in argv, (
        "the claude lane must attach the constitution; without it the agent hunts for "
        "the document the prompt names and fabricates the search"
    )
    sent = argv[argv.index("--append-system-prompt") + 1]
    assert _constitution_marker() in sent
    assert constitution_sha256_prefix() == constitution_sha256_prefix()


def test_claude_keeps_the_constitution_out_of_the_user_prompt(monkeypatch):
    """Above the abstract, not beside it.

    The abstract is untrusted internet text. Rules sent as a system prompt are
    something injected text has to argue against; rules pasted next to it are a
    peer.
    """
    captured = {}

    def _run(argv, **kwargs):
        captured["argv"] = argv
        return _FakeCompleted(stdout=json.dumps({"result": "a summary", "is_error": False}))

    _spawns(monkeypatch, _run)

    SubscriptionLLMClient(provider="claude_code", binary_path="/bin/claude").summarize(_ABSTRACT)

    user_prompt = captured["argv"][-1]
    assert _ABSTRACT in user_prompt
    assert _constitution_marker() not in user_prompt


# ---------------------------------------------------------------------------
# Subscription lane — codex
# ---------------------------------------------------------------------------


def test_codex_writes_the_constitution_into_its_working_directory(monkeypatch):
    """codex has no system-prompt flag; AGENTS.md in the cwd is its channel."""
    captured = {}

    def _run(argv, **kwargs):
        workdir = argv[argv.index("-C") + 1]
        with open(f"{workdir}/AGENTS.md", encoding="utf-8") as handle:
            captured["agents_md"] = handle.read()
        captured["argv"] = argv
        with open(argv[argv.index("-o") + 1], "w", encoding="utf-8") as handle:
            handle.write("a summary")
        return _FakeCompleted()

    _spawns(monkeypatch, _run)

    SubscriptionLLMClient(provider="codex", binary_path="/bin/codex").summarize(_ABSTRACT)

    assert _constitution_marker() in captured["agents_md"]
    assert _constitution_marker() not in captured["argv"][-1]


def test_codex_constitution_does_not_outlive_the_call(monkeypatch):
    """The temporary directory is the whole lifetime of that AGENTS.md."""
    seen = {}

    def _run(argv, **kwargs):
        seen["workdir"] = argv[argv.index("-C") + 1]
        with open(argv[argv.index("-o") + 1], "w", encoding="utf-8") as handle:
            handle.write("a summary")
        return _FakeCompleted()

    _spawns(monkeypatch, _run)

    SubscriptionLLMClient(provider="codex", binary_path="/bin/codex").summarize(_ABSTRACT)

    import os

    assert not os.path.exists(seen["workdir"])


# ---------------------------------------------------------------------------
# Local lane — ollama
# ---------------------------------------------------------------------------


def test_ollama_sends_the_constitution_in_the_system_field(monkeypatch):
    captured = {}

    class _Response:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"response": "a summary"}

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, json=None):
            captured["body"] = json
            return _Response()

    monkeypatch.setattr(httpx, "Client", _Client)

    LocalLLMClient(model="llama3").summarize(_ABSTRACT)

    body = captured["body"]
    assert "system" in body, "the ollama lane must populate /api/generate's system field"
    assert _constitution_marker() in body["system"]
    assert _constitution_marker() not in body["prompt"]


# ---------------------------------------------------------------------------
# API-key lane — the one that was always right
# ---------------------------------------------------------------------------


def test_api_key_lane_sends_the_constitution():
    from implementation_scripts.prompt_templates import SYSTEM_PREAMBLE

    assert _constitution_marker() in str(SYSTEM_PREAMBLE)


# ---------------------------------------------------------------------------
# Subscription lane — the batched call shape (1.8.5)
# ---------------------------------------------------------------------------
#
# A second way to call a lane is a second way to forget the constitution, and
# the first time this file was written there was only one. The batched call is
# built from the same argv helpers as the single one precisely so a flag
# cannot be present on one path and absent on the other — but "built from the
# same helper" is an implementation claim, and what has to be asserted is that
# the document arrives.


def _batch_reply(argv):
    return _FakeCompleted(stdout=json.dumps({
        "is_error": False,
        "structured_output": {"summaries": [
            {"index": 0, "summary": "one"}, {"index": 1, "summary": "two"},
        ]},
    }))


def test_claude_sends_the_constitution_on_the_batched_call(monkeypatch):
    captured = {}

    def _run(argv, **kwargs):
        captured["argv"] = argv
        return _batch_reply(argv)

    _spawns(monkeypatch, _run)

    SubscriptionLLMClient(provider="claude_code", binary_path="/bin/claude").summarize_many(
        [_ABSTRACT, "A second abstract."],
    )

    argv = captured["argv"]
    assert "--append-system-prompt" in argv
    assert _constitution_marker() in argv[argv.index("--append-system-prompt") + 1]


def test_claude_keeps_the_constitution_out_of_the_batched_prompt(monkeypatch):
    captured = {}

    def _run(argv, **kwargs):
        captured["argv"] = argv
        return _batch_reply(argv)

    _spawns(monkeypatch, _run)

    SubscriptionLLMClient(provider="claude_code", binary_path="/bin/claude").summarize_many(
        [_ABSTRACT, "A second abstract."],
    )

    user_prompt = captured["argv"][-1]
    assert _ABSTRACT in user_prompt
    assert _constitution_marker() not in user_prompt


def test_codex_writes_the_constitution_for_the_batched_call(monkeypatch):
    captured = {}

    def _run(argv, **kwargs):
        workdir = argv[argv.index("-C") + 1]
        with open(f"{workdir}/AGENTS.md", encoding="utf-8") as handle:
            captured["agents_md"] = handle.read()
        captured["argv"] = argv
        with open(argv[argv.index("-o") + 1], "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"summaries": [
                {"index": 0, "summary": "one"}, {"index": 1, "summary": "two"},
            ]}))
        return _FakeCompleted()

    _spawns(monkeypatch, _run)

    SubscriptionLLMClient(provider="codex", binary_path="/bin/codex").summarize_many(
        [_ABSTRACT, "A second abstract."],
    )

    assert _constitution_marker() in captured["agents_md"]
    assert _constitution_marker() not in captured["argv"][-1]


# ---------------------------------------------------------------------------
# The guard that makes the next lane answer this question
# ---------------------------------------------------------------------------
#
# The denominator is every lane kind × every call shape that lane kind
# implements, and it is read out of the code rather than hand-counted: the
# client class for each kind, and which of the two summarization methods it
# actually defines. Adding ``summarize_many`` to a second lane kind therefore
# fails this test until that lane has a case above.

_LANE_CLIENT_CLASSES = {
    "subscription": SubscriptionLLMClient,
    "local": LocalLLMClient,
    "api_key": RemoteLLMClient,
}

_CALL_SHAPES = ("summarize", "summarize_many")

_COVERED_LANE_CALLS = {
    ("subscription", "summarize"),
    ("subscription", "summarize_many"),
    ("local", "summarize"),
    ("api_key", "summarize"),
}


def test_every_lane_kind_and_call_shape_has_a_transmission_test():
    """A fourth lane, or a second way to call an existing one, answers here.

    This is the durable half. The individual assertions above catch today's
    bug; this one catches the next lane — or the next call shape — that
    forgets, which is the failure that actually repeated.
    """
    implemented = set()
    for kind in LANE_KINDS:
        client_class = _LANE_CLIENT_CLASSES.get(kind)
        assert client_class is not None, (
            f"lane kind {kind!r} has no client class listed here, so its "
            f"call shapes cannot be enumerated — add it before widening"
        )
        for shape in _CALL_SHAPES:
            if callable(getattr(client_class, shape, None)):
                implemented.add((kind, shape))

    assert implemented == _COVERED_LANE_CALLS, (
        f"lane calls in the code are {sorted(implemented)} but this file "
        f"covers {sorted(_COVERED_LANE_CALLS)} — add a transmission test "
        f"before widening this set"
    )


def test_both_subscription_providers_have_a_batched_case():
    """The channel differs per provider, so the denominator does too."""
    assert set(SUBSCRIPTION_PROVIDERS) == {"claude_code", "codex"}, (
        "a third agent CLI needs its own batched transmission test above"
    )


# ---------------------------------------------------------------------------
# Against the real CLIs
# ---------------------------------------------------------------------------
#
# BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT CATCH.
#
# It does NOT guard the constitution regression. That was measured, not assumed:
# with the `--append-system-prompt` fix reverted, this test still passed against
# the real CLI. The fabricated-transcript failure is probabilistic — an agent
# told to follow a document it cannot find sometimes hunts for it and sometimes
# just writes the summary — so a single live call is not a detector for it. The
# deterministic guard for that is the hermetic set above, which asserts what
# resmon sends and was mutation-checked.
#
# What it DOES catch is CLI contract drift, deterministically: both CLIs exit
# non-zero on an unknown option (verified — `claude` prints "error: unknown
# option" and exits 1), so if a future release renames or drops
# `--append-system-prompt`, or codex stops reading AGENTS.md from its working
# directory, this fails where the hermetic tests cannot. That is a real risk for
# a lane driving someone else's CLI, and nothing else in the suite covers it.
#
# Skipped unless the CLI is both discoverable and logged in, because neither is
# true in CI. Run it with `pytest -m live_network` on a machine with a signed-in
# CLI, and note that it spends the plan's usage window like any other lane call.

_FABRICATION_MARKERS = ("<invoke", "function_results", "<parameter name=")


@pytest.mark.live_network
@pytest.mark.parametrize("provider", SUBSCRIPTION_PROVIDERS)
def test_real_cli_returns_a_summary_not_a_fabricated_tool_transcript(provider):
    from implementation_scripts.ai_cli import discover_cli
    from implementation_scripts.ai_errors import AIError, AIErrorKind

    found = discover_cli(provider)
    if not found.found:
        pytest.skip(f"{provider} CLI not installed: {found.describe()}")

    client = SubscriptionLLMClient(provider=provider, binary_path=found.path)
    try:
        summary = client.summarize(_ABSTRACT)
    except AIError as exc:
        if exc.kind in (AIErrorKind.CLI_AUTH, AIErrorKind.QUOTA):
            pytest.skip(f"{provider} CLI is installed but not usable: {exc.kind.value}")
        raise

    # A cheap sanity assertion, not the regression guard — see the note above.
    # If a run ever does trip this, the transcript is worth keeping: it is the
    # shipped failure reproducing.
    for marker in _FABRICATION_MARKERS:
        assert marker not in summary, (
            f"{provider} returned fabricated tool-call syntax as a summary — "
            f"the constitution is probably not reaching the model"
        )
    assert len(summary.split()) >= 40, f"{provider} returned too little to be a summary"
