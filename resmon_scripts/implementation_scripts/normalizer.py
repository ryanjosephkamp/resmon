# resmon_scripts/implementation_scripts/normalizer.py
"""Metadata normalization pipeline and deduplication engine."""

import html
import logging
import re
import sqlite3
import unicodedata
from dataclasses import replace

from . import open_access
from .api_base import Author, NormalizedResult, as_authors
from .database import insert_document, find_duplicates_by_hash
from .utils import compute_metadata_hash, now_iso

logger = logging.getLogger(__name__)

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
    """One author name, standardized to 'First Last'.

    Handles 'Last, First' by reversing the components and collapses internal
    whitespace. Returns "" for a name with no letter in it, such as "", "-" or
    ".", which a source sends for an author it has no name for: kept, it would
    print as an empty place in the author list.
    """
    name = (name or "").strip()
    if not any(ch.isalpha() for ch in name):
        return ""
    if "," in name:
        parts = [p.strip() for p in name.split(",", 1)]
        name = f"{parts[1]} {parts[0]}" if len(parts) == 2 and parts[1] else parts[0]
    return re.sub(r"\s+", " ", name)


def normalize_authors(authors) -> list:
    """Standardize author names, **keeping whatever else the source gave**.

    Accepts names or ``Author`` objects and returns the same kind it was given,
    so the twenty-odd clients that still pass strings are unaffected and the
    handful that pass structured authors do not lose their ORCID to a
    normalization step. That last clause is the point: a function that took
    ``list[str]`` and returned ``list[str]`` would quietly discard exactly the
    fields author matching exists to keep.
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


# ---------------------------------------------------------------------------
# Markup in titles and abstracts
#
# Sources send text with markup in it: HTML from Zenodo, DataCite and Europe
# PMC, JATS from Crossref, MathML inside either, entities escaped once or
# twice, and bioRxiv's and medRxiv's own markers (O_ST_ABS ... C_ST_ABS for a
# section title, O_LI ... C_LI for a list item, O_FIG ... C_FIG for a figure).
# Each is turned into the text it stands for. The same functions run when a
# paper arrives and when stored text is read (the report, the bundle, and the
# engine's responses), so a paper stored before a rule existed reads cleanly
# without its row being rewritten. On text with no markup they change nothing
# but runs of spaces, which is what makes running them again on a read safe.
# ---------------------------------------------------------------------------

# Element names that are removed as markup. Only a well-formed tag whose name
# is one of these, or carries a namespace prefix (``jats:p``, ``mml:mi``), is
# touched, so prose such as "p <0.05" or "the <n> most cited" is left alone.
_HTML_ELEMENTS = frozenset("""
a abbr acronym address article aside b bdi bdo big blockquote body br caption
center cite code col colgroup dd del dfn div dl dt em figcaption figure font
footer h1 h2 h3 h4 h5 h6 head header hr html i img ins kbd label li main mark
nav ol p pre q s samp section small span strike strong sub sup table tbody td
tfoot th thead time tr tt u ul var wbr
""".split())
_JATS_ELEMENTS = frozenset("""
abstract bold boxed-text break caption ext-link fig inline-formula italic
list list-item monospace named-content overline p sc sec styled-content sub
sup title underline uri xref
""".split())
_MATHML_ELEMENTS = frozenset("""
annotation math menclose mfenced mfrac mi mmultiscripts mn mo mover mpadded
mphantom mroot mrow ms mspace msqrt mstyle msub msubsup msup mtable mtd mtext
mtr munder munderover semantics
""".split())
_MARKUP_ELEMENTS = _HTML_ELEMENTS | _JATS_ELEMENTS | _MATHML_ELEMENTS
# Elements that end a block of text: removed as a space, so "</p><p>" does not
# join the last word of one paragraph to the first of the next.
_BLOCK_ELEMENTS = frozenset("""
abstract blockquote body br break caption dd div dl dt fig figcaption figure
footer h1 h2 h3 h4 h5 h6 header hr li list list-item ol p pre sec section
table td th title tr ul
""".split())

_TAG_RE = re.compile(
    r"<(/?)((?:[A-Za-z][\w.-]*:)?[A-Za-z][\w.-]*)"
    r"((?:\s+[A-Za-z_:][-\w:.]*\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s\"'<>`]+))*)\s*/?>"
)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
# An entity only when it is complete, with its semicolon. Python's own
# ``html.unescape`` also reads "&para" in "&parameter" as a pilcrow.
_ENTITY_RE = re.compile(r"&(?:#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});")
# medRxiv and bioRxiv write a symbol as an entity in brackets: "p [&ge;] 0.479".
_BRACKETED_ENTITY_RE = re.compile(r"\[(" + _ENTITY_RE.pattern + r")\]")
_SUP_SUB_RE = re.compile(r"<((?:[A-Za-z][\w.-]*:)?)(sup|sub)(?:\s[^<>]*)?>([^<>]*)</\1\2\s*>", re.I)
# A JATS section title: "<jats:title>Methods</jats:title>" is the label of the
# paragraph after it. "Abstract" is the heading of the whole and is dropped.
_JATS_TITLE_RE = re.compile(r"<((?:[A-Za-z][\w.-]*:)?title)(?:\s[^<>]*)?>\s*([^<>]{1,120}?)\s*</\1\s*>")

_SUPERSCRIPT = dict(zip(
    "0123456789+-−=()nihjrwyabcdefgklmoprstuvxzABDEGHIJKLMNOPRTUVW",
    "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾ⁿⁱʰʲʳʷʸᵃᵇᶜᵈᵉᶠᵍᵏˡᵐᵒᵖʳˢᵗᵘᵛˣᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ",
))
_SUBSCRIPT = dict(zip(
    "0123456789+-−=()aehijklmnoprstuvx",
    "₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ",
))
_FOOTNOTE_MARKS = frozenset("*†‡§¶#")

# bioRxiv's and medRxiv's markers. A figure block holds an image link and
# HighWire's internal references, nothing a reader can use.
_PREPRINT_FIGURE_RE = re.compile(
    r"(?:Graphical abstract\s*)?O_(FIG|TBL|TABLE|LINKSMALLFIG|LINKBIGFIG).*?C_\1", re.S)
_PREPRINT_SECTION_RE = re.compile(r"O_ST(?:_ABS)?\s*(.*?)\s*C_ST(?:_ABS)?", re.S)
_PREPRINT_ITEM_OPEN_RE = re.compile(r"\s*O_LI\s*")
_PREPRINT_MARKER_RE = re.compile(
    r"\s*[OC]_(?:ST_ABS|ST|LINKSMALLFIG|LINKBIGFIG|LIST|LI|LS|FIG|TBL|TABLE)\s*")
_HIGHWIRE_LEFTOVER_RE = re.compile(
    r"(?:View larger version \(\d+K\):\s*)?(?:org\.highwire\.dtl\.DTL\s*Vardef@[0-9a-f]+\s*)+"
    r"(?:_HPS_FORMAT_FIGEXP\s*M_FIG\s*)?")
# The section heads of a structured abstract, which bioRxiv and medRxiv send
# run into the text after them ("MethodsIn 309 patients"). A head is read as
# one only where the next character starts a sentence with no space between.
_PREPRINT_HEADINGS = sorted((
    "Abstract", "Aims", "Background", "Conclusion", "Conclusions",
    "Conclusions and relevance", "Design", "Discussion", "Exposure", "Exposures",
    "Findings", "Funding", "Importance", "Interpretation", "Introduction",
    "Main outcome measures", "Main outcomes and measures", "Methods",
    "Methods and findings", "Methods and results", "Objective", "Objectives",
    "Participants", "Purpose", "Results", "Setting", "Significance",
    "Research in context", "Evidence before this study", "Added value of this study",
    "Implications of all the available evidence", "What is known", "What is new",
    "What is already known", "What this study adds",
), key=len, reverse=True)
_PREPRINT_HEADING_RE = re.compile(
    r"(?:^|(?<=[\s.;:!?)\]/\x02]))(" + "|".join(re.escape(h) for h in _PREPRINT_HEADINGS)
    + r")(?=[A-Z0-9\x01\x03])")
_PREPRINT_SOURCES = frozenset({"biorxiv", "medrxiv"})
# Placeholders while an abstract is cleaned: \x01 label \x02, and \x03 a list item.
_LABEL_RE = re.compile(r"\s*\x01([^\x01\x02]*)\x02\s*")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# An abstract that opens with its own heading: "Abstract", "Abstract:",
# "ABSTRACT", or "Abstract" run into a sentence that starts with a capital
# ("Abstract Fine-grained parts ..."). "Abstract algebra is ..." is a sentence
# and is kept.
_LEADING_ABSTRACT_RE = re.compile(r"^\s*(?i:abstract)(?:\s*[:.\-–—]+\s*|\s+(?=[A-Z0-9“\"(\[])|\s*$)")

# Characters with no width and no meaning in stored text.
_INVISIBLE = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff\u00ad"), None)
_WHITESPACE_RE = re.compile(r"\s+")


def _decode_entities(text: str) -> str:
    text = _BRACKETED_ENTITY_RE.sub(lambda m: html.unescape(m.group(1)), text)
    return _ENTITY_RE.sub(lambda m: html.unescape(m.group(0)), text)


def _script(inner: str, table: dict[str, str], mark: str) -> str:
    """``<sup>``/``<sub>`` content as superscript or subscript characters.

    Where a character has no such form, the content is written plainly after
    ``^`` or ``_`` ("10^-3.5"), so it is not read as part of the number before
    it; a footnote mark is written as itself.
    """
    inner = _decode_entities(inner).strip()
    if not inner:
        return ""
    if inner == "TM" and mark == "^":
        return "™"
    if all(ch in table for ch in inner):
        return "".join(table[ch] for ch in inner)
    if all(ch in _FOOTNOTE_MARKS for ch in inner):
        return inner
    return f"{mark}({inner})" if " " in inner else f"{mark}{inner}"


def _scripts(text: str) -> str:
    def sub(m: re.Match) -> str:
        is_sup = m.group(2).lower() == "sup"
        return _script(m.group(3), _SUPERSCRIPT if is_sup else _SUBSCRIPT, "^" if is_sup else "_")

    # A source that spaces its tags ("G <sup>2</sup> -SLAM") means "G²-SLAM".
    # A mark written straight onto the next word is an isotope or a prefix
    # ("of <sup>3</sup>He", "with <sup>18</sup>F-FDG"): its space stays.
    text = re.sub(
        r"(?<=\w)\s+(?=<((?:[A-Za-z][\w.-]*:)?)(?:sup|sub)\b[^<>]*>[^<>]*</\1(?:sup|sub)\s*>(?![^\W_]))",
        "", text, flags=re.I)
    text = re.sub(r"(</(?:[A-Za-z][\w.-]*:)?(?:sup|sub)\s*>)\s+(?=[-:,.;)])", r"\1", text, flags=re.I)
    return _SUP_SUB_RE.sub(sub, text)


def _strip_tags(text: str) -> str:
    def sub(m: re.Match) -> str:
        name = m.group(2)
        local = name.rsplit(":", 1)[-1].lower()
        if ":" not in name and local not in _MARKUP_ELEMENTS:
            return m.group(0)
        return " " if local in _BLOCK_ELEMENTS else ""

    return _TAG_RE.sub(sub, text)


def _jats_title(m: re.Match) -> str:
    label = m.group(2).strip()
    return " " if label.lower().rstrip(":.") == "abstract" else f"\x01{label}\x02"


def _strip_markup(text: str, *, jats_titles: bool = False) -> str:
    """Text with its HTML, JATS and MathML markup turned into the text it stands for."""
    text = _COMMENT_RE.sub("", _CONTROL_RE.sub("", text))
    # Again after each reading of entities: markup escaped as entities
    # ("&lt;/div&gt;", or "&amp;lt;" escaped twice) only becomes a tag once the
    # entities are read. Bounded at four readings.
    for _ in range(4):
        if jats_titles:
            text = _JATS_TITLE_RE.sub(_jats_title, text)
        text = _strip_tags(_scripts(text))
        decoded = _decode_entities(text)
        if decoded == text:
            break
        text = _CONTROL_RE.sub("", decoded)
    return text


def _clean_preprint_markers(text: str) -> str:
    """bioRxiv's and medRxiv's markers, as placeholders for labels and list items.

    A figure block goes, with its "Graphical abstract" caption.
    """
    if "O_" not in text and "C_" not in text and "Vardef@" not in text:
        return text
    text = _PREPRINT_FIGURE_RE.sub(" ", text)
    text = _HIGHWIRE_LEFTOVER_RE.sub(" ", text)
    text = _PREPRINT_SECTION_RE.sub(lambda m: f"\x01{m.group(1).strip()}\x02", text)
    text = _PREPRINT_ITEM_OPEN_RE.sub("\x03", text)
    return _PREPRINT_MARKER_RE.sub(" ", text)


def _finish_labels(text: str) -> str:
    """Section labels and list items marked during cleaning, written as text.

    A label is written "Label: ", or "Label. " when another label follows it
    at once, so a head and its first subhead read as a sentence and a label
    ("Research in context. Evidence before this study: We searched ..."). A
    list item becomes a bulleted sentence.
    """
    def sub(m: re.Match) -> str:
        label = m.group(1).strip()
        if not label:
            return " "
        follows_label = text[m.end():m.end() + 1] == "\x01"
        # "known/What is new" keeps its slash against the words.
        lead = "" if text[m.start() - 1:m.start()] == "/" else " "
        if label[-1] in ":?!.":
            return f"{lead}{label} "
        return f"{lead}{label}. " if follows_label else f"{lead}{label}: "

    text = _LABEL_RE.sub(sub, text)
    return text.replace("\x03", " • ")


def _tidy(text: str) -> str:
    text = unicodedata.normalize("NFC", text.translate(_INVISIBLE))
    return _WHITESPACE_RE.sub(" ", text).strip()


def clean_title(title: str) -> str:
    """A title as text: markup removed, ``<sup>``/``<sub>`` written as characters, spaces normalized."""
    if not title:
        return title
    return _tidy(_strip_markup(title))


def clean_abstract(abstract: str | None, source: str | None = None) -> str | None:
    """An abstract as readable text, or None when nothing is left.

    Removes markup and the abstract's own "Abstract" heading, and, for bioRxiv
    and medRxiv (*source* is the source's slug), writes their section titles as
    labels and their list items as bulleted sentences. Safe to run on text it
    has already cleaned.
    """
    if not abstract:
        return abstract
    cleaned = _clean_preprint_markers(_strip_markup(abstract, jats_titles=True))
    if (source or "").lower() in _PREPRINT_SOURCES:
        cleaned = _PREPRINT_HEADING_RE.sub(lambda m: f"\x01{m.group(1)}\x02", _tidy(cleaned))
    cleaned = _tidy(_finish_labels(cleaned))
    for _ in range(2):
        stripped = _LEADING_ABSTRACT_RE.sub("", cleaned, count=1)
        if stripped == cleaned:
            break
        cleaned = stripped
    return cleaned or None


def clean_author_list(authors: str | None) -> str | None:
    """A stored comma-joined author list with the entries that hold no name dropped.

    Each entry is kept as stored; only an entry with no letter in it ("",
    "-") is removed, so "A. Huang, , K. Zhang" reads "A. Huang, K. Zhang".
    """
    if not authors:
        return authors
    parts = [part.strip() for part in str(authors).split(",")]
    kept = [part for part in parts if any(ch.isalpha() for ch in part)]
    return ", ".join(kept)


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
    abstract = clean_abstract(result.abstract, result.source_repository)

    url = result.url
    if isinstance(url, str):
        url = re.sub(r"^http://(?=(?:[a-z0-9-]+\.)*arxiv\.org(?:[/:?#]|$))", "https://", url, flags=re.I)

    normalized = NormalizedResult(
        source_repository=result.source_repository,
        external_id=result.external_id,
        doi=result.doi,
        title=title,
        authors=authors,
        abstract=abstract,
        publication_date=pub_date,
        url=url,
        categories=list(result.categories),
        open_access=list(getattr(result, "open_access", None) or []),
        identifiers=list(getattr(result, "identifiers", None) or []),
    )
    # Attach metadata hash as a transient attribute for dedup
    # The hash is over the *names* alone: adding an ORCID to a record must not
    # make it a different paper from the same record without one, or every
    # cross-source duplicate would stop matching once a client fills the field.
    normalized._metadata_hash = compute_metadata_hash(  # type: ignore[attr-defined]
        title, [a.name for a in normalized.authors], pub_date)
    return normalized


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def deduplicate_batch(
    conn: sqlite3.Connection,
    results: list[NormalizedResult],
    *,
    collection_id: int | None = None,
    execution_id: int | None = None,
) -> dict:
    """Normalize, validate, and insert results into the database.

    Returns a dict with counts: {"total", "new", "duplicates", "invalid", "cross_source"}.

    A paper stored here is filed in *collection_id* (the default collection
    when None) as found by the run *execution_id*.

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

        row_id = insert_document(conn, doc, collection_id=collection_id, execution_id=execution_id)
        if row_id is not None:
            stats["new"] += 1
        else:
            stats["duplicates"] += 1
        _record_open_access(conn, normalized, row_id)

    return stats


def _record_open_access(conn: sqlite3.Connection, result: NormalizedResult,
                        row_id: int | None) -> None:
    """Store where this record says open copies are, for the paper new or already held.

    A paper stored before its source sent this data gains it the next time
    the source returns it: an insert that was ignored still records against
    the stored row. A failure here is logged and never loses the paper.
    """
    if not result.open_access and not result.identifiers:
        return
    try:
        if row_id is None:
            existing = conn.execute(
                "SELECT id FROM documents WHERE source_repository = ? AND external_id = ?",
                (result.source_repository, result.external_id)).fetchone()
            if existing is None:
                return
            row_id = int(existing[0])
        open_access.record(conn, int(row_id), result.source_repository,
                           result.open_access, result.identifiers)
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        logger.exception("Could not record open-access data for %s/%s",
                         result.source_repository, result.external_id)
