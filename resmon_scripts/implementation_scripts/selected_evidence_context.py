"""Explicit selected-page disclosure, canonical prompts and revalidation.

No project scan or transcript is a source. Private routing stays outside payloads.
"""
from __future__ import annotations

from pathlib import Path
import sqlite3
import threading
import time

from . import assistant_choices as choices, evidence as ev, evidence_reader as reader
from . import selected_evidence as se

MAX_ASSEMBLY_SECONDS = 120
RULES = Path(__file__).parent / 'assets' / 'selected_evidence_rules.md'
RESPONSE_CONTRACT = {
    'version': 1, 'request_sha256': 'copy the outer request_sha256',
    'mode': 'copy the payload mode', 'status': 'answer|insufficient_evidence',
    'sections': [{'kind': 'summary|details|limitations|questions', 'items': [{
        'kind': 'source_statement|interpretation|note_summary|question', 'text': 'literal text',
        'citations': [{'source_id': 'S01', 'start_codepoint': 'integer global page offset',
                       'end_codepoint': 'integer exclusive global page offset', 'quote': 'exact selected quote'}],
        'note_ids': ['selected note UUIDs only for note_summary']}]}],
    'limitations': ['literal limitations'],
}


def system_rules() -> str:
    try:
        with RULES.open('rb') as stream:
            raw = stream.read(16385)
        if len(raw) > 16384 or not raw:
            raise ValueError
        value = raw.decode('utf-8')
        se.text(value, 16384, 1)
        return value
    except (OSError, ValueError, UnicodeError):
        se.fail('The selected-evidence system rules are unavailable.', 'rules_unavailable', 503)


def validate_input(value: dict) -> dict:
    se.keys(value, {'expected_vault_id','expected_revision','expected_runtime_id','selections','notes','mode','instruction','choices'})
    ev.identity(value['expected_vault_id']); ev.identity(value['expected_runtime_id']); ev.integer(value['expected_revision'])
    if value['mode'] not in ('question', 'briefing'):
        se.fail('Choose question or briefing.')
    instruction = se.text(value['instruction'], 4000, 1)
    if not instruction.strip() or len(instruction.encode()) > 16384:
        se.fail('The instruction must contain text within 4,000 codepoints and 16 KiB.')
    try:
        choices.validate(value['choices'])
    except (ValueError, TypeError):
        se.fail('Supply a complete supported runtime/model/effort choice.')
    # The HTTP boundary is smaller; this also bounds direct domain callers.
    if len(se.canonical(value).encode()) > 262144:
        se.fail('The selection exceeds 256 KiB.', 'selection_limit', 413)
    unique = {}
    for item in se.bounded_list(value['selections'], 256, 1):
        se.keys(item, {'file_id','version_id','sha256','page_number','range'})
        ev.identity(item['file_id']); ev.identity(item['version_id']); se.digest(item['sha256'])
        ev.integer(item['page_number'], 1, 200)
        if item['range'] is not None:
            r = se.keys(item['range'], {'start_codepoint','end_codepoint','quote','page_text_sha256','extraction_contract'})
            start = ev.integer(r['start_codepoint'], 0); end = ev.integer(r['end_codepoint'])
            se.text(r['quote'], 24000, 1); se.digest(r['page_text_sha256']); se.text(r['extraction_contract'], 100, 1)
            if end <= start or len(r['quote']) != end-start:
                se.fail('A passage needs exact nonempty codepoint offsets and quote.')
        unique[se.canonical(item)] = item
    segments = list(unique.values())
    if len(segments) > 24 or len({(x['file_id'],x['version_id']) for x in segments}) > 5:
        se.fail('Choose at most 5 files and 24 distinct segments.', 'selection_limit', 413)
    if len({(x['file_id'],x['version_id'],x['page_number']) for x in segments}) > 12:
        se.fail('Choose at most 12 distinct pages.', 'selection_limit', 413)
    notes = se.bounded_list(value['notes'], 8)
    ids = set()
    for item in notes:
        se.keys(item, {'note_id','expected_note_revision'})
        ev.identity(item['note_id']); ev.integer(item['expected_note_revision'])
        if item['note_id'] in ids:
            se.fail('Select each note only once.')
        ids.add(item['note_id'])
    return {**value, 'selections': segments, 'notes': sorted(notes, key=lambda n: n['note_id'])}


