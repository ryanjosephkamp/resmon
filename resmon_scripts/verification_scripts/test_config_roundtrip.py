# resmon_scripts/verification_scripts/test_config_roundtrip.py
"""The saved-configuration export/import round trip, driven as a user drives it.

The app offers one Export control and one Import control on the Configurations
page, and the page's help text tells the user the second takes what the first
produced. It did not. ``export_configs`` writes a ZIP holding one JSON member
per selected configuration; ``import_configs`` called ``json.load`` on whatever
it was handed, so the exported archive parsed as nothing and the batch reported
zero imported. The renderer never got that far -- it refused any filename not
ending ``.json`` before the upload left the page.

Two existing tests appear to cover this and do not: ``test_e2e_config_export_import``
and the configurations leg of ``test_response_models`` both open the archive in
the test and hand the *members* to the import route. That is the one step a user
cannot perform from the Configurations page, and doing it in the test is what
kept the seam green while the journey was broken.

So the tests here take the bytes at the path the export route reports and post
those exact bytes back, under the name the export route gave them. Nothing is
unpacked, renamed or rewritten in between.
"""

import json
import sys
import zipfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod
from fastapi.testclient import TestClient


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


def _save_dive(client, name: str) -> int:
    """Save a manual Deep Dive configuration, the shape the Deep Dive page writes."""
    resp = client.post("/api/configurations", json={
        "name": name,
        "config_type": "manual_dive",
        "parameters": {"keywords": ["codex walk"], "repository": "arxiv"},
    })
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


def _save_sweep(client, name: str) -> int:
    """Save a manual Deep Sweep configuration -- the plural-repository shape."""
    resp = client.post("/api/configurations", json={
        "name": name,
        "config_type": "manual_sweep",
        "parameters": {"keywords": ["codex walk"],
                       "repositories": ["arxiv", "openalex"]},
    })
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


def _export(client, ids: list[int]) -> Path:
    resp = client.post("/api/configurations/export", json={"ids": ids})
    assert resp.status_code == 200, resp.text
    path = Path(resp.json()["path"])
    assert path.exists(), "the export route must have written the file it names"
    return path


def _post_artifact(client, path: Path, content_type: str = "application/zip"):
    """Hand the import route the exported file, byte for byte, under its own name.

    A browser posts the file's own basename and its own media type. The name
    matters: the backend used to decide what it had been given from the suffix
    of the temporary file it wrote, which is not the suffix of the file the
    user chose.
    """
    return client.post(
        "/api/configurations/import",
        files=[("files", (path.name, path.read_bytes(), content_type))],
    )


# ---------------------------------------------------------------------------
# The round trip
# ---------------------------------------------------------------------------

def test_the_exported_archive_imports_without_being_unpacked_first(client):
    """Export one configuration, import that exact file, get it back.

    This is the journey the Configurations page advertises and the walk of the
    shipped build could not complete.
    """
    cid = _save_dive(client, "codex-walk")
    archive = _export(client, [cid])
    assert archive.suffix == ".zip", (
        "this test is about the container the export actually writes; if the "
        "export stopped writing a ZIP, the round trip needs re-describing")

    client.delete(f"/api/configurations/{cid}")
    assert client.get("/api/configurations").json() == []

    resp = _post_artifact(client, archive)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 1, (
        "the import route refused the file the export route produced: "
        f"{body}")

    restored = client.get("/api/configurations").json()
    assert [c["name"] for c in restored] == ["codex-walk"]
    assert [c["config_type"] for c in restored] == ["manual_dive"]
    raw = restored[0]["parameters"]
    params = json.loads(raw) if isinstance(raw, str) else raw
    assert params["repository"] == "arxiv"
    assert params["keywords"] == ["codex walk"]

    archive.unlink(missing_ok=True)


def test_an_archive_of_several_configurations_imports_as_several(client):
    """The container is load-bearing: Export Selected takes a multi-selection.

    One JSON file cannot hold two configurations in the shape the export
    writes, which is why the import side is the side that learns the
    container rather than the export side dropping it.
    """
    first = _save_dive(client, "dive-one")
    second = _save_sweep(client, "sweep-two")
    archive = _export(client, [first, second])

    with zipfile.ZipFile(archive) as zf:
        assert len(zf.namelist()) == 2, (
            "the premise of this test is that one archive carries both")

    client.delete(f"/api/configurations/{first}")
    client.delete(f"/api/configurations/{second}")

    resp = _post_artifact(client, archive)
    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == 2, resp.text
    assert sorted(c["name"] for c in client.get("/api/configurations").json()) == [
        "dive-one", "sweep-two"]

    archive.unlink(missing_ok=True)


