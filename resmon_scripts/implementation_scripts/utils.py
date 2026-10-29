# resmon_scripts/implementation_scripts/utils.py
import hashlib
import re
from datetime import datetime, timezone


def now_iso() -> str:
    """Return the current UTC timestamp in ISO 8601 format."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def compute_metadata_hash(title: str, authors: list[str], publication_date: str | None) -> str:
    """Generate a SHA-256 hash from normalized title, authors, and date for deduplication."""
    normalized_title = re.sub(r"\s+", " ", title.strip().lower())
    normalized_authors = ",".join(sorted(a.strip().lower() for a in authors))
    date_part = (publication_date or "").strip()
    combined = f"{normalized_title}|{normalized_authors}|{date_part}"
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()


# A month as people write it, to its number. DOAJ gives ``bibjson.month`` as a
# name about as often as a number; the client reads it with this table, and the
# rows stored before it did are repaired with the same one
# (``database._repair_doaj_month_names``), so the two cannot disagree.
_MONTH_NUMBERS: dict[str, int] = {
    name: index
    for index, names in enumerate((
        ("january", "jan"), ("february", "feb"), ("march", "mar"), ("april", "apr"),
        ("may",), ("june", "jun"), ("july", "jul"), ("august", "aug"),
        ("september", "sep", "sept"), ("october", "oct"), ("november", "nov"), ("december", "dec"),
    ), start=1)
    for name in names
}


def month_from_name(text: str) -> int | None:
    """A month's name or abbreviation ("January", "jul", "Sept.") as 1-12, else None."""
    return _MONTH_NUMBERS.get(text.strip().lower().rstrip("."))


def sanitize_filename(name: str) -> str:
    """Remove or replace characters that are unsafe for filenames."""
    return re.sub(r'[<>:"/\\|?*]', "_", name).strip()
