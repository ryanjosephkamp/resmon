"""Batching the subscription lane: one call for N papers (1.8.5 D2).

One agent-CLI call per paper was the dominant cost of this lane, and the
reason the 25-document cap and the not-default-for-bulk guard were correct.
Batching is what makes making it primary safe, so what these tests pin is not
"batching works" but the four things that make a batch *safe*:

* **One process for N documents**, or the whole exercise is pointless.
* **Failure order.** ``is_error`` is classified before any shape check,
  because an authentication failure arrives with ``is_error`` true and
  ``subtype`` still ``"success"`` — so a count check running first would
  report a dead session as a malformed answer and re-present it once per
  document.
* **Accounting by document, not by call.** A batch that falls back and then
  succeeds one paper at a time did not half-work.
* **Cancellation reaches inside a batch.** Ten papers in one process is one
  long silence; a cancel honoured only between calls makes the user wait it
  out.

The mapping rule is the fifth, and it is the one with a wrong answer that is
worse than an error: a duplicate or out-of-range index means one of the
summaries belongs to a different paper, and there is no way to tell which. The
whole batch is discarded rather than guessed at.
"""

import json
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.ai_chain import ChainRunner  # noqa: E402
from implementation_scripts.ai_errors import AIErrorKind  # noqa: E402
from implementation_scripts.ai_lanes import (  # noqa: E402
    DEFAULT_SUBSCRIPTION_BATCH_SIZE,
    AILane,
)
from implementation_scripts.database import (  # noqa: E402
    get_execution_ai,
    init_db,
    insert_execution,
)
from implementation_scripts.llm_subscription import SubscriptionLLMClient  # noqa: E402


# ---------------------------------------------------------------------------
# A process double that counts spawns
# ---------------------------------------------------------------------------

class _Spawns:
    """Records every ``Popen`` and answers it from a scripted queue.

    The spawn count is the whole point: "one call for ten documents" is a
    claim about processes, and nothing short of counting them establishes it.
    """

    def __init__(self):
        self.argv: list[list[str]] = []
        self.processes: list = []
        self.responses: list = []
        self.default = None

    def install(self, monkeypatch):
        monkeypatch.setattr(
            "implementation_scripts.llm_subscription.subprocess.Popen",
            self._popen,
        )
        return self

    @property
    def count(self) -> int:
        return len(self.argv)

    def _popen(self, argv, **kwargs):
        self.argv.append(list(argv))
        response = (
            self.responses.pop(0) if self.responses else self.default
        )
        process = _Process(argv, response, kwargs)
        self.processes.append(process)
        return process


class _Process:
    def __init__(self, argv, response, kwargs):
        self.argv = list(argv)
        self.kwargs = kwargs
        self._response = response
        self.returncode = None
        self.terminated = False
        self.killed = False
        self.timeout = None

    def communicate(self, timeout=None):
        self.timeout = timeout
        response = self._response
        if callable(response):
            response = response(self.argv, self)
        if isinstance(response, BaseException):
            raise response
        stdout, stderr, code = response
        self.returncode = code
        return stdout, stderr

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def kill(self):
        self.killed = True
        self.returncode = -9


def _claude_batch_reply(summaries: dict, **extra) -> tuple:
    """A ``claude --output-format json`` envelope carrying *summaries*."""
    payload = {
        "is_error": False,
        "subtype": "success",
        "structured_output": {
            "summaries": [
                {"index": i, "summary": text} for i, text in sorted(summaries.items())
            ],
        },
    }
    payload.update(extra)
    return json.dumps(payload), "", 0


def _claude_single_reply(text: str) -> tuple:
    return json.dumps({"is_error": False, "result": text}), "", 0


def _claude(**kw):
    return SubscriptionLLMClient("claude_code", "/fake/claude", **kw)


def _docs(n: int) -> list[str]:
    return [f"Abstract number {i} about a distinct topic." for i in range(n)]


