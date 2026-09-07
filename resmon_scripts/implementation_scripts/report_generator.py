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

    watch_profile = metadata.get("watch_profile")
    lines.append("# resmon Literature Report")
    lines.append(f"**Generated:** {generated_at}  ")
    if repos_display is not None:
        lines.append(f"**Repositories:** {repos_display}  ")
    if isinstance(watch_profile, str) and watch_profile.strip():
        # A watch run followed a person, not a set of words. "Query: N/A" is
        # true of the words and says nothing about what the run was for.
        lines.append(f"**Watching:** {watch_profile.strip()}  ")
    else:
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

    # --- Footer: every source that returned nothing, and why ---
    #
    # This used to name only the sources missing an API key, which was the one
    # zero resmon could explain. Every other zero -- an outage, a window the
    # source cannot answer, a reply that would not parse -- reached the report
    # as silence, and the reader had no way to tell a quiet field from a
    # broken one. Each line is a recorded fact or says the reason was not
    # recorded; there is no third kind of line here.
    # Near-duplicate links (1.9b). A section rather than a note per paper: the
    # reader wants to know "does this report count anything twice", and the
    # answer is a short list they can scan, not a badge scattered through fifty
    # entries. Nothing is removed from the report and no count changes -- the
    # section says so in as many words, because a reader who sees "duplicates"
    # in a heading will otherwise assume the numbers above were adjusted.
    duplicate_links = metadata.get("duplicate_links")
    if isinstance(duplicate_links, list) and duplicate_links:
        lines.append("---")
        lines.append("")
        lines.append("## The same paper, from more than one source")
        lines.append("")
        lines.append(
            f"{len(duplicate_links)} pair"
            f"{'s' if len(duplicate_links) != 1 else ''} in this report look like the "
            "same work reaching resmon twice. **Nothing has been removed and no count "
            "above has been adjusted** — both records are kept, because each carries "
            "what its own source actually said."
        )
        lines.append("")
        for link in duplicate_links:
            if not isinstance(link, dict):
                continue
            title = str(link.get("title", "")).strip()
            other = str(link.get("other_title", "")).strip()
            method = str(link.get("method", ""))
            evidence = ("same DOI" if method == "shared_doi"
                        else "near-identical title and closely related text")
            lines.append(
                f"- **{title}** ({link.get('source', '?')}) and "
                f"**{other}** ({link.get('other_source', '?')}) — {evidence}."
            )
        lines.append("")

    zero_notes = metadata.get("zero_notes")
    if isinstance(zero_notes, list) and zero_notes:
        lines.append("---")
        lines.append("")
        lines.append("## Sources that returned nothing, and why")
        lines.append("")
        for note in zero_notes:
            source = str(note.get("source", "")) if isinstance(note, dict) else ""
            sentence = str(note.get("sentence", "")) if isinstance(note, dict) else ""
            if source and sentence:
                lines.append(f"- **{source}**: {sentence}")
        lines.append("")
    elif missing_key_repos:
        # A report built without the per-source outcomes still says what it
        # always said rather than saying nothing.
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


_BASIS_SENTENCE = {
    "identifier": "matched by identifier — the source returned this profile's ORCID",
    "name+affiliation": ("matched by name and affiliation — not by identity; another "
                         "researcher with this name at this institution would match too"),
    "name_only": ("matched by name only — resmon can tell you this name is on the "
                  "paper and nothing more"),
}


def generate_watch_report(profile: dict, findings: dict, check: dict) -> str:
    """The report a ``retractions`` watch run leaves behind.

    Its own function rather than a mode of ``generate_report`` because the two
    documents answer different questions: that one lists papers a query found,
    this one lists things that happened to papers already held. Reusing the
    paper report would have meant a "Total Results" line counting retractions,
    which reads as a find rather than as a warning.

    **The basis is printed beside every finding, in a sentence.** A retraction
    attached to a name is not a retraction attached to a person, and this report
    is the one place a user may read that fact away from the interface — it is
    saved to disk, and it can be mailed. The badge cannot travel; the sentence
    can.
    """
    lines: list[str] = []
    name = profile.get("display_name") or "this profile"
    warning = profile.get("basis_warning")
    rows = findings.get("findings") or []

    lines.append(f"# Watch report — {name}")
    lines.append(f"**Generated:** {now_iso()}  ")
    lines.append(f"**Watching for:** retractions and other lifecycle events  ")
    lines.append(f"**Papers matched to this profile:** "
                 f"{findings.get('matched_documents', 0)}  ")
    lines.append(f"**Checked this run:** {check.get('checked_now', 0)} of "
                 f"{check.get('selected', 0)} due")
    lines.append("")

    if warning:
        # The profile-level caveat travels with the document, because a report
        # read a month later has no editor open beside it.
        lines.append(f"> **About this profile.** {warning}")
        lines.append("")

    lines.append("## Coverage")
    lines.append("")
    lines.append(findings.get("coverage_note", ""))
    lines.append("")
    errors = check.get("errors") or []
    if errors:
        lines.append(f"{len(errors)} paper(s) could not be checked this run and "
                     f"were left unchecked rather than recorded as clear.")
        lines.append("")

    lines.append("## Findings")
    lines.append("")
    if not rows:
        # Never "no retractions" — that is a claim about the world. This is a
        # claim about the record, which is all resmon has.
        lines.append("Nothing has been recorded against the papers matched to "
                     "this profile. That is a statement about what has been "
                     "checked, above, and not a statement that nothing has "
                     "happened.")
        lines.append("")
        return "\n".join(lines)

    for row in rows:
        label = row.get("label") or row.get("kind") or "Lifecycle event"
        title = row.get("title") or "(untitled)"
        lines.append(f"### {label} — {title}")
        basis = row.get("basis")
        sentence = _BASIS_SENTENCE.get(basis)
        if sentence:
            lines.append(f"- **Why this paper is in this report:** {sentence} "
                         f"(`{row.get('matched_author') or ''}`).")
        if row.get("doi"):
            lines.append(f"- **Paper DOI:** {row['doi']}")
        if row.get("source_repository"):
            lines.append(f"- **Source:** {row['source_repository']}")
        if row.get("notice_date"):
            lines.append(f"- **Notice date:** {row['notice_date']}")
        notice = row.get("notice_url") or row.get("notice_doi")
        if notice:
            lines.append(f"- **Notice:** {notice}")
        provider = row.get("provider")
        provider_source = row.get("provider_source")
        if provider:
            # Retraction Watch's provenance is kept verbatim wherever the
            # finding goes; it is a condition of using the data, not a nicety.
            lines.append(f"- **Recorded from:** {provider}"
                         + (f" ({provider_source})" if provider_source else ""))
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
        # Names, whether the caller passed strings or ``api_base.Author``s. A
        # report renders people, not identity records.
        author_str = ", ".join(getattr(a, "name", a) for a in authors)
    else:
        author_str = str(authors)
    if author_str:
        lines.append(f"- **Authors:** {author_str}")

    # 2.1 — why this paper is in a watch run's report, immediately under the
    # authors, because that is the line it is a claim about. Absent from every
    # keyword run, where there is no such claim to make.
    basis = doc.get("match_basis")
    sentence = _BASIS_SENTENCE.get(basis) if basis else None
    if sentence:
        matched = doc.get("matched_author") or ""
        lines.append(f"- **Why this paper:** {sentence}"
                     + (f" (`{matched}`)" if matched else "") + ".")

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
