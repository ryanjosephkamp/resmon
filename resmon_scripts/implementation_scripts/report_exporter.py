"""Convert resmon Markdown reports into PDF and styled LaTeX.

Two output formats are produced alongside the Markdown source:

1. ``report.tex`` + ``report.pdf``: a plain ``article``-class rendering of
   the Markdown content, compiled with ``pdflatex``.
2. ``latex/report.tex`` + ``latex/report.pdf``: a professional
   journal-digest rendering with a colored title block, metadata table,
   styled section rules, and framed abstracts.

If no LaTeX engine is installed, only the ``.tex`` sources are written;
PDF compilation is skipped and a warning is logged.
"""

from __future__ import annotations

import glob
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Optional

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


# ---------------------------------------------------------------------------
# LaTeX escaping
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


def _escape_latex(text: str) -> str:
    """Escape LaTeX special characters in plain text."""
    if not text:
        return ""
    out = []
    for ch in text:
        out.append(_LATEX_SPECIAL.get(ch, ch))
    return "".join(out)


def _render_inline(text: str) -> str:
    """Render inline Markdown (bold, italic, links, code) as LaTeX.

    The order matters: we extract links and code first to protect their
    contents from further escaping, then handle bold/italic, and finally
    escape any remaining plain text.
    """
    placeholders: list[str] = []

    def _stash(latex: str) -> str:
        placeholders.append(latex)
        return f"\x00{len(placeholders) - 1}\x00"

    # Inline code: `code`
    def _code_sub(m: re.Match) -> str:
        return _stash("\\texttt{" + _escape_latex(m.group(1)) + "}")

    text = re.sub(r"`([^`]+)`", _code_sub, text)

    # Links: [label](url)
    def _link_sub(m: re.Match) -> str:
        label = _render_inline(m.group(1))  # labels may contain formatting
        url = m.group(2).strip()
        url_escaped = url.replace("%", r"\%").replace("#", r"\#").replace("_", r"\_").replace("&", r"\&")
        return _stash(f"\\href{{{url_escaped}}}{{{label}}}")

    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", _link_sub, text)

    # Bold: **text**
    def _bold_sub(m: re.Match) -> str:
        return _stash("\\textbf{" + _render_inline(m.group(1)) + "}")

    text = re.sub(r"\*\*([^*]+)\*\*", _bold_sub, text)

    # Italic: *text*
    def _italic_sub(m: re.Match) -> str:
        return _stash("\\textit{" + _render_inline(m.group(1)) + "}")

    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", _italic_sub, text)

    # Escape what remains.
    text = _escape_latex(text)

    # Restore placeholders.
    def _restore(m: re.Match) -> str:
        idx = int(m.group(1))
        return placeholders[idx]

    text = re.sub(r"\x00(\d+)\x00", _restore, text)
    return text


def _render_multiline(text: str) -> str:
    """Render a possibly-multi-paragraph string for LaTeX body contexts.

    Splits on blank-line paragraph breaks, renders each paragraph with
    :func:`_render_inline`, and joins them with ``\\par``. Safe to use
    inside ``\\colorbox{...}{\\begin{minipage}...}`` blocks such as
    :code:`\\resmonabstract` and :code:`\\resmonaisummary`. Not safe for
    raw ``tabular`` p-columns (use :func:`_render_inline` and flatten
    beforehand for those).
    """
    if not text:
        return ""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paragraphs:
        return ""
    return r" \par ".join(_render_inline(p) for p in paragraphs)


# ---------------------------------------------------------------------------
# Parse Markdown report structure
# ---------------------------------------------------------------------------