# ---------------------------------------------------------------------------
# P3 — one batch, one process
# ---------------------------------------------------------------------------

def test_a_batch_of_ten_spawns_one_process(monkeypatch):
    spawns = _Spawns().install(monkeypatch)
    spawns.default = _claude_batch_reply({i: f"Summary {i}." for i in range(10)})

    results = _claude().summarize_many(_docs(10))

    assert spawns.count == 1, (
        f"ten documents spawned {spawns.count} processes; batching exists to "
        f"make that one"
    )
    assert results == [f"Summary {i}." for i in range(10)]


def test_the_batch_prompt_carries_every_document_once(monkeypatch):
    spawns = _Spawns().install(monkeypatch)
    spawns.default = _claude_batch_reply({i: f"S{i}" for i in range(3)})

    texts = ["alpha-marker", "beta-marker", "gamma-marker"]
    _claude().summarize_many(texts)

    prompt = spawns.argv[0][-1]
    for text in texts:
        assert prompt.count(text) == 1, f"{text} appeared {prompt.count(text)} times"
    assert "DOCUMENT 0" in prompt and "DOCUMENT 2" in prompt


def test_the_schema_does_not_pin_the_number_of_summaries(monkeypatch):
    """Measured, not assumed — see the note in ``prompt_templates``.

    Both installed CLIs enforce ``minItems``/``maxItems`` by making the model
    fabricate the missing entry: claude 2.1.258 and codex 0.153.0-alpha.5 were
    each given a three-item schema and two documents, and each invented a
    third summary and reported success. A short array is a fact resmon acts
    on; a padded one is a fabricated summary attached to a real paper.
    """
    spawns = _Spawns().install(monkeypatch)
    spawns.default = _claude_batch_reply({0: "S0", 1: "S1"})

    _claude().summarize_many(_docs(2))

    argv = spawns.argv[0]
    schema = json.loads(argv[argv.index("--json-schema") + 1])
    array = schema["properties"]["summaries"]
    assert "minItems" not in array
    assert "maxItems" not in array


# ---------------------------------------------------------------------------
# P5 — the failure order
# ---------------------------------------------------------------------------

def test_is_error_is_classified_before_the_count_is_checked(monkeypatch):
    """An auth failure arrives with ``subtype`` still reading "success".

    The envelope below is well-formed and has no ``structured_output``, so a
    shape check running first would call it a malformed answer — document-
    local — and the chain would re-present a dead session once per paper.
    """
    spawns = _Spawns().install(monkeypatch)
    spawns.default = (
        json.dumps({
            "is_error": True,
            "subtype": "success",
            "result": "Failed to authenticate: OAuth session expired",
        }), "", 1,
    )

    from implementation_scripts.ai_errors import AIError

    with pytest.raises(AIError) as excinfo:
        _claude().summarize_many(_docs(5))

    assert excinfo.value.kind is AIErrorKind.CLI_AUTH
    assert excinfo.value.lane_fatal is True
    assert spawns.count == 1, "a lane-fatal batch must not retry anything"


def test_a_quota_failure_is_lane_fatal_from_a_batch(monkeypatch):
    spawns = _Spawns().install(monkeypatch)
    spawns.default = (
        json.dumps({"is_error": True, "result": "Usage limit reached; resets at 5pm"}),
        "", 1,
    )
    from implementation_scripts.ai_errors import AIError

    with pytest.raises(AIError) as excinfo:
        _claude().summarize_many(_docs(4))
    assert excinfo.value.kind is AIErrorKind.QUOTA
    assert spawns.count == 1


@pytest.mark.parametrize("envelope,why", [
    ({"is_error": False, "subtype": "error_max_structured_output_retries"},
     "the CLI gave up on the schema"),
    ({"is_error": False, "subtype": "success"},
     "success with no structured_output is a failure, not an answer"),
])
def test_document_local_batch_failures_do_not_demote(monkeypatch, envelope, why):
    spawns = _Spawns().install(monkeypatch)
    spawns.default = (json.dumps(envelope), "", 0)

    results = _claude().summarize_many(_docs(3))

    assert results == [None, None, None], why
    assert spawns.count == 1


