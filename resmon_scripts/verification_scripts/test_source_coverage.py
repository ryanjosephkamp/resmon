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
    assert result["counts"] == {"answered": 1, "non_answer": 0, "unknown": 2, "genuine_empty": 1}
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
    assert result["counts"] == {"answered": 4, "non_answer": 2, "unknown": 1, "genuine_empty": 1}
    assert "could not read" in result["sources"][3]["note"]
    assert "newly added" in result["sources"][0]["note"]
    assert any("does not prove truncation" in n for n in result["notes"])


def test_running_and_cancelled_keep_incomplete_note():
    for status in ("running", "cancelled", "failed"):
        assert any("not completed" in n for n in project({"repository": "a"}, status=status)["notes"])
