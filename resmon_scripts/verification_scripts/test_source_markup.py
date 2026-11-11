# resmon_scripts/verification_scripts/test_source_markup.py
"""Markup a source sends, turned into the text it stands for.

bioRxiv and medRxiv send their abstracts with markers (``O_ST_ABS`` ...
``C_ST_ABS`` round a section title, ``O_LI`` ... ``C_LI`` round a list item,
``O_FIG`` ... ``C_FIG`` round a figure), Crossref sends JATS, other sources send
HTML, sometimes escaped twice, and titles carry ``<sup>`` and ``<i>``. The
samples here are taken from a real Deep Sweep's report.

What is held:

* **Each kind of markup becomes text**: a section title a label, a list item a
  bulleted sentence, a figure nothing, a superscript a superscript character.
* **Prose is left alone**: "p <0.05", "<n>", TeX math, and "Abstract algebra".
* **Cleaning twice is cleaning once**, so a read can clean stored text again.
* **A stored paper reads cleanly without its row being rewritten**: the engine's
  responses clean on the way out, and the row keeps what the source sent.
"""

import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod
from fastapi.testclient import TestClient

from implementation_scripts.api_base import NormalizedResult
from implementation_scripts.database import init_db, insert_document
from implementation_scripts.normalizer import (
    clean_abstract, clean_author_list, clean_title, deduplicate_batch, normalize_author_name,
    normalize_result,
)

# From a medRxiv record in the report: a "What is known / What is new" box.
KNOWN_AND_NEW = (
    "patients with SBS. What is known/What is newO_ST_ABSWhat is knownC_ST_ABSO_LIChildren with "
    "short bowel syndrome (SBS) often demonstrate intestinal dysbiosis. C_LIO_LIDysbiosis in SBS "
    "is associated with increased PN dependence. C_LI What is newO_LISBS-specific differences "
    "were driven by depletion of Bacteroidota. C_LIO_LIOur findings shift attention. C_LI"
)
# From a medRxiv record: Lancet-style heads run into their text.
STRUCTURED = (
    "BackgroundClaims-based algorithms trade PPV against sensitivity. MethodsIn 309 oncology "
    "patients we compared 12 LLMs. FindingsLLMs extended the PPV-yield frontier. "
    "InterpretationZero-shot LLMs offer a higher-PPV alternative. FundingNational Institute on "
    "Aging. Research in contextO_ST_ABSEvidence before this studyC_ST_ABSWe searched PubMed "
    "up to August 2026. Added value of this studyOn a single, fixed cohort the LLMs did better."
)
# From a medRxiv record: a graphical abstract between two sections.
FIGURE = (
    "FundingAustrian Research Promotion Agency (FFG; grant FO999922422). Graphical abstract "
    "O_FIG O_LINKSMALLFIG WIDTH=200 HEIGHT=70 SRC=\"FIGDIR/small/26366943v1_ufig1.gif\" "
    "ALT=\"Figure 1\"> View larger version (23K): org.highwire.dtl.DTLVardef@a760b2"
    "org.highwire.dtl.DTLVardef@bd477a_HPS_FORMAT_FIGEXP M_FIG C_FIG Research in context"
    "O_ST_ABSEvidence before this studyC_ST_ABSWe searched PubMed."
)


def test_preprint_list_items_and_section_titles_become_labels_and_bullets():
    cleaned = clean_abstract(KNOWN_AND_NEW, "medrxiv")
    assert cleaned == (
        "patients with SBS. What is known/What is new. What is known: • Children with short "
        "bowel syndrome (SBS) often demonstrate intestinal dysbiosis. • Dysbiosis in SBS is "
        "associated with increased PN dependence. What is new: • SBS-specific differences were "
        "driven by depletion of Bacteroidota. • Our findings shift attention."
    )
    assert "O_" not in cleaned and "C_" not in cleaned


