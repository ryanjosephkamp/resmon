"""Static portable view of one validated public saved-answer snapshot.

Only authored markup, CSS and index-derived fragment targets are emitted. Text
identity is preserved without interpreting Markdown, URLs or model markup.
"""
from __future__ import annotations

import base64
import hashlib
import html
import threading
from typing import Any

from . import evidence_export, selected_evidence as se

MAX_BYTES = 4194304
MAX_CSS_BYTES = 65536
CONTRACT = 'selected-answer-html/v1'
CSS = """*{box-sizing:border-box}html{color:#171717;background:#fff;font:100%/1.6 system-ui,sans-serif}body{margin:0}main{max-width:76rem;margin:auto;padding:clamp(1rem,4vw,3rem)}h1,h2,h3,h4{line-height:1.25}h1{font-size:2rem}h2{margin-top:2.5rem;border-bottom:1px solid #aaa;padding-bottom:.4rem}h3{margin-top:1.8rem}a{color:#174c83;text-underline-offset:.2em}a:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid #174c83;outline-offset:4px}:target{outline:3px solid #986000;outline-offset:4px}p,dd,dt,summary,a,h1,h2,h3,h4{overflow-wrap:anywhere}dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,3fr);gap:.3rem 1rem}dt{font-weight:600}dd{margin:0;min-width:0}.literal{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;margin:.6rem 0;unicode-bidi:plaintext}.limits,.quote{border-left:3px solid #777;padding:.25rem 1rem;background:#f5f5f5}.item{margin:1.5rem 0}.source{border-top:1px solid #aaa;margin-top:2rem}details{margin:1rem 0}summary{cursor:pointer;font-weight:600}nav{display:flex;flex-wrap:wrap;gap:.5rem 1.2rem}.meta{font-size:.9rem}li{overflow-wrap:anywhere}section,article{min-width:0}@media(max-width:40rem){dl{display:block}dd{margin-bottom:.7rem}h1{font-size:1.6rem}}@media print{html{font-size:10pt}main{max-width:none;padding:0}a{color:inherit}nav{display:none}h2,h3,h4,summary{break-after:avoid}.quote,dl{break-inside:avoid}.literal{white-space:pre-wrap}details{display:block}summary{list-style:none}.limits,.quote{background:#fff}:target{outline:none}}
"""
CSS_HASH = base64.b64encode(hashlib.sha256(CSS.encode('utf-8')).digest()).decode('ascii')
CSP = ("default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; "
       "media-src 'none'; object-src 'none'; frame-src 'none'; font-src 'none'; "
       "base-uri 'none'; form-action 'none'; style-src 'sha256-" + CSS_HASH + "'")


def _text(value: Any) -> str:
    if value is None:
        value = 'Unknown (not recorded)'
    elif not isinstance(value, str):
        value = se.canonical(value)
    # A literal CR must survive HTML input newline normalization as a codepoint.
    return html.escape(value, quote=True).replace('\r', '&#13;')


class _Document:
    def __init__(self, cancel: threading.Event | None) -> None:
        self.parts: list[bytes] = []
        self.size = 0
        self.cancel = cancel

    def add(self, authored: str) -> None:
        evidence_export.cancelled(self.cancel)
        raw = authored.encode('utf-8')
        if self.size + len(raw) > MAX_BYTES:
            se.fail('The escaped HTML exceeds the 4 MiB portable limit.', 'export_limit', 413)
        self.parts.append(raw)
        self.size += len(raw)

    def literal(self, value: Any) -> None:
        self.add('<div class="literal">' + _text(value) + '</div>')

    def fields(self, fields: list[tuple[str, Any]]) -> None:
        self.add('<dl class="meta">')
        for label, value in fields:
            self.add('<dt>' + _text(label) + '</dt><dd class="literal">' + _text(value) + '</dd>')
        self.add('</dl>')


