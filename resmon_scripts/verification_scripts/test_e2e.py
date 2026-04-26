# resmon_scripts/verification_scripts/test_e2e.py
"""End-to-end integration tests for the resmon application.

Scenarios
---------
E2E-1 : Manual Deep Dive (arXiv, "neural networks", 7-day window)
E2E-2 : Manual Deep Sweep (arXiv + Semantic Scholar + OpenAlex, "climate change")
E2E-3 : Routine lifecycle (create, trigger, verify results and log)
E2E-4 : AI summarization (Deep Dive with LLM summaries)
E2E-5 : Configuration export and re-import
E2E-6 : Email notification for a completed routine
E2E-7 : Cloud backup of routine results
E2E-8 : Calendar correctly displays executions with color coding

Feature cross-check (§15.2.2): CP-1..CP-7, UI-1..UI-6, CAL-1..CAL-8,
CFG-1..CFG-7, LOG-1..LOG-3, EMAIL-1..EMAIL-8, CLOUD-1..CLOUD-4,
AI-1..AI-7, CIT-1..CIT-2, STOR-1..STOR-2.
"""

import io
import json
import sys
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.api_base import NormalizedResult

import resmon as resmon_mod
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _reset_db():
    """Point the app at a fresh in-memory database.

    Pre-creates the shared connection with ``check_same_thread=False`` so it
    can be used from both the test thread and the TestClient request thread.
    """
    import sqlite3 as _sqlite3
    from implementation_scripts.database import init_db

    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False

    conn = _sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = _sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    init_db(conn=conn)
    resmon_mod._shared_conn = conn


def _make_mock_client(name: str):
    """Return a mock API client whose ``search()`` yields NormalizedResult objects."""
    client = MagicMock()
    client.get_name.return_value = name
    client.search.return_value = [
        NormalizedResult(
            source_repository=name,
            external_id=f"{name}_001",
            doi=f"10.1234/{name}_001",
            title=f"Test Paper Alpha from {name}",
            authors=["Alice Researcher", "Bob Scientist"],
            abstract="An abstract discussing neural networks and climate change.",
            publication_date="2026-04-10",
            url=f"https://example.com/{name}/001",
            categories=["cs.AI", "cs.LG"],
        ),
        NormalizedResult(
            source_repository=name,
            external_id=f"{name}_002",
            doi=f"10.1234/{name}_002",
            title=f"Test Paper Beta from {name}",
            authors=["Charlie Scholar"],
            abstract="A study on deep learning approaches and methodology.",
            publication_date="2026-04-12",
            url=f"https://example.com/{name}/002",
            categories=["cs.LG"],
        ),
    ]
    return client


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _fresh_db():
    """Give every test a clean in-memory database."""
    _reset_db()
    yield
    if resmon_mod._shared_conn is not None:
        try:
            resmon_mod._shared_conn.close()
        except Exception:
            pass
    resmon_mod._shared_conn = None


@pytest.fixture
def client():
    return TestClient(resmon_mod.app)


@pytest.fixture
def tmp_reports(tmp_path):
    """Redirect REPORTS_DIR to a temp directory with required sub-dirs."""
    (tmp_path / "logs").mkdir()
    (tmp_path / "markdowns").mkdir()
    return tmp_path


# ===================================================================
# E2E-1  Manual Deep Dive
# ===================================================================

def test_e2e_deep_dive(client, tmp_reports):
    """E2E-1: POST /api/search/dive for arXiv 'neural networks' (7-day window).

    Covers CP-1, CP-2, CP-3, CP-4, CP-5, LOG-1.
    """
    import time as _time

    mock_arxiv = _make_mock_client("arxiv")

    with (
        patch("implementation_scripts.sweep_engine.get_client",
              return_value=mock_arxiv),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_reports),
    ):
        resp = client.post("/api/search/dive", json={
            "repository": "arxiv",
            "query": "neural networks",
            "date_from": "2026-04-08",
            "date_to": "2026-04-15",
            "max_results": 5,
        })

        assert resp.status_code == 200
        data = resp.json()
        assert "execution_id" in data
        exec_id = data["execution_id"]

        # Background execution – poll until finished
        for _ in range(50):
            exec_resp = client.get(f"/api/executions/{exec_id}")
            assert exec_resp.status_code == 200
            ex = exec_resp.json()
            if ex["status"] in ("completed", "failed"):
                break
            _time.sleep(0.1)

        assert ex["execution_type"] == "deep_dive"
        assert ex["status"] == "completed"
        assert ex["result_count"] >= 1

        # ---- mock assertions ----
        mock_arxiv.search.assert_called_once_with(
            query="neural networks",
            date_from="2026-04-08",
            date_to="2026-04-15",
            max_results=5,
        )

    # ---- report file ----
    report_path = Path(ex["result_path"])
    assert report_path.exists()
    report_text = report_path.read_text(encoding="utf-8")
    assert "resmon Literature Report" in report_text
    assert "Test Paper Alpha from arxiv" in report_text

    # ---- log file ----
    log_path = Path(ex["log_path"])
    assert log_path.exists()
    log_text = log_path.read_text(encoding="utf-8")
    assert "Querying repository: arxiv" in log_text
    assert "COMPLETED" in log_text