def _parse_report(md_text: str) -> dict:
    """Parse a resmon report Markdown file into a structured dict.

    Returns a dict of the form::

        {
            "header": {"title": str, "meta": [(label, value), ...]},
            "groups": [
                {"date": str, "papers": [{
                    "title": str, "url": str,
                    "fields": [(label, value), ...],  # Authors, Source, etc.
                    "abstract": str,
                }]}
            ],
        }
    """
    header: dict = {"title": "resmon Literature Report", "meta": []}
    groups: list[dict] = []
    current_group: Optional[dict] = None
    current_paper: Optional[dict] = None

    lines = md_text.splitlines()
    i = 0
    n = len(lines)
    in_header = True

    while i < n:
        line = lines[i]
        stripped = line.strip()

        # Top H1
        if in_header and stripped.startswith("# "):
            header["title"] = stripped[2:].strip()
            i += 1
            continue

        # Header metadata lines like "**Generated:** ..."
        if in_header:
            m = re.match(r"^\*\*([^*]+):\*\*\s*(.*?)\s*$", stripped)
            if m:
                header["meta"].append((m.group(1).strip(), m.group(2).strip()))
                i += 1
                continue
            if stripped == "" or stripped == "---":
                i += 1
                continue
            # Exit header section once we see a group header.
            if stripped.startswith("## "):
                in_header = False
            elif stripped.startswith("### "):
                in_header = False

        # Date group header
        if stripped.startswith("## "):
            current_group = {"date": stripped[3:].strip(), "papers": []}
            groups.append(current_group)
            current_paper = None
            i += 1
            continue

        # Paper title
        if stripped.startswith("### "):
            title_line = stripped[4:].strip()
            # Optional link syntax: [title](url)
            mlink = re.match(r"^\[(.+?)\]\((.+?)\)\s*$", title_line)
            if mlink:
                title = mlink.group(1)
                url = mlink.group(2)
            else:
                title = title_line
                url = ""
            current_paper = {"title": title, "url": url, "fields": [], "abstract": ""}
            if current_group is None:
                current_group = {"date": "Date Unknown", "papers": []}
                groups.append(current_group)
            current_group["papers"].append(current_paper)
            i += 1
            continue

        # Bullet list entries: "- **Label:** value"
        #
        # Values may span multiple lines: a blank line followed by one or
        # more paragraphs of continuation text (this is how the Markdown
        # report generator emits multi-paragraph AI summaries, where the
        # first line is an audit prefix and the body follows after a blank
        # line). We accumulate continuation paragraphs until the next
        # bullet, section/paper header, horizontal rule, or a second blank
        # line.
        if current_paper is not None:
            mfield = re.match(r"^-\s*\*\*([^*]+):\*\*\s*(.*?)\s*$", stripped)
            if mfield:
                label = mfield.group(1).strip()
                value_parts: list[str] = []
                first = mfield.group(2).strip()
                if first:
                    value_parts.append(first)
                j = i + 1
                pending_blank = False
                while j < n:
                    peek = lines[j].rstrip()
                    peek_stripped = peek.strip()
                    if peek_stripped == "":
                        if pending_blank:
                            # Two blank lines ends the field.
                            break
                        pending_blank = True
                        j += 1
                        continue
                    if (
                        peek_stripped.startswith("#")
                        or peek_stripped.startswith("---")
                        or re.match(r"^-\s*\*\*[^*]+:\*\*", peek_stripped)
                    ):
                        break
                    # Continuation paragraph line.
                    if value_parts and pending_blank:
                        value_parts.append("")  # paragraph break marker
                    value_parts.append(peek_stripped)
                    pending_blank = False
                    j += 1
                # Collapse paragraph break markers (empty strings) into \n\n.
                value = ""
                for part in value_parts:
                    if part == "":
                        value += "\n\n"
                    else:
                        value = f"{value} {part}".strip() if value and not value.endswith("\n\n") else value + part
                value = value.strip()
                if label.lower() == "abstract":
                    current_paper["abstract"] = value
                else:
                    current_paper["fields"].append((label, value))
                i = j
                continue

        i += 1

    return {"header": header, "groups": groups}


# ---------------------------------------------------------------------------
# Plain article-style LaTeX
# ---------------------------------------------------------------------------


