# resmon_scripts/verification_scripts/test_bundle_layout.py
"""A run's bundle, folder by folder.

``GET /api/executions/{id}/bundle`` (and the export route, the archive route,
folder delivery, email and webhooks, which hand out the same ZIP) puts each
run in ``execution_<id>/``:

* ``report/``: the report as PDF (where a LaTeX engine made it), HTML and
  Markdown, and the AI-summary PDF and Markdown when the run made summaries;
* ``references/``: the run's papers as BibTeX, RIS and CSV;
* ``record/``: the search record and ``metadata.json``;
* ``log/``: the run's log;
* ``latex/``: the PDF's LaTeX source;
* ``README.txt``, which names only what is there.

``manifest.json`` stays at the top and says where each run's files are.
"""

import csv
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

from implementation_scripts import report_exporter
from implementation_scripts.database import (
    insert_document, insert_execution, insert_routine, link_execution_document, update_execution_status,
    utc_now_iso,
)
from implementation_scripts.report_generator import generate_report


@pytest.fixture
def client():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod._get_db()
    yield TestClient(resmon_mod.app)
    resmon_mod.close_db()


def _run(tmp_path: Path, *, ai: bool = False, watch: str | None = None) -> int:
    conn = resmon_mod._get_db()
    routine_id = None
    if watch:
        routine_id = insert_routine(conn, {"name": watch, "schedule_cron": "0 8 * * *",
                                           "parameters": json.dumps({"keywords": ["splats"]})})
    eid = insert_execution(conn, {
        "execution_type": "automated_sweep" if watch else "deep_sweep", "routine_id": routine_id,
        "parameters": json.dumps({"repositories": ["medrxiv"], "keywords": ["splats"]}),
        "start_time": utc_now_iso(),
    })
    raw_title = "G <sup>2</sup> -SLAM: Geometrically-guided"
    doc_id = insert_document(conn, {
        "source_repository": "medrxiv", "external_id": "10.64898/1", "doi": "10.64898/1",
        "title": raw_title, "authors": "Huaqing Huang, , Kaiqi Zhang",
        "abstract": "MethodsIn 309 patients. O_LIone C_LI", "publication_date": "2026-11-01",
        "url": "https://doi.org/10.64898/1", "categories": "epidemiology", "metadata_hash": f"h{tmp_path.name}",
    })
    link_execution_document(conn, eid, doc_id)
    doc = {"title": raw_title, "authors": ["Huaqing Huang", "Kaiqi Zhang"], "abstract": "Text.",
           "publication_date": "2026-11-01", "url": "https://doi.org/10.64898/1",
           "source_repository": "medrxiv", "external_id": "10.64898/1", "categories": ["epidemiology"]}
    if ai:
        doc["ai_summary"] = "A summary."
    report = tmp_path / f"report_{eid}.md"
    report.write_text(generate_report([doc], {"keywords": ["splats"], "total": 1, "new": 1,
                                              "date_from": "2026-10-01", "date_to": "2026-11-10",
                                              "ai_model": "test/model" if ai else None}), encoding="utf-8")
    log = tmp_path / f"execution_{eid}.log"
    log.write_text("the run's log\n", encoding="utf-8")
    update_execution_status(conn, eid, "completed", end_time=utc_now_iso(), result_count=1,
                            new_result_count=1, result_path=str(report), log_path=str(log))
    return eid


