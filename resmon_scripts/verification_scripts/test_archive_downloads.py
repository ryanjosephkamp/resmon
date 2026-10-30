# resmon_scripts/verification_scripts/test_archive_downloads.py
"""The two archives a renderer saves through the system's save dialog.

``POST /api/configurations/export`` and ``POST /api/executions/export`` write
their archives to a folder the engine chooses and answer with the path: the
export folder when one is chosen, the system's temporary folder when not. A
desktop renderer can show that path; it cannot hand the file to a save dialog,
so the person never chooses where an export goes. ``POST
/api/configurations/archive`` and ``GET /api/executions/{exec_id}/bundle``
answer with the same archives' bytes instead.

What is held here:

* **The same archive, not a second format.** Each download is compared, member
  by member, with what the path-answering route writes for the same choice,
  and the saved-search archive is handed back to Import byte for byte.
* **Nothing is left behind.** Each route builds its archive in a staging folder
  of its own and removes it once the response is sent, and on a refusal.
* **A choice that names nothing is refused**, rather than answered with an
  empty archive that reads as an export of nothing.
"""

import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod
from fastapi.testclient import TestClient

from implementation_scripts.database import insert_execution, update_execution_status, utc_now_iso


@pytest.fixture(autouse=True)
def _fresh_db():
    """A clean in-memory database per test, as the rest of the suite does it."""
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod._get_db()
    yield
    resmon_mod.close_db()


@pytest.fixture
def client():
    return TestClient(resmon_mod.app)


@pytest.fixture
def staged(monkeypatch):
    """Every staging folder a route makes, so a test can see that it went."""
    made: list[Path] = []
    real = resmon_mod.tempfile.mkdtemp

    def recording(*args, **kwargs):
        path = real(*args, **kwargs)
        made.append(Path(path))
        return path

    monkeypatch.setattr(resmon_mod.tempfile, "mkdtemp", recording)
    return made


def _save(client, name: str, config_type: str, parameters: dict) -> int:
    resp = client.post("/api/configurations", json={
        "name": name, "config_type": config_type, "parameters": parameters,
    })
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


def _members(raw: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        assert archive.testzip() is None
        return {name: archive.read(name) for name in archive.namelist()}


def _is_download(resp, filename_prefix: str) -> None:
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/zip"
    disposition = resp.headers["content-disposition"]
    assert disposition.startswith("attachment;"), disposition
    assert f'filename="{filename_prefix}' in disposition, disposition
    assert resp.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------------------
# Saved searches
# ---------------------------------------------------------------------------

def test_the_saved_search_download_is_the_export_routes_archive(client, staged):
    dive = _save(client, "a dive", "manual_dive", {"keywords": ["graph"], "repository": "arxiv"})
    sweep = _save(client, "a sweep, two sources", "manual_sweep",
                  {"keywords": ["graph"], "repositories": ["arxiv", "openalex"]})

    resp = client.post("/api/configurations/archive", json={"ids": [dive, sweep]})
    _is_download(resp, "resmon_configs_")
    downloaded = _members(resp.content)

    written = client.post("/api/configurations/export", json={"ids": [dive, sweep]})
    assert written.status_code == 200, written.text
    on_disk = _members(Path(written.json()["path"]).read_bytes())
    Path(written.json()["path"]).unlink()

    assert downloaded == on_disk, "the download is not the archive the export route writes"
    assert {json.loads(raw)["name"] for raw in downloaded.values()} == {"a dive", "a sweep, two sources"}
    assert staged and not any(path.exists() for path in staged), "the staging folder outlived the response"


def test_the_downloaded_archive_imports_as_it_came(client):
    cid = _save(client, "round trip", "manual_sweep", {"keywords": ["x"], "repositories": ["arxiv"]})
    raw = client.post("/api/configurations/archive", json={"ids": [cid]}).content
    client.delete(f"/api/configurations/{cid}")

    resp = client.post("/api/configurations/import",
                       files=[("files", ("resmon_configs.zip", raw, "application/zip"))])
    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == 1, resp.json()
    [back] = client.get("/api/configurations").json()
    assert back["name"] == "round trip"
    assert back["parameters"] == {"keywords": ["x"], "repositories": ["arxiv"]}


def test_an_id_no_longer_saved_is_left_out_and_a_choice_of_none_is_refused(client, staged):
    cid = _save(client, "kept", "manual_dive", {"keywords": ["x"], "repository": "arxiv"})

    resp = client.post("/api/configurations/archive", json={"ids": [cid, 99999, cid]})
    _is_download(resp, "resmon_configs_")
    assert len(_members(resp.content)) == 1

    for ids in ([99999], []):
        refused = client.post("/api/configurations/archive", json={"ids": ids})
        assert refused.status_code == 404, refused.text
        assert refused.json()["detail"] == "None of the chosen configurations is saved."
    assert not any(path.exists() for path in staged), "a refusal left its staging folder behind"


# ---------------------------------------------------------------------------
# A run's bundle
# ---------------------------------------------------------------------------

def _finished_run(tmp_path: Path) -> tuple[int, Path, Path]:
    conn = resmon_mod._get_db()
    eid = insert_execution(conn, {
        "execution_type": "deep_dive",
        "parameters": json.dumps({"repositories": ["arxiv"], "keywords": ["graph"]}),
        "start_time": utc_now_iso(),
    })
    report = tmp_path / f"report_{eid}.md"
    report.write_text("# resmon Literature Report\n\nNo papers.\n", encoding="utf-8")
    log = tmp_path / f"log_{eid}.txt"
    log.write_text("the run's log\n", encoding="utf-8")
    update_execution_status(conn, eid, "completed", end_time=utc_now_iso(), result_count=0,
                            new_result_count=0, result_path=str(report), log_path=str(log))
    return eid, report, log


def test_a_runs_bundle_download_is_the_export_routes_bundle(client, staged, tmp_path):
    eid, report, log = _finished_run(tmp_path)

    resp = client.get(f"/api/executions/{eid}/bundle")
    _is_download(resp, f"resmon_execution_{eid}.zip")
    downloaded = _members(resp.content)

    written = client.post("/api/executions/export", json={"ids": [eid]})
    assert written.status_code == 200, written.text
    on_disk = _members(Path(written.json()["path"]).read_bytes())
    Path(written.json()["path"]).unlink()

    # The same members. The search record is dated when it is built, so its
    # bytes differ by that stamp and are compared by what they record.
    assert sorted(downloaded) == sorted(on_disk)
    prefix = f"execution_{eid}/"
    assert downloaded[prefix + report.name] == report.read_bytes()
    assert downloaded[prefix + log.name] == log.read_bytes()
    record = json.loads(downloaded[prefix + "search-record.json"])
    assert record["search"]["execution_id"] == eid
    assert record["coverage"] == json.loads(on_disk[prefix + "search-record.json"])["coverage"]
    assert [entry["id"] for entry in json.loads(downloaded["manifest.json"])] == [eid]
    assert staged and not any(path.exists() for path in staged), "the staging folder outlived the response"


def test_a_run_that_does_not_exist_is_refused_and_leaves_nothing(client, staged):
    resp = client.get("/api/executions/99999/bundle")
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"] == "Execution not found"
    assert not any(path.exists() for path in staged), "a refusal left its staging folder behind"