def _build_plain_tex(parsed: dict) -> str:
    """Render the parsed report as a plain article-class LaTeX document."""
    lines: list[str] = []
    lines.append(r"\documentclass[11pt]{article}")
    lines.append(r"\usepackage{fontspec}")
    lines.append(r"\usepackage[margin=1in]{geometry}")
    lines.append(r"\usepackage{hyperref}")
    lines.append(r"\usepackage{parskip}")
    lines.append(r"\usepackage{enumitem}")
    lines.append(r"\hypersetup{colorlinks=true, urlcolor=blue}")
    lines.append(r"\sloppy")
    lines.append(r"\begin{document}")
    lines.append("")

    header = parsed["header"]
    lines.append(f"\\begin{{center}}{{\\LARGE\\textbf{{{_render_inline(header['title'])}}}}}\\end{{center}}")
    lines.append("")
    if header["meta"]:
        lines.append(r"\begin{flushleft}")
        for label, value in header["meta"]:
            lines.append(
                f"\\textbf{{{_render_inline(label)}:}} {_render_inline(value)}\\\\"
            )
        lines.append(r"\end{flushleft}")
        lines.append(r"\vspace{0.5em}\hrule\vspace{0.5em}")
        lines.append("")

    for group in parsed["groups"]:
        lines.append(f"\\section*{{{_render_inline(group['date'])}}}")
        for paper in group["papers"]:
            title = _render_inline(paper["title"])
            if paper["url"]:
                safe_url = paper["url"].replace("%", r"\%").replace("#", r"\#").replace("_", r"\_").replace("&", r"\&")
                title_tex = f"\\href{{{safe_url}}}{{{title}}}"
            else:
                title_tex = title
            lines.append(f"\\subsection*{{{title_tex}}}")
            if paper["fields"]:
                lines.append(r"\begin{itemize}[leftmargin=1.2em, itemsep=2pt, topsep=2pt]")
                for label, value in paper["fields"]:
                    lines.append(
                        f"  \\item \\textbf{{{_render_inline(label)}:}} {_render_inline(value)}"
                    )
                lines.append(r"\end{itemize}")
            if paper["abstract"]:
                lines.append(r"\par\noindent\textbf{Abstract:} " + _render_inline(paper["abstract"]))
                lines.append("")

    lines.append(r"\end{document}")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Journal-digest styled LaTeX
# ---------------------------------------------------------------------------


def _get_meta(parsed: dict, label: str, default: str = "") -> str:
    for k, v in parsed["header"]["meta"]:
        if k.lower() == label.lower():
            return v
    return default


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