def _members(raw: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def test_each_folder_holds_what_the_readme_says(client, tmp_path, monkeypatch):
    # The PDF's presence depends on the computer, so the layout is checked without it.
    monkeypatch.setattr(report_exporter, "_latex_engine", lambda: None)
    eid = _run(tmp_path, ai=True)
    files = _members(client.get(f"/api/executions/{eid}/bundle").content)
    run = f"execution_{eid}/"
    assert sorted(name[len(run):] for name in files if name.startswith(run)) == sorted([
        "README.txt",
        f"log/execution_{eid}.log",
        "latex/report-ai-summary.tex",
        "latex/report.tex",
        "record/metadata.json",
        "record/search-record.json",
        "record/search-record.md",
        "references/references.bib",
        "references/references.csv",
        "references/references.ris",
        "report/report-ai-summary.md",
        "report/report.html",
        "report/report.md",
    ])
    assert sorted(name for name in files if not name.startswith(run)) == ["manifest.json"]

    readme = files[run + "README.txt"].decode()
    assert readme.startswith(f"resmon run {eid}: Deep Sweep\nBundled ")
    for name in ("report.html", "report.md", "report-ai-summary.md", "references.bib", "references.ris",
                 "references.csv", "search-record.json", "metadata.json", f"execution_{eid}.log", "report.tex"):
        assert f"  {name}\n" in readme, name
    # A file that is not there is not named; why the PDF is missing is.
    assert "  report.pdf\n" not in readme
    assert "No PDF: this computer has no XeLaTeX or LuaLaTeX" in readme
    assert "The run's 1 paper as BibTeX." in readme

    manifest = json.loads(files["manifest.json"])[0]
    assert manifest["report"] == {"pdf": None, "html": f"{run}report/report.html", "md": f"{run}report/report.md"}
    assert manifest["references"]["papers"] == 1
    assert manifest["search_record"]["json"] == f"{run}record/search-record.json"
    assert manifest["pdf_problem"].startswith("No PDF")


def test_references_are_the_runs_papers_read_clean(client, tmp_path, monkeypatch):
    monkeypatch.setattr(report_exporter, "_latex_engine", lambda: None)
    eid = _run(tmp_path)
    files = _members(client.get(f"/api/executions/{eid}/bundle").content)
    run = f"execution_{eid}/references/"
    rows = list(csv.DictReader(io.StringIO(files[run + "references.csv"].decode())))
    assert [(r["title"], r["authors"], r["abstract"]) for r in rows] == [
        ("G²-SLAM: Geometrically-guided", "Huaqing Huang, Kaiqi Zhang", "Methods: In 309 patients. • one")]
    assert b"title = {G\xc2\xb2-SLAM: Geometrically-guided}" in files[run + "references.bib"]
    assert b"TI  - G\xc2\xb2-SLAM: Geometrically-guided" in files[run + "references.ris"]
    # The stored row is not rewritten.
    stored = resmon_mod._get_db().execute("SELECT title FROM documents").fetchone()[0]
    assert stored == "G <sup>2</sup> -SLAM: Geometrically-guided"


def test_a_watch_runs_report_is_led_by_the_watchs_name(client, tmp_path, monkeypatch):
    monkeypatch.setattr(report_exporter, "_latex_engine", lambda: None)
    eid = _run(tmp_path, watch="Splat watch")
    files = _members(client.get(f"/api/executions/{eid}/bundle").content)
    page = files[f"execution_{eid}/report/report.html"].decode()
    assert "<h1>Splat watch</h1>" in page
    assert files[f"execution_{eid}/README.txt"].decode().startswith(f"resmon run {eid}: Splat watch\n")


@pytest.mark.skipif(report_exporter._latex_engine() is None, reason="no XeLaTeX or LuaLaTeX on this computer")
def test_with_an_engine_the_pdfs_are_in_report_and_the_source_in_latex(client, tmp_path):
    eid = _run(tmp_path, ai=True)
    files = _members(client.get(f"/api/executions/{eid}/bundle").content)
    run = f"execution_{eid}/"
    assert files[run + "report/report.pdf"].startswith(b"%PDF")
    assert files[run + "report/report-ai-summary.pdf"].startswith(b"%PDF")
    assert sorted(n for n in files if n.startswith(run + "latex/")) == [
        run + "latex/report-ai-summary.tex", run + "latex/report.tex"]
    readme = files[run + "README.txt"].decode()
    assert "  report.pdf\n" in readme and "No PDF" not in readme
    assert json.loads(files["manifest.json"])[0]["report"]["pdf"] == run + "report/report.pdf"