def test_an_out_of_range_index_discards_the_whole_batch(monkeypatch):
    """The mapping cannot be trusted, and a wrong mapping is silent."""
    spawns = _Spawns().install(monkeypatch)
    spawns.default = _claude_batch_reply({0: "S0", 1: "S1", 7: "S7"})

    assert _claude().summarize_many(_docs(3)) == [None, None, None]


def test_a_duplicate_index_discards_the_whole_batch(monkeypatch):
    """One of those two summaries belongs to another paper."""
    spawns = _Spawns().install(monkeypatch)
    spawns.default = (
        json.dumps({
            "is_error": False,
            "structured_output": {"summaries": [
                {"index": 0, "summary": "S0"},
                {"index": 0, "summary": "a different S0"},
                {"index": 1, "summary": "S1"},
            ]},
        }), "", 0,
    )

    assert _claude().summarize_many(_docs(3)) == [None, None, None]


def test_a_short_array_keeps_what_arrived(monkeypatch):
    """A missing entry is handled; only the mapping is all-or-nothing."""
    spawns = _Spawns().install(monkeypatch)
    spawns.default = _claude_batch_reply({0: "S0", 2: "S2"})

    assert _claude().summarize_many(_docs(3)) == ["S0", None, "S2"]


def test_a_batch_timeout_halves_rather_than_going_straight_to_one(monkeypatch):
    """N spawns is the ceiling, not the default."""
    spawns = _Spawns().install(monkeypatch)
    timeout = subprocess.TimeoutExpired(cmd="claude", timeout=1)
    # First call (4 docs) times out; both halves of 2 then answer.
    spawns.responses = [
        timeout,
        _claude_batch_reply({0: "A", 1: "B"}),
        _claude_batch_reply({0: "C", 1: "D"}),
    ]

    assert _claude().summarize_many(_docs(4)) == ["A", "B", "C", "D"]
    assert spawns.count == 3, (
        "a four-document timeout should cost three calls, not five"
    )


def test_a_single_document_timeout_stops_halving(monkeypatch):
    spawns = _Spawns().install(monkeypatch)
    spawns.default = subprocess.TimeoutExpired(cmd="claude", timeout=1)

    assert _claude().summarize_many(_docs(2)) == [None, None]
    # 2 -> 1 + 1: three calls total, and no infinite descent.
    assert spawns.count == 3


def test_the_batch_timeout_scales_with_the_document_count(monkeypatch):
    spawns = _Spawns().install(monkeypatch)
    spawns.default = _claude_batch_reply({i: f"S{i}" for i in range(10)})

    client = _claude()
    client.summarize_many(_docs(10))

    assert spawns.processes[0].timeout == client.batch_timeout(10)
    assert client.batch_timeout(10) > client.batch_timeout(1)


# ---------------------------------------------------------------------------
# P7 — cancellation reaches inside a batch
# ---------------------------------------------------------------------------

def test_cancel_terminates_the_process_running_the_batch(monkeypatch):
    spawns = _Spawns().install(monkeypatch)
    client = _claude()
    started = threading.Event()
    release = threading.Event()

    def _slow(argv, process):
        started.set()
        release.wait(5)
        return "", "", -15

    spawns.default = _slow

    worker = threading.Thread(
        target=lambda: client.summarize_many(_docs(5)), daemon=True,
    )
    worker.start()
    assert started.wait(5), "the batch never started"

    client.cancel()
    release.set()
    worker.join(5)

    assert spawns.processes[0].terminated is True


def test_a_cancelled_client_refuses_to_start_another_batch(monkeypatch):
    spawns = _Spawns().install(monkeypatch)
    spawns.default = _claude_batch_reply({0: "S0"})

    client = _claude()
    client.cancel()
    results = client.summarize_many(_docs(3))

    assert spawns.count == 0, "cancel must prevent the next spawn, not only the current one"
    assert results == [None, None, None]