_DIGEST_PREAMBLE = r"""\documentclass[11pt,letterpaper]{article}
\usepackage[margin=0.95in,top=1.1in,bottom=1.0in]{geometry}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{microtype}
\usepackage{xcolor}
\usepackage{titlesec}
\usepackage{fancyhdr}
\usepackage{array}
\usepackage{enumitem}
\usepackage{parskip}
\usepackage{hyperref}
\usepackage{needspace}

\definecolor{accent}{RGB}{20,66,114}
\definecolor{accentsoft}{RGB}{70,110,160}
\definecolor{mutedgrey}{RGB}{95,95,95}
\definecolor{rulegrey}{RGB}{200,205,215}
\definecolor{abstractbg}{RGB}{245,247,251}

\hypersetup{
  colorlinks=true,
  urlcolor=accent,
  linkcolor=accent,
  pdfborder={0 0 0}
}

\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\small\color{mutedgrey}\textsc{resmon literature digest}}
\fancyhead[R]{\small\color{mutedgrey}Page \thepage}
\renewcommand{\headrulewidth}{0.4pt}
\renewcommand{\headrule}{\hbox to\headwidth{\color{rulegrey}\leaders\hrule height \headrulewidth\hfill}}
\renewcommand{\footrulewidth}{0pt}

\titleformat{\section}
  {\Large\bfseries\color{accent}}
  {}{0pt}
  {}
  [\vspace{-4pt}{\color{rulegrey}\titlerule[0.6pt]}]
\titlespacing*{\section}{0pt}{1.4em}{0.7em}

\titleformat{\subsection}
  {\normalsize\bfseries\color{accentsoft}}
  {}{0pt}{}
\titlespacing*{\subsection}{0pt}{0.6em}{0.2em}

\setlist[itemize]{leftmargin=1.2em,itemsep=1pt,topsep=1pt,parsep=0pt}

\newcommand{\resmonpaper}[2]{%
  \needspace{6\baselineskip}%
  \vspace{0.4em}%
  {\large\bfseries\color{accent} #1}\par
  \ifx\relax#2\relax\else{\small\color{mutedgrey} #2}\par\fi
  \vspace{0.15em}{\color{rulegrey}\hrule height 0.3pt}\vspace{0.4em}%
}

\newcommand{\resmonabstract}[1]{%
  \par\vspace{0.3em}%
  \noindent\colorbox{abstractbg}{%
    \begin{minipage}{\dimexpr\linewidth-2\fboxsep\relax}%
      \small\textbf{\color{accent}Abstract.}\ #1%
    \end{minipage}%
  }\par\vspace{0.2em}%
}

\definecolor{aisummarybg}{RGB}{249,244,235}
\newcommand{\resmonaisummary}[1]{%
  \par\vspace{0.2em}%
  \noindent\colorbox{aisummarybg}{%
    \begin{minipage}{\dimexpr\linewidth-2\fboxsep\relax}%
      \small\textbf{\color{accent}AI Summary.}\ #1%
    \end{minipage}%
  }\par\vspace{0.2em}%
}
"""


