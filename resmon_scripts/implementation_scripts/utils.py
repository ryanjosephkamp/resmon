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


def sanitize_filename(name: str) -> str:
    """Remove or replace characters that are unsafe for filenames."""
    return re.sub(r'[<>:"/\\|?*]', "_", name).strip()
