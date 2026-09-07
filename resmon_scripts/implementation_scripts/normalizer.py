# resmon_scripts/implementation_scripts/normalizer.py
"""Metadata normalization pipeline and deduplication engine."""

import logging
import re
import sqlite3
from dataclasses import replace

from .api_base import Author, NormalizedResult, as_authors
from .database import insert_document, find_duplicates_by_hash
from .utils import compute_metadata_hash, now_iso

logger = logging.getLogger(__name__)

# Regex to strip HTML/XML tags
_HTML_TAG_RE = re.compile(r"<[^>]+>")

# Common date patterns for normalization
_DATE_PATTERNS = [
    # YYYY-MM-DD (already ISO)
    (re.compile(r"^(\d{4})-(\d{2})-(\d{2})"), lambda m: f"{m.group(1)}-{m.group(2)}-{m.group(3)}"),
    # YYYY/MM/DD
    (re.compile(r"^(\d{4})/(\d{2})/(\d{2})"), lambda m: f"{m.group(1)}-{m.group(2)}-{m.group(3)}"),
    # YYYY-MM (partial — day unknown)
    (re.compile(r"^(\d{4})-(\d{2})$"), lambda m: f"{m.group(1)}-{m.group(2)}-01"),
    # YYYY/MM (partial)
    (re.compile(r"^(\d{4})/(\d{2})$"), lambda m: f"{m.group(1)}-{m.group(2)}-01"),
    # YYYY (year only)
    (re.compile(r"^(\d{4})$"), lambda m: f"{m.group(1)}-01-01"),
]


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_result(result: NormalizedResult) -> bool:
    """Verify required fields are present and non-empty.

    Returns True if valid, False otherwise (with a warning log).
    """
    if not result.title or not result.title.strip():
        logger.warning("Validation failed: empty title (external_id=%s)", result.external_id)
        return False
    if not result.external_id or not result.external_id.strip():
        logger.warning("Validation failed: empty external_id (title=%s)", result.title[:60])
        return False
    if not result.source_repository or not result.source_repository.strip():
        logger.warning("Validation failed: empty source_repository (title=%s)", result.title[:60])
        return False
    return True


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

def normalize_author_name(name: str) -> str:
    """One author name, standardised to 'First Last'.

    Handles 'Last, First' by reversing the components and collapses internal
    whitespace. Returns "" for a name that is nothing but whitespace.
    """
    name = (name or "").strip()
    if not name:
        return ""
    if "," in name:
        parts = [p.strip() for p in name.split(",", 1)]
        name = f"{parts[1]} {parts[0]}" if len(parts) == 2 and parts[1] else parts[0]
    return re.sub(r"\s+", " ", name)


def normalize_authors(authors) -> list:
    """Standardise author names, **keeping whatever else the source gave**.

    Accepts names or ``Author`` objects and returns the same kind it was given,
    so the twenty-odd clients that still pass strings are unaffected and the
    handful that now pass structured authors do not lose their ORCID to a
    normalisation step. That last clause is the point: this function used to
    take ``list[str]`` and return ``list[str]``, and running it over structured
    authors would have quietly discarded exactly the fields phase 2.1 exists to
    keep.
    """
    normalized: list = []
    for entry in as_authors(authors):
        name = normalize_author_name(entry.name)
        if not name:
            continue
        normalized.append(replace(entry, name=name) if name != entry.name else entry)
    return normalized


def normalize_date(date_str: str | None) -> str | None:
    """Convert a date string to ISO 8601 (YYYY-MM-DD).

    Handles partial dates (YYYY-MM → YYYY-MM-01, YYYY → YYYY-01-01).
    Returns None if the input is None, empty, or unparseable.
    """
    if not date_str:
        return None
    date_str = date_str.strip()
    if not date_str:
        return None

    # Try each pattern
    for pattern, formatter in _DATE_PATTERNS:
        m = pattern.match(date_str)
        if m:
            return formatter(m)

    # If ISO 8601 with time component (e.g. 2026-04-15T08:00:00Z), extract date part
    iso_match = re.match(r"^(\d{4}-\d{2}-\d{2})", date_str)
    if iso_match:
        return iso_match.group(1)

    logger.warning("Could not normalize date: %r", date_str)
    return date_str  # Return as-is rather than discarding


