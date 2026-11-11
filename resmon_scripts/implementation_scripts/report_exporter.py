"""A run's report as a PDF, through LaTeX, and as an HTML page.

The Markdown report a run writes is parsed once, by :func:`parse_report`, into
its header, its notices, its groups of papers, and the sections that follow
them. The LaTeX document here and the HTML page in ``report_html`` are both
rendered from that one parse, so each holds what the other holds.

The LaTeX is compiled with XeLaTeX, or LuaLaTeX where XeLaTeX is missing,
because both read Unicode: a title, an author's name or an abstract may hold
any character. A character the body font lacks is set in the first fallback
font on this computer that has it (Greek, math and other symbols, Chinese,
Japanese, Korean). A character no font here has is listed after compiling, from
the engine's log, so the bundle can say so instead of printing a gap.

Nothing here needs the network, and no LaTeX engine is required: without one,
the ``.tex`` source is still written and the result says why there is no PDF.
"""

from __future__ import annotations

import glob
import logging
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .child_process import hidden_window_kwargs
from .normalizer import clean_abstract, clean_author_list, clean_title

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Common LaTeX install directories searched when the engine is not on PATH.
# This matters for processes launched by launchd / systemd / Windows Task
# Scheduler, whose PATH is stripped down to the system minimum and does not
# include /Library/TeX/texbin (MacTeX), /usr/local/texlive/<year>/bin/<arch>
# (Linux TeX Live), or %ProgramFiles%/MiKTeX/miktex/bin (Windows MiKTeX).
# Without this fallback, routine-fired executions running under the daemon
# silently produced PDF-less .zip bundles even though the same code
# produced PDFs when invoked from an interactive shell.
# ---------------------------------------------------------------------------
_LATEX_FALLBACK_DIRS: tuple[str, ...] = (
    # macOS (MacTeX / BasicTeX)
    "/Library/TeX/texbin",
    "/usr/local/texlive/*/bin/*",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    # Linux (TeX Live system + user installs)
    "/usr/bin",
    "/usr/local/bin",
    "/opt/texlive/*/bin/*",
    # Windows (MiKTeX / TeX Live)
    r"C:\Program Files\MiKTeX\miktex\bin\x64",
    r"C:\Program Files\MiKTeX\miktex\bin",
    r"C:\texlive\*\bin\windows",
)

# The report's name, everywhere it is printed.
REPORT_NAME = "resmon report"

# What each kind of run is called in the app.
_RUN_KINDS = {
    "deep_dive": "Deep Dive",
    "deep_sweep": "Deep Sweep",
    "automated_sweep": "Watch",
}

# Titles the Markdown report has carried, which name the document and not the run.
_GENERIC_TITLES = {"resmon literature report", "resmon report", "report"}

_MONTHS = (
    "", "January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December",
)
_DATE_HEADING_RE = re.compile(
    r"^(?:" + "|".join(_MONTHS[1:]) + r") \d{1,2}, \d{4}$|^Date Unknown$")

AI_SUMMARY_ONLY_NOTE = "AI summaries only: the original abstracts are left out."


# ---------------------------------------------------------------------------
# Parsing the Markdown report
# ---------------------------------------------------------------------------

_FIELD_RE = re.compile(r"^-\s*\*\*([^*]+):\*\*\s*(.*?)\s*$")
_META_RE = re.compile(r"^\*\*([^*]+):\*\*\s*(.*?)\s*$")
_TITLE_LINK_RE = re.compile(r"^\[(.+?)\]\((.+?)\)\s*$")

# Paper fields whose value is the source's own text, shown exactly as written.
# Every other field is a sentence resmon wrote, in Markdown.
LITERAL_FIELDS = frozenset({"authors", "categories", "source", "paper doi", "notice date", "notice"})


def _source_slug(fields: list[tuple[str, str]]) -> Optional[str]:
    """The source a paper came from, from its "Source" field ("medRxiv (10.1101/…)")."""
    for label, value in fields:
        if label.lower() == "source":
            return value.split(" (", 1)[0].strip().lower() or None
    return None


def _read_field(lines: list[str], i: int, first: str) -> tuple[str, int]:
    """A field's value, which may run on into paragraphs after a blank line.

    This is how the report writes a multi-paragraph AI summary. The value ends
    at the next field, heading or rule, or at a second blank line.
    """
    parts: list[str] = [first] if first else []
    j = i + 1
    pending_blank = False
    while j < len(lines):
        peek = lines[j].strip()
        if peek == "":
            if pending_blank:
                break
            pending_blank = True
            j += 1
            continue
        if peek.startswith("#") or peek.startswith("---") or _FIELD_RE.match(peek) or peek.startswith(">"):
            break
        if parts and pending_blank:
            parts.append("")
        parts.append(peek)
        pending_blank = False
        j += 1
    value = ""
    for part in parts:
        if part == "":
            value += "\n\n"
        elif value and not value.endswith("\n\n"):
            value = f"{value} {part}"
        else:
            value += part
    return value.strip(), j


