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
    assert "# resmon Literature Report" in report
    assert "Paper A" in report
    assert "Auth A" in report