def clean_title(title: str) -> str:
    """Strip whitespace and normalize internal spaces."""
    title = title.strip()
    title = re.sub(r"\s+", " ", title)
    return title


def clean_abstract(abstract: str | None) -> str | None:
    """Strip HTML tags and normalize whitespace."""
    if not abstract:
        return abstract
    # Remove HTML tags
    cleaned = _HTML_TAG_RE.sub("", abstract)
    # Decode common HTML entities
    cleaned = cleaned.replace("&amp;", "&")
    cleaned = cleaned.replace("&lt;", "<")
    cleaned = cleaned.replace("&gt;", ">")
    cleaned = cleaned.replace("&quot;", '"')
    cleaned = cleaned.replace("&#39;", "'")
    cleaned = cleaned.replace("&nbsp;", " ")
    # Normalize whitespace
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned if cleaned else None


# ---------------------------------------------------------------------------
# Full normalization
# ---------------------------------------------------------------------------

def normalize_result(result: NormalizedResult) -> NormalizedResult:
    """Apply all normalization steps to a NormalizedResult and return a new instance.

    Steps: clean title, normalize authors, normalize date, clean abstract,
    then compute and store the metadata hash (stored in a transient attribute).
    """
    title = clean_title(result.title)
    authors = normalize_authors(result.authors)
    pub_date = normalize_date(result.publication_date)
    abstract = clean_abstract(result.abstract)

    normalized = NormalizedResult(
        source_repository=result.source_repository,
        external_id=result.external_id,
        doi=result.doi,
        title=title,
        authors=authors,
        abstract=abstract,
        publication_date=pub_date,
        url=result.url,
        categories=list(result.categories),
    )
    # Attach metadata hash as a transient attribute for dedup
    # The hash is over the *names*, unchanged from before 2.1: adding an ORCID
    # to a record must not make it a different paper from the same record
    # without one, or every cross-source duplicate would stop matching the day a
    # client learned to fill the field.
    normalized._metadata_hash = compute_metadata_hash(  # type: ignore[attr-defined]
        title, [a.name for a in normalized.authors], pub_date)
    return normalized


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def deduplicate_batch(
    conn: sqlite3.Connection,
    results: list[NormalizedResult],
) -> dict:
    """Normalize, validate, and insert results into the database.

    Returns a dict with counts: {"total", "new", "duplicates", "invalid", "cross_source"}.

    - Same-source duplicates are silently ignored (UNIQUE constraint).
    - Cross-source duplicates are detected by metadata_hash and flagged but still stored.
    """
    stats = {"total": len(results), "new": 0, "duplicates": 0, "invalid": 0, "cross_source": 0}

    for result in results:
        # Normalize
        normalized = normalize_result(result)

        # Validate
        if not validate_result(normalized):
            stats["invalid"] += 1
            continue

        metadata_hash = normalized._metadata_hash  # type: ignore[attr-defined]

        # Check for cross-source duplicates
        existing = find_duplicates_by_hash(conn, metadata_hash)
        cross_source = any(
            d["source_repository"] != normalized.source_repository
            for d in existing
        )
        if cross_source:
            stats["cross_source"] += 1
            logger.info(
                "Cross-source duplicate: %s/%s matches existing record(s)",
                normalized.source_repository,
                normalized.external_id,
            )

        # Build document dict for insertion
        doc = {
            "source_repository": normalized.source_repository,
            "external_id": normalized.external_id,
            "doi": normalized.doi,
            "title": normalized.title,
            "authors": ", ".join(normalized.author_names),
            "abstract": normalized.abstract,
            "publication_date": normalized.publication_date,
            "url": normalized.url,
            "categories": ", ".join(normalized.categories),
            "metadata_hash": metadata_hash,
            # Not a column. ``insert_document`` hands this to
            # ``index_document_facets`` so the author rows carry whatever
            # identity the source gave, which the joined string above cannot.
            "structured_authors": normalized.authors,
        }

        row_id = insert_document(conn, doc)
        if row_id is not None:
            stats["new"] += 1
        else:
            stats["duplicates"] += 1

    return stats