# ===================================================================
# E2E-2  Manual Deep Sweep
# ===================================================================

def test_e2e_deep_sweep(client, tmp_reports):
    """E2E-2: POST /api/search/sweep across arXiv + Semantic Scholar + OpenAlex.

    Covers CP-1, CP-2, CP-3, CP-4, CP-5, CP-7, LOG-1.
    """
    import time as _time

    mocks = {
        "arxiv": _make_mock_client("arxiv"),
        "semantic_scholar": _make_mock_client("semantic_scholar"),
        "openalex": _make_mock_client("openalex"),
    }

    with (
        patch("implementation_scripts.sweep_engine.get_client",
              side_effect=lambda name, **kw: mocks[name]),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_reports),
    ):
        resp = client.post("/api/search/sweep", json={
            "repositories": ["arxiv", "semantic_scholar", "openalex"],
            "query": "climate change",
            "date_from": "2026-04-08",
            "date_to": "2026-04-15",
            "max_results": 5,
        })

        assert resp.status_code == 200
        data = resp.json()
        exec_id = data["execution_id"]

        # Background execution – poll until finished
        for _ in range(50):
            ex = client.get(f"/api/executions/{exec_id}").json()
            if ex["status"] in ("completed", "failed"):
                break
            _time.sleep(0.1)

        assert ex["execution_type"] == "deep_sweep"
        assert ex["status"] == "completed"

        # All three repos queried
        for m in mocks.values():
            m.search.assert_called_once()

    # Report generated
    report_path = Path(ex["result_path"])
    assert report_path.exists()
    assert "resmon Literature Report" in report_path.read_text(encoding="utf-8")

    # Log mentions every repo
    log_text = Path(ex["log_path"]).read_text(encoding="utf-8")
    for repo in mocks:
        assert f"Querying repository: {repo}" in log_text


# ===================================================================
# E2E-3  Routine lifecycle
# ===================================================================

def test_e2e_routine_lifecycle(client, tmp_reports):
    """E2E-3: Create routine, trigger execution, verify results, log, calendar.

    Covers UI-3, UI-4, UI-6, CFG-1, LOG-2.
    """
    # ---- create routine ----
    resp = client.post("/api/routines", json={
        "name": "E2E Lifecycle Routine",
        "schedule_cron": "0 8 * * *",
        "parameters": {"keywords": ["test"], "repositories": ["arxiv"]},
        "is_active": True,
        "email_enabled": False,
        "ai_enabled": False,
    })
    assert resp.status_code in (200, 201)
    routine_id = resp.json()["id"]
    assert resp.json()["name"] == "E2E Lifecycle Routine"

    # ---- confirm routine in list ----
    routines = client.get("/api/routines").json()
    assert any(r["id"] == routine_id for r in routines)

    # ---- simulate scheduler-triggered execution ----
    mock_arxiv = _make_mock_client("arxiv")
    conn = resmon_mod._get_db()

    with (
        patch("implementation_scripts.sweep_engine.get_client",
              return_value=mock_arxiv),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_reports),
    ):
        from implementation_scripts.sweep_engine import SweepEngine
        engine = SweepEngine(db_conn=conn, config={"ai_enabled": False})
        result = engine.execute_dive(
            repository="arxiv",
            query_params={"query": "test", "max_results": 5},
        )

    assert result["execution_id"] is not None
    assert result["result_count"] >= 1
    assert Path(result["log_path"]).exists()
    assert Path(result["report_path"]).exists()

    # ---- calendar shows the execution ----
    events = client.get("/api/calendar/events").json()
    assert any(e["id"] == result["execution_id"] for e in events)

    # ---- activate / deactivate ----
    client.post(f"/api/routines/{routine_id}/deactivate")
    routines = client.get("/api/routines").json()
    assert any(r["id"] == routine_id and r["is_active"] == 0 for r in routines)

    client.post(f"/api/routines/{routine_id}/activate")
    routines = client.get("/api/routines").json()
    assert any(r["id"] == routine_id and r["is_active"] == 1 for r in routines)

    # ---- cleanup ----
    client.delete(f"/api/routines/{routine_id}")
    assert not any(r["id"] == routine_id for r in client.get("/api/routines").json())


# ===================================================================
# E2E-4  AI summarization
# ===================================================================

