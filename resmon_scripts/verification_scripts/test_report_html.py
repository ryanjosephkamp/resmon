# resmon_scripts/verification_scripts/test_report_html.py
"""The report as one static HTML page, ``report/report.html`` in a run's bundle.

What is held:

* **The same report as the PDF.** Rendered from the same parse, it holds the
  summary, the notices, every group with every paper's link, details, abstract
  and AI summary, and the sections after the papers.
* **Static and escaped.** Every value is escaped, so a title holding markup
  shows the markup as text; a link is written only for ``http`` and ``https``;
  there is no script, no image, no request, and a content security policy that
  says so and admits only the page's own stylesheet, by its hash.
* **Readable anywhere**: a viewport for phones, a dark scheme, and print rules.
"""

import base64
import hashlib
import html
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import report_html
from implementation_scripts.report_exporter import _build_digest_tex, parse_report
from implementation_scripts.report_generator import generate_report

from verification_scripts.test_report_pdf import _docs, _metadata


def _page(**context) -> tuple[dict, str]:
    parsed = parse_report(generate_report(_docs(), _metadata()))
    return parsed, report_html.render(parsed, context=context or None)


def test_the_page_holds_what_the_pdf_holds():
    parsed, page = _page(kind="deep_sweep")
    tex = _build_digest_tex(parsed, context={"kind": "deep_sweep"})
    for entry in parsed["body"]:
        assert f">{entry['heading']}</h2>" in page
        for paper in entry.get("papers", []):
            assert report_html._e(paper["title"]) in page
            assert f'href="{paper["url"]}"' in page
            first_words = paper["abstract"].split(" ")[0]
            assert first_words in page and first_words in tex
    assert "arXiv answered with HTTP 503" in page
    assert "No API key was found" in page
    assert '<p class="kicker">resmon report</p><h1>Deep Sweep</h1>' in page
    assert '<p class="subtitle">gaussian splatting, splats</p>' in page
    assert "<dt>Publication Dates</dt><dd>4</dd>" in page
    assert "Categories" in page and "epidemiology" in page
    # Cleaned as stored text is read, and every hard character kept.
    assert "O_LI" not in page and "Methods: In 309 patients" in page
    for ch in "’“”–—›αβ中文":
        assert ch in page


def test_an_ai_summary_is_shown_with_its_paragraphs():
    docs = _docs(1, 1)
    docs[0]["ai_summary"] = "First paragraph with **bold**.\n\nSecond paragraph."
    page = report_html.render(parse_report(generate_report(docs, _metadata(ai_model="test/model"))))
    assert '<div class="ai"><p><span class="label">AI Summary.</span>First paragraph with <strong>bold</strong>.</p>' \
           "<p>Second paragraph.</p></div>" in page
    assert "<dt>AI Summarizer</dt><dd>test/model</dd>" in page


def test_every_value_is_escaped_and_only_web_links_are_links():
    docs = _docs(1, 1)
    docs[0]["title"] = 'A <script>alert(1)</script> title & "quotes" <img src=x onerror=alert(2)>'
    docs[0]["abstract"] = "An abstract with <b onclick=x>tags</b> and a* star and $x<y$."
    docs[0]["url"] = "javascript:alert(3)"
    docs[0]["authors"] = ['<a href="https://evil.example">Mallory</a>']
    page = report_html.render(parse_report(generate_report(docs, _metadata())))
    assert "<script" not in page.lower()
    assert "onerror" not in page and "onclick" not in page
    assert "javascript:" not in page
    assert "a* star and $x&lt;y$" in page
    assert 'href="https://evil.example"' not in page
    assert re.findall(r'href="([^"]+)"', page) == [m for m in re.findall(r'href="([^"]+)"', page)
                                                   if m.startswith(("#", "http://", "https://"))]


def test_the_page_is_static_with_a_policy_that_admits_only_its_own_stylesheet():
    _, page = _page()
    digest = base64.b64encode(hashlib.sha256(report_html.CSS.encode("utf-8")).digest()).decode()
    policy = html.unescape(re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', page).group(1))
    assert f"style-src 'sha256-{digest}'" in policy
    for directive in ("default-src 'none'", "script-src 'none'", "connect-src 'none'", "img-src 'none'",
                      "base-uri 'none'", "form-action 'none'"):
        assert directive in policy
    assert page.count("<style>") == 1 and f"<style>{report_html.CSS}</style>" in page
    assert "<script" not in page and " style=" not in page and "<img" not in page and "<link" not in page
    assert '<meta name="viewport" content="width=device-width, initial-scale=1">' in page
    assert "@media print" in report_html.CSS and "prefers-color-scheme:dark" in report_html.CSS


def test_a_report_with_no_papers_says_so():
    page = report_html.render(parse_report(generate_report([], _metadata(zero_notes=[], duplicate_links=[]))))
    assert "<h2>No Papers</h2><p>This report lists no papers.</p>" in page
