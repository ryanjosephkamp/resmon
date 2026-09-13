"""Real HTTP/SSE selected-answer identity, consent, cancellation and saved state."""
from __future__ import annotations
import ast
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid
import zipfile
import httpx
import pytest
from test_evidence_boundary import _setup, HEADERS, ROOT, _json
from test_selected_evidence_runtime import fake_cli

@pytest.fixture
def http_selected(tmp_path):
    state=tmp_path/'state';state.mkdir();reports=state/'reports';reports.mkdir()
    source=Path(__file__).parents[2];receipt=state/'identity.json';log=state/'backend.log'
    env=dict(os.environ);env.update(RESMON_STATE_DIR=str(state),RESMON_DB_PATH=str(state/'resmon.db'),RESMON_REPORTS_DIR=str(reports),RESMON_PORT_FILE=str(state/'resmon.port'),RESMON_DISABLE_SCHEDULER='1',PYTHON_KEYRING_BACKEND='keyring.backends.null.Keyring')
    script='''import os,socket,sys,json,datetime
import uvicorn,resmon
s=socket.socket();s.bind(('127.0.0.1',0));s.listen(128);port=s.getsockname()[1];assert port!=8742
resmon.serving_port=lambda:port
json.dump({'pid':os.getpid(),'port':port,'source':os.getcwd(),'state':os.environ['RESMON_STATE_DIR'],'database':os.environ['RESMON_DB_PATH'],'start':datetime.datetime.now(datetime.timezone.utc).isoformat()},open(sys.argv[1],'w'))
uvicorn.Server(uvicorn.Config(resmon.app,log_level='error')).run(sockets=[s])
'''
    with log.open('w') as output:
        process=subprocess.Popen([sys.executable,'-c',script,str(receipt)],cwd=source/'resmon_scripts',env=env,stdout=output,stderr=output)
        try:
            deadline=time.monotonic()+10
            while not receipt.exists():
                assert process.poll() is None,log.read_text();assert time.monotonic()<deadline;time.sleep(.02)
            record=json.loads(receipt.read_text());assert record['pid']==process.pid and record['port']!=8742
            with httpx.Client(base_url=f"http://127.0.0.1:{record['port']}",timeout=15) as client:
                while True:
                    try:
                        if client.get('/api/library',headers=HEADERS).status_code==200:break
                    except httpx.ConnectError:pass
                    assert process.poll() is None,log.read_text();assert time.monotonic()<deadline;time.sleep(.02)
                binary,capture=fake_cli(tmp_path)
                _json(client.put('/api/settings/ai',json={'settings':{'ai_cli_path':str(binary)}}))
                ctx=_setup(client,record,tmp_path);ctx.update(capture=capture,binary=binary)
                ctx['runtime_id']=_json(client.get('/api/health'))['identity']['runtime_id']
                yield ctx
        finally:
            process.terminate();code=process.wait(timeout=15)
            (state/'cleanup.json').write_text(json.dumps({'pid':process.pid,'exit':code,'reaped':True,'source':str(source)}))

def body(c):
    return {'expected_vault_id':c['vault_id'],'expected_revision':c['revision'],'expected_runtime_id':c['runtime_id'],
            'selections':[{'file_id':c['file_id'],'version_id':c['version_id'],'sha256':hashlib.sha256(c['raw']).hexdigest(),'page_number':1,'range':None}],
            'notes':[],'mode':'question','instruction':'Explicit synthetic question','choices':{'version':1,'runtime':'claude_cli','provider':'claude_code','model':'fixture-model','effort':None}}

def preview(c):return _json(c['client'].post(f"{ROOT}/{c['project_id']}/answer-previews",headers=HEADERS,json=body(c)))
def consent(c,p):return {'expected_vault_id':c['vault_id'],'expected_runtime_id':c['runtime_id'],'preview_id':p['preview_id'],'request_sha256':p['request_sha256'],'confirmed':True}
def send(c,p):return _json(c['client'].post(f"{ROOT}/{c['project_id']}/answers",headers=HEADERS,json=consent(c,p)),202)
def answer_url(c,a):return f"{ROOT}/{c['project_id']}/answers/{a['answer_id']}"
def query(c):return {'expected_vault_id':c['vault_id']}