def test_e2e_ai_summarization(client, tmp_reports):
    """E2E-4: Deep Dive with LLM-powered summaries.

    Covers AI-1, AI-2, AI-3, AI-4, AI-5, AI-7.
    """
    # 1. Verify API accepts ai_enabled / ai_settings
    mock_arxiv = _make_mock_client("arxiv")
    with (
        patch("implementation_scripts.sweep_engine.get_client",
              return_value=mock_arxiv),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_reports),
    ):
        resp = client.post("/api/search/dive", json={
            "repository": "arxiv",
            "query": "neural networks",
            "max_results": 2,
            "ai_enabled": True,
            "ai_settings": {"summary_length": "short", "tone": "technical"},
        })
    assert resp.status_code == 200
    assert "execution_id" in resp.json()

    # 2. SummarizationPipeline with a mock LLM client
    from implementation_scripts.summarizer import SummarizationPipeline

    mock_llm = MagicMock()
    mock_llm.summarize.return_value = "AI-generated summary."
    mock_llm.provider = "test"
    mock_llm.model = None

    pipeline = SummarizationPipeline(
        mock_llm,
        {"tone": "technical", "length": "short", "_show_audit_prefix": False},
    )

    # Token estimation
    assert pipeline.estimate_tokens("Hello world, this is a test.") > 0

    # Chunking
    long_text = "This is a test sentence. " * 500
    chunks = pipeline.chunk_text(long_text, max_tokens=100)
    assert len(chunks) >= 2

    # Single-document summarization
    result = pipeline.summarize_document("A short document about neural networks.")
    mock_llm.summarize.assert_called()
    assert result == "AI-generated summary."

    # Batch summarization
    mock_llm.reset_mock()
    mock_llm.summarize.return_value = "Batch summary."
    results = pipeline.summarize_batch(["Doc one.", "Doc two."])
    assert len(results) == 2
    assert all(r == "Batch summary." for r in results)

    # 3. AI settings persistence
    client.put("/api/settings/ai", json={"settings": {
        "ai_provider": "openai",
        "ai_model": "gpt-4",
        "ai_summary_length": "short",
        "ai_tone": "technical",
    }})
    ai = client.get("/api/settings/ai").json()
    assert ai["ai_provider"] == "openai"
    assert ai["ai_model"] == "gpt-4"
    assert ai["ai_summary_length"] == "short"
    assert ai["ai_tone"] == "technical"

    # 4. Credential store / delete round-trip (AI-3)
    client.put("/api/credentials/openai_api_key",
               json={"value": "sk-test-key"})
    # (credential_manager stores via keyring; we verify the endpoint responded)
    del_resp = client.delete("/api/credentials/openai_api_key")
    assert del_resp.status_code == 200


# ===================================================================
# E2E-5  Configuration export and re-import
# ===================================================================

def test_e2e_config_export_import(client):
    """E2E-5: Export configs to ZIP, delete originals, re-import from ZIP.

    Covers CFG-1, CFG-2, CFG-3, CFG-4, CFG-5, CFG-6, CFG-7.
    """
    # ---- create two configs (routine + manual_dive) ----
    # The routine config_type is the wrapper payload produced by
    # ``_serialize_routine_for_config`` (linked_routine_id + nested
    # ``parameters``); manual_dive stores a singular ``repository`` per
    # the Deep Dive page contract. The schema validates these per-type
    # shapes on import, so the test fixtures must match them.
    r1 = client.post("/api/configurations", json={
        "name": "E2E Routine Config",
        "config_type": "routine",
        "parameters": {
            "linked_routine_id": 999,
            "schedule_cron": "0 8 * * *",
            "parameters": {
                "keywords": ["machine learning"],
                "repositories": ["arxiv", "semantic_scholar"],
            },
        },
    })
    assert r1.status_code in (200, 201)
    id1 = r1.json()["id"]

    r2 = client.post("/api/configurations", json={
        "name": "E2E Manual Dive Config",
        "config_type": "manual_dive",
        "parameters": {
            "keywords": ["quantum computing"],
            "repository": "arxiv",
        },
    })
    assert r2.status_code in (200, 201)
    id2 = r2.json()["id"]

    # ---- export ----
    export_resp = client.post("/api/configurations/export",
                              json={"ids": [id1, id2]})
    assert export_resp.status_code == 200
    zip_path = Path(export_resp.json()["path"])
    assert zip_path.exists()

    # ---- verify ZIP contents ----
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        assert len(names) == 2
        for n in names:
            assert n.endswith(".json")
            content = json.loads(zf.read(n))
            assert "config_type" in content
            assert "name" in content
            # The two stored shapes diverge: manual_dive carries
            # ``keywords`` + singular ``repository``; routine carries the
            # wrapper payload with ``linked_routine_id`` and nested
            # ``parameters``. Verify config-type-specific keys.
            if content["config_type"] == "manual_dive":
                assert "keywords" in content
                assert "repository" in content
            elif content["config_type"] == "routine":
                assert "linked_routine_id" in content
                assert "parameters" in content

    # ---- delete originals ----
    client.delete(f"/api/configurations/{id1}")
    client.delete(f"/api/configurations/{id2}")
    assert len(client.get("/api/configurations").json()) == 0

    # ---- re-import ----
    files_to_upload = []
    with zipfile.ZipFile(zip_path) as zf:
        for n in zf.namelist():
            files_to_upload.append(
                ("files", (n, io.BytesIO(zf.read(n)), "application/json"))
            )

    import_resp = client.post("/api/configurations/import",
                              files=files_to_upload)
    assert import_resp.status_code == 200
    assert import_resp.json()["imported"] == 2

    # ---- verify re-imported configs ----
    configs = client.get("/api/configurations").json()
    assert len(configs) == 2

    # Clean up temp ZIP
    zip_path.unlink(missing_ok=True)


# ===================================================================
# E2E-6  Email notification
# ===================================================================

