# resmon_scripts/verification_scripts/test_missing_required_key_report.py
"""End-to-end test: missing required key → completed status + footer section."""

import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import sweep_engine as se
from implementation_scripts import credential_manager as cm
from implementation_scripts.database import init_db, get_execution_by_id
from implementation_scripts.sweep_engine import SweepEngine
from implementation_scripts.api_base import BaseAPIClient


class _NullClient(BaseAPIClient):
    def get_name(self) -> str:
        return "core"

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        # Would return 0 results anyway if ever reached.
        return []


def test_missing_required_key_completes_with_footer(monkeypatch):
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)

    monkeypatch.setattr(se, "get_client", lambda _name: _NullClient())
    monkeypatch.setattr(cm, "get_credential", lambda _name: None)

    engine = SweepEngine(db_conn=conn, config={})
    result = engine.execute_dive("core", {"query": "x", "max_results": 1})

    # Execution must complete — never fail — solely because of a missing key.
    row = get_execution_by_id(conn, result["execution_id"])
    assert row["status"] == "completed"

    report_path = Path(result["report_path"])
    assert report_path.exists()
    text = report_path.read_text(encoding="utf-8")
    # The footer generalised in 1.8.6: it names every source that returned
    # nothing and why, rather than only the ones missing a key. A missing key
    # keeps its own wording, which was already the right sentence, and sits
    # with the sources that did not answer rather than those that answered.
    assert "## Sources that did not answer, and why" in text
    assert "## Sources that answered with nothing to keep" not in text
    assert "**CORE**: Selected, but the API key it requires was not configured" in text
    conn.close()


def test_a_zero_nothing_observed_is_reported_as_not_recorded(monkeypatch):
    """The zero this phase exists for: no key involved, nothing came back.

    Before 1.8.6 this report said nothing at all about the source. The
    sentence it carries now is built from what the outcome channel recorded,
    and a run that recorded nothing says "not recorded" rather than guessing.
    """
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)

    monkeypatch.setattr(se, "get_client", lambda _name: _NullClient())
    monkeypatch.setattr(cm, "get_credential", lambda _name: "a-key")

    engine = SweepEngine(db_conn=conn, config={})
    result = engine.execute_dive("core", {"query": "x", "max_results": 1})

    text = Path(result["report_path"]).read_text(encoding="utf-8")
    # _NullClient never calls safe_request, so nothing observed this zero, and
    # it is neither an answer nor a non-answer.
    assert "## Sources whose outcome was not recorded" in text
    assert "## Sources that answered with nothing to keep" not in text
    assert "## Sources that did not answer, and why" not in text
    assert "resmon did not record whether CORE answered on this run." in text
    conn.close()


def _section(text: str, heading: str) -> str:
    """The body under one ``##`` heading, up to the next one."""
    start = text.index(heading) + len(heading)
    end = text.find("\n## ", start)
    return text[start:] if end == -1 else text[start:end]


def test_a_quiet_source_and_a_refusal_are_never_under_one_heading():
    """A source that answered with nothing is a quiet field; one that could not
    answer the window says nothing about the field. The report used to list both
    under "Sources that returned nothing"."""
    from implementation_scripts.report_generator import generate_report
    from implementation_scripts import zero_reason

    def note(source: str, reason: str) -> dict:
        return {"source": source, "slug": source.lower(), "reason": reason,
                "sentence": zero_reason.sentence(source, reason, {"status": 503, "attempts": 2})}

    text = generate_report([], {
        "query": "x", "repositories": ["arxiv", "dblp", "crossref", "core", "hal"],
        "zero_notes": [
            note("arXiv", "answered_empty"),
            note("DBLP", "window_unanswerable"),
            note("Crossref", "upstream_failure"),
            note("CORE", "not_recorded"),
            {"source": "HAL", "slug": "hal", "reason": "error",
             "sentence": "The query failed: boom. This is not a zero — the source did not answer."},
        ],
        "total": 0, "new": 0,
    })
    answered = _section(text, "## Sources that answered with nothing to keep")
    refused = _section(text, "## Sources that did not answer, and why")
    unknown = _section(text, "## Sources whose outcome was not recorded")
    assert "**arXiv**" in answered and "**DBLP**" not in answered
    assert all(f"**{name}**" in refused for name in ("DBLP", "Crossref", "HAL"))
    assert "**arXiv**" not in refused and "**CORE**" not in refused
    assert "says nothing about what they hold" in refused
    assert "**CORE**" in unknown and "**arXiv**" not in unknown
    assert "returned nothing, and why" not in text


def test_every_zero_reason_lands_where_the_coverage_account_puts_it():
    """The report and the search record sort a source the same way."""
    from implementation_scripts.report_generator import _note_group
    from implementation_scripts import source_coverage, zero_reason

    for reason in zero_reason.ZERO_REASONS:
        category = source_coverage.outcome(
            {"source": "x", "status": "ok", "result_count": 0, "zero_reason": reason})["category"]
        assert _note_group({"reason": reason}) == category, reason
    assert _note_group({"reason": None}) == "unknown"
    assert _note_group({"reason": "a reason this build does not know"}) == "unknown"
    assert _note_group({"reason": "upstream_failure", "partial": True}) == "partial"