# ---------------------------------------------------------------------------
# P6 — accounting by document, through a real ChainRunner and a real row
# ---------------------------------------------------------------------------

@pytest.fixture
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
        "start_time": "2026-09-03T00:00:00Z",
        "status": "running",
    })


class _FakeSubscriptionClient:
    """Declares the batching capability the way the real client does."""

    provider = "claude_code"
    model = None
    supports_batch_calls = True

    def __init__(self, many, single=None):
        self._many = many
        self._single = single
        self.many_calls = 0
        self.single_calls = 0

    def summarize_many(self, texts, prompt_params=None):
        self.many_calls += 1
        result = self._many
        if isinstance(result, BaseException):
            raise result
        if callable(result):
            return result(texts)
        return list(result)

    def summarize(self, text, prompt_params=None):
        self.single_calls += 1
        if isinstance(self._single, BaseException):
            raise self._single
        return self._single


def _runner(conn, exec_id, client, *, batch_size=3, doc_cap=None):
    lane = AILane(
        kind="subscription", provider="claude_code",
        batch_size=batch_size, doc_cap=doc_cap,
    )
    return ChainRunner(
        [lane], db=conn, exec_id=exec_id,
        prompt_params={"_show_audit_prefix": False},
        primary_client=client,
    )


def test_a_batch_that_falls_back_and_recovers_records_ok(conn):
    """P6: attempted = N, succeeded = N, outcome = ok.

    The lane answered for every document. That it needed a second call for
    two of them is a speed fact, not a correctness one, and counting the
    retries as fresh attempts would make a lane that worked look like a lane
    that half-worked.
    """
    exec_id = _an_execution(conn)
    client = _FakeSubscriptionClient(
        many=lambda texts: ["S0", None, None],
        single="recovered summary",
    )
    runner = _runner(conn, exec_id, client)

    results = runner.summarize_documents(_docs(3))
    runner.finish()

    assert [r[0] for r in results] == ["S0", "recovered summary", "recovered summary"]
    assert client.many_calls == 1
    assert client.single_calls == 2, "each missed document is retried exactly once"

    row = get_execution_ai(conn, exec_id)[0]
    assert row["docs_attempted"] == 3
    assert row["docs_succeeded"] == 3
    assert row["outcome"] == "ok"
    assert "fell back to per-document calls" in (row["safe_message"] or "")


def test_a_lane_fatal_batch_retries_nothing_on_that_lane(conn):
    """P5: zero individual retries, and every document moves on."""
    from implementation_scripts.ai_errors import AIError

    exec_id = _an_execution(conn)
    client = _FakeSubscriptionClient(
        many=AIError(kind=AIErrorKind.CLI_AUTH, message="not logged in"),
        single="should never be called",
    )
    runner = _runner(conn, exec_id, client)

    results = runner.summarize_documents(_docs(3))
    runner.finish()

    assert client.single_calls == 0, (
        "a lane-fatal batch must not be retried once per document"
    )
    assert all(summary == "" for summary, _ in results)
    row = get_execution_ai(conn, exec_id)[0]
    assert row["docs_attempted"] == 3
    assert row["docs_succeeded"] == 0
    assert row["outcome"] == "failed"
    assert row["error_kind"] == "cli_auth"