def sql_facts(conn: sqlite3.Connection, project_id: str, selection: dict) -> dict:
    vault_id = selection['expected_vault_id']
    project = ev.project(conn, vault_id, project_id)
    if project['revision'] != selection['expected_revision']:
        se.fail('The project changed. Prepare a new preview.', 'stale_revision', 409)
    pairs = sorted({(x['file_id'], x['version_id']) for x in selection['selections']})
    files = []
    for file_id, version_id in pairs:
        ev.member(conn, vault_id, project_id, file_id, version_id)
        files.append(ev.file_record(conn, vault_id, file_id, version_id))
    notes = []
    for selected in selection['notes']:
        found = conn.execute('SELECT * FROM evidence_notes WHERE project_id=? AND note_id=?',
                             (project_id, selected['note_id'])).fetchone()
        if found is None:
            se.fail('A selected note is missing.', 'unknown_note', 404)
        note = dict(found); ev.validate_note(note)
        if (note['revision'] != selected['expected_note_revision'] or
                (note['file_id'], note['version_id']) not in pairs):
            se.fail('A selected note changed or does not belong to a selected version.', 'stale_note', 409)
        se.text(note['body'], 2000)
        fields = ('note_id','revision','kind','body','created_at_utc','updated_at_utc','file_id','version_id')
        notes.append({**{k: note[k] for k in fields}, 'provenance': 'owner_note',
                      'anchor': {k: note[k] for k in ev.ANCHOR_FIELDS} if note['kind']=='passage' else None})
    if sum(len(n['body'].encode()) for n in notes) > 8192:
        se.fail('Selected note bodies exceed 8 KiB.', 'note_limit', 413)
    return {'project_revision': project['revision'], 'files': files, 'notes': notes}


