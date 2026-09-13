"""S26-S29: saved selected-only projections and exact complete/partial archives."""
from __future__ import annotations
import json
from pathlib import Path
import threading
import zipfile
import pytest
from implementation_scripts import selected_evidence as se, selected_evidence_export as export
from test_selected_evidence_runtime import workspace,real_lane,admitted


def completed(w,tmp_path):
    value,body,capture=real_lane(w,tmp_path)
    _,_,result=admitted(w,value,body);job=value.subscribe(result['answer_id'],w.vault_id,w.project_id,value.runtime_id)
    while not job.completed.is_set():value.next_event(job)
    assert job.completed.wait(5)
    value.shutdown()
    return se.detail(w.conn,w.vault_id,w.project_id,result['answer_id'])


def test_exact_three_entries_no_private_binding_or_originals(workspace,tmp_path):
    result=completed(workspace,tmp_path)
    bundle=export.build(workspace.conn,workspace.vault_id,workspace.project_id,result['answer_id'])
    try:
        with zipfile.ZipFile(bundle.path) as z:
            assert z.namelist()==['answer.json','answer.md','evidence.json']
            answer=json.loads(z.read('answer.json'));evidence=json.loads(z.read('evidence.json'))
            joined=b'\n'.join(z.read(n) for n in z.namelist()).decode()
            assert 'private_binding_json' not in joined and 'private_native_session_id' not in joined
            assert str(tmp_path) not in joined and 'route_digest' not in joined
            assert 'Unselected original and unrelated text' not in joined
            assert len(evidence['sources'])==1 and evidence['notes']==[]
            assert answer['state']=='succeeded' and answer['validation']=='exact_text_identity_only_support_unchecked'
            assert se.validate_request(answer['request'])==answer['request']
    finally:
        bundle.close()
    assert bundle.closed and not bundle.path.exists()


def test_snapshot_reopen_export_missing_current_file_no_parser(workspace,tmp_path,monkeypatch):
    result=completed(workspace,tmp_path)
    from implementation_scripts import evidence_reader
    monkeypatch.setattr(evidence_reader,'read_text',lambda *a,**k:pytest.fail('History/export must not parse'))
    file=workspace.files[0]
    row=workspace.conn.execute('SELECT relative_path FROM library_files WHERE file_id=?',(file['file_id'],)).fetchone()
    retained=workspace.root/row[0];original=retained.read_bytes();held=retained.with_suffix('.selected-held');retained.rename(held)
    try:
        again=se.detail(workspace.conn,workspace.vault_id,workspace.project_id,result['answer_id'])
        assert again['request']==result['request'] and again['current_originals']=='not_rechecked'
        bundle=export.build(workspace.conn,workspace.vault_id,workspace.project_id,result['answer_id']);bundle.close()
    finally:held.rename(retained)
    assert retained.read_bytes()==original


def test_export_cancel_cleans_spool(workspace,tmp_path):
    result=completed(workspace,tmp_path);stop=threading.Event();stop.set()
    with pytest.raises(Exception):export.build(workspace.conn,workspace.vault_id,workspace.project_id,result['answer_id'],cancel=stop)


def test_literal_markdown_cannot_close_its_fence():
    from implementation_scripts.evidence_export import _fence
    value='```\n<script>never()</script>\n`````'
    rendered=_fence(value)
    assert rendered.startswith('``````text\n') and rendered.endswith('\n``````')


def seed_snapshot(w, original, count, **changes):
    import uuid
    row=dict(w.conn.execute('SELECT * FROM evidence_answers WHERE answer_id=?',(original['answer_id'],)).fetchone());row.pop('id');row.update(changes);ids=[]
    for _ in range(count):
        row.update(answer_id=str(uuid.uuid4()),preview_id=str(uuid.uuid4()));ids.append(row['answer_id'])
        w.conn.execute('INSERT INTO evidence_answers ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',tuple(row.values()))
    w.conn.commit();return ids


def test_fixed_history_ceiling_wrong_project_and_1000_cap_preserve_every_row(workspace,tmp_path,monkeypatch):
    from implementation_scripts import evidence as ev,evidence_reader
    result=completed(workspace,tmp_path);seed_snapshot(workspace,result,50)
    original_read=evidence_reader.read_text
    monkeypatch.setattr(evidence_reader,'read_text',lambda *a,**k:pytest.fail('History must not extract'))
    first=se.history(workspace.conn,workspace.vault_id,workspace.project_id);assert len(first['answers'])==50 and first['total']==51 and first['has_more']
    last=seed_snapshot(workspace,result,1)[0]
    second=se.history(workspace.conn,workspace.vault_id,workspace.project_id,through_id=first['through_id'],after_id=first['next_after_id'])
    assert len(second['answers'])==1 and second['total']==51 and second['answers'][0]['answer_id']!=last
    other=ev.create_project(workspace.conn,workspace.vault_id,'Different empty project')['project']
    assert se.history(workspace.conn,workspace.vault_id,other['project_id'])['answers']==[]
    with pytest.raises(Exception):se.detail(workspace.conn,workspace.vault_id,other['project_id'],result['answer_id'])
    monkeypatch.setattr(evidence_reader,'read_text',original_read);seed_snapshot(workspace,result,948)
    before=[tuple(r) for r in workspace.conn.execute('SELECT * FROM evidence_answers ORDER BY id')]
    assert len(before)==1000
    from test_selected_evidence_runtime import real_lane
    value,body,capture=real_lane(workspace,tmp_path);capture.unlink() # only prior completed synthetic capture
    p=value.preview(workspace.conn,workspace.project_id,body,threading.Event())
    with pytest.raises(se.ev.EvidenceError,match='1,000'):
        value.send(workspace.conn,workspace.project_id,{'expected_vault_id':workspace.vault_id,'expected_runtime_id':value.runtime_id,'preview_id':p['preview_id'],'request_sha256':p['request_sha256'],'confirmed':True},threading.Event())
    assert not capture.exists() and [tuple(r) for r in workspace.conn.execute('SELECT * FROM evidence_answers ORDER BY id')]==before;value.shutdown()