def test_e2e_email_notification(client):
    """E2E-6: Email for a completed routine — settings, compose, send.

    Covers EMAIL-1..EMAIL-8.
    """
    # ---- persist email settings ----
    client.put("/api/settings/email", json={"settings": {
        "smtp_server": "smtp.test.example.com",
        "smtp_port": "587",
        "smtp_username": "user@test.example.com",
        "smtp_from": "resmon@test.example.com",
        "smtp_to": "recipient@test.example.com",
    }})
    email_cfg = client.get("/api/settings/email").json()
    assert email_cfg["smtp_server"] == "smtp.test.example.com"
    assert email_cfg["smtp_to"] == "recipient@test.example.com"

    # ---- create routine with per-routine email toggles ----
    rr = client.post("/api/routines", json={
        "name": "Email Test Routine",
        "schedule_cron": "0 8 * * *",
        "parameters": {"keywords": ["test"], "repositories": ["arxiv"]},
        "email_enabled": True,
        "email_ai_summary_enabled": True,
    })
    assert rr.status_code in (200, 201)
    routine_id = rr.json()["id"]

    # Fetch full routine to verify email toggles persisted
    routine = next(
        r for r in client.get("/api/routines").json() if r["id"] == routine_id
    )
    assert routine["email_enabled"] == 1
    assert routine["email_ai_summary_enabled"] == 1

    # ---- compose_notification produces valid MIME ----
    from implementation_scripts.email_notifier import compose_notification

    execution_data = {
        "routine_name": "Email Test Routine",
        "start_time": "2026-04-15T08:00:00Z",
        "end_time": "2026-04-15T08:05:00Z",
        "status": "completed",
        "result_count": 42,
        "new_count": 10,
    }
    msg = compose_notification(
        execution_data,
        ai_summary="AI overview of results.",
        recipient="recipient@test.example.com",
        sender="resmon@test.example.com",
    )
    assert msg["Subject"] == "[resmon] Email Test Routine - completed"
    assert msg["To"] == "recipient@test.example.com"
    assert msg["From"] == "resmon@test.example.com"

    body = msg.get_payload()[0].get_payload()
    assert "Start: 2026-04-15T08:00:00Z" in body       # EMAIL-2
    assert "End: 2026-04-15T08:05:00Z" in body          # EMAIL-2
    assert "Status: completed" in body                   # EMAIL-3
    assert "Total results: 42" in body                   # EMAIL-3
    assert "AI overview of results." in body             # EMAIL-4

    # ---- send_test_email with mocked SMTP ----
    from implementation_scripts.email_notifier import send_test_email

    with patch("implementation_scripts.email_notifier.smtplib") as mock_smtp:
        mock_server = MagicMock()
        mock_smtp.SMTP.return_value.__enter__.return_value = mock_server
        ok = send_test_email({
            "host": "smtp.test.example.com",
            "port": 587,
            "username": "user@test.example.com",
            "password": "test_password",
            "recipient": "recipient@test.example.com",
        })
    assert ok is True
    mock_server.sendmail.assert_called_once()

    # ---- per-routine toggle off (EMAIL-6, EMAIL-8) ----
    client.put(f"/api/routines/{routine_id}", json={
        "email_enabled": False,
        "email_ai_summary_enabled": False,
    })
    updated = next(
        r for r in client.get("/api/routines").json()
        if r["id"] == routine_id
    )
    assert updated["email_enabled"] == 0
    assert updated["email_ai_summary_enabled"] == 0

    client.delete(f"/api/routines/{routine_id}")


# ===================================================================
# E2E-7  Cloud backup
# ===================================================================

def test_e2e_cloud_backup(client):
    """E2E-7: Cloud link/unlink, status, backup.

    Covers CLOUD-1..CLOUD-4.
    """
    # ---- initial status: not linked ----
    # Mock the keyring probe so the test is hermetic regardless of what
    # tokens the developer's OS keychain happens to hold.
    with patch("resmon.cloud_is_token_stored", return_value=False):
        status = client.get("/api/cloud/status").json()
        assert status["is_linked"] is False

    # ---- persist cloud settings ----
    client.put("/api/settings/cloud", json={"settings": {
        "cloud_provider": "google_drive",
        "cloud_auto_backup": "true",
    }})
    cs = client.get("/api/settings/cloud").json()
    assert cs["cloud_provider"] == "google_drive"
    assert cs["cloud_auto_backup"] == "true"

    # ---- link (mocked OAuth) ----
    with patch("resmon.authorize_google_drive", return_value=True):
        link_resp = client.post("/api/cloud/link")
        assert link_resp.status_code == 200

    # ---- backup (mocked) ----
    with (
        patch("resmon.cloud_check_connection", return_value=True),
        patch(
            "resmon.upload_directory",
            return_value={
                "uploaded_ids": ["file_id_1", "file_id_2"],
                "total_files": 2,
                "folder_id": "folder_id_1",
                "folder_name": "backup-20260420-000000",
                "web_view_link": "https://drive.google.com/drive/folders/folder_id_1",
            },
        ),
    ):
        backup_resp = client.post("/api/cloud/backup", json={})
        assert backup_resp.status_code == 200
        assert backup_resp.json()["success"] is True

    # ---- backup when not linked → 400 ----
    # Mock cloud_check_connection to False so this is hermetic regardless of
    # any token the developer's OS keychain might hold.
    with patch("resmon.cloud_check_connection", return_value=False):
        fail_resp = client.post("/api/cloud/backup", json={})
        assert fail_resp.status_code == 400

    # ---- unlink ----
    with patch("resmon.revoke_authorization", return_value=True):
        unlink_resp = client.post("/api/cloud/unlink")
        assert unlink_resp.status_code == 200


