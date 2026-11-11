"""A run's report as one static HTML page.

Rendered from the same parse of the Markdown report as the PDF
(``report_exporter.parse_report``), so it holds what the PDF holds: the
summary, the notices, every group of papers with its links, details, abstracts
and AI summaries, and the sections after them.

The page is a file someone opens from a ZIP, a synced folder or an email, so it
carries nothing but authored markup, escaped text and one inline stylesheet.
Every value is escaped; a link is written only for an ``http`` or ``https``
address; there are no scripts, no images and no requests, and the content
security policy says so to the browser. It reads on a phone, in light and dark,
and prints.
"""

from __future__ import annotations

import base64
import hashlib
import html
import re
from typing import Optional

from .report_exporter import (
    AI_SUMMARY_ONLY_NOTE, LITERAL_FIELDS, REPORT_NAME, document_heading, get_meta,
    local_stamp, summary_rows,
)

CSS = """\
:root{color-scheme:light dark;--ink:#1c1f24;--muted:#5a5f68;--accent:#144272;--accent-soft:#3f6797;\
--rule:#d3d8e1;--paper:#fff;--abstract:#f3f5f9;--ai:#f8f2e7;--notice:#fbf4e2;--notice-rule:#b98a1e}
@media (prefers-color-scheme:dark){:root{--ink:#e3e6eb;--muted:#a3a9b3;--accent:#9cc0ee;\
--accent-soft:#86a7d3;--rule:#3a404a;--paper:#14171c;--abstract:#1c2129;--ai:#262119;--notice:#29241a;\
--notice-rule:#c99a35}}
*{box-sizing:border-box}
html{background:var(--paper);color:var(--ink);font:100%/1.6 Charter,"Iowan Old Style","Palatino Linotype",\
Georgia,serif;font-variant-ligatures:none;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0}
main{max-width:48rem;margin:0 auto;padding:clamp(1rem,4vw,3rem)}
h1,h2,h3,.kicker,.summary dt,.byline,.fields dt,nav,.generated,.label{font-family:system-ui,-apple-system,\
"Segoe UI",Roboto,sans-serif}
h1,h2,h3{line-height:1.25;color:var(--accent)}
.kicker{margin:0 0 .25rem;font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
h1{margin:0;font-size:clamp(1.6rem,5vw,2.2rem)}
.subtitle{margin:.35rem 0 0;font-size:1.15rem;color:var(--accent-soft)}
.note,.generated{margin:.4rem 0 0;font-size:.9rem;color:var(--muted)}
.note{font-style:italic}
header{border-top:3px solid var(--accent);padding-top:1rem;margin-bottom:1.25rem}
.summary{display:grid;grid-template-columns:minmax(8rem,max-content) minmax(0,1fr);gap:.35rem 1.25rem;\
margin:0;padding:1rem 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.summary dt{font-weight:600;font-size:.9rem;color:var(--accent-soft)}
.summary dd{margin:0;min-width:0}
.notice{margin:1rem 0;padding:.7rem 1rem;background:var(--notice);border-left:3px solid var(--notice-rule)}
.notice p{margin:0}
nav{margin:1.5rem 0;font-size:.9rem}
nav h2{font-size:1rem;margin:0 0 .4rem;border:0;padding:0}
nav ol{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:.25rem 1.1rem}
h2{margin:2.4rem 0 .8rem;font-size:1.35rem;padding-bottom:.3rem;border-bottom:1px solid var(--rule)}
.paper{margin:1.4rem 0 1.8rem}
h3{margin:0;font-size:1.1rem}
h3 a{color:inherit;text-decoration-thickness:.06em;text-underline-offset:.18em}
.byline{margin:.3rem 0 .4rem;font-size:.88rem;color:var(--muted)}
.byline .source{font-style:italic}
.fields{display:grid;grid-template-columns:minmax(6rem,max-content) minmax(0,1fr);gap:.15rem 1rem;\
margin:.3rem 0 .5rem;font-size:.9rem}
.fields dt{font-weight:600;color:var(--accent-soft)}
.fields dd{margin:0;min-width:0}
.abstract,.ai{margin:.5rem 0;padding:.7rem 1rem;background:var(--abstract);border-radius:4px;font-size:.97rem}
.ai{background:var(--ai)}
.abstract p,.ai p{margin:.3rem 0}
.label{font-weight:700;color:var(--accent);font-size:.88rem;margin-right:.3rem}
.none{font-style:italic;color:var(--muted);font-size:.92rem;margin:.3rem 0}
a{color:var(--accent)}
a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
code{font-size:.9em}
p,dd,dt,li,h1,h2,h3,a{overflow-wrap:anywhere}
.top{margin-top:3rem;font-size:.9rem}
@media (max-width:40rem){.summary,.fields{display:block}.summary dd,.fields dd{margin:0 0 .5rem}}
@media print{:root{--ink:#000;--muted:#444;--accent:#144272;--accent-soft:#3f6797;--rule:#bbb;--paper:#fff;\
--abstract:#f3f5f9;--ai:#f8f2e7;--notice:#fbf4e2}html{font-size:10.5pt}main{max-width:none;padding:0}\
nav,.top{display:none}h2,h3,.byline{break-after:avoid}h3{break-inside:avoid}\
.abstract,.ai,.notice{-webkit-print-color-adjust:exact;print-color-adjust:exact}a{text-decoration:none}}
"""
CSS_HASH = base64.b64encode(hashlib.sha256(CSS.encode("utf-8")).digest()).decode("ascii")
CSP = ("default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; "
       "media-src 'none'; object-src 'none'; frame-src 'none'; font-src 'none'; "
       "base-uri 'none'; form-action 'none'; style-src 'sha256-" + CSS_HASH + "'")