def test_preprint_heads_run_into_their_text_become_labels():
    cleaned = clean_abstract(STRUCTURED, "biorxiv")
    assert cleaned.startswith("Background: Claims-based algorithms")
    for label in ("Methods: In 309", "Findings: LLMs extended", "Interpretation: Zero-shot",
                  "Funding: National Institute", "Added value of this study: On a single"):
        assert label in cleaned, label
    # A head with a subhead after it at once reads as a sentence, then a label.
    assert "Research in context. Evidence before this study: We searched PubMed" in cleaned


def test_heads_are_only_read_as_heads_for_biorxiv_and_medrxiv():
    """Another source's "MethodsIn" is left as it came; the rule is these two's."""
    assert clean_abstract("MethodsIn 309 patients.", "crossref") == "MethodsIn 309 patients."


def test_preprint_figure_blocks_go_with_their_caption():
    cleaned = clean_abstract(FIGURE, "medrxiv")
    assert cleaned == ("Funding: Austrian Research Promotion Agency (FFG; grant FO999922422). "
                       "Research in context. Evidence before this study: We searched PubMed.")


def test_bracketed_and_double_escaped_entities_are_read():
    assert clean_abstract("walking (both Bonferroni p [&ge;] 0.479).", "medrxiv") == \
        "walking (both Bonferroni p ≥ 0.479)."
    assert clean_abstract("without sacrificing structural integrity.&lt;/div&gt; &lt;/div&gt;") == \
        "without sacrificing structural integrity."
    assert clean_abstract("R&amp;D at AT&T, &para; and &parameter") == "R&D at AT&T, ¶ and &parameter"


def test_jats_titles_become_labels_and_the_abstract_heading_goes():
    assert clean_abstract("<jats:title>Abstract</jats:title><jats:p>Fine-grained industrial parts "
                          "differ.</jats:p>", "crossref") == "Fine-grained industrial parts differ."
    assert clean_abstract(
        "<jats:sec><jats:title>Background</jats:title><jats:p>We study X.</jats:p></jats:sec>"
        "<jats:sec><jats:title>Methods</jats:title><jats:p>We used CO<jats:sub>2</jats:sub>."
        "</jats:p></jats:sec>", "crossref") == "Background: We study X. Methods: We used CO₂."


@pytest.mark.parametrize("raw, expected", [
    # From a Crossref record in the report, which printed "Abstract. Abstract Fine-grained".
    ("Abstract Fine-grained industrial parts such as screw, nut, and gear variants differ.",
     "Fine-grained industrial parts such as screw, nut, and gear variants differ."),
    ("Abstract: We present a method.", "We present a method."),
    ("Abstract. We present a method.", "We present a method."),
    ("ABSTRACT Background is given.", "Background is given."),
    ("Abstract Abstract The same heading twice.", "The same heading twice."),
    ("Abstract algebra is the study of groups.", "Abstract algebra is the study of groups."),
    ("Abstracts of the 2026 meeting.", "Abstracts of the 2026 meeting."),
])
def test_an_abstracts_own_heading_is_removed_and_a_sentence_is_kept(raw, expected):
    assert clean_abstract(raw) == expected


@pytest.mark.parametrize("raw, expected", [
    # Both from titles in the report.
    ("M <sup>3</sup> ISR: A Multi-Modal Multi-View Benchmark", "M³ ISR: A Multi-Modal Multi-View Benchmark"),
    ("G <sup>2</sup> -SLAM: Geometrically-guided 3D Gaussian Splatting SLAM",
     "G²-SLAM: Geometrically-guided 3D Gaussian Splatting SLAM"),
    ("Ca<sup>2+</sup> flux and CO<sub>2</sub> uptake", "Ca²⁺ flux and CO₂ uptake"),
    ("Uptake of <sup>3</sup>He and <sup>18</sup>F-FDG in mice", "Uptake of ³He and ¹⁸F-FDG in mice"),
    ("The <sup>1</sup>H NMR of x <sup>2</sup>", "The ¹H NMR of x²"),
    ("Rates near 10<sup>−3.5</sup> per year", "Rates near 10^−3.5 per year"),
    ("The <i>Drosophila</i> gene&#8217;s role", "The Drosophila gene’s role"),
    ("A note<sup>*</sup> and a mark<sup>TM</sup>", "A note* and a mark™"),
])
def test_title_markup_becomes_text(raw, expected):
    assert clean_title(raw) == expected


