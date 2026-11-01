"""Finite authored history cases: uncertainty cannot improve coverage."""
import json
import pytest
from implementation_scripts import source_coverage as coverage


def row(source="a", count=0, reason="answered_empty", **kwargs):
    return {"source": source, "status": "ok", "result_count": count,
            "zero_reason": reason, "recorded_at": "2026-01-01", **kwargs}


def project(params, rows=(), status="completed"):
    return coverage.build({"id": 7, "parameters": params, "status": status}, list(rows))


@pytest.mark.parametrize("params", [None, "broken", {}, {"repositories": []},
    {"repositories": "a"}, {"repositories": ["a", None]}, {"repositories": ["all"]},
    {"repositories": ["a"], "repository": "b"}, {"repositories": ["a", "b"], "repository": "a"},
    {"repository": "default"}, {"repositories": ["a", " "]}])
def test_unusable_selection_never_becomes_zero_selected(params):
    result = project(params)
    assert result["basis"] == "recorded" and not result["selection_known"]
    assert result["total"] == 0 and "No source outcomes were recorded" in result["summary"]
    assert "0/0" not in result["summary"]
    recorded = project(params, [row()])
    assert recorded["basis_label"] == "recorded sources" and recorded["total"] == 1


def test_exact_slug_selection_missing_and_additional_sources():
    result = project({"repositories": ["a", "a", "A", "missing"]}, [row(), row("extra")])
    assert [s["source"] for s in result["sources"]] == ["a", "A", "missing"]
    assert result["counts"] == {"answered": 1, "non_answer": 0, "unknown": 2, "genuine_empty": 1, "partial": 0,
                                "in_part": 0}
    assert [s["source"] for s in result["additional_sources"]] == ["extra"]
    assert all(not s["outcome_recorded"] for s in result["sources"][1:])
    assert "no attempt" in result["sources"][1]["note"]


def test_singular_and_matching_list_are_concrete_selection():
    for params in ({"repository": "a"}, {"repositories": ["a", "a"], "repository": "a"}):
        assert project(json.dumps(params))["total"] == 1
        assert project(params)["selection_known"]


@pytest.mark.parametrize("reason,expected", [(r, "non_answer" if r in coverage.zero_reason.DID_NOT_ANSWER else "unknown" if r == "not_recorded" else "answered") for r in coverage.zero_reason.ZERO_REASONS])
def test_every_existing_reason_has_one_exclusive_category(reason, expected):
    result = project({"repository": "a"}, [row(reason=reason)])
    assert result["sources"][0]["category"] == expected
    if reason == "window_unanswerable":
        assert result["sources"][0]["label"] == "could not answer this window"
    if reason == "parse_failure":
        assert result["sources"][0]["label"] == "reply unreadable"
    assert sum(result["counts"][k] for k in ("answered", "non_answer", "unknown")) == 1
    assert result["counts"]["genuine_empty"] == int(reason == "answered_empty")


@pytest.mark.parametrize("fields", [{"zero_reason": "future_reason"}, {"zero_detail": "bad"},
    {"zero_detail": "[]"}, {"zero_detail": '{"attempts":"oops"}', "zero_reason": "upstream_failure"},
    {"result_count": -1}, {"result_count": "bad"}, {"status": "future_status"}])
def test_malformed_outcomes_stay_unknown(fields):
    result = project({"repository": "a"}, [row(**fields)])
    assert result["counts"]["unknown"] == 1
    assert result["counts"]["genuine_empty"] == 0
    assert "malformed" in result["sources"][0]["note"]


def test_mixed_run_positive_rights_unusable_and_cap_do_not_mean_new_or_empty():
    rows = [row("positive", 100, None), row("empty"), row("failed", reason="upstream_failure"),
            row("parse", reason="parse_failure"), row("old", reason=None),
            row("rights", reason="rights_filtered"), row("unusable", reason="records_unusable")]
    result = project({"repositories": [r["source"] for r in rows], "max_results": 100}, rows)
    assert result["counts"] == {"answered": 4, "non_answer": 2, "unknown": 1, "genuine_empty": 1, "partial": 0,
                                "in_part": 0}
    assert "could not read" in result["sources"][3]["note"]
    assert "newly added" in result["sources"][0]["note"]
    assert any("does not prove truncation" in n for n in result["notes"])


def test_running_and_cancelled_keep_incomplete_note():
    for status in ("running", "cancelled", "failed"):
        assert any("not completed" in n for n in project({"repository": "a"}, status=status)["notes"])