def test_exact_seven_additive_routes_and_prebody_origin_guards(http_selected):
    c=http_selected;tree=ast.parse((Path(__file__).parents[1]/'resmon.py').read_text());routes=[];all_routes=[]
    for node in ast.walk(tree):
        if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)):
            for d in node.decorator_list:
                if isinstance(d,ast.Call) and isinstance(d.func,ast.Attribute) and isinstance(d.func.value,ast.Name) and d.func.value.id=='app' and d.args and isinstance(d.args[0],ast.Constant) and isinstance(d.args[0].value,str):
                    all_routes.append((d.func.attr,d.args[0].value))
                    if '/answer' in d.args[0].value:routes.append((d.func.attr,d.args[0].value))
    assert len(routes)==7 and len(all_routes)==165
    for method,path in routes:
        path=path.replace('{project_id}',c['project_id']).replace('{answer_id}',str(uuid.uuid4()))
        for headers in ({},{'Origin':'null','X-Resmon-Library':'1'},{'Origin':'https://other.invalid','X-Resmon-Library':'1'}):
            r=c['client'].request(method,path,headers=headers,content=b'not JSON')
            assert r.status_code==403 and r.headers['cache-control']=='no-store'
    assert not c['capture'].exists()

def test_real_http_preview_replay_sse_initial_terminal_and_saved_zip(http_selected):
    c=http_selected;p=preview(c);assert not c['capture'].exists()
    a=send(c,p);assert send(c,p)['answer_id']==a['answer_id']
    events=[]
    with c['client'].stream('GET',answer_url(c,a)+'/events',headers=HEADERS,params={**query(c),'expected_runtime_id':c['runtime_id']}) as stream:
        assert stream.status_code==200 and stream.headers['cache-control']=='no-store'
        for line in stream.iter_lines():
            if line.startswith('data: '):events.append(json.loads(line[6:]))
    assert events[0]['type']=='initial' and events[0]['sequence']==0 and events[0]['answer']['answer_id']==a['answer_id']
    assert events[-1]['type']=='terminal' and events[-1]['state']=='succeeded' and events[-1]['cleanup_state']=='confirmed'
    assert [e['sequence'] for e in events]==sorted(set(e['sequence'] for e in events))
    assert all((e['answer_id'],e['request_sha256'],e['owner_runtime_id'])==(a['answer_id'],p['request_sha256'],c['runtime_id']) for e in events)
    detail=_json(c['client'].get(answer_url(c,a),headers=HEADERS,params=query(c)))
    assert detail['result'] and detail['usage']['reported']['input_tokens']==0
    captured=json.loads(c['capture'].read_text());assert captured['prompt']==p['request']['user_prompt']
    assert 'private_native_session_id' not in json.dumps(detail) and 'owner_runtime_id' not in detail
    archive=c['client'].get(answer_url(c,a)+'/export',headers=HEADERS,params={**query(c),'format':'zip'})
    assert archive.status_code==200 and hashlib.sha256(archive.content).hexdigest()==archive.headers['X-Resmon-SHA256']
    with zipfile.ZipFile(io.BytesIO(archive.content)) as z:
        assert z.namelist()==['answer.json','answer.md','evidence.json']
        saved=json.loads(z.read('answer.json'));assert saved['answer_id']==a['answer_id']
    with sqlite3.connect(c['record']['database']) as conn:
        assert conn.execute('SELECT count(*) FROM evidence_answers').fetchone()[0]==1
        assert conn.execute('SELECT count(*) FROM assistant_sessions').fetchone()[0]==0
    (c['tmp']/'http-selected-evidence.json').write_text(json.dumps({'preview':p,'answer':detail,'events':events,'capture':captured},indent=2))

@pytest.mark.parametrize('fault',['unknown','duplicate','float','confirmation','query','runtime','hash'])
def test_strict_real_http_consent_refuses_no_admission(http_selected,fault):
    c=http_selected;p=preview(c);payload=consent(c,p);url=f"{ROOT}/{c['project_id']}/answers"
    if fault=='unknown':payload['question']='late edit'
    elif fault=='confirmation':payload['confirmed']=False
    elif fault=='runtime':payload['expected_runtime_id']=str(uuid.uuid4())
    elif fault=='hash':payload['request_sha256']='f'*64
    elif fault=='query':
        r=c['client'].get(url,headers=HEADERS,params={**query(c),'outside':'unapproved'});assert r.status_code==422;return
    elif fault=='float':payload['confirmed']=1.0
    raw=json.dumps(payload)
    if fault=='duplicate':raw=raw[:-1]+',"confirmed":true}'
    r=c['client'].post(url,headers={**HEADERS,'Content-Type':'application/json'},content=raw)
    assert r.status_code in (409,422),r.text
    assert not c['capture'].exists()
    with sqlite3.connect(c['record']['database']) as conn:assert conn.execute('SELECT count(*) FROM evidence_answers').fetchone()[0]==0