def parse_report(md_text: str) -> dict:
    """Parse a report's Markdown into what the PDF and the HTML page render.

    Returns::

        {
            "header": {"title": str, "subtitle": str, "meta": [(label, value), ...]},
            "notices": [str, ...],            # blockquotes, in Markdown
            "body": [entry, ...],             # in the report's order
            "groups": [entry, ...],           # the body's groups of papers
            "sections": [entry, ...],         # the body's other sections
        }

    A body entry is ``{"kind": "group", "heading", "is_date", "blocks",
    "papers"}`` for a heading with papers under it, or ``{"kind": "section",
    "heading", "blocks"}`` for one without, such as "Sources that did not
    answer, and why". ``blocks`` are ``("p", text)``, ``("ul", [item, ...])``
    and ``("quote", text)``, in Markdown. A paper is ``{"title", "url",
    "fields": [(label, value), ...], "abstract", "ai_summary"}``.

    Titles, abstracts and author lists are cleaned as stored text is
    (``normalizer``), so a report written before a cleaning rule existed prints
    as one written after it.
    """
    header: dict = {"title": "", "subtitle": "", "meta": []}
    notices: list[str] = []
    body: list[dict] = []
    entry: Optional[dict] = None
    paper: Optional[dict] = None
    in_header = True

    lines = md_text.splitlines()
    i = 0
    n = len(lines)

    def blocks() -> list:
        return entry["blocks"] if entry is not None else []

    while i < n:
        stripped = lines[i].strip()

        if in_header:
            if stripped.startswith("# ") and not header["title"]:
                header["title"] = stripped[2:].strip()
                i += 1
                continue
            m = _META_RE.match(stripped)
            if m:
                header["meta"].append((m.group(1).strip(), m.group(2).strip()))
                i += 1
                continue
            if re.match(r"^\*[^*].*\*$", stripped) and not header["subtitle"]:
                header["subtitle"] = stripped.strip("*").strip()
                i += 1
                continue
            if stripped.startswith(">"):
                quote, i = _read_quote(lines, i)
                notices.append(quote)
                continue
            if stripped in ("", "---"):
                i += 1
                continue
            if stripped.startswith("## ") or stripped.startswith("### "):
                in_header = False
            else:
                i += 1
                continue

        if stripped.startswith("## "):
            heading = stripped[3:].strip()
            entry = {"kind": "section", "heading": heading, "blocks": []}
            body.append(entry)
            paper = None
            i += 1
            continue

        if stripped.startswith("### "):
            title_line = stripped[4:].strip()
            mlink = _TITLE_LINK_RE.match(title_line)
            title, url = (mlink.group(1), mlink.group(2).strip()) if mlink else (title_line, "")
            if entry is None:
                entry = {"kind": "section", "heading": "Date Unknown", "blocks": []}
                body.append(entry)
            if entry["kind"] == "section":
                entry["kind"] = "group"
                entry["papers"] = []
            paper = {"title": title, "url": url, "fields": [], "abstract": "", "ai_summary": ""}
            entry["papers"].append(paper)
            i += 1
            continue

        if stripped in ("", "---"):
            i += 1
            continue

        if paper is not None:
            mfield = _FIELD_RE.match(stripped)
            if mfield:
                label = mfield.group(1).strip()
                value, i = _read_field(lines, i, mfield.group(2).strip())
                low = label.lower()
                if low == "abstract":
                    paper["abstract"] = value
                elif low == "ai summary":
                    paper["ai_summary"] = value
                else:
                    paper["fields"].append((label, value))
                continue
            i += 1
            continue

        if stripped.startswith(">"):
            quote, i = _read_quote(lines, i)
            if entry is None:
                notices.append(quote)
            else:
                blocks().append(("quote", quote))
            continue

        if re.match(r"^[-*]\s+", stripped):
            items: list[str] = []
            while i < n and lines[i].strip():
                line = lines[i].strip()
                if re.match(r"^[-*]\s+", line):
                    items.append(re.sub(r"^[-*]\s+", "", line))
                elif items and not line.startswith(("#", ">", "---")):
                    items[-1] = f"{items[-1]} {line}"
                else:
                    break
                i += 1
            if entry is None:
                notices.extend(items)
            else:
                blocks().append(("ul", items))
            continue

        paragraph: list[str] = []
        while i < n and lines[i].strip() and not re.match(r"^(#|>|---|[-*]\s)", lines[i].strip()):
            paragraph.append(lines[i].strip())
            i += 1
        if not paragraph:
            i += 1
            continue
        text = " ".join(paragraph)
        if entry is None:
            notices.append(text)
        else:
            blocks().append(("p", text))

    for item in body:
        if item["kind"] == "group":
            item["is_date"] = bool(_DATE_HEADING_RE.match(item["heading"]))
            for p in item["papers"]:
                p["title"] = clean_title(p["title"]) or p["title"]
                source = _source_slug(p["fields"])
                p["abstract"] = clean_abstract(p["abstract"], source) or ""
                p["fields"] = [
                    (label, clean_author_list(value) or "" if label.lower() == "authors" else value)
                    for label, value in p["fields"]
                ]
    return {
        "header": header,
        "notices": notices,
        "body": body,
        "groups": [b for b in body if b["kind"] == "group"],
        "sections": [b for b in body if b["kind"] == "section"],
    }


def _read_quote(lines: list[str], i: int) -> tuple[str, int]:
    """A blockquote's lines, joined, without their ``>`` markers."""
    parts: list[str] = []
    while i < len(lines) and lines[i].strip().startswith(">"):
        parts.append(lines[i].strip()[1:].strip())
        i += 1
    return " ".join(p for p in parts if p), i


# Kept for callers that used the private name.
_parse_report = parse_report


# ---------------------------------------------------------------------------
# What the document says about itself
# ---------------------------------------------------------------------------


def get_meta(parsed: dict, label: str, default: str = "") -> str:
    for k, v in parsed["header"]["meta"]:
        if k.lower() == label.lower():
            return v
    return default