def _build_digest_tex(parsed: dict, summary_only: bool = False) -> str:
    """Render the parsed report as a professional journal-digest LaTeX doc.

    When ``summary_only`` is True, the per-paper abstract block is omitted
    entirely (no "No abstract available." placeholder either), so only the
    AI summary follows each paper's metadata.
    """
    header = parsed["header"]
    title = header["title"] or "resmon Literature Digest"
    query = _get_meta(parsed, "Query")
    date_range = _get_meta(parsed, "Date Range")
    generated = _get_meta(parsed, "Generated")
    total_results = _get_meta(parsed, "Total Results")

    # Use any remaining meta items as extra rows so we do not silently drop data.
    consumed = {"query", "date range", "generated", "total results"}
    extra_meta = [
        (k, v) for k, v in header["meta"] if k.lower() not in consumed
    ]

    out: list[str] = []
    out.append(_DIGEST_PREAMBLE)
    out.append(r"\begin{document}")
    out.append("")

    # --- Title block -------------------------------------------------------
    out.append(r"\begingroup")
    out.append(r"\noindent{\color{accent}\rule{\linewidth}{1.4pt}}\par\vspace{6pt}")
    out.append(
        r"\noindent{\color{mutedgrey}\scshape\small Automated Literature Surveillance Digest}\par\vspace{2pt}"
    )
    out.append(
        r"\noindent{\LARGE\bfseries\color{accent} " + _render_inline(title) + r"}\par\vspace{4pt}"
    )
    if generated:
        out.append(
            r"\noindent{\color{mutedgrey}\small Generated "
            + _render_inline(generated)
            + r"}\par\vspace{3pt}"
        )
    out.append(r"\noindent{\color{rulegrey}\rule{\linewidth}{0.4pt}}")
    out.append(r"\endgroup")
    out.append(r"\vspace{0.6em}")
    out.append("")

    # --- Metadata summary -------------------------------------------------
    meta_rows: list[tuple[str, str]] = []
    if query:
        meta_rows.append(("Query", query))
    if date_range:
        meta_rows.append(("Date Range", date_range))
    if total_results:
        meta_rows.append(("Total Results", total_results))
    num_groups = len(parsed["groups"])
    num_papers = sum(len(g["papers"]) for g in parsed["groups"])
    meta_rows.append(("Date Groups", str(num_groups)))
    meta_rows.append(("Papers Included", str(num_papers)))
    meta_rows.extend(extra_meta)

    if meta_rows:
        out.append(r"\noindent\begin{tabular}{@{}>{\bfseries\color{accentsoft}}p{0.22\linewidth}@{\ }p{0.74\linewidth}@{}}")
        for label, value in meta_rows:
            out.append(
                _render_inline(label) + " & " + _render_inline(value) + r" \\"
            )
        out.append(r"\end{tabular}")
        out.append(r"\vspace{0.5em}")
        out.append(r"\noindent{\color{rulegrey}\rule{\linewidth}{0.3pt}}")
        out.append(r"\vspace{0.4em}")
        out.append("")

    # --- Body: date groups and papers -------------------------------------
    if not parsed["groups"] or num_papers == 0:
        out.append(r"\section*{No Papers}")
        out.append(r"No papers were included in this digest.")
    else:
        for group in parsed["groups"]:
            if not group["papers"]:
                continue
            out.append(
                r"\section*{" + _render_inline(group["date"]) + r"}"
            )
            for paper in group["papers"]:
                title_tex = _render_inline(paper["title"])
                if paper["url"]:
                    title_tex = (
                        r"\href{" + _safe_url(paper["url"]) + r"}{" + title_tex + r"}"
                    )

                # Byline: authors + source on one line.
                authors = ""
                source = ""
                for label, value in paper["fields"]:
                    low = label.lower()
                    if low == "authors":
                        authors = value
                    elif low == "source":
                        source = value
                byline_parts: list[str] = []
                if authors:
                    byline_parts.append(_render_inline(authors))
                if source:
                    byline_parts.append(r"\textit{" + _render_inline(source) + r"}")
                byline = r" \hspace{0.5em}\textbf{\textperiodcentered}\hspace{0.5em} ".join(byline_parts)
                if not byline:
                    byline = r"\relax"

                out.append(r"\resmonpaper{" + title_tex + r"}{" + byline + r"}")

                # Remaining fields (Categories, DOI, etc.) as compact table.
                # AI Summary is extracted and rendered as its own block below.
                ai_summary = ""
                other_fields = []
                for k, v in paper["fields"]:
                    low = k.lower()
                    if low in ("authors", "source"):
                        continue
                    if low == "ai summary":
                        ai_summary = v
                        continue
                    other_fields.append((k, v))
                if other_fields:
                    out.append(
                        r"\noindent\begin{tabular}{@{}>{\color{mutedgrey}\small}p{0.18\linewidth}@{\ }>{\small}p{0.78\linewidth}@{}}"
                    )
                    for label, value in other_fields:
                        out.append(
                            r"\textbf{" + _render_inline(label) + "} & "
                            + _render_inline(value) + r" \\"
                        )
                    out.append(r"\end{tabular}")
                    out.append(r"\par\vspace{0.15em}")

                if paper["abstract"].strip():
                    out.append(
                        r"\resmonabstract{" + _render_multiline(paper["abstract"]) + r"}"
                    )
                elif not summary_only:
                    out.append(r"\par\small\color{mutedgrey}\textit{No abstract available.}\normalsize\color{black}\par")

                if ai_summary.strip():
                    out.append(
                        r"\resmonaisummary{" + _render_multiline(ai_summary) + r"}"
                    )

                out.append(r"\vspace{0.4em}")
                out.append("")

    out.append(r"\end{document}")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# pdflatex compilation
# ---------------------------------------------------------------------------


def _latex_engine() -> Optional[str]:
    """Return the preferred LaTeX engine (xelatex > lualatex > pdflatex).

    First consults ``PATH`` via :func:`shutil.which`. When that fails (most
    commonly because the process was launched by launchd / systemd with a
    stripped PATH), falls back to scanning the well-known TeX install
    directories listed in :data:`_LATEX_FALLBACK_DIRS` and returns the
    absolute path to the first matching engine. The absolute path is what
    :func:`subprocess.run` needs anyway, so callers do not have to mutate
    ``os.environ['PATH']``.
    """
    exe_suffix = ".exe" if os.name == "nt" else ""
    candidates = ("xelatex", "lualatex", "pdflatex")
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


