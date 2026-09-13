"""H01-H05/H10-H13: saved SQLite snapshots, literal HTML and owned spools.

Seeded lifecycle records are authored fixtures, not extra model executions.
Real download/offline-engine behavior is in portable-briefing.spec.ts.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import html
from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
import re
import sqlite3
import threading
import uuid
import zipfile

import pytest

from implementation_scripts import database as db, evidence as ev, evidence_export, evidence_reader, library
from implementation_scripts import selected_evidence as se, selected_evidence_export as export, selected_evidence_html as document
from test_evidence import files_snapshot, sql_snapshot, save_note, anchor_for, put_file, revision
from test_selected_evidence_context import workspace, available, assemble, selection
from test_selected_evidence import answer as answer_result

HOSTILE = ('</style><script>globalThis.EXPORTED_ATTACK=1</script><img src="https://invalid.test/x" onerror="alert(1)">'
           '<form action="file:///private/secret"><input autofocus></form><meta http-equiv="refresh" content="0;url=javascript:alert(1)">'
           '<base href="https://invalid.test/"><svg onload="alert(1)"></svg> @import url(https://invalid.test/style); '
           '[visible](file:///private/secret) javascript:alert(1) data:text/html,hostile blob:hostile 😀\r\n')


def seed(w, *, state='succeeded', body=None, mutate=None, partial='Partial <script>literal</script> 😀\r\n'):
    """Insert a validated synthetic saved snapshot; no Send or runtime call."""
    request, binding, _ = assemble(w, body or selection(w))
    result = answer_result(request)
    if mutate:
        mutate(request, result)
    # Rehash authored fixtures exactly as the saved-row validator expects.
    payload = request['payload']
    for source in payload['sources']:
        source['source_sha256'] = se.sha(se.canonical({k:v for k,v in source.items() if k not in ('source_id','source_sha256')}))
    request['request_sha256'] = se.sha(se.canonical(payload))
    request['user_prompt'] = se.canonical({'request_sha256':request['request_sha256'],'payload':payload})
    request['user_sha256'] = se.sha(request['user_prompt'])
    result['request_sha256'] = request['request_sha256']
    result['status'] = 'insufficient_evidence' if state == 'refused' else 'answer'
    se.validate_request(request)
    se.validate_result(se.canonical(result),request)
    now = ev.utc_now()
    row = dict(answer_id=str(uuid.uuid4()),preview_id=str(uuid.uuid4()),vault_id=w.vault_id,project_id=w.project_id,
               project_revision=payload['project_revision'],mode=payload['mode'],state=state,
               request_json=se.canonical(request),request_sha256=request['request_sha256'],private_binding_json=se.canonical(binding),
               private_native_session_id='SYNTHETIC_PRIVATE_NATIVE',owner_runtime_id=str(uuid.uuid4()),partial_text=partial,
               result_json=se.canonical(result) if state in ('succeeded','refused') else None,
               reports_json='[]',usage_json=None,error_code='fixture_error' if state=='failed' else None,
               error_message=HOSTILE if state=='failed' else None,cleanup_state='unknown' if state=='interrupted' else 'confirmed' if state in se.TERMINAL else 'pending',
               created_at_utc=now,started_at_utc=None if state=='admitted' else now,finished_at_utc=now if state in se.TERMINAL else None)
    w.conn.execute('INSERT INTO evidence_answers ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',tuple(row.values()))
    w.conn.commit()
    return se.detail(w.conn,w.vault_id,w.project_id,row['answer_id'])


def exported(w, answer):
    bundle = export.build_html(w.conn,w.vault_id,w.project_id,answer['answer_id'])
    try:
        raw = bundle.path.read_bytes()
        assert bundle.size == len(raw) <= document.MAX_BYTES
        assert bundle.manifest['sha256'] == hashlib.sha256(raw).hexdigest()
        return raw.decode('utf-8')
    finally:
        bundle.close()
        assert not bundle.path.exists()


class Nodes(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.tags=[];self.attrs=[];self.data=[]
        self.feed(text)
    def handle_starttag(self, tag, attrs):
        self.tags.append(tag);self.attrs.append((tag,dict(attrs)))
    def handle_data(self, data):self.data.append(data)


@pytest.mark.parametrize('mode',['question','briefing'])
def test_saved_schema18_html_one_snapshot_no_reads_or_writes(workspace,available,tmp_path,monkeypatch,mode):
    w=workspace
    a=seed(w,body=selection(w,mode=mode))
    before=sql_snapshot(w.conn);files=files_snapshot(w);calls=[];original=se.detail
    def detail(*args):calls.append(args[3]);return original(*args)
    monkeypatch.setattr(se,'detail',detail)
    for module, name in [(library,'retained'),(evidence_reader,'read_text')]:
        monkeypatch.setattr(module,name,lambda *a,**k:pytest.fail('Export read a current original'))
    text=exported(w,a)
    assert calls==[a['answer_id']] and db.get_schema_version(w.conn)==18
    assert sql_snapshot(w.conn)==before and files_snapshot(w)==files
    for value in [a['answer_id'],a['vault_id'],a['project_id'],a['request_sha256'],a['request']['payload']['instruction']]:
        assert value in html.unescape(text)
    for forbidden in ['SYNTHETIC_PRIVATE_NATIVE','private_binding_json','owner_runtime_id',str(w.root),'Unselected original and unrelated text']:
        assert forbidden not in text
    (tmp_path/(mode+'.html')).write_text(text)


@pytest.mark.parametrize('state',se.STATES)
def test_all_saved_lifecycle_states_are_literal_and_honest(workspace,available,state):
    a=seed(workspace,state=state);text=exported(workspace,a);nodes=Nodes(text)
    visible=''.join(nodes.data)
    assert state in visible and a['cleanup_state'] in visible
    assert 'saved snapshot read for export' in visible and 'It does not update, resume work or recheck current originals.' in visible
    assert 'Citation identity is not semantic support.' in visible
    if state in ('succeeded','refused'):
        assert 'Structured result status' in visible
        assert ('Insufficient selected evidence was reported.' in visible)==(state=='refused')
    else:
        assert 'Incomplete / unvalidated output' in visible
        assert a['partial_text'] in visible
        assert '<script>' in visible and 'script' not in nodes.tags
    if state=='admitted':assert 'Unknown (not recorded)' in visible
    if state=='failed':assert HOSTILE in visible


def test_empty_partial_is_unavailable_not_a_success(workspace,available):
    a=seed(workspace,state='interrupted',partial='')
    text=exported(workspace,a)
    assert 'No durable text has been recorded.' in text
    assert 'Structured result status' not in text


def test_exact_unicode_repeated_overlapping_citation_targets_and_returns(workspace,available):
    w=workspace;f=w.files[0]
    other=put_file(w,'unicode.txt',w.raw[f['file_id']]+b'\nDistinct retained version')
    body=selection(w);body['selections'].append({'file_id':other['file_id'],'version_id':other['version_id'],'sha256':other['sha256'],'page_number':1,'range':None})
    def repeated(request,result):
        items=[]
        for source in request['payload']['sources']:
            quotes=[]
            for occurrence in (0,1):
                start=source['text'].find('target 😀',0 if occurrence==0 else source['text'].find('target 😀')+1)
                for width in (8,6):
                    quotes.append({'source_id':source['source_id'],'start_codepoint':start,'end_codepoint':start+width,'quote':source['text'][start:start+width]})
            items.append({'kind':'source_statement','text':'Repeated exact codepoints; support unchecked.','citations':quotes,'note_ids':[]})
        result['sections'][0]['items']=items
    a=seed(w,body=body,mutate=repeated);text=exported(w,a);nodes=Nodes(text)
    links={attrs['id']:attrs['href'] for tag,attrs in nodes.attrs if tag=='a' and 'id' in attrs}
    ids=[attrs['id'] for _,attrs in nodes.attrs if 'id' in attrs]
    assert len(ids)==len(set(ids))
    for ii,item in enumerate(a['result']['sections'][0]['items'],1):
        for ci,c in enumerate(item['citations'],1):
            source_index=int(c['source_id'][1:]);ref=f'reference-1-{ii}-{ci}';target=f'source-{source_index}-citation-1-{ii}-{ci}'
            assert links[ref]=='#'+target
            section=text.split(f'id="{target}"',1)[1].split('</section>',1)[0]
            assert f'href="#{ref}"' in section
            assert f'<dd class="literal">{c["start_codepoint"]}</dd>' in section
            assert f'<dd class="literal">{c["end_codepoint"]}</dd>' in section
            assert '<div class="literal">'+html.escape(c['quote'],quote=True)+'</div>' in section
    assert len(links)==8


def test_note_provenance_saved_revision_and_null_zero_observations(workspace,available):
    w=workspace;f=w.files[0];anchor=anchor_for(w,f)
    n=save_note(w,f,body='SELECTED OWNER NOTE '+HOSTILE,anchor=anchor)
    save_note(w,f,body='UNSELECTED_NOTE_SENTINEL')
    body=selection(w,notes=[{'note_id':n['note_id'],'expected_note_revision':n['revision']}])
    a=seed(w,body=body)
    w.conn.execute('UPDATE evidence_answers SET reports_json=?,usage_json=? WHERE answer_id=?',
       (se.canonical([{'model':HOSTILE,'source':'api_response_model','observed_at_utc':ev.utc_now()}]),
        se.canonical({'reported':{'input_tokens':0,'output_tokens':12},'provenance':'runtime_report','billing':'unknown'}),a['answer_id']))
    w.conn.commit();a=se.detail(w.conn,w.vault_id,w.project_id,a['answer_id'])
    ev.edit_note(w.conn,w.vault_id,w.project_id,revision(w),n['note_id'],n['revision'],'LATER_NOTE_SENTINEL')
    text=exported(w,a);visible=''.join(Nodes(text).data)
    assert 'SELECTED OWNER NOTE '+HOSTILE in visible
    assert n['note_id'] in visible and 'owner_note' in visible and anchor['quote'] in visible
    assert 'UNSELECTED_NOTE_SENTINEL' not in visible and 'LATER_NOTE_SENTINEL' not in visible
    assert '"input_tokens":0' in visible and '"output_tokens":12' in visible
    assert 'Requested settings' in visible and 'Literal reported model observations' in visible
    assert 'Reported effort and billing are unknown' in visible
    assert '<dt>unexamined_page_count</dt><dd class="literal">0</dd>' in text


def test_unknown_saved_pdf_page_count_is_not_zero(workspace,available):
    w=workspace
    f=put_file(w,'pages.pdf',(Path(__file__).parent/'fixtures/evidence/two-pages.pdf').read_bytes())
    body=selection(w,selections=[{'file_id':f['file_id'],'version_id':f['version_id'],'sha256':f['sha256'],'page_number':1,'range':None}])
    def unknown(request,result):
        request['payload']['sources'][0]['page_count']=None
        request['payload']['coverage']['files'][0].update(known_page_count=None,unexamined_page_count=None)
    a=seed(w,body=body,mutate=unknown);text=exported(w,a)
    assert '<dt>known_page_count</dt><dd class="literal">Unknown (not recorded)</dd>' in text
    assert '<dt>unexamined_page_count</dt><dd class="literal">Unknown (not recorded)</dd>' in text


def test_hostile_strings_are_text_and_only_authored_fragments_exist(workspace,available):
    w=workspace;f=put_file(w,'<img onerror="bad">.txt',HOSTILE.encode())
    body=selection(w,instruction=HOSTILE,selections=[{'file_id':f['file_id'],'version_id':f['version_id'],'sha256':f['sha256'],'page_number':1,'range':None}])
    def hostile(request,result):result['sections'][0]['items'][0]['text']=HOSTILE
    a=seed(w,body=body,mutate=hostile);text=exported(w,a);nodes=Nodes(text)
    assert HOSTILE in ''.join(nodes.data)
    assert not set(nodes.tags)&{'script','img','form','input','iframe','object','embed','svg','base','link','video','audio'}
    for tag,attrs in nodes.attrs:
        assert not any(k.lower().startswith('on') for k in attrs)
        assert 'src' not in attrs and 'style' not in attrs
        if tag=='a':assert re.fullmatch(r'#[a-z0-9-]+',attrs['href'])
        if tag=='meta':assert attrs.get('http-equiv') in (None,'Content-Security-Policy')
    assert text.index('Content-Security-Policy')<text.index('<style>')<text.index('<body>')
    style=text.split('<style>',1)[1].split('</style>',1)[0]
    assert style==document.CSS and len(style.encode())<=65536
    assert "style-src 'sha256-"+document.CSS_HASH+"'" in html.unescape(text)
    assert "script-src 'none'" in document.CSP


def test_html_uses_only_saved_data_after_sqlite_reopen_and_missing_originals(workspace,available,monkeypatch):
    w=workspace;a=seed(w);before=exported(w,a);files=files_snapshot(w)
    f=w.files[0];row=w.conn.execute('SELECT relative_path FROM library_files WHERE file_id=?',(f['file_id'],)).fetchone()
    retained=w.root/row[0];held=retained.with_suffix('.portable-held');retained.rename(held)
    ev.remove_file(w.conn,w.vault_id,w.project_id,revision(w),f['file_id'],f['version_id'])
    conn=db.get_connection(w.database)
    try:
        monkeypatch.setattr(library,'retained',lambda *a,**k:pytest.fail('Export traversed retained file'))
        bundle=export.build_html(conn,w.vault_id,w.project_id,a['answer_id'])
        try:assert bundle.path.read_bytes().decode()==before
        finally:bundle.close()
    finally:conn.close();held.rename(retained)
    assert files_snapshot(w)==files


def test_old_zip_markdown_and_json_are_identical_before_and_after_html(workspace,available):
    w=workspace;a=seed(w)
    first=export.build(w.conn,w.vault_id,w.project_id,a['answer_id'])
    try:
        raw=first.path.read_bytes()
        with zipfile.ZipFile(first.path) as archive:
            entries={name:archive.read(name) for name in archive.namelist()}
        exported(w,a)
        second=export.build(w.conn,w.vault_id,w.project_id,a['answer_id'])
        try:assert second.path.read_bytes()==raw
        finally:second.close()
        assert list(entries)==['answer.json','answer.md','evidence.json']
        assert entries['answer.md']==export.markdown(a).encode()
        assert entries['answer.json']==se.canonical(a).encode()
    finally:first.close()


def test_final_utf8_limit_exact_and_escape_expansion(workspace,available,monkeypatch):
    d=document._Document(None);d.add('a'*(document.MAX_BYTES-4));d.add('😀')
    assert d.size==4194304
    with pytest.raises(ev.EvidenceError) as e:d.add('x')
    assert e.value.reason=='export_limit' and e.value.status==413
    a=seed(workspace);size=len(document.render(a))
    monkeypatch.setattr(document,'MAX_BYTES',size)
    assert len(document.render(a))==size
    monkeypatch.setattr(document,'MAX_BYTES',size-1)
    before=sql_snapshot(workspace.conn)
    with pytest.raises(ev.EvidenceError) as e:exported(workspace,a)
    assert e.value.reason=='export_limit' and sql_snapshot(workspace.conn)==before
    monkeypatch.setattr(document,'MAX_BYTES',20)
    d=document._Document(None)
    with pytest.raises(ev.EvidenceError):d.literal('&'*4)


@pytest.mark.parametrize('fault',['pre-cancel','render-cancel','write','mid-write','chunk-close'])
def test_owned_spool_cancel_and_write_faults_preserve_state(workspace,available,monkeypatch,fault):
    w=workspace;a=seed(w);before=sql_snapshot(w.conn);files=files_snapshot(w);created=[];stop=threading.Event();original=evidence_export.Bundle
    def bundle():
        b=original();created.append(b);return b
    monkeypatch.setattr(evidence_export,'Bundle',bundle)
    if fault=='pre-cancel':stop.set()
    if fault=='render-cancel':
        add=document._Document.add
        def cancel_add(self,text):add(self,text);stop.set()
        monkeypatch.setattr(document._Document,'add',cancel_add)
    if fault in ('write','mid-write'):
        opener=Path.open
        class Broken:
            def __enter__(self):return self
            def __exit__(self,*a):return None
            def write(self,raw):
                if fault=='mid-write':
                    with opener(created[0].path,'wb') as out:out.write(raw[:12])
                raise OSError('Authored HTML spool write fault')
        def broken(path,*args,**kwargs):
            if created and path==created[0].path and args==('wb',):return Broken()
            return opener(path,*args,**kwargs)
        monkeypatch.setattr(Path,'open',broken)
    if fault=='chunk-close':
        b=export.build_html(w.conn,w.vault_id,w.project_id,a['answer_id']);chunks=b.chunks()
        assert next(chunks).startswith(b'<!doctype html>');chunks.close()
    else:
        with pytest.raises((ev.EvidenceError,OSError)):export.build_html(w.conn,w.vault_id,w.project_id,a['answer_id'],cancel=stop)
    assert all(b.closed and not b.path.exists() for b in created)
    assert len(created)==(0 if fault in ('pre-cancel','render-cancel') else 1)
    assert sql_snapshot(w.conn)==before and files_snapshot(w)==files


@pytest.mark.parametrize('fault',['request','result','usage','state','source','unknown'])
def test_corrupt_or_unknown_snapshot_refuses_without_repair(workspace,available,fault):
    w=workspace;a=seed(w)
    if fault!='unknown':
        column,value={'request':('request_json','{}'),'result':('result_json','{}'),'usage':('usage_json','{}'),
                      'state':('result_json',None),'source':('request_json',a['request']['user_prompt'])}[fault]
        w.conn.execute('UPDATE evidence_answers SET '+column+'=? WHERE answer_id=?',(value,a['answer_id']));w.conn.commit()
    else:a['answer_id']=str(uuid.uuid4())
    before=sql_snapshot(w.conn);files=files_snapshot(w)
    with pytest.raises(ev.EvidenceError):exported(w,a)
    assert sql_snapshot(w.conn)==before and files_snapshot(w)==files