def local_stamp(text: str) -> str:
    """A stored instant ("2026-11-10T19:22:14Z") as this computer's local time.

    "November 10, 2026, 2:22 PM EST". The Markdown keeps the instant in UTC,
    and a reader of the PDF or the page wants their own clock. Text that is not
    an instant is returned as it is.
    """
    value = (text or "").strip()
    m = re.match(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$", value)
    if not m:
        return text
    zone = m.group(3) or "Z"
    if zone == "Z":
        zone = "+00:00"
    elif ":" not in zone:
        zone = f"{zone[:3]}:{zone[3:]}"
    try:
        at = datetime.fromisoformat(f"{m.group(1)}T{m.group(2)}{zone}")
    except ValueError:
        return text
    local = at.astimezone()
    hour = local.hour % 12 or 12
    abbreviation = local.strftime("%Z") or ""
    # Windows names its zones in full ("Eastern Standard Time").
    if " " in abbreviation:
        abbreviation = "".join(word[0] for word in abbreviation.split() if word[:1].isalpha())
    stamp = (f"{_MONTHS[local.month]} {local.day}, {local.year}, "
             f"{hour}:{local.minute:02d} {'AM' if local.hour < 12 else 'PM'}")
    return f"{stamp} {abbreviation}".strip()


def document_heading(parsed: dict, context: Optional[dict] = None) -> dict:
    """The report's kicker, title and subtitle, and which header rows they replace.

    The document is always "resmon report". What leads it is the watch's name
    or the kind of run, with the run's terms under it. ``context`` comes from
    the run (``kind`` is its ``execution_type``, ``watch`` the watch's name);
    without it, the report's own heading is used.
    """
    context = context or {}
    md_title = (parsed["header"].get("title") or "").strip()
    canceled = md_title.endswith("(canceled)")
    base = md_title[: -len("(canceled)")].strip() if canceled else md_title
    query = get_meta(parsed, "Query")
    watching = get_meta(parsed, "Watching")
    kind = _RUN_KINDS.get(str(context.get("kind") or ""))
    watch = str(context.get("watch") or "").strip()
    terms = "" if query in ("", "N/A") else query

    replaces: set[str] = set()
    if watch:
        title = watch
    elif base and base.lower() not in _GENERIC_TITLES:
        title = base
    elif kind and kind != "Watch":
        title = kind
    elif kind == "Watch":
        title = "Watch"
    else:
        title = REPORT_NAME[0].upper() + REPORT_NAME[1:]
    if watching:
        subtitle = f"Watching {watching}"
        replaces.add("watching")
    elif terms:
        subtitle = terms
        replaces.add("query")
    else:
        subtitle = ""
    if canceled:
        title = f"{title} (canceled)"
    return {"kicker": REPORT_NAME, "title": title, "subtitle": subtitle, "replaces": replaces}


# The summary's order: what the run was, then what it found, then how. A row
# not named here keeps its place after these, in the report's order.
_SUMMARY_ORDER = (
    "status", "watching", "query", "match", "date range", "how the dates were set",
    "start date given", "total results", "collected before the cancel", "sources",
    "ai summarizer",
)


def summary_rows(parsed: dict, heading: dict) -> list[tuple[str, str]]:
    """The header's rows, as the summary under the title shows them.

    Every row the Markdown carries is shown, in its order, except "Generated"
    (under the title) and what the subtitle already says. The count of papers
    listed and of publication dates follows the line that counts results.
    """
    papers = sum(len(g["papers"]) for g in parsed["groups"])
    dates = sum(1 for g in parsed["groups"] if g.get("is_date"))
    meta = [(label, value) for label, value in parsed["header"]["meta"]
            if label.lower() != "generated" and label.lower() not in heading["replaces"]]
    rank = {label: index for index, label in enumerate(_SUMMARY_ORDER)}
    meta.sort(key=lambda row: rank.get(row[0].lower(), len(rank)))
    rows: list[tuple[str, str]] = []
    counted = False
    for label, value in meta:
        rows.append((label, value))
        if label.lower() in ("total results", "collected before the cancel"):
            rows.append(("Papers Included", str(papers)))
            if dates:
                rows.append(("Publication Dates", str(dates)))
            counted = True
    if not counted:
        rows.append(("Papers Included", str(papers)))
    return rows


# ---------------------------------------------------------------------------
# LaTeX text
# ---------------------------------------------------------------------------

_LATEX_SPECIAL = {
    "\\": r"\textbackslash{}",
    "{": r"\{",
    "}": r"\}",
    "$": r"\$",
    "&": r"\&",
    "#": r"\#",
    "%": r"\%",
    "_": r"\_",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}
# Characters the body font (Latin Modern) is known to have, set as they are.
# Every other character goes through ``\rc``, which uses the body font when it
# has the glyph and the first fallback font that has it when not.
_BODY_FONT_LACKS = frozenset("ĸŉŦŧ")
_BODY_FONT_PUNCTUATION = frozenset("‘’‚“”„†‡•…‰‹›–—€™‐‑⁄")
_SPACES = {
    "\u00a0": "~", "\u2009": r"\,", "\u202f": r"\,", "\u200a": r"\,",
    "\u2002": " ", "\u2003": " ", "\u2004": " ", "\u2005": " ", "\u2006": " ",
    "\u2007": " ", "\u2008": " ", "\u205f": " ", "\u3000": " ",
    "\u2028": " ", "\u2029": " ", "\t": " ", "\n": " ", "\r": " ",
}
_DROPPED = frozenset("\u200b\u200c\u200d\u2060\ufeff\u00ad")


def _body_font_has(ch: str) -> bool:
    code = ord(ch)
    if 0x20 <= code < 0x7F:
        return True
    if 0xA1 <= code < 0x180:
        return ch not in _BODY_FONT_LACKS
    return ch in _BODY_FONT_PUNCTUATION


def _escape_latex(text: str) -> str:
    """Plain text as LaTeX: special characters escaped, every character kept.

    ``\\x00`` is passed through, because :func:`_render_inline` uses it to mark
    its placeholders.
    """
    if not text:
        return ""
    out: list[str] = []
    for ch in text:
        if ch in _LATEX_SPECIAL:
            out.append(_LATEX_SPECIAL[ch])
        elif ch == "\x00" or (ch.isdigit() and ch.isascii()):
            out.append(ch)
        elif ch in _SPACES:
            out.append(_SPACES[ch])
        elif ch in _DROPPED or (ord(ch) < 0x20) or ord(ch) == 0x7F:
            continue
        elif _body_font_has(ch):
            out.append(ch)
        elif 0xD800 <= ord(ch) <= 0xDFFF:
            continue
        else:
            out.append(f"\\rc{{{ord(ch)}}}{{{ch}}}")
    return "".join(out)


def _safe_url(url: str) -> str:
    return (
        url.replace("\\", r"\textbackslash{}")
        .replace("%", r"\%")
        .replace("#", r"\#")
        .replace("_", r"\_")
        .replace("&", r"\&")
        .replace("{", r"\{")
        .replace("}", r"\}")
    )


def _is_web_url(url: str) -> bool:
    return bool(re.match(r"^https?://[^\s]+$", url or "", re.I))


def _render_inline(text: str) -> str:
    """Inline Markdown that resmon wrote (bold, italic, code, links) as LaTeX.

    For resmon's own sentences only. A source's text (a title, an abstract, an
    author list) goes through :func:`_escape_latex`, because an asterisk in "A*
    search" is not emphasis.
    """
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text or "")
    placeholders: list[str] = []

    def _stash(latex: str) -> str:
        placeholders.append(latex)
        return f"\x00{len(placeholders) - 1}\x00"

    text = re.sub(r"`([^`]+)`", lambda m: _stash("\\texttt{" + _escape_latex(m.group(1)) + "}"), text)

    def _link_sub(m: re.Match) -> str:
        label = _render_inline(m.group(1))
        url = m.group(2).strip()
        if not _is_web_url(url):
            return _stash(label)
        return _stash(f"\\href{{{_safe_url(url)}}}{{{label}}}")

    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", _link_sub, text)
    text = re.sub(r"\*\*([^*]+)\*\*", lambda m: _stash("\\textbf{" + _render_inline(m.group(1)) + "}"), text)
    text = re.sub(r"(?<![*\w])\*([^*\s][^*]*)\*(?![*\w])",
                  lambda m: _stash("\\textit{" + _render_inline(m.group(1)) + "}"), text)
    text = _escape_latex(text)
    return re.sub(r"\x00(\d+)\x00", lambda m: placeholders[int(m.group(1))], text)