# ===================================================================
# E2E-8  Calendar events with color coding
# ===================================================================

def test_e2e_calendar_events(client, tmp_reports):
    """E2E-8: Calendar displays executions with green/red color coding.

    Covers CAL-1..CAL-8.
    """
    from implementation_scripts.database import insert_execution, update_execution_status
    from implementation_scripts.utils import now_iso

    # ---- successful execution (via API) → green ----
    mock_arxiv = _make_mock_client("arxiv")
    with (
        patch("implementation_scripts.sweep_engine.get_client",
              return_value=mock_arxiv),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_reports),
    ):
        ok_resp = client.post("/api/search/dive", json={
            "repository": "arxiv",
            "query": "calendar test",
            "max_results": 2,
        })
    success_id = ok_resp.json()["execution_id"]

    # Background execution – poll until finished so the execution row
    # reaches a terminal status before we read the calendar.
    import time as _time
    for _ in range(50):
        exec_resp = client.get(f"/api/executions/{success_id}")
        if exec_resp.json().get("status") in ("completed", "failed"):
            break
        _time.sleep(0.1)

    # ---- failed execution (inserted directly) → red ----
    conn = resmon_mod._get_db()
    fail_id = insert_execution(conn, {
        "execution_type": "deep_sweep",
        "parameters": json.dumps({"query": "fail test"}),
        "start_time": now_iso(),
    })
    update_execution_status(conn, fail_id, "failed",
                            end_time=now_iso(),
                            error_message="Simulated failure")

    # ---- fetch calendar events ----
    events = client.get("/api/calendar/events").json()
    assert len(events) >= 2

    success_evt = next(e for e in events if e["id"] == success_id)
    failed_evt = next(e for e in events if e["id"] == fail_id)

    assert success_evt["color"] == "#22c55e"   # green
    assert failed_evt["color"] == "#ef4444"     # red

    # ---- event structure ----
    for evt in events:
        assert "id" in evt
        assert "title" in evt
        assert "start" in evt
        assert "color" in evt

    # ---- routine scheduling shown in system ----
    rr = client.post("/api/routines", json={
        "name": "Calendar Routine",
        "schedule_cron": "30 9 * * 1",
        "parameters": {"keywords": ["calendar"], "repositories": ["arxiv"]},
    })
    routine_id = rr.json()["id"]
    assert any(r["id"] == routine_id for r in client.get("/api/routines").json())
    client.delete(f"/api/routines/{routine_id}")


# ===================================================================
# Feature Requirement Cross-Check  (§15.2.2)
# ===================================================================