def test_http_stop_has_one_terminal_and_no_late_success(http_selected):
    c=http_selected;fake_cli(c['tmp'],fault='wait');p=preview(c);a=send(c,p)
    deadline=time.monotonic()+5
    while not c['capture'].exists():assert time.monotonic()<deadline;time.sleep(.01)
    start=time.monotonic();stopped=_json(c['client'].post(answer_url(c,a)+'/cancel',headers=HEADERS,json={'expected_vault_id':c['vault_id'],'expected_runtime_id':c['runtime_id']}))
    assert stopped['state']=='cancelled' and stopped['result'] is None
    while True:
        final=_json(c['client'].get(answer_url(c,a),headers=HEADERS,params=query(c)))
        if final['cleanup_state']=='confirmed':break
        assert time.monotonic()-start<5;time.sleep(.02)
    assert final['state']=='cancelled' and final['result'] is None
    assert _json(c['client'].post(answer_url(c,a)+'/cancel',headers=HEADERS,json={'expected_vault_id':c['vault_id'],'expected_runtime_id':c['runtime_id']}))==final


# Reuse the pre-existing HTTP regression verbatim, including its WRONG/CONFIRM
# calls and all old assertions. Add only a saved-answer preservation sentinel;
# this wrapper introduces no new admin request or erase/activation journey.
from test_library_boundary import http_library

def test_existing_confirmed_corpus_and_settings_regression_preserves_answer(http_library,monkeypatch):
    from test_library_boundary import test_real_stream_import_read_open_export_links_and_refusals as original_regression
    from test_evidence import Workspace
    from test_selected_evidence_export import completed
    from implementation_scripts import database as db,evidence as ev,selected_evidence as se
    client,record,tmp=http_library;post=client.post;sentinel={};observations=[]
    def observed_post(url,*args,**kwargs):
        if url=='/api/admin/erase-corpus' and not sentinel:
            conn=db.get_connection(record['database'])
            vault=dict(conn.execute('SELECT * FROM library_vault').fetchone());f=dict(conn.execute('SELECT * FROM library_files').fetchone())
            project=ev.create_project(conn,vault['vault_id'],'Authored retained-answer sentinel')['project']
            ev.add_file(conn,vault['vault_id'],project['project_id'],project['revision'],f['file_id'],f['version_id'])
            root=Path(vault['root_path']);fake=tmp/'selected-sentinel';fake.mkdir()
            w=Workspace(conn,Path(record['database']),root,tmp,vault['vault_id'],project['project_id'],1,[f])
            result=completed(w,fake);sentinel.update(conn=conn,w=w,result=result,rows=[tuple(r) for r in conn.execute('SELECT * FROM evidence_answers')],raw=(root/f['relative_path']).read_bytes(),file=root/f['relative_path'])
        response=post(url,*args,**kwargs)
        if url.startswith('/api/admin/'):
            assert [tuple(r) for r in sentinel['conn'].execute('SELECT * FROM evidence_answers')]==sentinel['rows']
            assert sentinel['file'].read_bytes()==sentinel['raw']
            w=sentinel['w'];assert se.detail(w.conn,w.vault_id,w.project_id,sentinel['result']['answer_id'])==sentinel['result']
            observations.append({'url':url,'confirmation':kwargs['json']['confirm'],'status':response.status_code,'answer_rows':len(sentinel['rows']),'preserved':True})
        return response
    monkeypatch.setattr(client,'post',observed_post)
    try:
        original_regression(http_library)
        assert observations==[{'url':'/api/admin/erase-corpus','confirmation':'WRONG','status':400,'answer_rows':1,'preserved':True},{'url':'/api/admin/erase-corpus','confirmation':'CONFIRM','status':200,'answer_rows':1,'preserved':True},{'url':'/api/admin/reset-settings','confirmation':'CONFIRM','status':200,'answer_rows':1,'preserved':True}]
        (tmp/'existing-regression-answer-preservation.json').write_text(json.dumps(observations,indent=2))
    finally:
        if sentinel:sentinel['conn'].close()