def test_a_routine_archive_round_trips_and_still_lands_deactivated(client):
    """A routine configuration arrives as one file and lands as two rows.

    The import route mirrors every routine config into a real routine row,
    deactivated. Teaching the route a container must not change that: a bulk
    import that silently activated someone's schedule would be worse than the
    refusal it replaces.
    """
    resp = client.post("/api/configurations", json={
        "name": "nightly",
        "config_type": "routine",
        "parameters": {
            "linked_routine_id": 999,
            "schedule_cron": "0 8 * * *",
            "is_active": True,
            "parameters": {"keywords": ["codex walk"], "repositories": ["arxiv"]},
        },
    })
    assert resp.status_code in (200, 201), resp.text
    cid = resp.json()["id"]
    archive = _export(client, [cid])
    client.delete(f"/api/configurations/{cid}")

    result = _post_artifact(client, archive)
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["imported"] == 1, result.text
    assert body["routines_created"] == 1, result.text

    routines = client.get("/api/routines").json()
    assert len(routines) == 1
    assert not routines[0]["is_active"], (
        "an imported routine is deactivated; the container must not change that")

    archive.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# What the change must not break
# ---------------------------------------------------------------------------

def test_the_loose_json_files_inside_an_old_export_still_import(client):
    """Somebody has unpacked an export by hand. That still works.

    This is the behavior that existed before the container was understood, and
    the only reason anyone could import at all. Dropping it would remove a
    capability rather than add one.
    """
    cid = _save_dive(client, "hand-unpacked")
    archive = _export(client, [cid])
    with zipfile.ZipFile(archive) as zf:
        members = [(n, zf.read(n)) for n in zf.namelist()]
    client.delete(f"/api/configurations/{cid}")

    resp = client.post(
        "/api/configurations/import",
        files=[("files", (n, data, "application/json")) for n, data in members])
    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == 1, resp.text

    archive.unlink(missing_ok=True)


def test_a_mixed_upload_of_an_archive_and_a_loose_file_takes_both(client):
    """The file picker is ``multiple``; a user can choose one of each."""
    a = _save_dive(client, "from-archive")
    archive = _export(client, [a])
    client.delete(f"/api/configurations/{a}")

    loose = json.dumps({
        "config_type": "manual_dive",
        "name": "from-loose-json",
        "keywords": ["codex walk"],
        "repository": "arxiv",
    }).encode("utf-8")

    resp = client.post("/api/configurations/import", files=[
        ("files", (archive.name, archive.read_bytes(), "application/zip")),
        ("files", ("loose.json", loose, "application/json")),
    ])
    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == 2, resp.text
    assert sorted(c["name"] for c in client.get("/api/configurations").json()) == [
        "from-archive", "from-loose-json"]

    archive.unlink(missing_ok=True)


def test_importing_over_an_existing_name_adds_a_second_row(client):
    """The page help said a clashing name "appends a numeric suffix". It does not.

    ``insert_configuration`` is a plain INSERT and ``saved_configurations.name``
    carries no UNIQUE constraint, so a re-import lands a second row under the
    same name. Nothing is replaced and nothing is renamed. The help text now
    says that, and this test is why it can.
    """
    cid = _save_dive(client, "codex-walk")
    archive = _export(client, [cid])

    resp = _post_artifact(client, archive)
    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == 1

    rows = client.get("/api/configurations").json()
    assert [c["name"] for c in rows] == ["codex-walk", "codex-walk"]
    assert len({c["id"] for c in rows}) == 2, "the original row is still there"

    archive.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# What a file it cannot take should say
# ---------------------------------------------------------------------------

def test_a_file_the_import_cannot_read_reports_itself_and_does_not_fail_the_batch(client):
    """``errors`` is documented as carrying the files that could not be read.

    It was always an empty list, so an import of an unreadable file answered
    "Imported 0 configuration(s)" and said nothing about why. A user who picks
    the wrong file deserves to be told which file and what the route wanted.
    """
    good = json.dumps({
        "config_type": "manual_dive",
        "name": "good",
        "keywords": ["codex walk"],
        "repository": "arxiv",
    }).encode("utf-8")

    resp = client.post("/api/configurations/import", files=[
        ("files", ("good.json", good, "application/json")),
        ("files", ("notes.txt", b"this is not a configuration", "text/plain")),
    ])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 1, "the bad entry must not fail the batch"
    assert len(body["errors"]) == 1, body
    assert "notes.txt" in body["errors"][0], body


