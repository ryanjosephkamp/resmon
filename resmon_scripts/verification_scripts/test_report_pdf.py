# resmon_scripts/verification_scripts/test_report_pdf.py
"""The report's PDF: what it holds, and that it holds every character.

A run's Markdown report is parsed once and rendered as LaTeX here (and as HTML
in ``test_report_html.py``). What is held:

* **Every section of the Markdown reaches the document.** "Sources that did not
  answer, and why" and the others are sections, not date groups, and the
  count of publication dates counts only dates.
* **No character is dropped silently.** The LaTeX is Unicode (fontspec, never
  the 8-bit T1 fonts), each character the body font lacks goes to a fallback
  font, and a character no font has is read back from the engine's log. With a
  LaTeX engine present, the PDF is compiled and its text read with pypdf: each
  test character is in the PDF or listed as missing, never neither.
* **The layout's rules**: labels and values set side by side in hanging boxes
  (no ``\\color`` opening a ``p`` column), the abstract in a box that continues
  on the next page, no date heading as the last line of a page and no title
  parted from its abstract, one name for the document, and the time it was
  made in the reader's own zone.
"""

import os
import re
import shutil
import sys
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import report_exporter
from implementation_scripts.report_exporter import (
    _build_digest_tex, document_heading, export_report_bundle, local_stamp, missing_characters,
    parse_report, summary_rows,
)
from implementation_scripts.report_generator import generate_report

# The characters the report used to lose, with Greek, Chinese and Korean.
HARD = "’ “ ” – — › α β 中文"
WORDS = ("splatting radiance field reconstruction depth prior densification pruning scene "
         "neural rendering benchmark covariance rasterization camera pose dataset memory").split()


def _sentence(i: int, n: int = 18) -> str:
    words = [WORDS[(i * 7 + k * 3) % len(WORDS)] for k in range(n)]
    return " ".join(words).capitalize() + "."


def _docs(groups: int = 4, per_group: int = 3, sentences: int = 8) -> list[dict]:
    docs = []
    for g in range(groups):
        for p in range(per_group):
            i = g * per_group + p
            docs.append({
                "title": f"Paper {i}: {_sentence(i, 8)[:-1]}",
                "authors": [f"A. Author{i}", "B. Second"],
                "abstract": " ".join(_sentence(i + k) for k in range(sentences)),
                "publication_date": f"2026-11-{10 - g:02d}",
                "url": f"https://doi.org/10.1234/t.{i}",
                "source_repository": "arxiv" if p else "medrxiv",
                "external_id": f"10.1234/t.{i}",
                "categories": ["cs.CV"] if p else ["epidemiology"],
            })
    docs[0]["title"] = f"Jingdezhen’s kilns {HARD}"
    docs[0]["abstract"] = f"The twins’ and the videos’ frames {HARD}. MethodsIn 309 patients O_LIone C_LI"
    if len(docs) > 2:
        docs[1]["abstract"] = "Abstract Fine-grained industrial parts differ."
        docs[2]["authors"] = ["Huaqing Huang", "黄华清", "Kaiqi Zhang"]
    return docs


def _metadata(**extra) -> dict:
    meta = {
        "query": "", "keywords": ["gaussian splatting", "splats"],
        "repositories": ["arxiv", "medrxiv", "core"], "missing_key_repos": ["CORE"],
        "zero_notes": [
            {"source": "arXiv", "slug": "arxiv", "reason": "upstream_failure",
             "sentence": "arXiv answered with HTTP 503, so this run has no answer from it."},
            {"source": "medRxiv", "slug": "medrxiv", "reason": "answered_empty",
             "sentence": "medRxiv answered and had nothing in this window."},
        ],
        "duplicate_links": [{"title": "One", "source": "arXiv", "other_title": "One",
                             "other_source": "Crossref", "method": "shared_doi"}],
        "date_from": "2026-10-11", "date_to": "2026-11-10", "total": 12, "new": 10,
    }
    meta.update(extra)
    return meta


def test_every_section_reaches_the_parse_and_only_dates_are_counted():
    parsed = parse_report(generate_report(_docs(), _metadata()))
    headings = [entry["heading"] for entry in parsed["body"]]
    assert headings[:4] == ["November 10, 2026", "November 9, 2026", "November 8, 2026", "November 7, 2026"]
    assert headings[4:] == ["The same paper, from more than one source",
                            "Sources that answered with nothing to keep",
                            "Sources that did not answer, and why"]
    assert [e["kind"] for e in parsed["body"]] == ["group"] * 4 + ["section"] * 3
    rows = dict(summary_rows(parsed, document_heading(parsed)))
    assert rows["Papers Included"] == "12"
    assert rows["Publication Dates"] == "4"
    assert parsed["notices"] == ["**Warning:** No API key was found for the following repository(ies), "
                                 "so they returned zero results: CORE."]
    tex = _build_digest_tex(parsed)
    for heading in headings:
        assert re.search(r"\\resmonheading\[\d+\]\{" + re.escape(heading) + r"\}", tex), heading
    assert "arXiv answered with HTTP 503" in tex
    assert "No API key was found" in tex