def _paragraphs(text: str, render) -> str:
    """Paragraphs split at blank lines, each rendered, joined with ``\\par``."""
    parts = [p.strip() for p in re.split(r"\n\s*\n", text or "") if p.strip()]
    return r" \par ".join(render(p) for p in parts)


# ---------------------------------------------------------------------------
# Fallback fonts
# ---------------------------------------------------------------------------

# Font files tried, in this order, for a character the body font lacks. Only
# the groups the document's characters need are loaded, and only files found
# on this computer: in the TeX installation (by ``kpsewhich``, then loaded by
# name) or in the system's own font folders (loaded by path). Fonts are never
# looked up by family name, because on macOS a name lookup can start a font
# download that waits on a dialog; and a person's own font folder is never
# used, because its path names them and the LaTeX source travels in the bundle.
_FALLBACK_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("symbols", (
        "latinmodern-math.otf", "NotoSerif-Regular.ttf", "DejaVuSerif.ttf", "STIXTwoText.ttf",
        "STIXTwoMath.otf", "STIXTwoMath-Regular.otf", "cambria.ttc", "Times New Roman.ttf",
        "times.ttf", "seguisym.ttf", "Apple Symbols.ttf", "FreeSerif.otf", "FreeSerif.ttf",
        "Arial Unicode.ttf", "ARIALUNI.TTF",
    )),
    ("cjk", (
        "NotoSerifCJK-Regular.ttc", "NotoSansCJK-Regular.ttc", "NotoSerifCJKsc-Regular.otf",
        "NotoSansCJKsc-Regular.otf", "SourceHanSerifSC-Regular.otf", "Songti.ttc",
        "Hiragino Sans GB.ttc", "STHeiti Light.ttc", "simsun.ttc", "msyh.ttc", "yumin.ttf",
        "msmincho.ttc", "FandolSong-Regular.otf", "wqy-zenhei.ttc", "DroidSansFallbackFull.ttf",
        "Arial Unicode.ttf", "ARIALUNI.TTF",
    )),
    ("hangul", (
        "NotoSerifCJK-Regular.ttc", "NotoSansCJK-Regular.ttc", "NotoSerifCJKkr-Regular.otf",
        "AppleMyungjo.ttf", "AppleSDGothicNeo.ttc", "batang.ttc", "malgun.ttf",
        "NanumMyeongjo.ttf", "UnBatang.ttf", "Arial Unicode.ttf", "ARIALUNI.TTF",
    )),
    ("other", (
        "NotoSerif-Regular.ttf", "FreeSerif.otf", "FreeSerif.ttf", "Arial Unicode.ttf",
        "ARIALUNI.TTF", "Times New Roman.ttf", "times.ttf", "DejaVuSans.ttf", "Nirmala.ttc",
        "Kohinoor.ttc", "Thonburi.ttc",
    )),
)
_FONTS_PER_GROUP = 6


def _system_font_dirs() -> tuple[str, ...]:
    if os.name == "nt":
        return (os.environ.get("WINDIR", "C:/Windows").replace("\\", "/").rstrip("/") + "/Fonts/",)
    if sys.platform == "darwin":
        return ("/System/Library/Fonts/", "/System/Library/Fonts/Supplemental/", "/Library/Fonts/")
    return ("/usr/share/fonts/", "/usr/local/share/fonts/")


_system_font_index: Optional[dict[str, str]] = None


def _system_fonts() -> dict[str, str]:
    """Font file name (lowercase) to the folder holding it, in the system's font folders."""
    global _system_font_index
    if _system_font_index is None:
        index: dict[str, str] = {}
        for root in _system_font_dirs():
            for folder, _dirs, files in os.walk(root):
                for name in files:
                    index.setdefault(name.lower(), folder.replace("\\", "/").rstrip("/") + "/")
        _system_font_index = index
    return _system_font_index


def _tex_fonts(engine: Optional[str], names: list[str]) -> set[str]:
    """Which of ``names`` the TeX installation has, by ``kpsewhich``."""
    if not names:
        return set()
    suffix = ".exe" if os.name == "nt" else ""
    kpsewhich = None
    if engine:
        beside = Path(engine).with_name(f"kpsewhich{suffix}")
        kpsewhich = str(beside) if beside.is_file() else None
    kpsewhich = kpsewhich or shutil.which("kpsewhich")
    if not kpsewhich:
        return set()
    try:
        run = subprocess.run([kpsewhich, *names], capture_output=True, timeout=30,
                             **hidden_window_kwargs())
    except (OSError, subprocess.SubprocessError):
        return set()
    found = {Path(line.strip()).name for line in run.stdout.decode("utf-8", "replace").splitlines()
             if line.strip()}
    return {name for name in names if name in found}