def _e(value: object) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def _web_url(url: str) -> Optional[str]:
    url = (url or "").strip()
    return url if re.match(r"^https?://[^\s<>\"']+$", url, re.I) else None


def _inline(text: str) -> str:
    """resmon's own sentences: escaped, then their Markdown (bold, italic, code, links)."""
    placeholders: list[str] = []

    def stash(markup: str) -> str:
        placeholders.append(markup)
        return f"\x00{len(placeholders) - 1}\x00"

    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text or "")
    text = re.sub(r"`([^`]+)`", lambda m: stash("<code>" + _e(m.group(1)) + "</code>"), text)

    def link(m: re.Match) -> str:
        url = _web_url(m.group(2))
        label = _inline(m.group(1))
        return stash(f'<a href="{_e(url)}">{label}</a>' if url else label)

    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, text)
    text = re.sub(r"\*\*([^*]+)\*\*", lambda m: stash("<strong>" + _inline(m.group(1)) + "</strong>"), text)
    text = re.sub(r"(?<![*\w])\*([^*\s][^*]*)\*(?![*\w])",
                  lambda m: stash("<em>" + _inline(m.group(1)) + "</em>"), text)
    text = _e(text)
    return re.sub(r"\x00(\d+)\x00", lambda m: placeholders[int(m.group(1))], text)


def _paragraphs(text: str, render) -> list[str]:
    return [render(p.strip()) for p in re.split(r"\n\s*\n", text or "") if p.strip()]


def _anchor(index: int) -> str:
    return f"section-{index}"


