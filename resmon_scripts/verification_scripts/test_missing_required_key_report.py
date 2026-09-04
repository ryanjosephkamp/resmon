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
    # keeps its own wording, which was already the right sentence.
    assert "Sources that returned nothing, and why" in text
    assert "**CORE**: Selected, but the API key it requires was not configured" in text
    conn.close()


def test_a_source_that_answered_with_nothing_says_so_in_the_report(monkeypatch):
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
    assert "Sources that returned nothing, and why" in text
    # _NullClient never calls safe_request, so nothing observed this zero.
    assert "resmon did not record whether CORE answered on this run." in text
    conn.close()