def assemble(conn: sqlite3.Connection, project_id: str, value: dict, settings: dict,
             runtime_id: str, *, cancel: threading.Event | None = None,
             frozen_binding: dict | None = None) -> tuple[dict, dict, dict]:
    selection = validate_input(value)
    if selection['expected_runtime_id'] != runtime_id:
        se.fail('The serving runtime changed. Prepare a new preview.', 'wrong_runtime', 409)
    started = time.monotonic()
    class AssemblyCancellation:
        def is_set(self) -> bool:
            return (cancel is not None and cancel.is_set()) or time.monotonic()-started >= MAX_ASSEMBLY_SECONDS
    assembly_cancel = AssemblyCancellation()
    def check() -> None:
        if cancel is not None and cancel.is_set():
            se.fail('Preview assembly was cancelled.', 'cancelled', 409)
        if time.monotonic()-started >= MAX_ASSEMBLY_SECONDS:
            se.fail('Preview assembly exceeded 120 seconds.', 'preview_timeout', 413)
    binding = choices.resolve(settings, selection['choices'])
    if frozen_binding is not None:
        if any(binding[k] != frozen_binding[k] for k in binding if k != 'created_at_utc'):
            se.fail('The configured route or choices changed. Prepare a new preview.', 'changed_route', 409)
        binding = dict(frozen_binding)
    from .assistant_runtime import get_bound_runtime
    runtime = get_bound_runtime(binding, settings)
    if not runtime.status().available:
        se.fail('The selected connection is unavailable. Review its existing settings.', 'runtime_unavailable', 503)
    system = system_rules()
    facts = sql_facts(conn, project_id, selection)
    file_map = {(x['file_id'], x['version_id']): x for x in facts['files']}
    pages: dict[tuple, dict] = {}
    def page(file_id: str, version_id: str, number: int) -> dict:
        check(); key = (file_id, version_id, number)
        if key not in pages:
            if len(pages) >= 12:
                se.fail('Selected pages and passage-note anchor checks exceed 12 pages.', 'selection_limit', 413)
            try:
                projection = reader.read_text(conn, selection['expected_vault_id'], project_id, file_id, version_id, number, cancel=assembly_cancel)
            except OSError:
                se.fail(f'Selected file {file_id}, page {number} is unavailable; explicitly remove or reselect it.', 'unavailable_selection', 409)
            check()
            if projection['status'] != 'extracted' or not projection['text']:
                se.fail(f'Selected file {file_id}, page {number}: {projection["status"]}; explicitly remove or reselect it.', 'unavailable_selection', 409)
            pages[key] = projection
        return pages[key]
    sources = []
    for selected in selection['selections']:
        f = file_map[(selected['file_id'], selected['version_id'])]
        if selected['sha256'] != f['sha256']:
            se.fail('The selected retained digest changed.', 'changed_content', 409)
        p = page(f['file_id'], f['version_id'], selected['page_number'])
        r = selected['range']
        if r is None:
            start, end, quote = 0, len(p['text']), p['text']
        else:
            start, end, quote = r['start_codepoint'], r['end_codepoint'], r['quote']
            if (r['page_text_sha256'] != p['page_text_sha256'] or r['extraction_contract'] != p['extraction_contract']
                    or not 0 <= start < end <= len(p['text']) or p['text'][start:end] != quote):
                se.fail('The selected page hash, extraction contract, offsets or quote changed.', 'quote_mismatch', 409)
        sources.append({**{k:f[k] for k in ('file_id','version_id','vault_id','sha256','byte_size','media_type','original_name')},
                        'project_id': project_id, 'page_number': p['page_number'], 'page_count': p['page_count'],
                        'extraction_contract': p['extraction_contract'], 'page_text_sha256': p['page_text_sha256'],
                        'start_codepoint': start, 'end_codepoint': end, 'text': quote})
    # Whole-page and an equivalent explicit range collapse by their actual basis.
    sources = list({se.canonical(s): s for s in sources}.values())
    sources.sort(key=lambda s: (s['file_id'],s['version_id'],s['page_number'],s['start_codepoint'],s['end_codepoint']))
    source_bytes = sum(len(s['text'].encode()) for s in sources)
    source_points = sum(len(s['text']) for s in sources)
    if source_bytes > 49152 or source_points > 24000:
        se.fail('Selected text exceeds 48 KiB or 24,000 codepoints. Select a smaller explicit passage.', 'source_limit', 413)
    sources = [{**s, 'source_id':f'S{i:02d}', 'source_sha256':se.sha(se.canonical(s))} for i,s in enumerate(sources,1)]
    for note in facts['notes']:
        a = note['anchor']
        if a is not None:
            p = page(note['file_id'], note['version_id'], a['page_number'])
            if (a['page_text_sha256'] != p['page_text_sha256'] or a['extraction_contract'] != p['extraction_contract']
                    or a['end_codepoint'] > len(p['text']) or p['text'][a['start_codepoint']:a['end_codepoint']] != a['quote']):
                se.fail('A selected passage note has an unresolved anchor.', 'quote_mismatch', 409)
    check()
    if sql_facts(conn, project_id, selection) != facts:
        se.fail('Selected SQL facts changed during extraction.', 'stale_revision', 409)
    coverage_files = []
    for f in facts['files']:
        selected_pages = sorted({s['page_number'] for s in sources if s['file_id']==f['file_id']})
        checked_pages = sorted(k[2] for k in pages if k[:2]==(f['file_id'],f['version_id']))
        known = next(p['page_count'] for k,p in pages.items() if k[:2]==(f['file_id'],f['version_id']))
        coverage_files.append({'file_id':f['file_id'],'version_id':f['version_id'],'known_page_count':known,
                               'selected_pages':selected_pages,'anchor_checked_pages':checked_pages,
                               'unexamined_page_count':known-len(checked_pages) if known is not None else None})
    payload = {'version':1,'profile':se.PROFILE,'vault_id':selection['expected_vault_id'],'project_id':project_id,
               'project_revision':facts['project_revision'],'mode':selection['mode'],'instruction':selection['instruction'],
               'requested':choices.request_projection(binding),'sources':sources,'notes':facts['notes'],
               'system_version':se.SYSTEM_VERSION,'system_sha256':se.sha(system),'response_contract':RESPONSE_CONTRACT,
               'coverage':{'files':coverage_files,'file_count':len(facts['files']),'page_count':len(pages),'segment_count':len(sources),
                           'source_bytes':source_bytes,'source_codepoints':source_points,'note_count':len(facts['notes']),
                           'note_bytes':sum(len(n['body'].encode()) for n in facts['notes'])},
               'disclosure':{'custom_endpoint':binding['provider']=='custom',
                             'retained_digest_reads_selected_file_bytes':True,'pdf_structure_examined_for_selected_pages':True,
                             'source_strings_may_contain_private_material':'Inspect all literal filenames, text and notes before Send; no automatic secret-removal promise.',
                             'limitations':se.LIMITS}}
    request_digest = se.sha(se.canonical(payload))
    prompt = se.canonical({'request_sha256':request_digest,'payload':payload})
    if len(prompt.encode()) > 98304:
        se.fail('The complete app user payload exceeds 96 KiB.', 'payload_limit', 413)
    snapshot = {'payload':payload,'request_sha256':request_digest,'user_prompt':prompt,'user_sha256':se.sha(prompt),
                'system_text':system,'system_sha256':se.sha(system)}
    if len(se.canonical(snapshot).encode()) > 262144:
        se.fail('The complete immutable request snapshot exceeds its storage budget.', 'snapshot_limit', 413)
    return snapshot, binding, selection


def recheck_sql(conn: sqlite3.Connection, project_id: str, selection: dict, snapshot: dict) -> None:
    facts = sql_facts(conn, project_id, selection)
    if facts['notes'] != snapshot['payload']['notes']:
        se.fail('Selected note snapshots changed before admission.', 'changed_preview', 409)
    for source in snapshot['payload']['sources']:
        file = next(f for f in facts['files'] if (f['file_id'],f['version_id'])==(source['file_id'],source['version_id']))
        if any(source[k] != file[k] for k in ('file_id','version_id','vault_id','sha256','byte_size','media_type','original_name')):
            se.fail('Selected file facts changed before admission.', 'changed_preview', 409)