def render(parsed: dict, *, context: Optional[dict] = None, summary_only: bool = False) -> str:
    """The parsed report as a complete HTML document."""
    heading = document_heading(parsed, context)
    out: list[str] = []
    title = f"{heading['title']} — {REPORT_NAME}"
    out.append('<!doctype html><html lang="en"><head><meta charset="utf-8">'
               f'<meta http-equiv="Content-Security-Policy" content="{_e(CSP)}">'
               '<meta name="viewport" content="width=device-width, initial-scale=1">'
               '<meta name="referrer" content="no-referrer">'
               f"<title>{_e(title)}</title><style>{CSS}</style></head><body>"
               '<main id="top">')

    out.append("<header>")
    out.append(f'<p class="kicker">{_e(heading["kicker"])}</p><h1>{_e(heading["title"])}</h1>')
    if heading["subtitle"]:
        out.append(f'<p class="subtitle">{_e(heading["subtitle"])}</p>')
    note = AI_SUMMARY_ONLY_NOTE if summary_only else parsed["header"].get("subtitle", "")
    if note:
        out.append(f'<p class="note">{_inline(note)}</p>')
    generated = get_meta(parsed, "Generated")
    if generated:
        out.append(f'<p class="generated">Generated {_e(local_stamp(generated))}</p>')
    out.append("</header>")

    out.append('<dl class="summary">')
    for label, value in summary_rows(parsed, heading):
        out.append(f"<dt>{_e(label)}</dt><dd>{_inline(value)}</dd>")
    out.append("</dl>")

    for notice in parsed["notices"]:
        out.append(f'<div class="notice" role="note"><p>{_inline(notice)}</p></div>')

    body = parsed["body"]
    if len(body) > 1:
        out.append('<nav aria-labelledby="contents"><h2 id="contents">Contents</h2><ol>')
        for index, entry in enumerate(body, 1):
            count = len(entry.get("papers", []))
            suffix = f" ({count})" if entry["kind"] == "group" else ""
            out.append(f'<li><a href="#{_anchor(index)}">{_e(entry["heading"])}</a>{_e(suffix)}</li>')
        out.append("</ol></nav>")

    if not parsed["groups"]:
        out.append("<section><h2>No Papers</h2><p>This report lists no papers.</p></section>")
    for index, entry in enumerate(body, 1):
        out.append(f'<section id="{_anchor(index)}" aria-labelledby="{_anchor(index)}-h">'
                   f'<h2 id="{_anchor(index)}-h">{_e(entry["heading"])}</h2>')
        out.extend(_blocks(entry.get("blocks", [])))
        for paper in entry.get("papers", []):
            out.extend(_paper(paper, summary_only=summary_only, note_missing=entry.get("is_date", True)))
        out.append("</section>")

    out.append('<p class="top"><a href="#top">Back to the top</a></p></main></body></html>\n')
    return "".join(out)


def _blocks(blocks: list) -> list[str]:
    out: list[str] = []
    for kind, value in blocks:
        if kind == "p":
            out.append(f"<p>{_inline(value)}</p>")
        elif kind == "quote":
            out.append(f'<div class="notice" role="note"><p>{_inline(value)}</p></div>')
        elif kind == "ul":
            out.append("<ul>" + "".join(f"<li>{_inline(item)}</li>" for item in value) + "</ul>")
    return out


def _paper(paper: dict, *, summary_only: bool, note_missing: bool = True) -> list[str]:
    """One paper. ``note_missing`` is false for a finding in a watch's report,
    which is not a paper's record and says nothing about an abstract."""
    out = ['<article class="paper">']
    url = _web_url(paper["url"])
    title = _e(paper["title"])
    out.append(f'<h3><a href="{_e(url)}">{title}</a></h3>' if url else f"<h3>{title}</h3>")
    fields = {label.lower(): value for label, value in paper["fields"]}
    byline: list[str] = []
    if fields.get("authors"):
        byline.append(_e(fields["authors"]))
    if fields.get("source"):
        byline.append(f'<span class="source">{_e(fields["source"])}</span>')
    if byline:
        out.append('<p class="byline">' + " · ".join(byline) + "</p>")
    rest = [(label, value) for label, value in paper["fields"] if label.lower() not in ("authors", "source")]
    if rest:
        out.append('<dl class="fields">')
        for label, value in rest:
            shown = _e(value) if label.lower() in LITERAL_FIELDS else _inline(value)
            out.append(f"<dt>{_e(label)}</dt><dd>{shown}</dd>")
        out.append("</dl>")
    if not summary_only:
        paragraphs = _paragraphs(paper["abstract"], _e)
        if paragraphs:
            paragraphs[0] = '<span class="label">Abstract.</span>' + paragraphs[0]
            out.append('<div class="abstract">' + "".join(f"<p>{p}</p>" for p in paragraphs) + "</div>")
        elif note_missing:
            out.append('<p class="none">No abstract available.</p>')
    summary = _paragraphs(paper.get("ai_summary", ""), _inline)
    if summary:
        summary[0] = '<span class="label">AI Summary.</span>' + summary[0]
        out.append('<div class="ai">' + "".join(f"<p>{p}</p>" for p in summary) + "</div>")
    out.append("</article>")
    return out