def _compile_pdf(tex_path: Path, work_dir: Path) -> Optional[Path]:
    """Compile ``tex_path`` inside ``work_dir`` using the best available engine.

    Two passes are run to resolve cross-references. Returns the resulting
    PDF path on success, otherwise ``None``.
    """
    engine = _latex_engine()
    if engine is None:
        logger.warning("No LaTeX engine found; skipping PDF compilation for %s", tex_path)
        return None
    try:
        for _ in range(2):
            result = subprocess.run(
                [
                    engine,
                    "-interaction=nonstopmode",
                    "-halt-on-error",
                    "-output-directory",
                    str(work_dir),
                    str(tex_path.name),
                ],
                cwd=str(work_dir),
                capture_output=True,
                timeout=180,
            )
            if result.returncode != 0:
                logger.warning(
                    "%s failed for %s (exit=%d). Tail: %s",
                    engine,
                    tex_path,
                    result.returncode,
                    result.stdout.decode("utf-8", errors="replace")[-800:],
                )
                return None
    except subprocess.TimeoutExpired:
        logger.warning("%s timed out for %s", engine, tex_path)
        return None
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("%s raised for %s: %s", engine, tex_path, exc)
        return None

    pdf_path = work_dir / (tex_path.stem + ".pdf")
    return pdf_path if pdf_path.exists() else None


# ---------------------------------------------------------------------------
# AI summary-only variant helpers
# ---------------------------------------------------------------------------


_AI_SUMMARY_ONLY_SUBTITLE = "AI Summaries Only (original abstracts excluded)"


def _has_ai_summary(parsed: dict) -> bool:
    """Return True if any paper in ``parsed`` carries an AI Summary field."""
    for group in parsed.get("groups", []):
        for paper in group.get("papers", []):
            for label, value in paper.get("fields", []):
                if label.strip().lower() == "ai summary" and str(value).strip():
                    return True
    return False


def _strip_abstracts_from_md(md_text: str) -> str:
    """Return a copy of ``md_text`` with all ``- **Abstract:** ...`` bullets
    (and their multi-paragraph continuations) removed, and an added subtitle
    line under the top-level ``# `` title identifying the variant.
    """
    lines = md_text.splitlines()
    out: list[str] = []
    i = 0
    n = len(lines)
    title_done = False
    while i < n:
        line = lines[i]
        stripped = line.strip()

        # Insert subtitle immediately after the first H1.
        if not title_done and stripped.startswith("# "):
            out.append(line)
            out.append(f"*{_AI_SUMMARY_ONLY_SUBTITLE}*  ")
            title_done = True
            i += 1
            continue

        # Skip an Abstract bullet plus its continuation lines.
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
                if (
                    peek.startswith("#")
                    or peek.startswith("---")
                    or re.match(r"^-\s*\*\*[^*]+:\*\*", peek)
                ):
                    break
                i += 1
                pending_blank = False
            continue

        out.append(line)
        i += 1

    return "\n".join(out)