def test_an_archive_rezipped_by_the_finder_still_imports(client, tmp_path):
    """macOS adds ``__MACOSX`` bookkeeping when an export is unzipped and rezipped.

    Those entries are not files the user chose and are not JSON. Naming them
    in the errors list would read as a fault in the user's archive.
    """
    cid = _save_dive(client, "rezipped")
    archive = _export(client, [cid])
    with zipfile.ZipFile(archive) as zf:
        members = [(n, zf.read(n)) for n in zf.namelist()]
    client.delete(f"/api/configurations/{cid}")

    rezipped = tmp_path / "Archive.zip"
    with zipfile.ZipFile(rezipped, "w") as zf:
        for name, raw in members:
            zf.writestr(name, raw)
            zf.writestr(f"__MACOSX/._{name}", b"\x00\x05\x16\x07")

    resp = _post_artifact(client, rezipped)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 1, body
    assert body["errors"] == [], body

    archive.unlink(missing_ok=True)


def test_an_oversized_member_is_refused_by_name_and_never_read(client, tmp_path):
    """The per-member cap is real, not a comment.

    A saved configuration is a few hundred bytes. A member far above that is
    not one, and decompressing it to find out is the mistake the cap exists to
    avoid.
    """
    from implementation_scripts import config_manager

    big = tmp_path / "big.zip"
    with zipfile.ZipFile(big, "w", zipfile.ZIP_DEFLATED) as zf:
        # Compresses to almost nothing; its declared uncompressed size is what
        # the cap reads, before any of it is decompressed.
        zf.writestr("config_manual_dive_x_1.json",
                    b" " * (config_manager._MAX_MEMBER_BYTES + 1))

    resp = _post_artifact(client, big)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 0
    assert len(body["errors"]) == 1, body
    assert "big.zip" in body["errors"][0], body


def test_the_caps_bound_a_total_rather_than_multiplying(client, tmp_path):
    """Every member passes its own cap, and together they are still refused.

    A per-member limit and a member count do not bound anything on their own:
    ``_archive_members`` holds what it read until the caller has parsed it, so
    512 members of 1 MiB each would be 512 MiB resident while each one is
    individually legal. This archive is built entirely out of members that
    pass both of the other caps.
    """
    from implementation_scripts import config_manager

    member_bytes = config_manager._MAX_MEMBER_BYTES
    count = (config_manager._MAX_ARCHIVE_BYTES // member_bytes) + 2
    assert count <= config_manager._MAX_ARCHIVE_MEMBERS, (
        "this archive has to pass the member-count cap to test the other one")

    heavy = tmp_path / "heavy.zip"
    with zipfile.ZipFile(heavy, "w", zipfile.ZIP_DEFLATED) as zf:
        for i in range(count):
            # Valid JSON, legal on its own, and padded to just under the
            # per-member cap so nothing but the total can refuse it.
            payload = {"config_type": "manual_dive", "name": f"heavy{i}",
                       "keywords": ["k"], "repository": "arxiv",
                       "note": "x" * (member_bytes - 200)}
            raw = json.dumps(payload).encode("utf-8")
            assert len(raw) <= member_bytes
            zf.writestr(f"config_manual_dive_heavy_{i}.json", raw)

    resp = _post_artifact(client, heavy)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 0, "an over-budget archive imports no prefix of itself"
    assert len(body["errors"]) == 1, body
    assert "heavy.zip" in body["errors"][0], body
    assert client.get("/api/configurations").json() == []


def test_an_archive_of_too_many_files_is_refused_before_any_are_read(client, tmp_path):
    from implementation_scripts import config_manager

    crowded = tmp_path / "crowded.zip"
    with zipfile.ZipFile(crowded, "w", zipfile.ZIP_DEFLATED) as zf:
        for i in range(config_manager._MAX_ARCHIVE_MEMBERS + 1):
            zf.writestr(f"config_manual_dive_x_{i}.json", json.dumps({
                "config_type": "manual_dive", "name": f"x{i}",
                "keywords": ["k"], "repository": "arxiv"}))

    resp = _post_artifact(client, crowded)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 0, "nothing is read once the count is refused"
    assert len(body["errors"]) == 1, body
    assert "crowded.zip" in body["errors"][0], body
    assert client.get("/api/configurations").json() == []


def test_an_archive_with_nothing_importable_in_it_says_so(client, tmp_path):
    """A ZIP that is not a resmon export is refused by name, not in silence."""
    stranger = tmp_path / "holiday-photos.zip"
    with zipfile.ZipFile(stranger, "w") as zf:
        zf.writestr("beach.txt", "not a configuration")

    resp = _post_artifact(client, stranger)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 0
    assert len(body["errors"]) == 1, body
    assert "holiday-photos.zip" in body["errors"][0], body
