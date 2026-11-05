"""Reference-manager exports: BibTeX, RIS, CSV and JSON.

resmon's existing outputs -- Markdown, PDF and LaTeX -- are all for reading.
None of them import into Zotero, Mendeley, EndNote or Papers, which is where a
researcher actually keeps the papers a sweep found. These formats close that
gap; JSON is the one that is not for a reference manager at all, and exists
because a program consuming this data should not have to parse BibTeX.

Everything here is pure: it takes document dicts as stored in the ``documents``
table and returns text. No database access, no network.

Every format is written as a stream of pieces (:func:`stream`), one paper at a
time, so a file of any size is never held whole: the engine sends each piece as
it is made, and an export of the whole collection costs the memory of one batch
of papers rather than of the file. ``to_bibtex`` and its siblings join the same
pieces, so a file written either way is the same bytes.
"""

from __future__ import annotations

import csv
import io
import json
import re
from typing import Iterable, Iterator, Sequence

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
    """Build a file-local unique key; collision suffixes follow input order."""
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


def _bibtex_entry(doc: dict, used: set[str]) -> str:
    """One ``@article`` or ``@misc`` entry; *used* holds the file's keys so far."""
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
    return f"@{entry_type}{{{key},\n{body}\n}}"


def stream_bibtex(documents: Iterable[dict]) -> Iterator[str]:
    """A BibTeX ``.bib`` file, one entry at a time.

    Entries are ``@article`` when a DOI is present and ``@misc`` otherwise,
    which is the honest mapping: without a DOI resmon usually has a preprint or
    a record it cannot attribute to a journal. Cite keys are unique across the
    whole file, however it is cut into pieces: one set of used keys runs from
    the first entry to the last.
    """
    used: set[str] = set()
    first = True
    for doc in documents:
        entry = _bibtex_entry(doc, used)
        yield entry if first else f"\n\n{entry}"
        first = False
    if not first:
        yield "\n"


def to_bibtex(documents: Iterable[dict]) -> str:
    """Render documents as a BibTeX ``.bib`` file (:func:`stream_bibtex`, joined)."""
    return "".join(stream_bibtex(documents))


def _ris_record(doc: dict) -> str:
    """One record, from ``TY`` to ``ER``, and the blank line after it."""
    lines: list[str] = []
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


def stream_ris(documents: Iterable[dict]) -> Iterator[str]:
    """RIS, the format EndNote and Papers prefer, one record at a time."""
    first = True
    for doc in documents:
        record = _ris_record(doc)
        yield record if first else f"\n{record}"
        first = False


def to_ris(documents: Iterable[dict]) -> str:
    """Render documents as RIS (:func:`stream_ris`, joined)."""
    return "".join(stream_ris(documents))


def stream_csv(documents: Iterable[dict]) -> Iterator[str]:
    """CSV, for a spreadsheet or a script: the header, then one row at a time."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(CSV_COLUMNS), extrasaction="ignore")

    def drained() -> str:
        text = buf.getvalue()
        buf.seek(0)
        buf.truncate()
        return text

    writer.writeheader()
    yield drained()
    for doc in documents:
        row = {}
        for column in CSV_COLUMNS:
            value = doc.get(column)
            # Collapse whitespace so an abstract does not spill across rows.
            row[column] = " ".join(str(value).split()) if value is not None else ""
        writer.writerow(row)
        yield drained()


def to_csv(documents: Iterable[dict]) -> str:
    """Render documents as CSV (:func:`stream_csv`, joined)."""
    return "".join(stream_csv(documents))


def _json_row(doc: dict, include_ids: bool) -> dict:
    row = {column: doc.get(column) for column in CSV_COLUMNS}
    if include_ids:
        row["id"] = doc["id"]
    return row


def stream_json(documents: Iterable[dict], *, include_ids: bool = False) -> Iterator[str]:
    """A JSON array, one object at a time, laid out as ``json.dumps(..., indent=2)`` lays it out.

    Each object is dumped on its own and indented one level, which is exactly
    what the whole array dumped at once would hold: no string value can carry
    a raw newline, so every line of an object is a line of the array.
    """
    first = True
    for doc in documents:
        text = json.dumps(_json_row(doc, include_ids), indent=2, ensure_ascii=False, default=str)
        nested = "\n".join(f"  {line}" for line in text.split("\n"))
        yield f"[\n{nested}" if first else f",\n{nested}"
        first = False
    yield "[]" if first else "\n]"


def to_json(documents: Iterable[dict], *, include_ids: bool = False) -> str:
    """Render documents as a JSON array, for a program rather than a person.

    This is not a nicety. The MCP server asks this module for ``json`` -- the
    contract it is built against names a structured export -- and without the
    format ``get_execution_results`` would return HTTP 400 for *every*
    execution, and the tool that answers "what did my last run find" would
    never work once.

    By default the same field set as CSV. ``include_ids`` additionally carries
    the existing corpus document ID for reading-to-explanation continuity; it
    does not change CSV or the default JSON shape. Values are passed through
    as stored: a missing field
    is ``null`` rather than an empty string, because for a machine-readable
    format "we do not have this" and "this is blank" are different facts.
    """
    return "".join(stream_json(documents, include_ids=include_ids))


FORMATS = {
    "bibtex": (stream_bibtex, "application/x-bibtex", "bib"),
    "ris": (stream_ris, "application/x-research-info-systems", "ris"),
    "csv": (stream_csv, "text/csv", "csv"),
    "json": (stream_json, "application/json", "json"),
}


def describe(fmt: str, *, include_ids: bool = False) -> tuple[str, str]:
    """``(media_type, file_extension)`` for *fmt*, or ``ValueError`` naming the formats there are.

    Asked before anything is written, so a request for a format that does not
    exist is refused whole rather than after part of a file has been sent.
    """
    try:
        _renderer, media_type, extension = FORMATS[fmt]
    except KeyError:
        raise ValueError(
            f"Unknown export format {fmt!r}. Expected one of: {', '.join(sorted(FORMATS))}."
        ) from None
    if include_ids and fmt != "json":
        raise ValueError("include_ids requires the json format")
    return media_type, extension


def stream(documents: Iterable[dict], fmt: str, *, include_ids: bool = False) -> Iterator[str]:
    """The file for *fmt*, piece by piece. Check *fmt* with :func:`describe` first."""
    describe(fmt, include_ids=include_ids)
    if fmt == "json":
        return stream_json(documents, include_ids=include_ids)
    return FORMATS[fmt][0](documents)


def render(documents: Iterable[dict], fmt: str, *, include_ids: bool = False) -> tuple[str, str, str]:
    """Return ``(text, media_type, file_extension)`` for *fmt*."""
    media_type, extension = describe(fmt, include_ids=include_ids)
    return "".join(stream(list(documents), fmt, include_ids=include_ids)), media_type, extension