@pytest.mark.parametrize("prose", [
    "Bounds for n<5 and m>3",
    "We reach $1.24$-$2.14\\times$ speedups when p<0.05 and q > 3.",
    "Keep the <n> most cited, where a<b and c>d.",
    "Abstract algebra is the study of groups.",
    "Clear cell sarcoma (CCS) is driven by the EWSR1::ATF1 fusion — and “Jingdezhen’s” kilns.",
])
def test_prose_with_angle_brackets_and_tex_is_left_alone(prose):
    assert clean_abstract(prose) == prose
    assert clean_title(prose) == prose


@pytest.mark.parametrize("raw, source", [
    (KNOWN_AND_NEW, "medrxiv"), (STRUCTURED, "biorxiv"), (FIGURE, "medrxiv"),
    ("<jats:title>Abstract</jats:title><jats:p>Text.</jats:p>", "crossref"),
    ("Abstract: Abstract text &amp;lt;b&amp;gt;", "openalex"),
])
def test_cleaning_twice_is_cleaning_once(raw, source):
    once = clean_abstract(raw, source)
    assert clean_abstract(once, source) == once


def test_names_with_no_letter_are_dropped():
    assert normalize_author_name("-") == ""
    assert normalize_author_name(" . ") == ""
    assert normalize_author_name("黄华清") == "黄华清"
    assert clean_author_list("Huaqing Huang, , Kaiqi Zhang") == "Huaqing Huang, Kaiqi Zhang"
    assert clean_author_list("Zirui Ma, Dongrui Fan, -, Wenming Li") == "Zirui Ma, Dongrui Fan, Wenming Li"
    result = normalize_result(NormalizedResult("openalex", "1", None, "T", ["A. One", "", "-", "B. Two"],
                                               None, "2026-01-01", "", []))
    assert result.author_names == ["A. One", "B. Two"]


def test_a_paper_arriving_is_stored_clean():
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    deduplicate_batch(conn, [NormalizedResult(
        "medrxiv", "10.64898/1", None, "G <sup>2</sup> -SLAM", ["A. One"],
        "MethodsIn 309 patients. O_LIone C_LI", "2026-11-01", "", [])])
    title, abstract = conn.execute("SELECT title, abstract FROM documents").fetchone()
    assert (title, abstract) == ("G²-SLAM", "Methods: In 309 patients. • one")
    conn.close()


@pytest.fixture
def client():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod._get_db()
    yield TestClient(resmon_mod.app)
    resmon_mod.close_db()


def test_a_paper_stored_with_markup_is_read_clean_and_its_row_is_kept(client):
    """The paper page's answer is clean; the stored row still holds what the source sent."""
    raw_title = "G <sup>2</sup> -SLAM: Geometrically-guided"
    raw_abstract = KNOWN_AND_NEW
    conn = resmon_mod._get_db()
    doc_id = insert_document(conn, {
        "source_repository": "medrxiv", "external_id": "10.64898/2", "doi": None,
        "title": raw_title, "authors": "A. One", "abstract": raw_abstract,
        "publication_date": "2026-11-01", "url": "", "categories": "", "metadata_hash": "h-markup",
    })
    conn.commit()
    body = client.get(f"/api/documents/{doc_id}").json()
    assert body["title"] == "G²-SLAM: Geometrically-guided"
    assert body["abstract"] == clean_abstract(raw_abstract, "medrxiv")
    assert "O_LI" not in body["abstract"]
    stored = conn.execute("SELECT title, abstract FROM documents WHERE id = ?", (doc_id,)).fetchone()
    assert tuple(stored) == (raw_title, raw_abstract)
