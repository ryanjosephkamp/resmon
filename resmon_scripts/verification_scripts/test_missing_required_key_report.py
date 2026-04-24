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
    assert "Repositories Skipped Due to Missing API Keys" in text
    assert "core: required API key not provided — 0 results returned." in text
    conn.close()
