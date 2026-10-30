"""An install that had the upload to Google Drive on, after the upload was removed.

resmon used to sign in to Google and, with Settings › Cloud Storage's *Upload
each run's report and log* switched on, upload each finished run's report and
log to Google Drive. The sign-in and the upload are gone: a backup is written
into a folder the person chooses, Google Drive for desktop's among them. A
database from before that still holds ``cloud_auto_backup = true``, and the
keyring may still hold the sign-in. These hold the engine to starting over
both, reading the setting only for the notice that says the upload has gone,
never asking the keyring for the sign-in, and saying nothing about an upload
anywhere a person reads.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import keyring
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import backup as backup_module  # noqa: E402
from implementation_scripts import database as db  # noqa: E402
from implementation_scripts.api_base import NormalizedResult  # noqa: E402
import resmon as resmon_mod  # noqa: E402

_SIGN_IN = ("google_drive_token", "google_drive_client_id", "google_drive_client_secret")


@pytest.fixture
def old_install(tmp_path, monkeypatch):
    """A database with the upload switched on, a stored sign-in, and a keyring that records every read."""
    path = tmp_path / "corpus.db"
    conn = db.get_connection(path)
    db.init_db(conn=conn)
    db.set_setting(conn, "cloud_provider", "google_drive")
    db.set_setting(conn, "cloud_auto_backup", "true")
    conn.commit()
    conn.close()

    backend = keyring.get_keyring()
    backend.set_password("resmon", "google_drive_token", json.dumps({"refresh_token": "an-old-sign-in"}))
    asked: list[str] = []
    real_get = backend.get_password

    def recording_get(service: str, username: str):
        asked.append(username)
        return real_get(service, username)

    monkeypatch.setattr(backend, "get_password", recording_get)
    resmon_mod._db_path = str(path)
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    try:
        yield asked
    finally:
        backend.delete_password("resmon", "google_drive_token")
        resmon_mod._db_path = None
        resmon_mod._shared_conn = None
        resmon_mod._db_initialized = False


def _client_for(name: str) -> MagicMock:
    source = MagicMock()
    source.get_name.return_value = name
    source.search.return_value = [NormalizedResult(
        source_repository=name, external_id=f"{name}_001", doi=f"10.1234/{name}_001",
        title="A paper the run found", authors=["A. Researcher"],
        abstract="An abstract.", publication_date="2026-10-29",
        url=f"https://example.org/{name}/001", categories=["cs.DL"],
    )]
    return source


def test_the_engine_starts_over_the_old_setting_and_sign_in(old_install):
    from fastapi.testclient import TestClient

    with TestClient(resmon_mod.app) as client:
        assert client.get("/api/health").status_code == 200
        last = client.get("/api/backup/last")
        assert last.status_code == 200, last.text
        assert last.json()["drive_upload_retired"] is True
        # The routes went with the sign-in.
        for method, route in (("GET", "/api/cloud/status"), ("POST", "/api/cloud/link"),
                              ("POST", "/api/cloud/backup"), ("GET", "/api/settings/cloud")):
            assert client.request(method, route).status_code == 404, route

    assert not set(old_install) & set(_SIGN_IN), f"the keyring was asked for {sorted(set(old_install) & set(_SIGN_IN))}"


def test_a_finished_run_uploads_nothing_and_its_log_says_nothing_of_it(old_install, tmp_path):
    from fastapi.testclient import TestClient

    reports = tmp_path / "reports"
    (reports / "logs").mkdir(parents=True)
    (reports / "markdowns").mkdir()
    with TestClient(resmon_mod.app) as client, \
            patch("implementation_scripts.sweep_engine.get_client", return_value=_client_for("arxiv")), \
            patch("implementation_scripts.sweep_engine.REPORTS_DIR", reports):
        started = client.post("/api/search/dive", json={
            "repository": "arxiv", "query": "provenance", "max_results": 5})
        assert started.status_code == 200, started.text
        exec_id = started.json()["execution_id"]
        for _ in range(100):
            run = client.get(f"/api/executions/{exec_id}").json()
            if run["status"] in ("completed", "failed"):
                break
            time.sleep(0.1)
    assert run["status"] == "completed", run

    log = Path(run["log_path"]).read_text(encoding="utf-8")
    assert "Status: COMPLETED" in log
    for said in ("Auto-backup", "Google", "Drive"):
        assert said not in log, f"the run's log mentions {said!r}:\n{log}"
    assert not [t.name for t in threading.enumerate() if t.name.startswith("resmon-autobackup-")]
    assert not set(old_install) & set(_SIGN_IN), f"the keyring was asked for {sorted(set(old_install) & set(_SIGN_IN))}"


def test_the_notice_is_read_as_the_upload_read_the_switch_and_goes_when_dismissed(old_install):
    from fastapi.testclient import TestClient

    client = TestClient(resmon_mod.app)
    conn = resmon_mod._get_db()
    for stored, shown in ((" TRUE ", True), ("1", False), ("false", False), ("true", True)):
        db.set_setting(conn, "cloud_auto_backup", stored)
        conn.commit()
        assert client.get("/api/backup/last").json()["drive_upload_retired"] is shown, stored

    assert client.post("/api/backup/drive-upload-notice/acknowledge").json() == {
        "success": True, "acknowledged": True}
    assert db.get_setting(conn, "cloud_auto_backup") is None
    assert db.get_setting(conn, "cloud_provider") is None
    assert client.get("/api/backup/last").json()["drive_upload_retired"] is False


def test_a_backup_never_names_the_sign_in_and_a_restore_never_asks_for_it(old_install, tmp_path):
    from fastapi.testclient import TestClient

    assert not set(backup_module.credential_names_present()) & set(_SIGN_IN)

    client = TestClient(resmon_mod.app)
    exports = tmp_path / "exports"
    exports.mkdir()
    client.put("/api/settings/storage", json={"settings": {"export_directory": str(exports)}})
    written = client.post("/api/backup", json={"confirm": "CONFIRM", "include_reports": False})
    assert written.status_code == 200, written.text
    bundle = Path(written.json()["path"])
    assert not set(written.json()["manifest"]["excluded"]["credentials"]) & set(_SIGN_IN)

    # A bundle written before the upload was removed names the sign-in. The
    # restore asks for every other name it recorded, and not for that one.
    manifest_path = bundle / backup_module.MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["excluded"]["credentials"] = sorted(["openai_api_key", *_SIGN_IN])
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    report = client.post("/api/backup/verify", json={"path": str(bundle)})
    assert report.status_code == 200, report.text
    assert report.json()["will_not_restore"]["credentials"] == ["openai_api_key"]
