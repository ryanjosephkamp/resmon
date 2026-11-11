"""A source that answered HTTP 429 is "rate-limited", never "did not answer".

A 429 is a source that is up and asking resmon to slow down. The person can
act on that differently from an outage: wait, or ask less often. So it has its
own words everywhere an outcome is shown, and where the source said when it
may be asked again (its Retry-After, or what was left of resmon's own wait for
it), that time is recorded as ``cooldown_until_utc`` and said as "try again
after about 3:40 PM" in this computer's time while it is still ahead.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from implementation_scripts import api_base, source_coverage, zero_reason


@pytest.fixture
def new_york(monkeypatch):
    """This computer's zone, held to one with a daylight-saving rule."""
    if not hasattr(time, "tzset"):
        pytest.skip("needs a settable local zone")
    monkeypatch.setenv("TZ", "America/New_York")
    time.tzset()
    yield
    monkeypatch.delenv("TZ")
    time.tzset()


@pytest.fixture(autouse=True)
def _fresh_outcome():
    api_base.reset_search_outcome()
    yield
    api_base.reset_search_outcome()


NOW = datetime(2026, 11, 10, 20, 0, tzinfo=timezone.utc)  # 3:00 PM in New York


def _limited(**extra) -> dict:
    return {"detail": "rate_limited", "status": 429, "attempts": 6, "waited_seconds": 155, **extra}


# ---------------------------------------------------------------------------
# What counts as rate-limited
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("reason, detail, expected", [
    ("upstream_failure", {"detail": "rate_limited", "status": 429}, True),
    ("upstream_failure", {"detail": "server_cooldown", "status": 429}, True),
    # A 503 also means a source is down, Retry-After or not.
    ("upstream_failure", {"detail": "server_cooldown", "status": 503}, False),
    ("upstream_failure", {"detail": "http_503", "status": 503}, False),
    ("upstream_failure", {"detail": "timeout"}, False),
    ("parse_failure", {"detail": "rate_limited"}, False),
    ("upstream_failure", None, False),
])
def test_only_a_429_is_rate_limited(reason, detail, expected):
    assert zero_reason.rate_limited(reason, detail) is expected


def test_the_label_is_rate_limited_and_never_did_not_answer():
    assert zero_reason.label("upstream_failure", _limited()) == "rate-limited"
    assert zero_reason.label("upstream_failure", {"detail": "http_503", "status": 503}) == "did not answer"
    # A search that read part of a window first still says how far it got.
    read = {"records": 50, "first_date": "2026-11-01"}
    assert zero_reason.label("upstream_failure", _limited(read=read)) == "read part of the window"


# ---------------------------------------------------------------------------
# The time to try again
# ---------------------------------------------------------------------------

def test_a_time_is_said_in_this_computers_clock_rounded_up(new_york):
    at = datetime(2026, 11, 10, 20, 39, 20, tzinfo=timezone.utc)
    assert zero_reason.clock_words(at, NOW) == "3:40 PM"
    assert zero_reason.clock_words(datetime(2026, 11, 10, 20, 40, tzinfo=timezone.utc), NOW) == "3:40 PM"
    # Another day says its day; another year, its year.
    assert zero_reason.clock_words(datetime(2026, 11, 11, 14, 5, tzinfo=timezone.utc), NOW) == "9:05 AM on November 11"
    assert zero_reason.clock_words(datetime(2027, 1, 2, 17, 0, tzinfo=timezone.utc), NOW) == "12:00 PM on January 2, 2027"


def test_a_time_is_said_only_while_it_is_ahead(new_york):
    ahead = {"cooldown_until_utc": "2026-11-10T20:40:00Z"}
    assert zero_reason.again_words(ahead, NOW) == "try again after about 3:40 PM"
    assert zero_reason.again_words(ahead, NOW + timedelta(hours=1)) is None
    assert zero_reason.again_words({}, NOW) is None
    assert zero_reason.again_words({"cooldown_until_utc": "not a time"}, NOW) is None


def test_the_sentence_says_what_happened_and_when_to_try_again(new_york):
    later = (datetime.now(timezone.utc) + timedelta(hours=2)).replace(microsecond=0)
    local = later.astimezone()
    sentence = zero_reason.sentence("arXiv", "upstream_failure",
                                    _limited(cooldown_until_utc=later.isoformat()))
    assert sentence.startswith(
        "arXiv rate-limited resmon: it answered HTTP 429 (too many requests) after 6 attempts, "
        "with 155 seconds of waiting between them. Try again after about ")
    assert f"{local.hour % 12 or 12}:" in sentence
    assert sentence.endswith("This is not a zero — the source did not answer.")
    assert "could not be queried" not in sentence


def test_a_503_that_named_a_time_says_it_too():
    later = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    sentence = zero_reason.sentence("Crossref", "upstream_failure",
                                    {"detail": "http_503", "status": 503, "attempts": 4,
                                     "cooldown_until_utc": later})
    assert sentence.startswith("Crossref could not be queried: HTTP 503 after 4 attempts.")
    assert "Try again after about " in sentence