def test_a_canceled_report_says_so_in_its_title_its_rows_and_its_notice():
    md = generate_report(_docs(1, 1), _metadata(cancellation={"stage": "querying", "stored": False, "answered": []}))
    parsed = parse_report(md)
    heading = document_heading(parsed, {"kind": "deep_sweep"})
    assert heading["title"] == "Deep Sweep (canceled)"
    assert dict(summary_rows(parsed, heading))["Status"] == "Canceled before the run finished"
    assert any("This run was canceled" in n for n in parsed["notices"])
    assert "This run was canceled" in _build_digest_tex(parsed)


def test_a_watch_reports_findings_say_nothing_of_an_abstract():
    """A finding is not a paper's record: no "No abstract available." under it."""
    from implementation_scripts import report_html
    from implementation_scripts.report_generator import generate_watch_report
    md = generate_watch_report(
        {"display_name": "Ada Lovelace"},
        {"findings": [{"label": "Retraction", "title": "A retracted paper", "basis": "name_only",
                       "matched_author": "Ada Lovelace", "doi": "10.1/x", "notice_url": "https://example.org/n"}],
         "matched_documents": 1, "coverage_note": "One paper was checked."},
        {"checked_now": 1, "selected": 1})
    parsed = parse_report(md)
    assert [e["heading"] for e in parsed["body"]] == ["Coverage", "Findings"]
    assert "No abstract available" not in _build_digest_tex(parsed)
    assert "No abstract available" not in report_html.render(parsed)
    assert "One paper was checked." in report_html.render(parsed)
    # Under a date, a paper with no abstract still says so.
    plain = parse_report(generate_report([{**_docs(1, 1)[0], "abstract": None}], _metadata()))
    assert "No abstract available." in _build_digest_tex(plain)


def test_the_document_has_one_name_and_is_led_by_the_watch_or_the_kind_of_run():
    parsed = parse_report(generate_report(_docs(1, 1), _metadata()))
    assert document_heading(parsed, {"kind": "automated_sweep", "watch": "Splat watch"})["title"] == "Splat watch"
    sweep = document_heading(parsed, {"kind": "deep_sweep"})
    assert (sweep["kicker"], sweep["title"], sweep["subtitle"]) == (
        "resmon report", "Deep Sweep", "gaussian splatting, splats")
    # The terms are the subtitle, so the summary does not repeat them.
    assert "Query" not in dict(summary_rows(parsed, sweep))
    tex = _build_digest_tex(parsed, context={"kind": "deep_sweep"})
    for old in ("literature digest", "Literature Digest", "Surveillance", "Literature Report"):
        assert old not in tex
    # A report written before the rename is titled the same way.
    legacy = parse_report("# resmon Literature Report\n**Query:** graph\n")
    assert document_heading(legacy, {"kind": "deep_dive"})["title"] == "Deep Dive"


@pytest.fixture
def eastern(monkeypatch):
    if not hasattr(time, "tzset"):
        pytest.skip("the time zone can only be set this way on POSIX")
    monkeypatch.setenv("TZ", "America/New_York")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


def test_the_time_made_is_said_in_local_time(eastern):
    assert local_stamp("2026-11-10T19:22:14Z") == "November 10, 2026, 2:22 PM EST"
    assert local_stamp("2026-07-04T16:05:00.123456+00:00") == "July 4, 2026, 12:05 PM EDT"
    assert local_stamp("not a time") == "not a time"
    tex = _build_digest_tex(parse_report("# resmon report\n**Generated:** 2026-11-10T19:22:14Z  \n"))
    assert "Generated November 10, 2026, 2:22 PM EST" in tex
    assert "2026-11-10T" not in tex


def test_the_latex_is_unicode_and_sends_every_hard_character_to_a_font():
    tex = _build_digest_tex(parse_report(generate_report(_docs(), _metadata())))
    assert r"\usepackage{fontspec}" in tex
    assert "fontenc" not in tex and "lmodern" not in tex
    # The body font has these and sets them as they are.
    for ch in "’“”–—›":
        assert ch in tex
    # The rest go through \rc, which finds them a font.
    for ch in "αβ中文":
        assert f"\\rc{{{ord(ch)}}}{{{ch}}}" in tex
    # Cleaned as stored text is read: no markup, no doubled "Abstract", no empty author.
    assert "O_LI" not in tex and "Methods: In 309 patients" in tex
    assert "Abstract.}\\ Fine-grained" in tex
    assert "Huang, , " not in tex


