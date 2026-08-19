"""Reference-manager exports: BibTeX, RIS and CSV.

resmon's existing outputs -- Markdown, PDF and LaTeX -- are all for reading.
None of them import into Zotero, Mendeley, EndNote or Papers, which is where a
researcher actually keeps the papers a sweep found. These three formats close
that gap.

Everything here is pure: it takes document dicts as stored in the ``documents``
table and returns text. No database access, no network.
"""

from __future__ import annotations

import csv
import io
import re
from typing import Iterable, Sequence

CSV_COLUMNS: Sequence[str] = (
    "title", "authors", "publication_date", "doi", "url",
    "source_repository", "external_id", "categories", "abstract",
)

# BibTeX special characters, escaped so a title containing & or % does not
# break the importing tool.
_BIBTEX_ESCAPES = {
    "\\": r"\textbackslash{}",
    "{": r"\{", "}": r"\}", "$": r"\$", "&": r"\&", "%": r"\%",
    "#": r"\#", "_": r"\_", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
}


def _split_authors(raw: str | None) -> list[str]:
    """Split the stored comma-joined author string back into names."""
    if not raw:
        return []
    return [a.strip() for a in str(raw).split(",") if a.strip()]


def _escape_bibtex(value: str) -> str:
    return "".join(_BIBTEX_ESCAPES.get(ch, ch) for ch in value)


def _year_of(date: str | None) -> str:
    if not date:
        return ""
    return str(date)[:4] if str(date)[:4].isdigit() else ""


def _cite_key(doc: dict, used: set[str]) -> str:
    """Build a stable, unique BibTeX key: firstauthor+year+firstword."""
    authors = _split_authors(doc.get("authors"))
    surname = ""
    if authors:
        # "Ada Lovelace" -> lovelace; "Lovelace, Ada" -> lovelace
        first = authors[0]
        surname = first.split(",")[0].strip() if "," in first else first.split()[-1]
    surname = re.sub(r"[^A-Za-z]", "", surname).lower() or "anon"

    year = _year_of(doc.get("publication_date")) or "nodate"

    word = ""
    for candidate in re.split(r"\s+", str(doc.get("title") or "")):
        cleaned = re.sub(r"[^A-Za-z]", "", candidate).lower()
        if len(cleaned) > 3:
            word = cleaned
            break

    base = f"{surname}{year}{word}" or "resmon"
    key, n = base, 2
    while key in used:
        key = f"{base}{n}"
        n += 1
    used.add(key)
    return key


def to_bibtex(documents: Iterable[dict]) -> str:
    """Render documents as a BibTeX ``.bib`` file.

    Entries are ``@article`` when a DOI is present and ``@misc`` otherwise,
    which is the honest mapping: without a DOI resmon usually has a preprint or
    a record it cannot attribute to a journal.
    """
    used: set[str] = set()
    entries: list[str] = []

    for doc in documents:
        doi = (doc.get("doi") or "").strip()
        entry_type = "article" if doi else "misc"
        key = _cite_key(doc, used)

        fields: list[tuple[str, str]] = []
        if doc.get("title"):
            fields.append(("title", str(doc["title"]).strip()))
        authors = _split_authors(doc.get("authors"))
        if authors:
            fields.append(("author", " and ".join(authors)))
        year = _year_of(doc.get("publication_date"))
        if year:
            fields.append(("year", year))
        if doi:
            fields.append(("doi", doi))
        if doc.get("url"):
            fields.append(("url", str(doc["url"]).strip()))
        if doc.get("source_repository"):
            fields.append(("note", f"Retrieved via resmon from {doc['source_repository']}"))
        if doc.get("categories"):
            fields.append(("keywords", str(doc["categories"]).strip()))
        if doc.get("abstract"):
            # Collapse whitespace: a hard-wrapped abstract is legal BibTeX but
            # several importers mangle multi-line braced values.
            fields.append(("abstract", " ".join(str(doc["abstract"]).split())))

        body = ",\n".join(
            # url and doi are escaped too: a bare _ in a URL breaks LaTeX.
            f"  {name} = {{{_escape_bibtex(value)}}}"
            for name, value in fields
        )
        entries.append(f"@{entry_type}{{{key},\n{body}\n}}")

    return "\n\n".join(entries) + ("\n" if entries else "")


def to_ris(documents: Iterable[dict]) -> str:
    """Render documents as RIS, the format EndNote and Papers prefer."""
    lines: list[str] = []
    for doc in documents:
        doi = (doc.get("doi") or "").strip()
        lines.append(f"TY  - {'JOUR' if doi else 'GEN'}")
        if doc.get("title"):
            lines.append(f"TI  - {str(doc['title']).strip()}")
        for author in _split_authors(doc.get("authors")):
            lines.append(f"AU  - {author}")
        date = str(doc.get("publication_date") or "").strip()
        if date:
            year = _year_of(date)
            if year:
                lines.append(f"PY  - {year}")
            # RIS dates are YYYY/MM/DD.
            lines.append(f"DA  - {date.replace('-', '/')}")
        if doc.get("abstract"):
            # RIS is line-oriented; newlines inside a field break parsers.
            abstract = " ".join(str(doc["abstract"]).split())
            lines.append(f"AB  - {abstract}")
        if doi:
            lines.append(f"DO  - {doi}")
        if doc.get("url"):
            lines.append(f"UR  - {str(doc['url']).strip()}")
        for category in [c.strip() for c in str(doc.get("categories") or "").split(",") if c.strip()]:
            lines.append(f"KW  - {category}")
        if doc.get("source_repository"):
            lines.append(f"DP  - {doc['source_repository']}")
        lines.append("ER  - ")
        lines.append("")
    return "\n".join(lines)


def to_csv(documents: Iterable[dict]) -> str:
    """Render documents as CSV, for a spreadsheet or a script."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(CSV_COLUMNS), extrasaction="ignore")
    writer.writeheader()
    for doc in documents:
        row = {}
        for column in CSV_COLUMNS:
            value = doc.get(column)
            # Collapse whitespace so an abstract does not spill across rows.
            row[column] = " ".join(str(value).split()) if value is not None else ""
        writer.writerow(row)
    return buf.getvalue()


FORMATS = {
    "bibtex": (to_bibtex, "application/x-bibtex", "bib"),
    "ris": (to_ris, "application/x-research-info-systems", "ris"),
    "csv": (to_csv, "text/csv", "csv"),
}


def render(documents: Iterable[dict], fmt: str) -> tuple[str, str, str]:
    """Return ``(text, media_type, file_extension)`` for *fmt*."""
    try:
        renderer, media_type, extension = FORMATS[fmt]
    except KeyError:
        raise ValueError(
            f"Unknown export format {fmt!r}. Expected one of: {', '.join(sorted(FORMATS))}."
        ) from None
    return renderer(list(documents)), media_type, extension