def _retitle_parsed_for_summary_only(parsed: dict) -> dict:
    """Annotate the parsed header so the digest title indicates the variant."""
    new_title = parsed["header"]["title"]
    suffix = " — AI Summaries Only"
    if suffix not in new_title:
        new_title = new_title + suffix
    parsed["header"] = {"title": new_title, "meta": list(parsed["header"]["meta"])}
    return parsed


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def export_report_bundle(
    md_path: Path,
    out_dir: Path,
    stem: str = "report",
) -> dict:
    """Produce a styled LaTeX/PDF bundle for one report.

    Writes the following into ``out_dir`` (which is created if absent)::

        <stem>.pdf            (copy of latex/<stem>.pdf; the Markdown report's
                               PDF rendering, placed alongside the .md for
                               convenient viewing)
        latex/<stem>.tex
        latex/<stem>.pdf      (if a LaTeX engine is available)

    The source Markdown is not copied by this function; callers should
    include ``md_path`` separately.

    Returns a dict describing which artifacts were produced.
    """
    md_path = Path(md_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    latex_dir = out_dir / "latex"
    latex_dir.mkdir(parents=True, exist_ok=True)

    artifacts: dict = {
        "pdf": None,
        "newspaper_tex": None,
        "newspaper_pdf": None,
        "summary_md": None,
        "summary_pdf": None,
        "summary_newspaper_tex": None,
        "summary_newspaper_pdf": None,
    }

    try:
        md_text = md_path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("Cannot read %s: %s", md_path, exc)
        return artifacts

    parsed = _parse_report(md_text)

    # Journal-digest styled tex + pdf (self-contained; no external class
    # files). The plain article-style ``<stem>.tex`` at the top of
    # ``out_dir`` was dropped; the single ``latex/`` rendering is now
    # canonical. The compiled PDF is additionally copied to the top of
    # ``out_dir`` so users have a readily-viewable PDF next to the .md
    # source.
    digest_tex = _build_digest_tex(parsed)
    digest_tex_path = latex_dir / f"{stem}.tex"
    digest_tex_path.write_text(digest_tex, encoding="utf-8")
    artifacts["newspaper_tex"] = digest_tex_path

    digest_pdf = _compile_pdf(digest_tex_path, latex_dir)
    if digest_pdf is not None:
        artifacts["newspaper_pdf"] = digest_pdf
        top_pdf = out_dir / f"{stem}.pdf"
        try:
            shutil.copyfile(digest_pdf, top_pdf)
            artifacts["pdf"] = top_pdf
        except OSError as exc:
            logger.warning("Failed to copy PDF to %s: %s", top_pdf, exc)
    _cleanup_aux(latex_dir, stem)

    # -------------------------------------------------------------------
    # AI summary-only variant (only when AI summaries are present).
    # Produces ``<stem>_ai_summary.md`` + ``<stem>_ai_summary.pdf`` at the
    # top of ``out_dir`` and ``latex/<stem>_ai_summary.tex`` +
    # ``latex/<stem>_ai_summary.pdf`` alongside the full-report variants.
    # -------------------------------------------------------------------
    if _has_ai_summary(parsed):
        summary_stem = f"{stem}_ai_summary"
        summary_md_text = _strip_abstracts_from_md(md_text)
        summary_md_path = out_dir / f"{summary_stem}.md"
        try:
            summary_md_path.write_text(summary_md_text, encoding="utf-8")
            artifacts["summary_md"] = summary_md_path
        except OSError as exc:
            logger.warning("Failed to write %s: %s", summary_md_path, exc)

        summary_parsed = _retitle_parsed_for_summary_only(_parse_report(summary_md_text))
        summary_tex = _build_digest_tex(summary_parsed, summary_only=True)
        summary_tex_path = latex_dir / f"{summary_stem}.tex"
        summary_tex_path.write_text(summary_tex, encoding="utf-8")
        artifacts["summary_newspaper_tex"] = summary_tex_path

        summary_pdf = _compile_pdf(summary_tex_path, latex_dir)
        if summary_pdf is not None:
            artifacts["summary_newspaper_pdf"] = summary_pdf
            top_summary_pdf = out_dir / f"{summary_stem}.pdf"
            try:
                shutil.copyfile(summary_pdf, top_summary_pdf)
                artifacts["summary_pdf"] = top_summary_pdf
            except OSError as exc:
                logger.warning("Failed to copy PDF to %s: %s", top_summary_pdf, exc)
        _cleanup_aux(latex_dir, summary_stem)

    return artifacts


def _cleanup_aux(work_dir: Path, stem: str) -> None:
    """Remove pdflatex auxiliary files for a given stem."""
    for ext in (".aux", ".log", ".out", ".toc", ".lof", ".lot", ".fls", ".fdb_latexmk"):
        p = work_dir / f"{stem}{ext}"
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass
