# resmon_scripts/implementation_scripts/report_generator.py
"""Chronological Markdown report generator for literature surveillance results."""

import logging
import shlex
from collections import defaultdict
from pathlib import Path

from .utils import now_iso

logger = logging.getLogger(__name__)


def generate_report(documents: list[dict], metadata: dict) -> str:
    """Generate a Markdown reading report from a list of document dicts.

    Parameters
    ----------
    documents : list[dict]
        Each dict must have: title, authors (list[str] or str), abstract,
        publication_date, url, source_repository, external_id, categories (list or str).
    metadata : dict
        Report metadata with keys: query, date_from, date_to, total, new.

    Returns
    -------
    str
        Complete Markdown report text.
    """
    lines: list[str] = []

    # --- Header ---
    generated_at = now_iso()
    raw_query = metadata.get("query", "")
    keywords = metadata.get("keywords")
    if isinstance(keywords, list) and keywords:
        query_display = ", ".join(str(k) for k in keywords)
    elif isinstance(raw_query, str) and raw_query.strip():
        # Fall back to parsing the flat query string with shlex so that
        # quoted multi-word phrases (e.g. "machine learning") stay intact
        # instead of being split at every whitespace character.
        try:
            parts = shlex.split(raw_query)
        except ValueError:
            parts = []
        if not parts:
            parts = [raw_query.strip()]
        query_display = ", ".join(parts)
    else:
        query_display = "N/A"

    repositories = metadata.get("repositories")
    if isinstance(repositories, list) and repositories:
        repos_display = ", ".join(str(r) for r in repositories)
    elif isinstance(repositories, str) and repositories.strip():
        repos_display = repositories
    else:
        repos_display = None

    missing_key_repos = metadata.get("missing_key_repos") or []
    if not isinstance(missing_key_repos, list):
        missing_key_repos = []

    date_from = metadata.get("date_from", "N/A")
    date_to = metadata.get("date_to", "N/A")
    total = metadata.get("total", len(documents))
    new = metadata.get("new", total)

    lines.append("# resmon Literature Report")
    lines.append(f"**Generated:** {generated_at}  ")
    if repos_display is not None:
        lines.append(f"**Repositories:** {repos_display}  ")
    lines.append(f"**Query:** {query_display}  ")
    lines.append(f"**Date Range:** {date_from} to {date_to}  ")
    lines.append(f"**Total Results:** {total} ({new} new)")
    ai_model = metadata.get("ai_model")
    if isinstance(ai_model, str) and ai_model.strip():
        # Append as a continuation of the header metadata block. The
        # trailing two spaces on the previous line would otherwise force
        # a line break; we rebuild the last entry to include a proper
        # Markdown line-ending before the AI row.
        lines[-1] = f"**Total Results:** {total} ({new} new)  "
        lines.append(f"**AI Summarizer:** {ai_model}")

    # --- API-key warnings ---
    if missing_key_repos:
        lines.append("")
        missing_display = ", ".join(missing_key_repos)
        # If zero results were found AND every queried repository was one
        # whose search was blocked by a missing API key, surface that as the
        # direct cause. Otherwise just note the missing keys as a warning
        # without ascribing causation to the zero-result outcome.
        queried_repos = repositories if isinstance(repositories, list) else []
        all_queried_missing = (
            bool(queried_repos)
            and all(r in missing_key_repos for r in queried_repos)
        )
        if total == 0 and all_queried_missing:
            lines.append(
                f"> **Note:** Zero results were returned because no API key was "
                f"configured for the chosen repository(ies): {missing_display}. "
                f"Configure the required credentials in Settings → Credentials "
                f"and re-run the execution."
            )
        else:
            lines.append(
                f"> **Warning:** No API key was found for the following "
                f"repository(ies), so they returned zero results: "
                f"{missing_display}."
            )

    lines.append("")
    lines.append("---")
    lines.append("")

    # --- Group by date and sort newest first ---
    date_groups: dict[str, list[dict]] = defaultdict(list)
    undated: list[dict] = []

    for doc in documents:
        pub_date = doc.get("publication_date")
        if pub_date:
            # Use only the date portion (YYYY-MM-DD)
            date_key = str(pub_date)[:10]
            date_groups[date_key].append(doc)
        else:
            undated.append(doc)

    # Sort dates newest first
    sorted_dates = sorted(date_groups.keys(), reverse=True)

    for date_key in sorted_dates:
        # Format date heading
        heading = _format_date_heading(date_key)
        lines.append(f"## {heading}")
        lines.append("")

        for doc in date_groups[date_key]:
            lines.extend(_format_paper_entry(doc))
            lines.append("")

    # Undated papers at the end
    if undated:
        lines.append("## Date Unknown")
        lines.append("")
        for doc in undated:
            lines.extend(_format_paper_entry(doc))
            lines.append("")

    # --- Footer: repositories skipped due to missing API keys ---
    if missing_key_repos:
        lines.append("---")
        lines.append("")
        lines.append("## Repositories Skipped Due to Missing API Keys")
        lines.append("")
        for repo in missing_key_repos:
            lines.append(
                f"- {repo}: required API key not provided — 0 results returned."
            )
        lines.append("")

    return "\n".join(lines)


def save_report(report_text: str, output_path: Path) -> Path:
    """Write the report to a .md file. Creates parent directories if needed.

    Returns the resolved output path.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(report_text, encoding="utf-8")
    logger.info("Report saved to %s", output_path)
    return output_path


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def _format_date_heading(date_str: str) -> str:
    """Convert YYYY-MM-DD to a readable heading like 'April 15, 2026'."""
    try:
        parts = date_str.split("-")
        year = parts[0]
        month = int(parts[1]) if len(parts) > 1 else 1
        day = int(parts[2]) if len(parts) > 2 else 1
        month_name = _MONTH_NAMES[month] if 1 <= month <= 12 else str(month)
        return f"{month_name} {day}, {year}"
    except (ValueError, IndexError):
        return date_str


def _format_paper_entry(doc: dict) -> list[str]:
    """Format a single paper as Markdown lines."""
    lines: list[str] = []

    title = doc.get("title", "Untitled")
    url = doc.get("url", "")
    if url:
        lines.append(f"### [{title}]({url})")
    else:
        lines.append(f"### {title}")

    # Authors
    authors = doc.get("authors", [])
    if isinstance(authors, str):
        author_str = authors
    elif isinstance(authors, list):
        author_str = ", ".join(authors)
    else:
        author_str = str(authors)
    if author_str:
        lines.append(f"- **Authors:** {author_str}")

    # Source
    source = doc.get("source_repository", "")
    ext_id = doc.get("external_id", "")
    if source:
        source_line = f"- **Source:** {source}"
        if ext_id:
            source_line += f" ({ext_id})"
        lines.append(source_line)

    # Categories
    categories = doc.get("categories", [])
    if isinstance(categories, str) and categories:
        lines.append(f"- **Categories:** {categories}")
    elif isinstance(categories, list) and categories:
        lines.append(f"- **Categories:** {', '.join(categories)}")

    # Abstract
    abstract = doc.get("abstract")
    if abstract:
        lines.append(f"- **Abstract:** {abstract}")

    # AI summary (present only when AI summarization ran successfully for
    # this paper in the current execution).
    ai_summary = doc.get("ai_summary")
    if isinstance(ai_summary, str) and ai_summary.strip():
        lines.append(f"- **AI Summary:** {ai_summary.strip()}")

    return lines
