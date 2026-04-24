# resmon_scripts/verification_scripts/test_sweep_engine_ephemeral.py
"""Test that SweepEngine threads exec_id onto API clients (IMPL-23)."""

import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import sweep_engine as se
from implementation_scripts.database import init_db
from implementation_scripts.sweep_engine import SweepEngine
from implementation_scripts.api_base import BaseAPIClient


class _CaptureClient(BaseAPIClient):
    """Minimal fake client that records the _exec_id seen at search time."""

    def __init__(self) -> None:
        self.seen_exec_id: int | None = None

    def get_name(self) -> str:
        return "capture"

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        self.seen_exec_id = self._exec_id
        return []


def test_sweep_engine_sets_exec_id_on_client(monkeypatch):
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)

    capture = _CaptureClient()
    monkeypatch.setattr(se, "get_client", lambda _name: capture)
    # Force the "missing key" branch into the non-required path so we don't
    # mistakenly skip the search call before the client is invoked.
    monkeypatch.setattr(se, "_REQUIRED_CREDENTIALS", {})

    engine = SweepEngine(db_conn=conn, config={})
    result = engine.execute_dive("capture", {"query": "x", "max_results": 1})

    assert result["execution_id"] is not None
    assert capture.seen_exec_id == result["execution_id"]
    conn.close()


def test_sweep_engine_emits_skip_event_on_missing_key(monkeypatch):
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)

    capture = _CaptureClient()
    monkeypatch.setattr(se, "get_client", lambda _name: capture)
    # Declare the fake repo as requiring a credential we won't provide.
    monkeypatch.setattr(
        se, "_REQUIRED_CREDENTIALS", {"capture": "capture_api_key"},
    )
    # Keyring fallback returns nothing → treated as missing.
    from implementation_scripts import credential_manager as cm
    monkeypatch.setattr(cm, "get_credential", lambda _name: None)

    engine = SweepEngine(db_conn=conn, config={})
    result = engine.execute_dive("capture", {"query": "x", "max_results": 1})

    from implementation_scripts.progress import progress_store
    events = progress_store.get_events(result["execution_id"])
    skip_events = [e for e in events if e.get("type") == "repo_skipped_missing_key"]
    assert len(skip_events) == 1
    assert skip_events[0]["repository"] == "capture"
    assert skip_events[0]["credential_name"] == "capture_api_key"
    conn.close()