def test_a_lane_fatal_batch_hands_every_document_to_the_next_lane(conn):
    from implementation_scripts.ai_errors import AIError

    exec_id = _an_execution(conn)
    failing = _FakeSubscriptionClient(
        many=AIError(kind=AIErrorKind.CLI_AUTH, message="not logged in"),
    )

    class _Fallback:
        provider, model = "local", "llama3"

        def summarize(self, text, prompt_params=None):
            return "fallback summary"

    lanes = [
        AILane(kind="subscription", provider="claude_code", batch_size=3),
        AILane(kind="local", provider="local", model="llama3"),
    ]
    runner = ChainRunner(
        lanes, db=conn, exec_id=exec_id,
        prompt_params={"_show_audit_prefix": False},
        primary_client=failing,
    )
    import unittest.mock as _mock
    with _mock.patch(
        "implementation_scripts.llm_factory.build_client_for_lane",
        return_value=_Fallback(),
    ):
        results = runner.summarize_documents(_docs(3))
    runner.finish()

    assert [r[0] for r in results] == ["fallback summary"] * 3
    rows = {r["lane_index"]: r for r in get_execution_ai(conn, exec_id)}
    assert rows[0]["outcome"] == "failed"
    assert rows[1]["docs_attempted"] == 3
    assert rows[1]["outcome"] == "ok"


def test_the_document_cap_still_bounds_a_batching_lane(conn):
    """The guard rail is per document, and a batch must not step over it."""
    exec_id = _an_execution(conn)
    client = _FakeSubscriptionClient(many=lambda texts: [f"S{i}" for i in range(len(texts))])
    runner = _runner(conn, exec_id, client, batch_size=4, doc_cap=5)

    runner.summarize_documents(_docs(9))
    runner.finish()

    row = get_execution_ai(conn, exec_id)[0]
    assert row["docs_attempted"] == 5, "the cap was exceeded by batching past it"
    assert "limit of 5 documents" in (row["safe_message"] or "")


def test_a_non_batching_lane_is_unchanged(conn):
    """An API-key lane has batch_size 1 and walks documents one at a time."""
    exec_id = _an_execution(conn)

    class _Remote:
        provider, model = "anthropic", "claude-3-5-sonnet"
        calls = 0

        def summarize(self, text, prompt_params=None):
            _Remote.calls += 1
            return "remote summary"

    lane = AILane(kind="api_key", provider="anthropic", model="claude-3-5-sonnet")
    assert lane.batch_size == 1
    runner = ChainRunner(
        [lane], db=conn, exec_id=exec_id,
        prompt_params={"_show_audit_prefix": False},
        primary_client=_Remote(),
    )
    results = runner.summarize_documents(_docs(4))
    runner.finish()

    assert [r[0] for r in results] == ["remote summary"] * 4
    assert _Remote.calls == 4
    assert get_execution_ai(conn, exec_id)[0]["docs_attempted"] == 4


def test_the_default_subscription_batch_size_is_five():
    """Measured, not assumed — and the measurement changed it from ten.

    Batching does not improve monotonically with size. On 25 real abstracts
    claude took 6.1s per paper at five and 6.9s at ten; codex took 5.3s at
    five and 8.0s at ten. Ten also produced fewer summaries inside the
    word-count band on real abstracts (19/25 against 21/25).

    Changing this is a product decision backed by
    ``verification_scripts/measure_subscription_batching.py``, not a refactor.
    """
    assert DEFAULT_SUBSCRIPTION_BATCH_SIZE == 5
    assert AILane(kind="subscription", provider="codex").batch_size == 5


def test_an_empty_summary_string_counts_as_missing(monkeypatch):
    """A slot filled with whitespace is not an answer."""
    spawns = _Spawns().install(monkeypatch)
    spawns.default = (
        json.dumps({
            "is_error": False,
            "structured_output": {"summaries": [
                {"index": 0, "summary": "S0"},
                {"index": 1, "summary": "   "},
                {"index": 2, "summary": ""},
            ]},
        }), "", 0,
    )
    assert _claude().summarize_many(_docs(3)) == ["S0", None, None]


# ---------------------------------------------------------------------------
# The leakage detector, checked against a leak
# ---------------------------------------------------------------------------