@pytest.mark.parametrize('state',['failed','cancelled','interrupted'])
def test_partial_terminal_export_is_literal_unvalidated_and_preserved(workspace,tmp_path,state):
    result=completed(workspace,tmp_path);identity=seed_snapshot(workspace,result,1,state=state,result_json=None,partial_text='Partial ``` <script>literal</script>',cleanup_state='unknown' if state=='interrupted' else 'confirmed')[0]
    bundle=export.build(workspace.conn,workspace.vault_id,workspace.project_id,identity)
    try:
        with zipfile.ZipFile(bundle.path) as z:
            a=json.loads(z.read('answer.json'));assert a['state']==state and a['validation']=='unvalidated' and a['result'] is None
            assert 'Incomplete / unvalidated output' in z.read('answer.md').decode()
    finally:bundle.close()
    assert not bundle.path.exists()


def test_mid_zip_write_failure_cleans_owned_spool_and_preserves_rows(workspace,tmp_path,monkeypatch):
    from implementation_scripts import evidence_export
    result=completed(workspace,tmp_path);created=[];original=evidence_export.Bundle
    def bundle():
        value=original();created.append(value);return value
    monkeypatch.setattr(evidence_export,'Bundle',bundle);write=zipfile.ZipFile.writestr;calls=[]
    def broken(self,*args,**kwargs):
        calls.append(args[0]);
        if len(calls)==2:raise OSError('Authored second-entry write failure')
        return write(self,*args,**kwargs)
    monkeypatch.setattr(zipfile.ZipFile,'writestr',broken)
    with pytest.raises(OSError,match='second-entry'):export.build(workspace.conn,workspace.vault_id,workspace.project_id,result['answer_id'])
    assert len(created)==1 and created[0].closed and not created[0].path.exists()
    assert se.detail(workspace.conn,workspace.vault_id,workspace.project_id,result['answer_id'])==result


@pytest.mark.parametrize('fault',['partial','reports','usage','timestamp'])
def test_corrupt_saved_fields_refuse_without_rewriting(workspace,tmp_path,fault):
    result=completed(workspace,tmp_path);column,value={'partial':('partial_text','\ud800'),'reports':('reports_json','[{"model":"x","source":"api_response_model","observed_at_utc":"bad"}]'),'usage':('usage_json','{"reported":{"input_tokens":-1},"provenance":"runtime_report","billing":"unknown"}'),'timestamp':('created_at_utc','today')}[fault]
    if fault=='partial':column='request_json';value=se.canonical(result['request']).replace('selected_evidence_v1','selected_evidence_v0')
    workspace.conn.execute('UPDATE evidence_answers SET '+column+'=? WHERE answer_id=?',(value,result['answer_id']));workspace.conn.commit();before=tuple(workspace.conn.execute('SELECT * FROM evidence_answers').fetchone())
    with pytest.raises(se.ev.EvidenceError,match='unreadable'):se.detail(workspace.conn,workspace.vault_id,workspace.project_id,result['answer_id'])
    assert tuple(workspace.conn.execute('SELECT * FROM evidence_answers').fetchone())==before


def test_member_remove_readd_and_note_edit_preserve_exact_saved_answer_and_files(workspace,tmp_path):
    from implementation_scripts import evidence as ev
    from test_evidence import save_note,revision,files_snapshot,sql_snapshot
    note=save_note(workspace,workspace.files[0],body='Before owner edit')
    result=completed(workspace,tmp_path);before=sql_snapshot(workspace.conn,{'evidence_answers','library_files','documents','assistant_sessions'})
    files=files_snapshot(workspace);f=workspace.files[0]
    ev.remove_file(workspace.conn,workspace.vault_id,workspace.project_id,revision(workspace),f['file_id'],f['version_id'])
    assert se.detail(workspace.conn,workspace.vault_id,workspace.project_id,result['answer_id'])==result
    ev.add_file(workspace.conn,workspace.vault_id,workspace.project_id,revision(workspace),f['file_id'],f['version_id'])
    ev.edit_note(workspace.conn,workspace.vault_id,workspace.project_id,revision(workspace),note['note_id'],note['revision'],'After owner edit')
    assert sql_snapshot(workspace.conn,set(before))==before and files_snapshot(workspace)==files
    assert se.detail(workspace.conn,workspace.vault_id,workspace.project_id,result['answer_id'])==result
    bundle=export.build(workspace.conn,workspace.vault_id,workspace.project_id,result['answer_id']);bundle.close()