def test_labels_sit_in_hanging_boxes_without_a_color_opening_a_column():
    tex = _build_digest_tex(parse_report(generate_report(_docs(1, 1), _metadata())))
    assert r"\resmonfield{Date Range}{October 11, 2026 to November 10, 2026}" in tex
    assert ">{" not in tex, "no column specification with \\color in it"
    assert r"\begin{tabular}" not in tex
    assert r"\begin{minipage}" not in tex, "an abstract box must be able to continue on the next page"
    assert r"\begin{resmonbox}{abstractbg}" in tex


def test_missing_characters_are_read_from_the_engines_log():
    log = ("Missing character: There is no 😀 (U+1F600) in font [lmroman10-regular.otf]/OT:script=latn;!\n"
           "Missing character: There is no 😀 (U+1F600) in font [lmroman10-bold.otf]/OT:script=latn;!\n"
           "Missing character: There is no 中 (U+4E2D) in font [lmroman10-regular.otf]!\n")
    assert missing_characters(log) == ["中 (U+4E2D)", "😀 (U+1F600)"]


def test_no_engine_means_no_pdf_and_a_sentence_saying_why(tmp_path, monkeypatch):
    monkeypatch.setattr(report_exporter, "_latex_engine", lambda: None)
    md = tmp_path / "r.md"
    md.write_text(generate_report(_docs(1, 1), _metadata()), encoding="utf-8")
    result = export_report_bundle(md, tmp_path / "out")
    assert result["pdf"] is None
    assert result["pdf_problem"].startswith("No PDF: this computer has no XeLaTeX or LuaLaTeX")
    assert (tmp_path / "out" / "latex" / "report.tex").exists()
    assert (tmp_path / "out" / "report" / "report.html").exists()


# ---------------------------------------------------------------------------
# Compiled, where a LaTeX engine is installed
# ---------------------------------------------------------------------------

needs_engine = pytest.mark.skipif(report_exporter._latex_engine() is None,
                                  reason="no XeLaTeX or LuaLaTeX on this computer")


def _pages(pdf: Path) -> list[str]:
    import pypdf
    return [page.extract_text() for page in pypdf.PdfReader(str(pdf)).pages]


@needs_engine
def test_the_pdf_shows_every_character_or_says_which_it_could_not(tmp_path):
    md = tmp_path / "r.md"
    md.write_text(generate_report(_docs(), _metadata()), encoding="utf-8")
    result = export_report_bundle(md, tmp_path / "out", context={"kind": "deep_sweep"})
    assert result["pdf"] is not None, result["pdf_problem"]
    text = "\n".join(_pages(result["pdf"]))
    missing = " ".join(result["pdf_missing_characters"])
    for ch in HARD.replace(" ", ""):
        assert ch in text or ch in missing, f"{ch} was dropped and not reported"
    assert "Sources that did not answer, and why" in text
    assert "Sources that answered with nothing to keep" in text
    assert "The same paper, from more than one source" in text
    assert "Abstract. Abstract" not in text
    # The engine's working files go; the source stays for a rebuild.
    assert sorted(p.name for p in (tmp_path / "out" / "latex").iterdir()) == ["report.tex"]


@needs_engine
def test_a_long_abstract_continues_on_the_next_page(tmp_path):
    docs = _docs(1, 1, sentences=1)
    docs[0]["abstract"] = " ".join(f"Sentence {k} " + _sentence(k) for k in range(90))
    md = tmp_path / "r.md"
    md.write_text(generate_report(docs, _metadata(zero_notes=[], duplicate_links=[])), encoding="utf-8")
    result = export_report_bundle(md, tmp_path / "out")
    pages = _pages(result["pdf"])
    assert len(pages) >= 2
    assert "Sentence 0 " in pages[0]
    assert "Sentence 89 " in pages[-1]


@needs_engine
def test_no_heading_ends_a_page_and_no_title_is_parted_from_its_abstract(tmp_path):
    md = tmp_path / "r.md"
    md.write_text(generate_report(_docs(groups=12, per_group=2, sentences=5), _metadata()), encoding="utf-8")
    result = export_report_bundle(md, tmp_path / "out")
    pages = _pages(result["pdf"])
    assert len(pages) > 3
    heading = re.compile(r"^(January|February|March|April|May|June|July|August|September|October|"
                         r"November|December) \d{1,2}, \d{4}$")
    for number, page in enumerate(pages[:-1], 1):
        lines = [line.strip() for line in page.splitlines() if line.strip()]
        assert not heading.match(lines[-1]), f"page {number} ends with the heading {lines[-1]!r}"
    for number, page in enumerate(pages[1:], 2):
        lines = [line.strip() for line in page.splitlines() if line.strip()]
        # Line 0 is the running header; a box opening the page means its paper's
        # title was left at the foot of the page before.
        assert not lines[1].startswith("Abstract."), f"page {number} opens with an abstract"