def _script_group(ch: str) -> str:
    code = ord(ch)
    if 0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F or 0xAC00 <= code <= 0xD7AF:
        return "hangul"
    if (0x2E80 <= code <= 0x2FDF or 0x3000 <= code <= 0x312F or 0x3190 <= code <= 0x9FFF
            or 0xA000 <= code <= 0xA4CF or 0xF900 <= code <= 0xFAFF or 0xFE30 <= code <= 0xFE4F
            or 0xFF00 <= code <= 0xFFEF or 0x20000 <= code <= 0x3FFFF):
        return "cjk"
    if 0x0590 <= code <= 0x1CFF or 0xA8E0 <= code <= 0xABFF:
        return "other"
    return "symbols"


def _fallback_preamble(tex_body: str, engine: Optional[str]) -> str:
    """The preamble lines that load the fallback fonts this document needs."""
    needed = {_script_group(chr(int(m.group(1)))) for m in re.finditer(r"\\rc\{(\d+)\}", tex_body)}
    if not needed:
        return ""
    wanted = [name for group, names in _FALLBACK_GROUPS if group in needed for name in names]
    in_tex = _tex_fonts(engine, list(dict.fromkeys(wanted)))
    system = _system_fonts()
    lines: list[str] = []
    loaded: set[str] = set()
    for group, names in _FALLBACK_GROUPS:
        if group not in needed:
            continue
        used = 0
        for name in names:
            if used >= _FONTS_PER_GROUP:
                break
            if name in loaded:
                used += 1
                continue
            command = "\\resmonfb" + _letters(len(loaded) + 1)
            if name in in_tex:
                lines.append(f"\\resmonaddfont{command}{{{name}}}")
            elif name.lower() in system:
                lines.append(f"\\resmonaddpath{command}{{{name}}}{{{system[name.lower()]}}}")
            else:
                continue
            loaded.add(name)
            used += 1
    return "\n".join(lines)


def _letters(n: int) -> str:
    out = ""
    while n:
        n, rem = divmod(n - 1, 26)
        out = chr(ord("a") + rem) + out
    return out


# ---------------------------------------------------------------------------
# The LaTeX document
# ---------------------------------------------------------------------------

_PREAMBLE = r"""\documentclass[11pt,letterpaper]{article}
\usepackage[margin=0.9in,top=1in,bottom=0.95in,headsep=0.3in]{geometry}
\usepackage{fontspec}
\usepackage{xcolor}
\usepackage{fancyhdr}
\usepackage{framed}
\usepackage{hyperref}

% Unicode text, with no substitutions: "--" stays two hyphens and "fi" two
% letters, so text copied from the PDF is the text that was written.
\setmainfont{lmroman10}[Extension=.otf, UprightFont=*-regular, BoldFont=*-bold,
  ItalicFont=*-italic, BoldItalicFont=*-bolditalic,
  SmallCapsFont=lmromancaps10-regular, Ligatures={NoCommon,TeXOff}]
% A character no font has is written to the log, where it is read back.
\tracinglostchars=2

\definecolor{accent}{RGB}{20,66,114}
\definecolor{accentsoft}{RGB}{70,110,160}
\definecolor{mutedgray}{RGB}{90,90,90}
\definecolor{rulegray}{RGB}{200,205,215}
\definecolor{abstractbg}{RGB}{244,246,250}
\definecolor{aisummarybg}{RGB}{249,244,235}
\definecolor{noticebg}{RGB}{252,246,230}

\hypersetup{colorlinks=true, urlcolor=accent, linkcolor=accent, pdfborder={0 0 0}}

\setlength{\parindent}{0pt}
\setlength{\parskip}{0.3em plus 0.1em}
\setlength{\emergencystretch}{3em}
\raggedbottom

\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\small\color{mutedgray}\textsc{RESMONNAME}}
\fancyhead[R]{\small\color{mutedgray}Page \thepage}
\renewcommand{\headrulewidth}{0.4pt}
\renewcommand{\headrule}{\hbox to\headwidth{\color{rulegray}\leaders\hrule height \headrulewidth\hfill}}
\renewcommand{\footrulewidth}{0pt}
% Page 1 carries the report's name in its title block, so not in a header too.
\fancypagestyle{resmonfirst}{\fancyhf{}\renewcommand{\headrulewidth}{0pt}}

\makeatletter
% A character the body font lacks: the body font if it has it after all, else
% the first fallback font that does, else the body font, which logs it.
\newif\ifresmonhit
\newcount\resmoncode
\def\resmonchain{}
\def\resmonusefont#1{\expandafter\def\expandafter\resmonchain\expandafter{\resmonchain\resmontry#1}}
\def\resmonaddfont#1#2{\IfFontExistsTF{#2}{\newfontfamily#1{#2}\resmonusefont#1}{}}
\def\resmonaddpath#1#2#3{\IfFileExists{#3#2}{\newfontfamily#1{#2}[Path=#3]\resmonusefont#1}{}}
\def\resmontry#1{\ifresmonhit\else\begingroup#1%
  \iffontchar\font\resmoncode\global\resmonhittrue\resmonglyph\fi\endgroup\fi}
\def\rc#1#2{\resmoncode=#1\relax\def\resmonglyph{#2}%
  \iffontchar\font\resmoncode #2\else\resmonhitfalse\resmonchain\ifresmonhit\else#2\fi\fi}

% Room kept on the page before something that should not start at its foot.
\newcommand{\resmonneed}[1]{\par\penalty-100\begingroup
  \setlength{\dimen@}{#1}\dimen@ii\pagegoal\advance\dimen@ii-\pagetotal
  \ifdim\dimen@>\dimen@ii\ifdim\dimen@ii>\z@\vfil\fi\penalty-\@M\fi\endgroup}
\makeatother

% A heading: a publication date, or a section after the papers. The room kept
% before it (#1 lines) holds the heading and the start of what follows, so a
% heading is never the last line on a page.
\newcommand{\resmonheading}[2][8]{%
  \resmonneed{#1\baselineskip}\vspace{1.1em}%
  {\raggedright\Large\bfseries\textcolor{accent}{#2}\par}\nopagebreak
  \vspace{0.1em}{\color{rulegray}\hrule height 0.6pt}\nopagebreak\vspace{0.5em}\nopagebreak}

% A paper's title, unhyphenated, and its authors and source. A paper other
% than the first under a heading first keeps room for its start.
\newcommand{\resmonpaper}[1]{%
  {\raggedright\hyphenpenalty=10000\exhyphenpenalty=10000\large\bfseries\textcolor{accent}{#1}\par}\nopagebreak}
\newcommand{\resmonbyline}[1]{{\raggedright\small\textcolor{mutedgray}{#1}\par}\nopagebreak\vspace{0.1em}}

% A label and its value on one line, the value wrapping under itself. Both
% boxes hang from their first line, so a label sits level with its value.
\newcommand{\resmonfield}[3][0.2]{\par\noindent
  \parbox[t]{#1\linewidth}{\raggedright\small\textbf{\textcolor{accentsoft}{#2}}}%
  \hspace{0.02\linewidth}%
  \parbox[t]{\dimexpr0.98\linewidth-#1\linewidth\relax}{\raggedright\small #3}\par\nopagebreak}

% Boxes that continue on the next page when they reach the foot of this one.
\newenvironment{resmonbox}[1]{%
  \def\FrameCommand{\setlength{\fboxsep}{6pt}\colorbox{#1}}%
  \MakeFramed{\advance\hsize-\width\FrameRestore}\small}{\endMakeFramed}
\newenvironment{resmonnoticebox}{%
  \def\FrameCommand{{\color{accentsoft}\vrule width 2pt}\setlength{\fboxsep}{6pt}\colorbox{noticebg}}%
  \MakeFramed{\advance\hsize-\width\FrameRestore}\small}{\endMakeFramed}
"""


