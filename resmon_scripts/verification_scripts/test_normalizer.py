# resmon_scripts/verification_scripts/test_normalizer.py
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.api_base import NormalizedResult
from implementation_scripts.database import init_db
from implementation_scripts.normalizer import (
    normalize_result, deduplicate_batch, clean_abstract,
)
from implementation_scripts.report_exporter import _build_digest_tex, _parse_report
from implementation_scripts.report_generator import generate_report


def test_normalization_consistency():
    """Normalization produces identical output for semantically identical inputs."""
    r1 = NormalizedResult("arxiv", "1", None, "  A Test Paper  ", ["John Doe"], None, "2026-04-15", "", [])
    r2 = NormalizedResult("crossref", "2", None, "A Test Paper", ["John Doe"], None, "2026-04-15", "", [])
    n1 = normalize_result(r1)
    n2 = normalize_result(r2)
    assert n1.title == n2.title


def test_html_stripping():
    """HTML tags are removed from abstracts."""
    cleaned = clean_abstract("<p>This is <b>bold</b> text.</p>")
    assert "<" not in cleaned
    assert "bold" in cleaned


def test_deduplication():
    """Same-source duplicates are silently ignored; cross-source flagged."""
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    results = [
        NormalizedResult("arxiv", "1", None, "Paper A", ["Auth"], "Abstract", "2026-04-15", "", []),
        NormalizedResult("arxiv", "1", None, "Paper A", ["Auth"], "Abstract", "2026-04-15", "", []),
    ]
    stats = deduplicate_batch(conn, results)
    assert stats["new"] == 1
    assert stats["duplicates"] >= 1
    conn.close()


def test_report_generation():
    """Report generates valid Markdown with header and paper entries."""
    docs = [
        {"title": "Paper A", "authors": ["Auth A"], "abstract": "Abstract A",
         "publication_date": "2026-04-15", "url": "https://example.com/a",
         "source_repository": "arxiv", "external_id": "1", "categories": ["cs.LG"]},
    ]
    metadata = {"query": "machine learning", "date_from": "2026-04-14",
                "date_to": "2026-04-15", "total": 1, "new": 1}
    report = generate_report(docs, metadata)
    assert report.startswith("# resmon report\n")
    assert "Paper A" in report
    assert "Auth A" in report


def test_report_names_its_sources_and_says_its_dates_as_words():
    """The header and each paper name a source as the catalog does, and the range is said as dates."""
    docs = [
        {"title": "Paper A", "authors": ["Auth A"], "abstract": "Abstract A",
         "publication_date": "2026-04-15", "url": "", "source_repository": "biorxiv",
         "external_id": "10.1101/1", "categories": []},
    ]
    metadata = {"query": "machine learning", "repositories": ["biorxiv", "arxiv", "ieee"],
                "date_from": "2025-11-03", "date_to": "2026-11-03T00:00:00", "total": 1, "new": 1}
    report = generate_report(docs, metadata)
    assert "**Sources:** bioRxiv, arXiv, IEEE Xplore  " in report
    assert "**Repositories:**" not in report
    assert "- **Source:** bioRxiv (10.1101/1)" in report
    assert "**Date Range:** November 3, 2025 to November 3, 2026  " in report
    # The PDF and LaTeX renderings are made from the same Markdown and carry both lines.
    tex = _build_digest_tex(_parse_report(report))
    assert r"\resmonfield{Sources}{bioRxiv, arXiv, IEEE Xplore}" in tex
    assert r"\resmonfield{Date Range}{November 3, 2025 to November 3, 2026}" in tex
    # A slug the catalog does not know, and a bound that is not a day, are shown as stored.
    odd = generate_report([], {"query": "q", "repositories": ["nowhere"], "date_from": "last week", "date_to": None})
    assert "**Sources:** nowhere  " in odd
    assert "**Date Range:** from last week, with no end date  " in odd


def test_new_arxiv_addresses_are_stored_as_https_from_any_source():
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    result = NormalizedResult("openalex", "https-test", None, "A paper", [], None,
                              "2026-01-01", "http://arxiv.org/abs/2601.00001", [])
    deduplicate_batch(conn, [result])
    assert conn.execute("SELECT url FROM documents").fetchone()[0] == "https://arxiv.org/abs/2601.00001"
    conn.close()


def test_normalization_preserves_an_absent_or_empty_source_address():
    for url in (None, ""):
        result = NormalizedResult("openalex", "no-url", None, "A paper", [], None,
                                  "2026-01-01", url, [])
        assert normalize_result(result).url == url
