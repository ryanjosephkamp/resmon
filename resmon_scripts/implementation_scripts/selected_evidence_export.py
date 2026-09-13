"""One selected answer and its immutable excerpts, never retained originals."""
from __future__ import annotations

import hashlib
import sqlite3
import threading
import zipfile

from . import evidence_export, selected_evidence as se


def markdown(answer: dict) -> str:
    fence = evidence_export._fence
    parts = ['# Selected-evidence answer', '', 'Answer: '+answer['answer_id'], '',
             'State: '+answer['state']+'; validation: '+answer['validation'], '', se.LIMITS, '',
             '## Instruction', '', fence(answer['request']['payload']['instruction']), '']
    if answer['result'] is not None:
        for section in answer['result']['sections']:
            parts += ['## '+section['kind'], '']
            for item in section['items']:
                parts += [item['kind']+' (support unchecked)', '', fence(item['text']), '']
                for citation in item['citations']:
                    parts += [citation['source_id']+f" [{citation['start_codepoint']},{citation['end_codepoint']})",'',fence(citation['quote']),'']
                if item['note_ids']:
                    parts += ['Saved local note IDs: '+', '.join(item['note_ids']), '']
        for limitation in answer['result']['limitations']:
            parts += [fence(limitation),'']
    else:
        parts += ['## Incomplete / unvalidated output', '', fence(answer['partial_text']), '']
    parts += ['## Exact request identity','',answer['request_sha256'],'',
              'Requested settings and literal runtime reports are in answer.json. Billing is unknown.','']
    return '\n'.join(parts)


def build(conn: sqlite3.Connection, vault_id: str, project_id: str, answer_id: str,
          *, cancel: threading.Event | None = None) -> evidence_export.Bundle:
    evidence_export.cancelled(cancel)
    # One read transaction captures the partial/terminal state; no current files
    # are traversed. Detail uses explicit public projections of private rows.
    answer = se.detail(conn, vault_id, project_id, answer_id)
    payload = answer['request']['payload']
    evidence = {'contract_version':1,'answer_id':answer_id,'request_sha256':answer['request_sha256'],
                'sources':payload['sources'],'notes':payload['notes'],'coverage':payload['coverage'],
                'disclosure':payload['disclosure'],'verification':'retained_request_excerpts_not_fresh_originals',
                'hash_basis':'SHA256 of sorted compact UTF-8 JSON with ensure_ascii=false; source hashes exclude source_id and source_sha256; request hash excludes its own digest.'}
    entries = {'answer.json':se.canonical(answer).encode('utf-8'),
               'answer.md':markdown(answer).encode('utf-8'),
               'evidence.json':se.canonical(evidence).encode('utf-8')}
    if any(len(raw)>1048576 for raw in entries.values()) or sum(map(len,entries.values()))>4194304:
        se.fail('The selected answer exceeds the portable ZIP limits.', 'export_limit', 413)
    bundle = evidence_export.Bundle()
    try:
        with zipfile.ZipFile(bundle.path,'w',compression=zipfile.ZIP_DEFLATED) as archive:
            for name, raw in entries.items():
                evidence_export.cancelled(cancel)
                info = zipfile.ZipInfo(name, (1980,1,1,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED
                archive.writestr(info,raw)
        evidence_export.cancelled(cancel)
        bundle.size = bundle.path.stat().st_size
        bundle.manifest = {'answer_id':answer_id,'vault_id':vault_id,'project_id':project_id,'request_sha256':answer['request_sha256'],
                           'sha256':hashlib.sha256(bundle.path.read_bytes()).hexdigest(),
                           'entries':{name:hashlib.sha256(raw).hexdigest() for name,raw in entries.items()}}
        return bundle
    except BaseException:
        bundle.close(); raise