def _tex_text(text: str) -> str:
    return _escape_latex(text or "")


def _build_digest_tex(parsed: dict, summary_only: bool = False,
                      context: Optional[dict] = None) -> str:
    """The report as a LaTeX document.

    ``summary_only`` leaves out each paper's abstract (and the "No abstract
    available." line), so only the AI summary follows each paper's details.
    """
    heading = document_heading(parsed, context)
    generated = get_meta(parsed, "Generated")
    out: list[str] = []

    # --- Title block -------------------------------------------------------
    out.append(r"\begin{document}\thispagestyle{resmonfirst}")
    out.append(r"\noindent{\color{accent}\rule{\linewidth}{1.4pt}}\par\vspace{4pt}")
    kicker = heading["kicker"]
    out.append(r"{\color{mutedgray}\small\textsc{" + _tex_text(kicker) + r"}}\par\vspace{1pt}")
    out.append(r"{\raggedright\hyphenpenalty=10000\LARGE\bfseries\color{accent} "
               + _tex_text(heading["title"]) + r"\par}")
    if heading["subtitle"]:
        out.append(r"\vspace{2pt}{\raggedright\large\color{accentsoft} "
                   + _tex_text(heading["subtitle"]) + r"\par}")
    note = AI_SUMMARY_ONLY_NOTE if summary_only else parsed["header"].get("subtitle", "")
    if note:
        out.append(r"\vspace{2pt}{\small\itshape\color{mutedgray} " + _render_inline(note) + r"\par}")
    if generated:
        out.append(r"\vspace{3pt}{\small\color{mutedgray} Generated "
                   + _tex_text(local_stamp(generated)) + r"\par}")
    out.append(r"\vspace{4pt}\noindent{\color{rulegray}\rule{\linewidth}{0.4pt}}\par\vspace{0.4em}")

    # --- Summary rows --------------------------------------------------------
    for label, value in summary_rows(parsed, heading):
        out.append(r"\resmonfield{" + _tex_text(label) + "}{" + _render_inline(value) + "}")
    out.append(r"\par\vspace{0.4em}\noindent{\color{rulegray}\rule{\linewidth}{0.4pt}}\par")

    # --- Notices: a canceled run, a missing key -----------------------------
    for notice in parsed["notices"]:
        out.append(r"\begin{resmonnoticebox}" + _render_inline(notice) + r"\end{resmonnoticebox}")

    # --- Body: groups of papers and the sections after them ------------------
    if not parsed["groups"]:
        out.append(r"\resmonheading{No Papers}")
        out.append(r"This report lists no papers.\par")
    for entry in parsed["body"]:
        papers = entry.get("papers") or []
        # Room for the heading, the first paper's title, byline and details,
        # and the first lines of its abstract.
        need = 10 + _detail_lines(papers[0]) if papers and not entry.get("blocks") else 7
        out.append(rf"\resmonheading[{need}]{{" + _tex_text(entry["heading"]) + "}")
        out.extend(_blocks_tex(entry.get("blocks", [])))
        if entry["kind"] != "group":
            continue
        for index, paper in enumerate(entry["papers"]):
            out.extend(_paper_tex(paper, first=(index == 0 and not entry.get("blocks")),
                                  summary_only=summary_only, note_missing=entry.get("is_date", True)))

    out.append(r"\end{document}")
    body = "\n".join(out) + "\n"
    preamble = _PREAMBLE.replace("RESMONNAME", _tex_text(REPORT_NAME))
    # The PDF's title is a PDF string, where a font cannot be chosen: its
    # characters are written as they are.
    pdf_title = "".join(_LATEX_SPECIAL.get(ch, ch) for ch in f"{heading['title']} — {REPORT_NAME}"
                        if ch.isprintable())
    preamble += "\\hypersetup{pdftitle={" + pdf_title + "}}\n"
    return preamble + _fallback_preamble(body, _latex_engine()) + "\n" + body


def _blocks_tex(blocks: list) -> list[str]:
    out: list[str] = []
    for kind, value in blocks:
        if kind == "p":
            out.append(_render_inline(value) + r"\par")
        elif kind == "quote":
            out.append(r"\begin{resmonnoticebox}" + _render_inline(value) + r"\end{resmonnoticebox}")
        elif kind == "ul":
            out.append(r"\begin{itemize}\setlength{\itemsep}{2pt}\setlength{\parskip}{0pt}"
                       r"\setlength{\topsep}{2pt}")
            for item in value:
                out.append(r"\item " + _render_inline(item))
            out.append(r"\end{itemize}")
    return out