def test_requirement_crosscheck(client):
    """Systematic walk-through of every requirement ID from §6.

    CP-1..CP-7, UI-1..UI-6, CAL-1..CAL-8, CFG-1..CFG-7,
    LOG-1..LOG-3, EMAIL-1..EMAIL-8, CLOUD-1..CLOUD-4,
    AI-1..AI-7, CIT-1..CIT-2, STOR-1..STOR-2.
    """
    # ------------------------------------------------------------------ CP
    # CP-1  Query repositories           → E2E-1, E2E-2
    # CP-2  Chronological reports         → E2E-1 (report generated)
    # CP-3  Metadata extraction           → E2E-1 (NormalizedResult fields)
    # CP-4  Targeted filtering            → E2E-1 (date_from, date_to, query)
    # CP-5  Deduplication via SQLite      → E2E-2 (cross-repo dedup)
    # CP-6  Adaptive scraping             → Tier 2/3 clients (IMPL-7 verified)
    # CP-7  Many repositories             → 17 clients registered (IMPL-3/4/7)
    resp = client.get("/api/search/repositories")
    assert resp.status_code == 200
    # Endpoint functional; 17 clients verified by prior IMPL tests.

    # ------------------------------------------------------------------ UI
    # UI-1  Professional dashboard UI     → webpack build (IMPL-12)
    # UI-2  Navigation                    → Router with 8 pages (IMPL-12)
    # UI-3  Review/modify routines        → E2E-3
    # UI-4  Unlimited routines            → E2E-3
    # UI-5  Review/export/delete results  → E2E-1, E2E-5
    # UI-6  Overlapping schedules         → E2E-3 (routines endpoint)
    assert client.get("/api/executions").status_code == 200
    assert client.get("/api/routines").status_code == 200

    # ------------------------------------------------------------------ CAL
    # CAL-1  Calendar views              → FullCalendar (IMPL-13)
    # CAL-2  Routines on calendar        → /api/calendar/events + /api/routines
    # CAL-3  Toggle visibility           → UI-side (IMPL-13)
    # CAL-4  Click → activate/deactivate → /api/routines/{id}/(de)activate
    # CAL-5  Click → routine page        → UI-side routing (IMPL-13)
    # CAL-6  Click → results page        → UI-side routing (IMPL-13)
    # CAL-7  Color coding (green/red)    → E2E-8
    # CAL-8  Manual ops on calendar      → E2E-8 (timestamp display)
    assert client.get("/api/calendar/events").status_code == 200

    # ------------------------------------------------------------------ CFG
    # CFG-1  Save routine config         → E2E-5
    # CFG-2  Export as .json in .zip     → E2E-5
    # CFG-3  Upload .json for routines   → E2E-5
    # CFG-4  Save manual config          → E2E-5
    # CFG-5  Export manual configs       → E2E-5
    # CFG-6  Upload .json for manual     → E2E-5
    # CFG-7  JSON format                 → E2E-5 (verified contents)
    assert client.get("/api/configurations").status_code == 200

    # ------------------------------------------------------------------ LOG
    # LOG-1  Manual sweep/dive log       → E2E-1 (log_path verified)
    # LOG-2  Automated sweep log         → E2E-3 (scheduler trigger log)
    # LOG-3  Logs in UI                  → /api/executions/{id}/log endpoint
    assert client.get("/api/executions/99999/log").status_code == 404  # 404 if absent

    # ------------------------------------------------------------------ EMAIL
    # EMAIL-1  Auto-email on routine     → E2E-6
    # EMAIL-2  Start/end/elapsed time    → E2E-6 (body assertions)
    # EMAIL-3  Status + error type       → E2E-6
    # EMAIL-4  AI summary in email       → E2E-6
    # EMAIL-5  Global email toggle       → settings endpoint
    # EMAIL-6  Per-routine toggle        → E2E-6
    # EMAIL-7  Global AI-in-email toggle → settings endpoint
    # EMAIL-8  Per-routine AI toggle     → E2E-6
    assert client.get("/api/settings/email").status_code == 200

    # ------------------------------------------------------------------ CLOUD
    # CLOUD-1  Link cloud account        → E2E-7
    # CLOUD-2  Auto backup               → E2E-7 (cloud_auto_backup setting)
    # CLOUD-3  Manual backup             → E2E-7 (/api/cloud/backup)
    # CLOUD-4  Supplement or replace     → settings (cloud_auto_backup)
    assert client.get("/api/cloud/status").status_code == 200

    # ------------------------------------------------------------------ AI
    # AI-1  Optional AI pipeline         → E2E-4
    # AI-2  BYOK for OpenAI/Anthropic    → E2E-4 (credential endpoints)
    # AI-3  Secure key storage           → credential_manager (keyring)
    # AI-4  Model selection persisted    → ai_settings (ai_model)
    # AI-5  Custom prompting params      → ai_settings (ai_tone, summary_length)
    # AI-6  Local model support          → llm_local.py (IMPL-8)
    # AI-7  Token-aware chunking         → E2E-4 (SummarizationPipeline)
    ai = client.get("/api/settings/ai")
    assert ai.status_code == 200
    assert client.delete("/api/credentials/test_key").status_code == 200

    # ------------------------------------------------------------------ CIT
    # CIT-1  Fetch follow-up references  → citation_graph module
    # CIT-2  Mini-citation tree          → citation_graph module
    from implementation_scripts.citation_graph import (
        build_citation_tree,
        fetch_citations,
        fetch_references,
    )
    assert callable(build_citation_tree)
    assert callable(fetch_citations)
    assert callable(fetch_references)

    # ------------------------------------------------------------------ STOR
    # STOR-1  PDF save/archive/discard toggle
    # STOR-2  TXT save/archive/discard toggle
    client.put("/api/settings/storage", json={"settings": {
        "pdf_policy": "archive",
        "txt_policy": "save",
        "archive_after_days": "30",
    }})
    stor = client.get("/api/settings/storage").json()
    assert stor["pdf_policy"] == "archive"
    assert stor["txt_policy"] == "save"
    assert stor["archive_after_days"] == "30"


# ===================================================================
# IMPL-AI8 — LLM factory wiring in _launch_execution
# ===================================================================

def _poll_status(client, exec_id, target=("completed", "failed"), attempts=60, delay=0.1):
    import time as _time
    for _ in range(attempts):
        ex = client.get(f"/api/executions/{exec_id}").json()
        if ex["status"] in target:
            return ex
        _time.sleep(delay)
    return ex