def test_records_kept_before_a_429_say_it_rate_limited():
    sentence = zero_reason.partial_sentence("arXiv", "upstream_failure", _limited(), 50)
    assert sentence == ("arXiv returned 50 usable records before it rate-limited resmon (HTTP 429, "
                        "too many requests). The retained set may be incomplete.")


# ---------------------------------------------------------------------------
# Recorded where it happens
# ---------------------------------------------------------------------------

def test_a_reply_that_ends_a_search_records_its_retry_after():
    outcome = api_base.search_outcome()
    outcome.note_attempt()
    outcome.note_failure(429)
    before = time.time()
    outcome.note_cooldown(600)
    reason, detail = zero_reason.derive(outcome.snapshot())
    assert reason == "upstream_failure" and detail["detail"] == "rate_limited"
    until = zero_reason.cooldown_until(detail)
    assert until is not None and abs(until.timestamp() - (before + 600)) < 2
    assert detail["cooldown_until_utc"].endswith("Z")


@pytest.mark.parametrize("seconds", [None, 0, -5, float("inf"), float("nan")])
def test_a_wait_with_no_time_records_none(seconds):
    outcome = api_base.search_outcome()
    outcome.note_attempt()
    outcome.note_failure(429)
    outcome.note_cooldown(seconds)
    assert outcome.snapshot()["cooldown_until_utc"] is None


def test_a_later_attempt_clears_an_earlier_time():
    outcome = api_base.search_outcome()
    outcome.note_attempt()
    outcome.note_cooldown(600)
    outcome.note_attempt()
    assert outcome.snapshot()["cooldown_until_utc"] is None


def test_safe_request_records_the_retry_after_of_the_429_it_returns(monkeypatch):
    """Driven through ``safe_request`` with a stub transport: the time is taken from the reply."""
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "120"})

    real = httpx.Client

    class Stubbed(real):  # type: ignore[misc, valid-type]
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", Stubbed)
    before = time.time()
    response = api_base.safe_request("GET", "http://127.0.0.1:9/search", max_retries=0,
                                     retry_statuses=frozenset())
    assert response.status_code == 429
    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert zero_reason.rate_limited(reason, detail)
    until = zero_reason.cooldown_until(detail)
    assert until is not None and abs(until.timestamp() - (before + 120)) < 3


def test_a_cooldown_that_stops_a_request_records_what_was_left():
    limiter = api_base.RateLimiter(requests_per_second=100)
    limiter.defer(300, status_code=429)
    before = time.time()
    with pytest.raises(api_base.ServerCooldownActive):
        api_base.safe_request("GET", "http://127.0.0.1:9/search", rate_limiter=limiter, max_retries=0)
    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert (reason, detail["detail"], detail["status"]) == ("upstream_failure", "server_cooldown", 429)
    until = zero_reason.cooldown_until(detail)
    assert until is not None and abs(until.timestamp() - (before + 300)) < 3
    assert zero_reason.label(reason, detail) == "rate-limited"


# ---------------------------------------------------------------------------
# A run's coverage
# ---------------------------------------------------------------------------

def _row(source: str, *, count: int = 0, reason: str | None = None, detail: dict | None = None,
         status: str = "ok") -> dict:
    return {"source": source, "status": status, "result_count": count, "zero_reason": reason,
            "zero_detail": json.dumps(detail) if detail else None, "recorded_at": "2026-11-10 20:00:00"}


def test_the_coverage_names_a_rate_limited_source_and_counts_it():
    later = (datetime.now(timezone.utc) + timedelta(hours=1)).replace(microsecond=0)
    execution = {"id": 7, "status": "completed",
                 "parameters": json.dumps({"repositories": ["arxiv", "crossref", "plos"]})}
    rows = [_row("arxiv", reason="upstream_failure", detail=_limited(cooldown_until_utc=later.isoformat())),
            _row("crossref", reason="upstream_failure", detail={"detail": "timeout", "attempts": 4}),
            _row("plos", count=12)]
    coverage = source_coverage.build(execution, rows)
    arxiv, crossref, _ = coverage["sources"]
    assert (arxiv["label"], arxiv["rate_limited"], arxiv["category"]) == ("rate-limited", True, "non_answer")
    assert arxiv["cooldown_until_utc"] == later.isoformat().replace("+00:00", "Z")
    assert (crossref["label"], crossref["rate_limited"], crossref["cooldown_until_utc"]) == (
        "did not answer", False, None)
    assert coverage["counts"]["rate_limited"] == 1
    assert coverage["summary"].startswith(
        "3 selected sources: 1 answered, 2 recorded non-answers (1 rate-limited, 1 could not answer), 0 unknown.")


def test_records_kept_before_a_429_count_as_rate_limited_and_partial():
    execution = {"id": 8, "status": "completed", "parameters": json.dumps({"repositories": ["arxiv"]})}
    detail = {**_limited(), "partial": True, "returned": 50}
    coverage = source_coverage.build(execution, [_row("arxiv", count=50, reason="upstream_failure", detail=detail)])
    (arxiv,) = coverage["sources"]
    assert (arxiv["label"], arxiv["category"], arxiv["rate_limited"]) == ("answered, partial", "answered", True)
    assert coverage["counts"]["rate_limited"] == 1 and coverage["counts"]["non_answer"] == 0