def _detail_lines(paper: dict) -> int:
    """About how many lines a paper's title, byline and details take beyond one each."""
    fields = [(label, value) for label, value in paper["fields"] if label.lower() not in ("authors", "source")]
    byline = sum(len(value) for label, value in paper["fields"] if label.lower() in ("authors", "source"))
    return (len(paper["title"]) // 70 + len(fields) + sum(len(value) // 90 for _, value in fields)
            + byline // 110)


def _paper_tex(paper: dict, *, first: bool, summary_only: bool, note_missing: bool = True) -> list[str]:
    """One paper. ``note_missing`` is false for a finding in a watch's report,
    which is not a paper's record and says nothing about an abstract."""
    title = _tex_text(paper["title"])
    if _is_web_url(paper["url"]):
        title = r"\href{" + _safe_url(paper["url"]) + "}{" + title + "}"
    fields = dict((label.lower(), value) for label, value in paper["fields"])
    byline_parts = []
    if fields.get("authors"):
        byline_parts.append(_tex_text(fields["authors"]))
    if fields.get("source"):
        byline_parts.append(r"\textit{" + _tex_text(fields["source"]) + "}")
    # Room for the title, byline and details, and the first lines of the
    # abstract, so a paper's title never ends a page with its abstract on the next.
    out: list[str] = [] if first else [rf"\resmonneed{{{7 + _detail_lines(paper)}\baselineskip}}\vspace{{0.6em}}"]
    out.append(r"\resmonpaper{" + title + "}")
    if byline_parts:
        out.append(r"\resmonbyline{" + r"\enspace\textperiodcentered\enspace ".join(byline_parts) + "}")

    for label, value in paper["fields"]:
        if label.lower() in ("authors", "source"):
            continue
        rendered = _tex_text(value) if label.lower() in LITERAL_FIELDS else _render_inline(value)
        out.append(r"\resmonfield[0.17]{" + _tex_text(label) + "}{" + rendered + "}")

    if paper["abstract"].strip() and not summary_only:
        out.append(r"\begin{resmonbox}{abstractbg}\textbf{\color{accent}Abstract.}\ "
                   + _paragraphs(paper["abstract"], _tex_text) + r"\end{resmonbox}")
    elif not summary_only and note_missing:
        out.append(r"{\small\itshape\color{mutedgray} No abstract available.\par}")
    if paper["ai_summary"].strip():
        out.append(r"\begin{resmonbox}{aisummarybg}\textbf{\color{accent}AI Summary.}\ "
                   + _paragraphs(paper["ai_summary"], _render_inline) + r"\end{resmonbox}")
    return out


# ---------------------------------------------------------------------------
# Compiling
# ---------------------------------------------------------------------------


def _latex_engine() -> Optional[str]:
    """The LaTeX engine to compile with: XeLaTeX, else LuaLaTeX.

    Both read Unicode and the system's fonts, which the report needs; pdfLaTeX
    reads neither and is not used. First consults ``PATH``; when that fails
    (most commonly because the process was launched by launchd / systemd with
    a stripped PATH), scans the well-known TeX install directories in
    :data:`_LATEX_FALLBACK_DIRS` and returns the absolute path.
    """
    exe_suffix = ".exe" if os.name == "nt" else ""
    candidates = ("xelatex", "lualatex")
    for name in candidates:
        found = shutil.which(name)
        if found:
            return found
    for name in candidates:
        for pattern in _LATEX_FALLBACK_DIRS:
            for directory in glob.glob(pattern) or [pattern]:
                candidate = Path(directory) / f"{name}{exe_suffix}"
                if candidate.is_file() and os.access(candidate, os.X_OK):
                    return str(candidate)
    return None


_MISSING_CHAR_RE = re.compile(r"Missing character: There is no (.+?) \(U\+([0-9A-Fa-f]{4,6})\)")
_LATEX_ERROR_RE = re.compile(r"^! (.+)$", re.M)


def missing_characters(log_text: str) -> list[str]:
    """The characters the engine could not set, from its log: "中 (U+4E2D)"."""
    found: dict[str, str] = {}
    for m in _MISSING_CHAR_RE.finditer(log_text or ""):
        code = m.group(2).upper()
        found.setdefault(code, f"{m.group(1)} (U+{code})")
    return [found[code] for code in sorted(found, key=lambda c: int(c, 16))]


def _compile_pdf(tex_path: Path, work_dir: Path) -> dict:
    """Compile ``tex_path`` in ``work_dir``.

    Returns ``{"pdf": Path | None, "missing": [...], "problem": str | None}``.
    ``problem`` says, in a sentence, why there is no PDF; ``missing`` lists the
    characters the PDF could not show. One pass is enough: the document has no
    cross-references.
    """
    result: dict = {"pdf": None, "missing": [], "problem": None}
    engine = _latex_engine()
    if engine is None:
        result["problem"] = ("No PDF: this computer has no XeLaTeX or LuaLaTeX, which the PDF "
                             "is made with. The HTML report holds the same report.")
        logger.warning("No Unicode LaTeX engine found; skipping PDF compilation for %s", tex_path)
        return result
    log_path = work_dir / (tex_path.stem + ".log")
    try:
        run = subprocess.run(
            [engine, "-interaction=nonstopmode", "-halt-on-error",
             "-output-directory", str(work_dir), str(tex_path.name)],
            cwd=str(work_dir), capture_output=True, timeout=180, **hidden_window_kwargs(),
        )
    except subprocess.TimeoutExpired:
        result["problem"] = "No PDF: LaTeX took longer than three minutes and was stopped."
        logger.warning("%s timed out for %s", engine, tex_path)
        return result
    except Exception as exc:  # pragma: no cover - defensive
        result["problem"] = f"No PDF: LaTeX could not be started ({exc})."
        logger.warning("%s raised for %s: %s", engine, tex_path, exc)
        return result
    try:
        log_text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        log_text = run.stdout.decode("utf-8", errors="replace")
    result["missing"] = missing_characters(log_text)
    pdf_path = work_dir / (tex_path.stem + ".pdf")
    if run.returncode != 0 or not pdf_path.exists():
        error = _LATEX_ERROR_RE.search(log_text)
        reason = error.group(1).strip() if error else f"it stopped with exit status {run.returncode}"
        result["problem"] = f"No PDF: LaTeX stopped: {reason}"
        logger.warning("%s failed for %s (exit=%d): %s", engine, tex_path, run.returncode, reason)
        return result
    result["pdf"] = pdf_path
    if result["missing"]:
        logger.warning("The PDF for %s could not show %d character(s): %s",
                       tex_path, len(result["missing"]), ", ".join(result["missing"]))
    return result


def _cleanup_aux(work_dir: Path, stem: str) -> None:
    """Remove the engine's working files for a given stem."""
    for ext in (".aux", ".log", ".out", ".toc", ".lof", ".lot", ".fls", ".fdb_latexmk", ".pdf"):
        p = work_dir / f"{stem}{ext}"
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# AI summary-only variant helpers
# ---------------------------------------------------------------------------


def _has_ai_summary(parsed: dict) -> bool:
    """Return True if any paper in ``parsed`` carries an AI summary."""
    return any(p.get("ai_summary", "").strip() for g in parsed.get("groups", []) for p in g["papers"])


def _strip_abstracts_from_md(md_text: str) -> str:
    """``md_text`` without its ``- **Abstract:** ...`` bullets (and their
    continuation paragraphs), with a line under the title saying so.
    """
    lines = md_text.splitlines()
    out: list[str] = []
    i = 0
    n = len(lines)
    title_done = False
    while i < n:
        line = lines[i]
        stripped = line.strip()

        if not title_done and stripped.startswith("# "):
            out.append(line)
            out.append(f"*{AI_SUMMARY_ONLY_NOTE}*  ")
            title_done = True
            i += 1
            continue

        if re.match(r"^-\s*\*\*Abstract:\*\*", stripped, re.IGNORECASE):
            i += 1
            pending_blank = False
            while i < n:
                peek = lines[i].strip()
                if peek == "":
                    if pending_blank:
                        break
                    pending_blank = True
                    i += 1
                    continue
                if peek.startswith("#") or peek.startswith("---") or re.match(r"^-\s*\*\*[^*]+:\*\*", peek):
                    break
                i += 1
                pending_blank = False
            continue

        out.append(line)
        i += 1

    return "\n".join(out)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

AI_SUMMARY_SUFFIX = "-ai-summary"


def export_report_bundle(
    md_path: Path,
    out_dir: Path,
    stem: str = "report",
    *,
    context: Optional[dict] = None,
) -> dict:
    """Render one report into a bundle's ``report/`` and ``latex/`` folders.

    Writes, under ``out_dir``::

        report/<stem>.pdf                 when a LaTeX engine made it
        report/<stem>.html                always
        report/<stem>-ai-summary.md       when the report has AI summaries
        report/<stem>-ai-summary.pdf      likewise, when a LaTeX engine made it
        latex/<stem>.tex                  the PDF's source
        latex/<stem>-ai-summary.tex

    The Markdown report itself is the caller's to copy. ``context`` names the
    run (``kind``, ``watch``) for the title. Returns the paths written, and for
    the PDF, ``pdf_missing_characters`` and ``pdf_problem``.
    """
    from . import report_html  # noqa: PLC0415 - report_html imports this module

    md_path = Path(md_path)
    out_dir = Path(out_dir)
    report_dir = out_dir / "report"
    latex_dir = out_dir / "latex"
    report_dir.mkdir(parents=True, exist_ok=True)
    latex_dir.mkdir(parents=True, exist_ok=True)

    artifacts: dict = {
        "pdf": None, "html": None, "tex": None,
        "summary_md": None, "summary_pdf": None, "summary_tex": None,
        "pdf_missing_characters": [], "pdf_problem": None,
    }
    try:
        md_text = md_path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("Cannot read %s: %s", md_path, exc)
        artifacts["pdf_problem"] = "No PDF or HTML: the run's report could not be read."
        return artifacts

    parsed = parse_report(md_text)

    html_path = report_dir / f"{stem}.html"
    html_path.write_text(report_html.render(parsed, context=context), encoding="utf-8")
    artifacts["html"] = html_path

    def compile_into(tex_text: str, name: str) -> Optional[Path]:
        tex_path = latex_dir / f"{name}.tex"
        tex_path.write_text(tex_text, encoding="utf-8")
        outcome = _compile_pdf(tex_path, latex_dir)
        pdf: Optional[Path] = None
        if outcome["pdf"] is not None:
            pdf = report_dir / f"{name}.pdf"
            shutil.move(str(outcome["pdf"]), pdf)
        for item in outcome["missing"]:
            if item not in artifacts["pdf_missing_characters"]:
                artifacts["pdf_missing_characters"].append(item)
        if outcome["problem"] and not artifacts["pdf_problem"]:
            artifacts["pdf_problem"] = outcome["problem"]
        _cleanup_aux(latex_dir, name)
        return pdf

    artifacts["tex"] = latex_dir / f"{stem}.tex"
    artifacts["pdf"] = compile_into(_build_digest_tex(parsed, context=context), stem)

    if _has_ai_summary(parsed):
        summary_stem = f"{stem}{AI_SUMMARY_SUFFIX}"
        summary_md_text = _strip_abstracts_from_md(md_text)
        summary_md_path = report_dir / f"{summary_stem}.md"
        summary_md_path.write_text(summary_md_text, encoding="utf-8")
        artifacts["summary_md"] = summary_md_path
        summary_parsed = parse_report(summary_md_text)
        artifacts["summary_tex"] = latex_dir / f"{summary_stem}.tex"
        artifacts["summary_pdf"] = compile_into(
            _build_digest_tex(summary_parsed, summary_only=True, context=context), summary_stem)
    return artifacts