def test_the_canary_leak_detector_can_actually_detect_a_leak():
    """D3 reports "0 leaks". A detector that always says zero would too.

    This is the check that makes P9's zero mean something. It is not testing
    resmon; it is testing the instrument, which is the thing the phase's whole
    accuracy claim about batching rests on.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "measure",
        str(PROJECT_ROOT / "resmon_scripts" / "verification_scripts"
            / "measure_subscription_batching.py"),
    )
    measure = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(measure)

    tokens = ["AAA-1", "BBB-2", "CCC-3"]

    clean = ["about AAA-1", "about BBB-2", "about CCC-3"]
    assert measure.leaked(clean, tokens) == []

    # Document 1's summary mentions document 0's token: that is the failure
    # batching could introduce, and the detector must name it.
    dirty = ["about AAA-1", "about BBB-2 and also AAA-1", "about CCC-3"]
    assert measure.leaked(dirty, tokens) == [(1, "AAA-1")]

    # A document mentioning its own token is not a leak.
    assert measure.leaked(["AAA-1 AAA-1", "BBB-2", "CCC-3"], tokens) == []

    # An unanswered slot cannot leak.
    assert measure.leaked([None, "BBB-2", "CCC-3"], tokens) == []


# ---------------------------------------------------------------------------
# Against the real CLIs
# ---------------------------------------------------------------------------
#
# BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT CATCH — the same warning that
# sits on `test_real_cli_returns_a_summary_not_a_fabricated_tool_transcript`,
# for the same reason.
#
# It does NOT guard batching's accuracy. Leakage between documents in one batch
# is probabilistic, so one live call is not a detector for it; D3's script
# measures it as a rate over canary tokens, and even that measures leakage of
# *unrelated* content, which is the easy case.
#
# What it DOES catch, deterministically, is **structured-output contract
# drift**. `--json-schema` (claude, inline) and `--output-schema` (codex, a
# file path) are the two flags the batched path is built on, and both CLIs exit
# non-zero on an unknown option. If a future release renames or drops either,
# or moves the validated object out of `structured_output`, this fails where
# the hermetic tests cannot — and the hermetic tests would go on passing
# against a double that still speaks the old contract.
#
# Skipped unless the CLI is discoverable and signed in, because neither is true
# in CI. It spends the plan's usage window like any other lane call.

@pytest.mark.live_network
@pytest.mark.parametrize("provider", ["claude_code", "codex"])
def test_the_real_cli_answers_a_batch_with_one_summary_per_document(provider):
    from implementation_scripts.ai_cli import discover_cli
    from implementation_scripts.ai_errors import AIError, AIErrorKind

    found = discover_cli(provider)
    if not found.found:
        pytest.skip(f"{provider} CLI not installed: {found.describe()}")

    texts = [
        "Title: Thermal drift in layered sensors\n\nAbstract: We characterise "
        "the thermal drift of a layered sensing lattice across 240 hours of "
        "continuous operation. Drift was 0.4 mK per hour under nominal load.",
        "Title: A retrieval benchmark for procedural corpora\n\nAbstract: We "
        "report baseline retrieval scores for sparse and dense methods and "
        "find that sparse retrieval remains competitive on procedural queries.",
        "Title: Population dynamics of a ground beetle\n\nAbstract: Field "
        "surveys across eleven sites record seasonal abundance. Abundance "
        "peaked in late June and correlated with soil moisture.",
    ]

    client = SubscriptionLLMClient(provider=provider, binary_path=found.path)
    try:
        summaries = client.summarize_many(texts)
    except AIError as exc:
        if exc.kind in (AIErrorKind.CLI_AUTH, AIErrorKind.QUOTA):
            pytest.skip(f"{provider} CLI is installed but not usable: {exc.kind.value}")
        raise

    assert len(summaries) == len(texts)
    assert all(s and s.strip() for s in summaries), (
        f"{provider} returned {sum(1 for s in summaries if s)} of {len(texts)} "
        f"summaries — the structured-output contract may have drifted"
    )
    # Each summary must be about its own document. A cheap sanity check, not
    # the leakage detector: D3's script measures that as a rate.
    assert "beetle" not in (summaries[0] or "").lower()
