"""Literal selected-answer validation and immutable SQLite records.

Exact citations identify selected text. They never certify semantic support.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from typing import Any

from . import assistant_choices, evidence as ev

PROFILE = 'selected_evidence_v1'
SYSTEM_VERSION = 'selected-evidence/v1'
MAX_TEXT = 65536
TERMINAL = ('succeeded', 'refused', 'failed', 'cancelled', 'interrupted')
STATES = ('admitted', 'running', *TERMINAL)
LIMITS = (
    'Citations match selected text identity only; support, research quality and truth are unchecked. '
    'Unselected pages and files are unexamined. Native/provider system context, authentication, '
    'remote completion, retention and billing are not fully observable. Live model quality is untested. '
    'Saved excerpts are not a freshly checked original or a whole-paper archive.'
)


def fail(message: str, reason: str = 'invalid_output', status: int = 422) -> None:
    ev.refuse(reason, message, status)


def keys(value: Any, expected: set[str]) -> dict:
    if not isinstance(value, dict) or set(value) != expected:
        fail('Use exactly the required fields and types.')
    return value


def bounded_list(value: Any, maximum: int, minimum: int = 0) -> list:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail('The list exceeds its stated bounds.')
    return value


def text(value: Any, maximum: int, minimum: int = 0) -> str:
    return ev.literal(value, minimum, maximum)


def digest(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        fail('An exact lowercase SHA256 is required.')
    return value


def _tree(value: Any, depth: int = 0, max_depth: int = 16) -> None:
    if depth > max_depth:
        fail('The JSON exceeds its nesting bound.')
    if isinstance(value, str):
        text(value, 262144)
    elif isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                fail('JSON object keys must be strings.')
            text(key, 1000)
            _tree(item, depth + 1, max_depth)
    elif isinstance(value, list):
        for item in value:
            _tree(item, depth + 1, max_depth)
    elif value is not None and type(value) not in (int, bool):
        fail('Only finite integer, boolean, null and literal JSON values are supported.')


def canonical(value: Any) -> str:
    _tree(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def sha(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _unique(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            fail('Duplicate JSON keys are not accepted.')
        result[key] = value
    return result


def loads(raw: str, maximum: int = MAX_TEXT, *, max_depth: int = 16) -> Any:
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > maximum:
        fail('JSON exceeds its byte budget.')
    try:
        value = json.loads(raw, object_pairs_hook=_unique,
                           parse_constant=lambda _: fail('Nonfinite JSON is not accepted.'))
        _tree(value, max_depth=max_depth)
    except (ValueError, UnicodeError, RecursionError):
        fail('One bounded valid JSON value is required.')
    return value


def validate_result(raw: str, request: dict) -> dict:
    result = loads(raw, max_depth=8)
    keys(result, {'version', 'request_sha256', 'mode', 'status', 'sections', 'limitations'})
    if (type(result['version']) is not int or result['version'] != 1
            or result['request_sha256'] != request['request_sha256']
            or result['mode'] != request['payload']['mode']
            or result['status'] not in ('answer', 'insufficient_evidence')):
        fail('The response identity, mode or status does not match this request.')
    sources = {s['source_id']: s for s in request['payload']['sources']}
    notes = {n['note_id'] for n in request['payload']['notes']}
    item_count = citation_count = visible = 0
    for section in bounded_list(result['sections'], 6, 1):
        keys(section, {'kind', 'items'})
        if section['kind'] not in ('summary', 'details', 'limitations', 'questions'):
            fail('Unknown section kind.')
        for item in bounded_list(section['items'], 36):
            item_count += 1
            keys(item, {'kind', 'text', 'citations', 'note_ids'})
            kind = item['kind']
            if kind not in ('source_statement', 'interpretation', 'note_summary', 'question'):
                fail('Unknown item kind.')
            visible += len(text(item['text'], 20000, 1))
            citations = bounded_list(item['citations'], 72)
            selected_notes = bounded_list(item['note_ids'], 8)
            if len(set(ev.identity(x) for x in selected_notes)) != len(selected_notes):
                fail('Duplicate note references are not accepted.')
            if not set(selected_notes) <= notes:
                fail('A note reference does not belong to this selected request.')
            if kind in ('source_statement', 'interpretation') and not citations:
                fail('Each source statement and interpretation needs an exact citation.')
            if kind == 'note_summary' and (not selected_notes or citations):
                fail('A note summary needs selected note IDs and cannot masquerade as document evidence.')
            if kind != 'note_summary' and selected_notes:
                fail('Note IDs belong only to explicitly note-based summaries.')
            for citation in citations:
                citation_count += 1
                keys(citation, {'source_id', 'start_codepoint', 'end_codepoint', 'quote'})
                source_id = text(citation['source_id'], 3, 3)
                if source_id not in sources:
                    fail('The citation is not a source in this request.')
                source = sources[source_id]
                start = ev.integer(citation['start_codepoint'], 0)
                end = ev.integer(citation['end_codepoint'])
                quote = text(citation['quote'], 1000, 1)
                if (not source['start_codepoint'] <= start < end <= source['end_codepoint']
                        or source['text'][start-source['start_codepoint']:end-source['start_codepoint']] != quote
                        or end-start != len(quote)):
                    fail('Citation offsets and quote must match the exact selected text.')
                visible += len(quote)
    for limitation in bounded_list(result['limitations'], 36):
        visible += len(text(limitation, 20000, 1))
    if item_count > 36 or citation_count > 72 or visible > 20000:
        fail('The structured response exceeds its item, citation or visible-text budget.')
    return result


def validate_report(observation: dict) -> None:
    keys(observation, {'model', 'source', 'observed_at_utc'})
    text(observation['model'], 1000, 1)
    ev.timestamp(observation['observed_at_utc'])
    if assistant_choices.report(observation['model'], observation['source']) is None:
        fail('Invalid model observation.')


def validate_payload(payload: dict) -> None:
    keys(payload, {'version','profile','vault_id','project_id','project_revision','mode','instruction',
                   'requested','sources','notes','system_version','system_sha256','response_contract','coverage','disclosure'})
    if type(payload['version']) is not int or payload['version'] != 1 or payload['profile'] != PROFILE or payload['mode'] not in ('question','briefing'):
        fail('Unknown selected request contract.')
    ev.identity(payload['vault_id']); ev.identity(payload['project_id']); ev.integer(payload['project_revision'])
    if not text(payload['instruction'],4000,1).strip():
        fail('Empty instruction.')
    keys(payload['requested'], set(assistant_choices.REQUEST_FIELDS))
    assistant_choices.request_projection(payload['requested'])
    sources = bounded_list(payload['sources'],24,1); pairs = set(); pages = set(); ordering=[]
    for source in sources:
        keys(source, {'source_id','source_sha256','vault_id','project_id','file_id','version_id','sha256','byte_size','media_type','original_name','page_number','page_count','extraction_contract','page_text_sha256','start_codepoint','end_codepoint','text'})
        for key in ('file_id','version_id'): ev.identity(source[key])
        for key in ('sha256','page_text_sha256','source_sha256'): digest(source[key])
        ev.integer(source['byte_size'],1,16777216); text(source['original_name'],255,1)
        if source['vault_id'] != payload['vault_id'] or source['project_id'] != payload['project_id'] or source['media_type'] not in ('application/pdf','text/plain','text/markdown'):
            fail('Selected source provenance mismatch.')
        expected = ev.PDF_CONTRACT if source['media_type']=='application/pdf' else ev.TEXT_CONTRACT
        if source['extraction_contract'] != expected:
            fail('Unknown extraction contract.')
        ev.integer(source['page_number'],1,200)
        if source['page_count'] is not None: ev.integer(source['page_count'],source['page_number'],200)
        if source['media_type'] != 'application/pdf' and (source['page_number'] != 1 or source['page_count'] != 1):
            fail('Text sources have one logical page.')
        start=ev.integer(source['start_codepoint'],0); end=ev.integer(source['end_codepoint'])
        if end-start != len(text(source['text'],24000,1)):
            fail('Selected text offsets do not match.')
        pairs.add((source['file_id'],source['version_id']));pages.add((source['file_id'],source['version_id'],source['page_number']))
        ordering.append((source['file_id'],source['version_id'],source['page_number'],start,end))
    if len(pairs)>5 or len(pages)>12 or ordering != sorted(set(ordering)):
        fail('Selected source ordering or counts are corrupt.')
    notes=bounded_list(payload['notes'],8);note_ids=[];checked_pages=set(pages)
    for note in notes:
        keys(note, {'note_id','revision','kind','body','created_at_utc','updated_at_utc','file_id','version_id','provenance','anchor'})
        if note['provenance'] != 'owner_note' or (note['file_id'],note['version_id']) not in pairs:
            fail('Selected note provenance is corrupt.')
        anchor=note['anchor']
        if anchor is not None: keys(anchor,set(ev.ANCHOR_FIELDS))
        ev.validate_note({**note,'project_id':payload['project_id'],**(anchor or {k:None for k in ev.ANCHOR_FIELDS})})
        text(note['body'],2000);note_ids.append(note['note_id'])
        if anchor: checked_pages.add((note['file_id'],note['version_id'],anchor['page_number']))
    if note_ids != sorted(set(note_ids)) or len(checked_pages)>12:
        fail('Selected note order or checked-page count is corrupt.')
    coverage=keys(payload['coverage'],{'files','file_count','page_count','segment_count','source_bytes','source_codepoints','note_count','note_bytes'})
    counts={'file_count':len(pairs),'page_count':len(checked_pages),'segment_count':len(sources),'source_bytes':sum(len(s['text'].encode()) for s in sources),'source_codepoints':sum(len(s['text']) for s in sources),'note_count':len(notes),'note_bytes':sum(len(n['body'].encode()) for n in notes)}
    if any(type(coverage[k]) is not int or coverage[k]!=v for k,v in counts.items()) or counts['source_bytes']>49152 or counts['source_codepoints']>24000 or counts['note_bytes']>8192:
        fail('Selected coverage counts are corrupt.')
    files=bounded_list(coverage['files'],5,1)
    if [(f['file_id'],f['version_id']) for f in files] != sorted(pairs):
        fail('Selected coverage file identities are corrupt.')
    for f in files:
        keys(f,{'file_id','version_id','known_page_count','selected_pages','anchor_checked_pages','unexamined_page_count'})
        pair=(f['file_id'],f['version_id']);known=next(s['page_count'] for s in sources if (s['file_id'],s['version_id'])==pair)
        selected=sorted(p[2] for p in pages if p[:2]==pair);checked=sorted(p[2] for p in checked_pages if p[:2]==pair)
        if f['known_page_count']!=known or f['selected_pages']!=selected or f['anchor_checked_pages']!=checked or f['unexamined_page_count']!=(known-len(checked) if known is not None else None):
            fail('Selected page coverage is corrupt.')
    disclosure=keys(payload['disclosure'],{'custom_endpoint','retained_digest_reads_selected_file_bytes','pdf_structure_examined_for_selected_pages','source_strings_may_contain_private_material','limitations'})
    if type(disclosure['custom_endpoint']) is not bool or disclosure['custom_endpoint']!=(payload['requested']['provider']=='custom') or disclosure['retained_digest_reads_selected_file_bytes'] is not True or disclosure['pdf_structure_examined_for_selected_pages'] is not True:
        fail('Selected disclosure identity is corrupt.')
    text(disclosure['source_strings_may_contain_private_material'],2000,1);text(disclosure['limitations'],2000,1)
    from .selected_evidence_context import RESPONSE_CONTRACT
    if payload['response_contract'] != RESPONSE_CONTRACT:
        fail('Unknown selected response contract.')


def validate_request(request: dict) -> dict:
    keys(request, {'payload', 'request_sha256', 'user_prompt', 'user_sha256', 'system_text', 'system_sha256'})
    payload = request['payload']
    validate_payload(payload)
    text(request['system_text'],16384,1); digest(request['system_sha256']); digest(request['user_sha256'])
    raw = canonical(payload)
    if (len(raw.encode()) > 98304 or sha(raw) != digest(request['request_sha256'])
            or sha(request['system_text']) != request['system_sha256']
            or len(request['system_text'].encode()) > 16384
            or payload['system_sha256'] != request['system_sha256']
            or payload['system_version'] != SYSTEM_VERSION
            or request['user_prompt'] != canonical({'request_sha256': request['request_sha256'], 'payload': payload})
            or sha(request['user_prompt']) != request['user_sha256']
            or len(request['user_prompt'].encode()) > 98304):
        fail('Stored request hashes or exact prompt bytes do not match.', 'corrupt_record', 409)
    for index, source in enumerate(payload['sources'], 1):
        if (source['source_id'] != f'S{index:02d}' or
                sha(canonical({k: v for k, v in source.items() if k not in ('source_id', 'source_sha256')})) != source['source_sha256']):
            fail('Stored selected-source identity is corrupt.', 'corrupt_record', 409)
    return request


def row(conn: sqlite3.Connection, vault_id: str, project_id: str, answer_id: str) -> dict:
    ev.project(conn, vault_id, project_id)
    ev.identity(answer_id)
    found = conn.execute('SELECT * FROM evidence_answers WHERE answer_id=? AND project_id=? AND vault_id=?',
                         (answer_id, project_id, vault_id)).fetchone()
    if found is None:
        fail('This answer is not present in the selected project.', 'unknown_answer', 404)
    result = dict(found)
    try:
        ev.integer(result['id']); ev.identity(result['preview_id']); ev.identity(result['owner_runtime_id'])
        ev.integer(result['project_revision']); ev.timestamp(result['created_at_utc'])
        for key in ('started_at_utc', 'finished_at_utc'):
            if result[key] is not None:
                ev.timestamp(result[key])
        if (result['state'] not in STATES or result['cleanup_state'] not in ('not_started','pending','confirmed','unknown')
                or (result['state'] in TERMINAL) != (result['finished_at_utc'] is not None)):
            raise ValueError
        request = validate_request(loads(result['request_json'], 262144))
        if (request['request_sha256'] != result['request_sha256'] or
                any(request['payload'][k] != result[k] for k in ('vault_id','project_id','project_revision','mode'))):
            raise ValueError
        reports = loads(result['reports_json'], 16384)
        for observation in bounded_list(reports, 64):
            validate_report(observation)
        text(result['partial_text'], MAX_TEXT)
        if len(result['partial_text'].encode()) > MAX_TEXT:
            raise ValueError
        structured = validate_result(result['result_json'], request) if result['result_json'] is not None else None
        if ((result['state'] in ('succeeded','refused')) != (structured is not None)
                or structured is not None and ((structured['status']=='answer') != (result['state']=='succeeded'))):
            raise ValueError
        usage = loads(result['usage_json'], 4096) if result['usage_json'] is not None else None
        if usage is not None:
            keys(usage, {'reported','provenance','billing'})
            if usage['provenance'] != 'runtime_report' or usage['billing'] != 'unknown' or not isinstance(usage['reported'],dict) or not usage['reported'] or not set(usage['reported']) <= {'input_tokens','output_tokens','cache_read_tokens','cache_creation_tokens'}:
                raise ValueError
            for count in usage['reported'].values(): ev.integer(count,0)
        for key in ('error_code','error_message'):
            if result[key] is not None: text(result[key],2000,1)
        binding = loads(result['private_binding_json'], 4096)
        assistant_choices.request_projection(binding)
    except (ValueError, TypeError, KeyError, UnicodeError, ev.EvidenceError):
        fail('This saved answer is unreadable; it was not repaired or resumed.', 'corrupt_record', 409)
    return {**result, 'request': request, 'result': structured, 'reports': reports, 'usage': usage}


def public(value: dict) -> dict:
    fields = ('id','answer_id','vault_id','project_id','project_revision','mode','state','request_sha256',
              'partial_text','cleanup_state','created_at_utc','started_at_utc','finished_at_utc',
              'error_code','error_message','request','result','reports','usage')
    return {**{k: value[k] for k in fields}, 'contract_version': 1,
            'validation': 'exact_text_identity_only_support_unchecked' if value['result'] else 'unvalidated',
            'current_originals': 'not_rechecked', 'limitations': LIMITS}


def detail(conn: sqlite3.Connection, vault_id: str, project_id: str, answer_id: str) -> dict:
    conn.execute('BEGIN')
    try:
        return public(row(conn, vault_id, project_id, answer_id))
    finally:
        conn.rollback()


def history(conn: sqlite3.Connection, vault_id: str, project_id: str, **page: int) -> dict:
    conn.execute('BEGIN')
    try:
        ev.project(conn, vault_id, project_id)
        rows, bounds = ev.pagination(conn, 'evidence_answers', 'project_id=? AND vault_id=?', (project_id, vault_id), **page)
        fields = ('id','answer_id','request_sha256','mode','state','created_at_utc','finished_at_utc','cleanup_state')
        items = []
        for candidate in rows:
            checked = row(conn, vault_id, project_id, candidate['answer_id'])
            items.append({k: checked[k] for k in fields})
        return ev.envelope(vault_id, project_id, answers=items, **bounds)
    finally:
        conn.rollback()


def finish(conn: sqlite3.Connection, answer_id: str, owner: str, state: str, *,
           partial: str, reports: list, result: dict | None = None, usage: dict | None = None,
           code: str | None = None, message: str | None = None, cleanup: str = 'pending') -> bool:
    if state not in TERMINAL:
        raise ValueError('Terminal transition required')
    cursor = conn.execute("UPDATE evidence_answers SET state=?,partial_text=?,reports_json=?,result_json=?,usage_json=?,"
                          "error_code=?,error_message=?,finished_at_utc=?,cleanup_state=? "
                          "WHERE answer_id=? AND owner_runtime_id=? AND state IN ('admitted','running')",
                          (state, partial, canonical(reports), canonical(result) if result is not None else None,
                           canonical(usage) if usage is not None else None, code, message, ev.utc_now(), cleanup, answer_id, owner))
    conn.commit()
    return cursor.rowcount == 1