@pytest.mark.parametrize("reason,detail", [
    ("upstream_failure", {"detail": "http_503", "status": 503, "attempts": 2}),
    ("upstream_failure", {"detail": "server_cooldown", "status": 429, "attempts": 1}),
    ("parse_failure", {"detail": "json"}),
])
def test_positive_terminal_issue_is_answered_and_partial(reason, detail):
    message = "Catalog Name returned 2 usable records before a terminal issue. The retained set may be incomplete."
    result = project({"repository": "a"}, [row(
        count=2, reason=reason,
        zero_detail={**detail, "partial": True, "returned": 2, "message": message},
    )])
    source = result["sources"][0]
    assert source["category"] == "answered"
    assert source["label"] == "answered, partial"
    assert source["partial"] is True
    assert result["counts"]["partial"] == 1
    assert source["note"] == message
    assert "may be incomplete" in source["note"]


def test_positive_reason_without_partial_fact_keeps_historical_rendering():
    result = project({"repository": "a"}, [row(
        count=2, reason="upstream_failure",
        zero_detail={"detail": "http_503", "status": 503, "attempts": 2},
    )])
    assert result["counts"]["partial"] == 0
    assert result["sources"][0]["label"] == "answered"


@pytest.mark.parametrize(("rows", "selected", "summary"), [
    ([row("a", 3, None)], ["a"], "1 selected source: 1 answered, 0 recorded non-answers, 0 unknown."),
    ([row("a", 3, None), row("b", reason="upstream_failure")], ["a", "b"],
     "2 selected sources: 1 answered, 1 recorded non-answer (could not answer), 0 unknown."),
    ([row("a", reason="upstream_failure"), row("b", reason="parse_failure")], ["a", "b", "c"],
     "3 selected sources: 0 answered, 2 recorded non-answers (could not answer), 1 unknown."),
    ([row("a", 3, None)], None, "1 recorded source: 1 answered, 0 recorded non-answers, 0 unknown."),
])
def test_the_summary_agrees_with_its_counts(rows, selected, summary):
    params = {"repositories": selected} if selected else None
    assert project(params, rows)["summary"] == summary


def test_a_source_still_being_asked_when_the_run_was_cancelled_did_not_fail_to_answer():
    cancelled = row("hal", status="cancelled", reason=None)
    result = project({"repository": "hal"}, [cancelled], status="cancelled")
    assert result["summary"] == (
        "1 selected source: 0 answered, 1 recorded non-answer (cancelled before it answered), 0 unknown.")
    assert "could not answer" not in result["summary"]

    both = project({"repositories": ["hal", "plos"]},
                   [row("hal", status="cancelled", reason=None), row("plos", status="cancelled", reason=None)],
                   status="cancelled")
    assert "2 recorded non-answers (cancelled before they answered)" in both["summary"]

    mixed = project({"repositories": ["hal", "plos"]},
                    [cancelled, row("plos", reason="upstream_failure")], status="cancelled")
    assert "2 recorded non-answers (1 could not answer, 1 cancelled before it answered)" in mixed["summary"]


def _refused(source, status=400):
    return row(source, 0, "upstream_failure", zero_detail=json.dumps({"status": status, "attempts": 1}))


def test_a_400_to_a_run_with_no_terms_is_said_to_be_the_empty_search():
    """A watch saved with no terms sent arXiv, DOAJ, and PLOS an empty search on
    every run, and each answered HTTP 400. The rows read as sources that could
    not be queried; the run says why."""
    built = project({"repositories": ["arxiv", "doaj", "crossref"], "query": "", "keywords": []},
                    [_refused("arxiv"), _refused("doaj"), _refused("crossref", status=503)])
    notes = {s["source"]: s["note"] for s in built["sources"]}
    assert notes["arxiv"].endswith(coverage.NO_TERMS_REFUSAL)
    assert notes["doaj"].endswith(coverage.NO_TERMS_REFUSAL)
    # A 503 is the source being down, whatever was asked.
    assert coverage.NO_TERMS_REFUSAL not in notes["crossref"]
    assert built["summary"].endswith(
        "This run had no search terms, so each source was sent an empty search; "
        "the 2 that answered HTTP 400 refused it for that reason.")


@pytest.mark.parametrize("params", [
    {"repositories": ["arxiv"], "query": "graph", "keywords": []},
    {"repositories": ["arxiv"], "query": "", "keywords": ["graph"]},
    {"repositories": ["arxiv"], "query": "", "keywords": [], "entity": {"profile_id": 1, "mode": "new_papers"}},
    # Saved parameters that record no words say nothing about what was searched.
    {"repositories": ["arxiv"]},
])
def test_a_400_is_not_blamed_on_terms_the_run_had_or_did_not_record(params):
    built = project(params, [_refused("arxiv")])
    assert coverage.NO_TERMS_REFUSAL not in built["sources"][0]["note"]
    assert "no search terms" not in built["summary"]