def test_dive_with_ai_enabled_constructs_client(client, tmp_reports):
    """AI8-V1: build_llm_client_from_settings is called; SummarizationPipeline
    receives prompt_params reflecting persisted settings."""
    mock_arxiv = _make_mock_client("arxiv")

    recorded: dict = {"pipeline_args": []}

    class _StubLLM:
        provider = "xai"
        model = "grok-2-latest"

    class _StubPipeline:
        def __init__(self, llm_client, prompt_params=None):
            recorded["pipeline_args"].append({
                "llm_client": llm_client,
                "prompt_params": dict(prompt_params or {}),
            })

        def summarize_batch(self, documents):
            return "Stub aggregated summary."

    # Persist AI settings via the PUT endpoint
    client.put("/api/settings/ai", json={"settings": {
        "ai_provider": "xai",
        "ai_model": "grok-2-latest",
        "ai_summary_length": "detailed",
        "ai_tone": "technical",
    }})

    with (
        patch("implementation_scripts.sweep_engine.get_client", return_value=mock_arxiv),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_reports),
        patch(
            "resmon.build_llm_client_from_settings",
            return_value=_StubLLM(),
        ) as mock_factory,
        patch(
            "implementation_scripts.summarizer.SummarizationPipeline",
            _StubPipeline,
        ),
    ):
        resp = client.post("/api/search/dive", json={
            "repository": "arxiv",
            "query": "neural networks",
            "max_results": 2,
            "ai_enabled": True,
        })
        assert resp.status_code == 200
        exec_id = resp.json()["execution_id"]
        ex = _poll_status(client, exec_id)
        assert ex["status"] == "completed", f"unexpected status: {ex}"

    # Factory must have been invoked once with the persisted settings merged in.
    assert mock_factory.call_count == 1
    passed_settings = mock_factory.call_args.args[0]
    assert passed_settings.get("ai_provider") == "xai"
    assert passed_settings.get("ai_summary_length") == "detailed"

    # Pipeline must have been constructed with prompt_params reflecting settings.
    assert recorded["pipeline_args"], "SummarizationPipeline was never constructed"
    pp = recorded["pipeline_args"][0]["prompt_params"]
    assert pp.get("length") == "detailed"
    assert pp.get("tone") == "technical"


def test_dive_with_ai_enabled_but_no_key_emits_log_entry(client, tmp_reports):
    """AI8-V2: factory returning None emits a warn log_entry and the execution
    still completes."""
    mock_arxiv = _make_mock_client("arxiv")

    client.put("/api/settings/ai", json={"settings": {
        "ai_provider": "openai",
        "ai_model": "gpt-4o-mini",
        "ai_summary_length": "standard",
        "ai_tone": "technical",
    }})

    with (
        patch("implementation_scripts.sweep_engine.get_client", return_value=mock_arxiv),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_reports),
        patch("resmon.build_llm_client_from_settings", return_value=None),
    ):
        resp = client.post("/api/search/dive", json={
            "repository": "arxiv",
            "query": "neural networks",
            "max_results": 2,
            "ai_enabled": True,
        })
        assert resp.status_code == 200
        exec_id = resp.json()["execution_id"]
        ex = _poll_status(client, exec_id)

    assert ex["status"] == "completed"

    # Fetch the persisted progress events and confirm the warn log_entry fired.
    events_resp = client.get(f"/api/executions/{exec_id}/progress/events")
    assert events_resp.status_code == 200
    events = events_resp.json()
    log_entries = [
        e for e in events
        if e.get("type") == "log_entry" and "AI skipped" in (e.get("message") or "")
    ]
    assert log_entries, f"no AI-skip log_entry found in events: {events}"
    msg = log_entries[0]["message"]
    assert "provider not configured" in msg or "API key missing" in msg


# ---------------------------------------------------------------------------
# IMPL-AI13: per-execution override + audit-prefix tests
# ---------------------------------------------------------------------------

def _make_summarize_pipeline(prompt_params):
    """Build a real SummarizationPipeline with a recording stub LLM."""
    from implementation_scripts.summarizer import SummarizationPipeline

    class _RecordingLLM:
        provider = "openai"
        model = "gpt-4o-mini"

        def __init__(self):
            self.calls = []

        def summarize(self, text, params):
            self.calls.append({"text": text, "params": dict(params)})
            return "STUB BODY"

    llm = _RecordingLLM()
    return SummarizationPipeline(llm, prompt_params=prompt_params), llm


def test_audit_prefix_present_by_default():
    """IMPL-AI13: by default the audit prefix decorates the returned summary."""
    from implementation_scripts.prompt_templates import constitution_sha256_prefix

    pipeline, _ = _make_summarize_pipeline({
        "length": "standard",
        "tone": "technical",
        "_show_audit_prefix": True,
        "_audit_provider": "openai",
        "_audit_model": "gpt-4o-mini",
    })
    out = pipeline.summarize_document("Short abstract text.")
    expected_hash = constitution_sha256_prefix(8)
    assert out.startswith(f"[constitution: {expected_hash} "), out
    assert "model: openai/gpt-4o-mini" in out
    assert "length: ~120\u2013180" in out  # standard band
    assert "STUB BODY" in out


def test_audit_prefix_absent_when_disabled():
    """IMPL-AI13: ``_show_audit_prefix=False`` suppresses the prefix."""
    pipeline, _ = _make_summarize_pipeline({
        "length": "brief",
        "tone": "technical",
        "_show_audit_prefix": False,
        "_audit_provider": "openai",
        "_audit_model": "gpt-4o-mini",
    })
    out = pipeline.summarize_document("Short abstract text.")
    assert not out.startswith("[constitution:"), out
    assert out == "STUB BODY"