def render(answer: dict, *, cancel: threading.Event | None = None) -> bytes:
    """Render the public value from se.detail; never query a database or file."""
    if len(CSS.encode('utf-8')) > MAX_CSS_BYTES:
        se.fail('The authored stylesheet exceeds its portable limit.', 'export_limit', 413)
    d = _Document(cancel)
    payload = answer['request']['payload']
    sources = payload['sources']
    source_indexes = {source['source_id']: i for i, source in enumerate(sources, 1)}
    note_indexes = {note['note_id']: i for i, note in enumerate(payload['notes'], 1)}
    citations: dict[int, list[tuple[str, str, dict]]] = {i: [] for i in source_indexes.values()}
    title = 'Manual structured briefing' if answer['mode'] == 'briefing' else 'Selected-evidence question'
    d.add('<!doctype html><html lang="en"><head><meta charset="utf-8">'
          '<meta http-equiv="Content-Security-Policy" content="' + _text(CSP) + '">'
          '<meta name="viewport" content="width=device-width, initial-scale=1">'
          '<title>' + title + '</title><style>' + CSS + '</style></head><body><main id="top">')
    d.add('<h1>' + title + '</h1><p>This is the saved snapshot read for export. '
          'It does not update, resume work or recheck current originals.</p>'
          '<nav aria-label="Document sections"><a href="#answer">Answer</a><a href="#sources">Frozen sources</a>'
          '<a href="#notes">Local notes</a><a href="#coverage">Coverage and limits</a><a href="#settings">Settings and identity</a></nav>')
    d.fields([('State', answer['state']), ('Validation', answer['validation']),
              ('Local transport cleanup', answer['cleanup_state']), ('Created UTC', answer['created_at_utc']),
              ('Started UTC', answer['started_at_utc']), ('Finished UTC', answer['finished_at_utc'])])
    d.add('<aside class="limits" aria-label="Evidence limits">')
    d.literal(answer['limitations'])
    d.add('<p>Citation identity is not semantic support. Local notes are saved owner commentary, '
          'not authenticated provenance or document evidence. Remote completion and billing remain unknown.</p></aside>')
    d.add('<section id="answer" tabindex="-1"><h2>Answer</h2><h3>Saved instruction</h3>')
    d.literal(payload['instruction'])
    if answer['error_code'] is not None or answer['error_message'] is not None:
        d.add('<h3>Saved error</h3>')
        d.fields([('Code', answer['error_code']), ('Message', answer['error_message'])])
    result = answer['result']
    if result is None:
        d.add('<h3>Incomplete / unvalidated output</h3><p>This text has not passed the structured '
              'answer checks. It may be partial; no missing result is inferred.</p>')
        d.literal(answer['partial_text'] or 'No durable text has been recorded.')
    else:
        d.fields([('Structured result status', result['status'])])
        if result['status'] == 'insufficient_evidence':
            d.add('<p class="limits">Insufficient selected evidence was reported.</p>')
        for si, section in enumerate(result['sections'], 1):
            d.add('<section><h3>' + _text(section['kind']) + '</h3>')
            for ii, item in enumerate(section['items'], 1):
                d.add('<article class="item"><h4>' + _text(item['kind']) + ' · support unchecked</h4>')
                d.literal(item['text'])
                for ci, citation in enumerate(item['citations'], 1):
                    index = source_indexes[citation['source_id']]
                    suffix = f'{si}-{ii}-{ci}'
                    reference, target = f'reference-{suffix}', f'source-{index}-citation-{suffix}'
                    citations[index].append((reference, target, citation))
                    d.add(f'<p><a id="{reference}" href="#{target}">Citation {suffix} · '
                          + _text(citation['source_id']) + ' · exact frozen quote</a></p>')
                for note_id in item['note_ids']:
                    d.add(f'<p><a href="#note-{note_indexes[note_id]}">Saved local note '
                          + _text(note_id) + '</a></p>')
                d.add('</article>')
            d.add('</section>')
        d.add('<h3>Reported answer limitations</h3>')
        for limitation in result['limitations']:
            d.literal(limitation)
        if not result['limitations']:
            d.add('<p>No additional limitation text was reported. The evidence limits above still apply.</p>')
    d.add('</section><section id="sources" tabindex="-1"><h2>Frozen selected sources</h2>'
          '<p>Only the persisted selection is included. Ranges are zero-based, half-open Unicode '
          'codepoint offsets in the saved page text; they are not byte or UTF-16 offsets.</p>')
    for index, source in enumerate(sources, 1):
        d.add(f'<section class="source" id="source-{index}" tabindex="-1"><h3>'
              + _text(source['source_id']) + ' · ' + _text(source['original_name']) + '</h3>')
        d.fields([(key, value) for key, value in source.items() if key not in ('text', 'original_name')])
        d.add('<h4>Exact selected excerpt</h4>')
        d.literal(source['text'])
        for reference, target, citation in citations[index]:
            d.add(f'<section class="quote" id="{target}" tabindex="-1"><h4>Exact citation in this source</h4>')
            d.fields([('Source', citation['source_id']), ('Start codepoint (inclusive)', citation['start_codepoint']),
                      ('End codepoint (exclusive)', citation['end_codepoint'])])
            d.literal(citation['quote'])
            d.add(f'<p><a href="#{reference}">Return to this answer citation</a></p></section>')
        d.add('</section>')
    d.add('</section><section id="notes" tabindex="-1"><h2>Saved local notes</h2>'
          '<p>These selected note bodies and anchors are frozen owner commentary. Later edits are not read.</p>')
    if not payload['notes']:
        d.add('<p>No local note bodies were selected.</p>')
    for index, note in enumerate(payload['notes'], 1):
        d.add(f'<section id="note-{index}" tabindex="-1"><h3>Local note {index}</h3>')
        d.fields([(key, value) for key, value in note.items() if key != 'body'])
        d.literal(note['body'])
        d.add('</section>')
    d.add('</section><section id="coverage" tabindex="-1"><h2>Saved coverage and disclosure</h2>'
          '<p>Coverage describes the saved selection. Anchor-checked pages can include selected-note '
          'anchors. Unexamined counts use that saved basis, not a current whole-paper review. '
          'Unknown is not zero; an empty selection list is not a new observation.</p>')
    coverage = payload['coverage']
    d.fields([(key, value) for key, value in coverage.items() if key != 'files'])
    for index, file in enumerate(coverage['files'], 1):
        d.add(f'<h3>Coverage for selected file {index}</h3>')
        d.fields(list(file.items()))
    d.add('<h3>Disclosure saved at selection</h3><p>The retained-digest and PDF-structure fields '
          'below describe selection-time work. Export performs neither operation.</p>')
    d.fields(list(payload['disclosure'].items()))
    d.add('</section><section id="settings" tabindex="-1"><h2>Settings, observations and identity</h2>'
          '<h3>Requested settings</h3><p>These are requested choices, not observations of execution.</p>')
    d.fields(list(payload['requested'].items()))
    d.add('<h3>Literal reported model observations</h3>')
    if not answer['reports']:
        d.add('<p>Model not reported (unknown).</p>')
    for report in answer['reports']:
        d.fields(list(report.items()))
    d.add('<p>Reported effort and billing are unknown. Runtime-reported usage is not a bill or an estimate.</p>'
          '<h3>Reported usage</h3>')
    if answer['usage'] is None:
        d.add('<p>Usage not reported (unknown).</p>')
    else:
        d.fields(list(answer['usage'].items()))
    d.add('<details open><summary>Exact saved identity and output limits</summary>')
    d.fields([('HTML format contract', CONTRACT), ('Saved public contract version', answer['contract_version']),
              *[(key, answer[key]) for key in ('answer_id','vault_id','project_id','project_revision','mode','request_sha256','current_originals')],
              ('System contract', payload['system_version']), ('System SHA256', answer['request']['system_sha256']),
              ('User prompt SHA256', answer['request']['user_sha256'])])
    d.add('<h3>Saved structured output contract</h3>')
    d.literal(payload['response_contract'])
    d.add('<h3>Output validation for this export</h3>'
          '<p>The selected-evidence/v1 validator admits at most 65,536 UTF-8 bytes of model text, '
          '6 sections, 36 items, 72 citations, 1,000 codepoints per quote, 20,000 visible '
          'codepoints and JSON nesting depth 8. These are validation bounds, not observed usage.</p>'
          '<h3>Saved system instructions</h3>')
    d.literal(answer['request']['system_text'])
    d.add('<p>Hash basis: SHA256 of sorted compact UTF-8 JSON with ensure_ascii=false. Source hashes '
          'exclude source_id and source_sha256; the request hash covers the payload. '
          'This document contains selected excerpts, not full originals or embedded PDFs.</p></details></section>'
          '<p><a href="#top">Return to top</a></p></main></body></html>')
    evidence_export.cancelled(cancel)
    return b''.join(d.parts)