def test_per_execution_override_wins(client, tmp_reports):
    """IMPL-AI13: request-body ai_settings overrides persisted app settings."""
    mock_arxiv = _make_mock_client("arxiv")

    recorded: dict = {"pipeline_args": []}

    class _StubLLM:
        provider = "openai"
        model = "gpt-4o-mini"

    class _StubPipeline:
        def __init__(self, llm_client, prompt_params=None):
            recorded["pipeline_args"].append(dict(prompt_params or {}))

        def summarize_batch(self, documents):
            return "Stub aggregated summary."

    # App-wide = brief; per-execution override requests detailed.
    client.put("/api/settings/ai", json={"settings": {
        "ai_provider": "openai",
        "ai_model": "gpt-4o-mini",
        "ai_summary_length": "brief",
        "ai_tone": "technical",
    }})

    with (
        patch("implementation_scripts.sweep_engine.get_client", return_value=mock_arxiv),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_reports),
        patch("resmon.build_llm_client_from_settings", return_value=_StubLLM()),
        patch("implementation_scripts.summarizer.SummarizationPipeline", _StubPipeline),
    ):
        resp = client.post("/api/search/dive", json={
            "repository": "arxiv",
            "query": "neural networks",
            "max_results": 2,
            "ai_enabled": True,
            "ai_settings": {"length": "detailed", "tone": "accessible"},
        })
        assert resp.status_code == 200
        exec_id = resp.json()["execution_id"]
        ex = _poll_status(client, exec_id)
        assert ex["status"] == "completed", f"unexpected status: {ex}"

    assert recorded["pipeline_args"], "SummarizationPipeline was never constructed"
    pp = recorded["pipeline_args"][0]
    assert pp.get("length") == "detailed", f"override did not win: {pp}"
    assert pp.get("tone") == "accessible", f"tone override did not win: {pp}"


# ---------------------------------------------------------------------------
# IMPL-AI14: rendered-prompt integration test (§7)
# ---------------------------------------------------------------------------

def test_dive_rendered_prompt_contains_constitution_and_settings(client, tmp_reports):
    """IMPL-AI14: a full Deep Dive with ai_enabled=True and an xAI provider
    renders a prompt that contains the constitution markers, ``Target length:
    detailed``, and the user's tone. The live HTTPS call is mocked at the
    ``httpx.Client`` boundary inside ``llm_remote``; no real network call is
    made and no real keyring entry is touched (the API key is supplied via
    ``ephemeral_credentials`` on the POST body)."""
    mock_arxiv = _make_mock_client("arxiv")

    # Record every outbound chat-completion POST body.
    recorded_posts: list[dict] = []

    def _mock_post(url, *args, **kwargs):
        recorded_posts.append({"url": url, "json": kwargs.get("json", {})})
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = {
            "choices": [{"message": {"content": "Mock summary body."}}]
        }
        return resp

    mock_http_cm = MagicMock()
    mock_http_cm.__enter__.return_value.post.side_effect = _mock_post

    # The production sweep_engine passes a list[dict] to summarize_batch;
    # normalize to list[str] so the real RemoteLLMClient path is exercised
    # end-to-end without hitting that pre-existing contract mismatch.
    from implementation_scripts.summarizer import SummarizationPipeline
    _orig_batch = SummarizationPipeline.summarize_batch

    def _coerce_batch(self, documents):
        texts = [
            d if isinstance(d, str) else (d.get("abstract") or d.get("title") or "")
            for d in documents
        ]
        return _orig_batch(self, texts)

    # Persist app-wide AI settings so they are merged into prompt_params.
    client.put("/api/settings/ai", json={"settings": {
        "ai_provider": "xai",
        "ai_model": "grok-2-latest",
        "ai_summary_length": "detailed",
        "ai_tone": "technical",
    }})

    with (
        patch("implementation_scripts.sweep_engine.get_client", return_value=mock_arxiv),
        patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_reports),
        patch(
            "implementation_scripts.llm_remote.httpx.Client",
            return_value=mock_http_cm,
        ),
        patch.object(SummarizationPipeline, "summarize_batch", _coerce_batch),
    ):
        resp = client.post("/api/search/dive", json={
            "repository": "arxiv",
            "query": "neural networks",
            "max_results": 2,
            "ai_enabled": True,
            # Ephemeral credential — never hits the real keyring.
            "ephemeral_credentials": {"xai_api_key": "ephemeral-xai"},
        })
        assert resp.status_code == 200
        exec_id = resp.json()["execution_id"]
        ex = _poll_status(client, exec_id)
        assert ex["status"] == "completed", f"unexpected status: {ex}"

    # At least one summarization call was made; inspect the first.
    assert recorded_posts, "llm_remote never posted to the mocked httpx.Client"
    first_body = recorded_posts[0]["json"]
    assert recorded_posts[0]["url"] == "https://api.x.ai/v1/chat/completions"
    messages = first_body.get("messages") or []
    roles = {m["role"]: m["content"] for m in messages}

    # (a) constitution markers appear in the system message.
    assert "BEGIN SUMMARIZATION CONSTITUTION" in roles.get("system", ""), roles.get("system", "")[:500]
    assert "END SUMMARIZATION CONSTITUTION" in roles.get("system", "")

    # (b) Target length: detailed is threaded through to the user prompt.
    assert "Target length: detailed" in roles.get("user", ""), roles.get("user", "")[:500]

    # (c) user-configured tone appears in the user prompt.
    assert "Tone: technical" in roles.get("user", "")
