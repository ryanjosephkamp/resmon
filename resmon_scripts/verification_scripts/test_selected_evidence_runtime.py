"""S10-S15/S23-S24: actual authored CLI processes and loopback HTTP families."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import time
import uuid

import pytest

from implementation_scripts import assistant_runtime as cli, assistant_api_runtime as api
from implementation_scripts import assistant_tool_calling, selected_evidence as se
from implementation_scripts import selected_evidence_context as ctx, selected_evidence_runtime as lane
from test_selected_evidence_context import workspace, available, selection, assemble
from test_selected_evidence import answer


def fake_cli(tmp_path: Path, *, fault: str = '') -> tuple[Path,Path]:
    binary=tmp_path/'selected-fake-cli';capture=tmp_path/'captured-cli.json'
    code='''import json,os,sys,time,subprocess,datetime
from pathlib import Path
args=sys.argv[1:]
def arg(key):return args[args.index(key)+1]
native=arg('--session-id')
config=json.loads(Path(arg('--mcp-config')).read_text())
Path(CAPTURE).write_text(json.dumps({'pid':os.getpid(),'parent_pid':os.getppid(),'process_start':subprocess.check_output(['ps','-p',str(os.getpid()),'-o','lstart='],text=True).strip(),'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'argv':args,'cwd':os.getcwd(),'env':dict(os.environ),'config':config,'prompt':args[-1]}))
message={'type':'system','subtype':'init','session_id':native,'tools':[],'mcp_servers':[],'model':'literal-fixture-model'}
if FAULT=='missing_inventory':del message['tools']
if FAULT=='missing_identity':del message['session_id']
if FAULT=='wrong_identity':message['session_id']='00000000-0000-4000-8000-000000000000'
if FAULT=='tools':message['tools']=['forbidden']
print(json.dumps(message),flush=True)
if FAULT=='wait':time.sleep(20)
if FAULT=='tool_call':print(json.dumps({'type':'assistant','message':{'content':[{'type':'tool_use','name':'forbidden','input':{}}]}}),flush=True)
if FAULT=='stderr':sys.stderr.write('x'*20000);sys.stderr.flush()
if FAULT=='line':print('x'*262145,flush=True)
outer=json.loads(args[-1]);p=outer['payload'];source=p['sources'][0];quote=source['text'][:8]
result={'version':1,'request_sha256':outer['request_sha256'],'mode':p['mode'],'status':'answer','sections':[{'kind':'summary','items':[{'kind':'source_statement','text':'Authored synthetic answer','citations':[{'source_id':source['source_id'],'start_codepoint':source['start_codepoint'],'end_codepoint':source['start_codepoint']+len(quote),'quote':quote}],'note_ids':[]}]}],'limitations':['Synthetic fixture; semantic support unchecked.']}
print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':json.dumps(result)}]}}),flush=True)
if FAULT!='missing_done':print(json.dumps({'type':'result','subtype':'success','is_error':False,'total_cost_usd':0.01,'usage':{'input_tokens':0,'output_tokens':12}}),flush=True)
'''
    code='#!'+sys.executable+'\nCAPTURE='+repr(str(capture))+'\nFAULT='+repr(fault)+'\n'+code
    binary.write_text(code);binary.chmod(0o700)
    return binary,capture


def test_actual_cli_profile_captures_exact_system_prompt_flags_empty_tools_and_fresh_id(workspace,available,tmp_path,monkeypatch):
    request,_,_=assemble(workspace,selection(workspace));binary,capture=fake_cli(tmp_path)
    monkeypatch.setenv('SYNTHETIC_CREDENTIAL_CANARY','SYNTHETIC_NOT_A_SECRET')
    runtime=cli.ClaudeCliRuntime(cli_path=str(binary),model='literal requested model',effort='high',profile=se.PROFILE)
    native=str(uuid.uuid4());events=list(runtime.run_turn(-1,request['user_prompt'],cli_session_id=native,resume=False))
    data=json.loads(capture.read_text());args=data['argv']
    assert args[-1]==request['user_prompt']
    assert args[args.index('--append-system-prompt')+1]==request['system_text']
    assert data['config']=={'mcpServers':{}}
    assert args[args.index('--tools')+1]=='' and args[args.index('--setting-sources')+1]==''
    assert args[args.index('--session-id')+1]==native and '--resume' not in args
    assert '--allowedTools' not in args and '--permission-prompt-tool' not in args
    assert args[args.index('--model')+1]=='literal requested model' and args[args.index('--effort')+1]=='high'
    assert 'SYNTHETIC_CREDENTIAL_CANARY' not in data['env']
    assert not any(k.startswith('RESMON_') for k in data['env'])
    assert not Path(data['cwd']).exists() and not cli.is_running(-1)
    assert events[-1]['type']=='done' and not any(e['type']=='error' for e in events)
    raw=''.join(e['text'] for e in events if e['type']=='text_delta')
    assert se.validate_result(raw,request)['status']=='answer'


@pytest.mark.parametrize('fault',['missing_inventory','missing_identity','wrong_identity','tools','tool_call','stderr','line','missing_done'])
def test_cli_faults_fail_without_retry_and_reap(workspace,available,tmp_path,fault):
    request,_,_=assemble(workspace,selection(workspace));binary,capture=fake_cli(tmp_path,fault=fault)
    runtime=cli.ClaudeCliRuntime(cli_path=str(binary),profile=se.PROFILE)
    events=list(runtime.run_turn(-4,request['user_prompt'],cli_session_id=str(uuid.uuid4()),resume=False))
    assert any(e['type']=='error' for e in events) and not cli.is_running(-4)
    assert capture.exists() and '--resume' not in json.loads(capture.read_text())['argv']


def test_cli_actual_stop_before_late_success(workspace,available,tmp_path):
    request,_,_=assemble(workspace,selection(workspace));binary,capture=fake_cli(tmp_path,fault='wait')
    runtime=cli.ClaudeCliRuntime(cli_path=str(binary),profile=se.PROFILE);events=[]
    worker=threading.Thread(target=lambda:events.extend(runtime.run_turn(-5,request['user_prompt'],cli_session_id=str(uuid.uuid4()),resume=False)))
    worker.start()
    deadline=time.monotonic()+5
    while not capture.exists() and time.monotonic()<deadline:time.sleep(.01)
    assert capture.exists();start=time.monotonic();assert runtime.cancel(-5)
    worker.join(5)
    assert not worker.is_alive() and time.monotonic()-start<5 and not cli.is_running(-5)
    assert not any(e['type']=='done' for e in events)


@contextmanager
def responder(body: dict, *, status=200, delay=0):
    captures=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            raw=self.rfile.read(int(self.headers['Content-Length']))
            captures.append({'method':'POST','path':self.path.replace('SYNTHETIC_API_CANARY','[synthetic-key]'),
                             'headers':{k:('[synthetic-key]' if k.lower() in ('authorization','x-api-key') else v) for k,v in self.headers.items()},
                             'raw':raw.decode(),'body':json.loads(raw)})
            data=json.dumps(body).encode()
            self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers()
            if delay:time.sleep(delay)
            try:self.wfile.write(data)
            except (BrokenPipeError,ConnectionResetError):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    assert server.server_port!=8742
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:yield f'http://127.0.0.1:{server.server_port}',captures
    finally:
        server.shutdown();server.server_close();thread.join(5)
        out=os.environ.get('RESMON_E2E_SCREENSHOT_DIR')
        if out:
            target=Path(out);target.mkdir(parents=True,exist_ok=True)
            (target/('selected-api-request-'+str(uuid.uuid4())+'.json')).write_text(json.dumps({'server_pid':os.getpid(),'thread_id':thread.ident,'base':f'http://127.0.0.1:{server.server_port}','captures':captures,'status':status,'delay':delay,'cleanup':'server closed; responder thread joined','thread_alive':thread.is_alive()},indent=2))


def provider_response(family: str, raw: str, *, tool=False, completion=True):
    if family=='anthropic':return {'model':'reported-fixture','content':[{'type':'tool_use','name':'forbidden','input':{}}] if tool else [{'type':'text','text':raw}], 'stop_reason':'end_turn' if completion else 'max_tokens','usage':{'input_tokens':0,'output_tokens':12}}
    if family=='google':return {'modelVersion':'reported-google-fixture','candidates':[{'content':{'parts':[{'functionCall':{'name':'forbidden','args':{}}}] if tool else [{'text':raw}]},'finishReason':'STOP' if completion else 'MAX_TOKENS'}],'usageMetadata':{'promptTokenCount':0,'candidatesTokenCount':12}}
    return {'model':'reported-fixture','choices':[{'message':{'tool_calls':[{'id':'t','function':{'name':'forbidden','arguments':'{}'}}]} if tool else {'content':raw},'finish_reason':'stop' if completion else 'length'}],'usage':{'prompt_tokens':0,'completion_tokens':12}}


OFFERED=[(name,value.family) for name,value in assistant_tool_calling.PROVIDER_TOOL_CALLING.items() if value.offered]


@pytest.mark.parametrize('provider,family',OFFERED)
def test_all_eight_offered_descriptors_actual_three_family_http(workspace,available,provider,family):
    assert len(OFFERED)==8 and {f for _,f in OFFERED}=={'anthropic','google','openai'}
    request,_,_=assemble(workspace,selection(workspace,choices={'version':1,'runtime':'api_key','provider':provider,'model':'requested-fixture','effort':None}));raw=se.canonical(answer(request))
    assert request['payload']['requested']['runtime']=='api_key' and request['payload']['requested']['provider']==provider
    assert request['payload']['requested']['requested_model']=='requested-fixture' and request['payload']['requested']['requested_effort'] is None
    with responder(provider_response(family,raw)) as (base,captured):
        runtime=api.ApiKeyRuntime(provider=provider,model='requested-fixture',base_url=base,custom_base_url=base,api_key='SYNTHETIC_API_CANARY',profile=se.PROFILE)
        events=list(runtime.run_turn(-9,request['user_prompt']))
    assert len(captured)==1 and events[-1]['type']=='done' and not any(e['type']=='error' for e in events)
    body=captured[0]['body'];assert 'tools' not in body and 'tool_choice' not in body
    if family=='anthropic':
        assert body['system']==request['system_text'] and body['messages']==[{'role':'user','content':request['user_prompt']}]
        assert body['model']=='requested-fixture'
    elif family=='google':
        assert body['system_instruction']=={'parts':[{'text':request['system_text']}]}
        assert body['contents']==[{'role':'user','parts':[{'text':request['user_prompt']}]}]
        assert '/models/requested-fixture:generateContent' in captured[0]['path']
    else:
        assert body['messages']==[{'role':'system','content':request['system_text']},{'role':'user','content':request['user_prompt']}]
        assert body['model']=='requested-fixture'
    reports=[e['model_report'] for e in events if 'model_report' in e]
    assert len(reports)==1 and reports[0]['model']==('reported-google-fixture' if family=='google' else 'reported-fixture')
    out=os.environ.get('RESMON_E2E_SCREENSHOT_DIR')
    if out:
        target=Path(out);target.mkdir(parents=True,exist_ok=True)
        (target/('selected-offered-'+provider+'.json')).write_text(json.dumps({'provider':provider,'family':family,'request':request,'captures':captured,'events':events,'report':reports[0],'one_request':len(captured)==1,'live_compatibility':'untested'},indent=2))


@pytest.mark.parametrize('family,provider',[('anthropic','anthropic'),('openai','openai'),('google','google')])
@pytest.mark.parametrize('fault',['tool','completion','body_limit','http_error'])
def test_api_faults_one_request_no_dispatch(workspace,available,family,provider,fault,monkeypatch):
    request,_,_=assemble(workspace,selection(workspace));raw=se.canonical(answer(request))
    body=provider_response(family,raw,tool=fault=='tool',completion=fault!='completion')
    if fault=='body_limit':body['oversized']='a'*1048577
    with responder(body,status=503 if fault=='http_error' else 200) as (base,captured):
        runtime=api.ApiKeyRuntime(provider=provider,model='fixture',base_url=base,api_key='SYNTHETIC_API_CANARY',profile=se.PROFILE)
        monkeypatch.setattr(runtime,'_run_one_tool',lambda *a:pytest.fail('No selected tool dispatch is allowed'))
        events=list(runtime.run_turn(-8,request['user_prompt']))
    assert len(captured)==1 and any(e['type']=='error' for e in events)
    assert not any(e['type']=='done' for e in events)


def real_lane(w,tmp_path):
    binary,capture=fake_cli(tmp_path)
    owner=str(uuid.uuid4())
    value=lane.Lane(str(w.database),owner,45671,lambda c:{'ai_cli_path':str(binary)})
    body=selection(w,expected_runtime_id=owner)
    return value,body,capture


def admitted(w,value,body):
    preview=value.preview(w.conn,w.project_id,body,threading.Event())
    send={'expected_vault_id':w.vault_id,'expected_runtime_id':value.runtime_id,'preview_id':preview['preview_id'],
          'request_sha256':preview['request_sha256'],'confirmed':True}
    result=value.send(w.conn,w.project_id,send,threading.Event())
    return preview,send,result


def test_preview_close_no_invocation_then_send_replay_one_answer(workspace,tmp_path):
    value,body,capture=real_lane(workspace,tmp_path)
    preview=value.preview(workspace.conn,workspace.project_id,body,threading.Event())
    assert not capture.exists() and workspace.conn.execute('SELECT count(*) FROM evidence_answers').fetchone()[0]==0
    send={'expected_vault_id':workspace.vault_id,'expected_runtime_id':value.runtime_id,'preview_id':preview['preview_id'],
          'request_sha256':preview['request_sha256'],'confirmed':True}
    result=value.send(workspace.conn,workspace.project_id,send,threading.Event())
    job=value.subscribe(result['answer_id'],workspace.vault_id,workspace.project_id,value.runtime_id)
    seen=[]
    while not job.completed.is_set():
        event=value.next_event(job)
        if event:seen.append(event)
    assert job.completed.wait(5)
    saved=se.detail(workspace.conn,workspace.vault_id,workspace.project_id,result['answer_id'])
    assert saved['state']=='succeeded' and saved['cleanup_state']=='confirmed'
    assert value.send(workspace.conn,workspace.project_id,send,threading.Event())['answer_id']==result['answer_id']
    assert workspace.conn.execute('SELECT count(*) FROM evidence_answers').fetchone()[0]==1
    assert workspace.conn.execute('SELECT count(*) FROM assistant_sessions').fetchone()[0]==0
    assert capture.exists() and seen and all(e['answer_id']==result['answer_id'] for e in seen)
    assert list(sorted(e['sequence'] for e in seen))==[e['sequence'] for e in seen]
    value.shutdown()


@pytest.mark.parametrize('fault',['digest','runtime','expired','note_change','rules','selected_note_edit','member_removed','retained_changed','route_changed'])
def test_admission_rechecks_frozen_preview_before_any_process(workspace,tmp_path,monkeypatch,fault):
    value,body,capture=real_lane(workspace,tmp_path)
    if fault=='selected_note_edit':
        from test_evidence import save_note,revision
        note=save_note(workspace,workspace.files[0],'Explicit selected body')
        body.update(expected_revision=revision(workspace),notes=[{'note_id':note['note_id'],'expected_note_revision':note['revision']}])
    preview=value.preview(workspace.conn,workspace.project_id,body,threading.Event())
    send={'expected_vault_id':workspace.vault_id,'expected_runtime_id':value.runtime_id,'preview_id':preview['preview_id'],
          'request_sha256':preview['request_sha256'],'confirmed':True}
    if fault=='digest':send['request_sha256']='0'*64
    elif fault=='runtime':send['expected_runtime_id']=str(uuid.uuid4())
    elif fault=='expired':value.previews[preview['preview_id']].expires=0
    elif fault=='note_change':
        from test_evidence import save_note
        save_note(workspace,workspace.files[0],'A later note')
    elif fault=='selected_note_edit':
        se.ev.edit_note(workspace.conn,workspace.vault_id,workspace.project_id,body['expected_revision'],note['note_id'],note['revision'],'Changed after preview')
    elif fault=='member_removed':
        f=workspace.files[0];se.ev.remove_file(workspace.conn,workspace.vault_id,workspace.project_id,body['expected_revision'],f['file_id'],f['version_id'])
    elif fault=='retained_changed':
        f=workspace.files[0];row=workspace.conn.execute('SELECT relative_path FROM library_files WHERE file_id=?',(f['file_id'],)).fetchone();retained=workspace.root/row[0];original_bytes=retained.read_bytes();retained.write_bytes(b'Changed retained bytes after preview')
    elif fault=='route_changed':value.settings=lambda c:{'ai_cli_path':'/authored/missing/new-cli'}
    else:monkeypatch.setattr(ctx,'system_rules',lambda:'A changed system asset')
    try:
        with pytest.raises(Exception):value.send(workspace.conn,workspace.project_id,send,threading.Event())
        assert not capture.exists() and workspace.conn.execute('SELECT count(*) FROM evidence_answers').fetchone()[0]==0
    finally:
        if fault=='retained_changed':retained.write_bytes(original_bytes);assert retained.read_bytes()==original_bytes
        value.shutdown()


def test_second_subscriber_and_wrong_cancel_cannot_own_job(workspace,tmp_path):
    value,body,capture=real_lane(workspace,tmp_path)
    _,_,result=admitted(workspace,value,body)
    job=value.subscribe(result['answer_id'],workspace.vault_id,workspace.project_id,value.runtime_id)
    with pytest.raises(Exception):value.subscribe(result['answer_id'],workspace.vault_id,workspace.project_id,value.runtime_id)
    with pytest.raises(Exception):value.cancel(result['answer_id'],workspace.vault_id,workspace.project_id,str(uuid.uuid4()))
    while not job.completed.is_set():value.next_event(job)
    value.shutdown()


def test_api_actual_stop_closes_delayed_owned_response(workspace,available):
    request,_,_=assemble(workspace,selection(workspace));raw=se.canonical(answer(request))
    with responder(provider_response('openai',raw),delay=2) as (base,captured):
        runtime=api.ApiKeyRuntime(provider='openai',model='fixture',base_url=base,api_key='SYNTHETIC_API_CANARY',profile=se.PROFILE)
        events=[];worker=threading.Thread(target=lambda:events.extend(runtime.run_turn(-90,request['user_prompt'])))
        worker.start();deadline=time.monotonic()+5
        while not captured and time.monotonic()<deadline:time.sleep(.01)
        assert captured;started=time.monotonic();assert runtime.cancel(-90)
        worker.join(6)
        assert not worker.is_alive() and time.monotonic()-started<6
        assert not any(e['type']=='done' for e in events)
        assert runtime._selected_client is None and runtime._selected_response is None


def test_four_preview_limit_and_restart_expiry_without_any_runtime(workspace,tmp_path):
    value,body,capture=real_lane(workspace,tmp_path)
    previews=[value.preview(workspace.conn,workspace.project_id,body,threading.Event()) for _ in range(4)]
    assert len(value.previews)==4 and not capture.exists()
    with pytest.raises(Exception):value.preview(workspace.conn,workspace.project_id,body,threading.Event())
    for p in value.previews.values():p.expires=0
    fresh=value.preview(workspace.conn,workspace.project_id,body,threading.Event());assert len(value.previews)==1
    value.shutdown();restarted=lane.Lane(str(workspace.database),str(uuid.uuid4()),value.port,value.settings)
    send={'expected_vault_id':workspace.vault_id,'expected_runtime_id':restarted.runtime_id,'preview_id':fresh['preview_id'],'request_sha256':fresh['request_sha256'],'confirmed':True}
    with pytest.raises(Exception):restarted.send(workspace.conn,workspace.project_id,send,threading.Event())
    assert not capture.exists() and workspace.conn.execute('SELECT count(*) FROM evidence_answers').fetchone()[0]==0
    restarted.shutdown()


def test_two_real_connections_race_one_consent_without_second_process(workspace,tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from implementation_scripts import database
    value,body,capture=real_lane(workspace,tmp_path);p=value.preview(workspace.conn,workspace.project_id,body,threading.Event())
    consent={'expected_vault_id':workspace.vault_id,'expected_runtime_id':value.runtime_id,'preview_id':p['preview_id'],'request_sha256':p['request_sha256'],'confirmed':True}
    barrier=threading.Barrier(2)
    def send_one():
        conn=database.get_connection(workspace.database)
        try:
            barrier.wait()
            try:return value.send(conn,workspace.project_id,consent,threading.Event())
            except se.ev.EvidenceError as e:return e.reason
        finally:conn.close()
    with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:send_one(),range(2)))
    accepted=[r for r in results if isinstance(r,dict)];assert accepted and len({a['answer_id'] for a in accepted})==1
    job=value.subscribe(accepted[0]['answer_id'],workspace.vault_id,workspace.project_id,value.runtime_id)
    while not job.completed.is_set():value.next_event(job)
    assert value.send(workspace.conn,workspace.project_id,consent,threading.Event())['answer_id']==accepted[0]['answer_id']
    assert workspace.conn.execute('SELECT count(*) FROM evidence_answers').fetchone()[0]==1 and capture.exists()
    value.shutdown()


def test_two_connections_terminal_cas_one_winner_and_no_late_rewrite(workspace,tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from implementation_scripts import database
    from test_selected_evidence_export import completed
    original=completed(workspace,tmp_path);r=dict(workspace.conn.execute('SELECT * FROM evidence_answers').fetchone());r.pop('id');r.update(answer_id=str(uuid.uuid4()),preview_id=str(uuid.uuid4()),state='running',finished_at_utc=None,result_json=None,partial_text='durable prefix',cleanup_state='pending')
    workspace.conn.execute('INSERT INTO evidence_answers ('+','.join(r)+') VALUES ('+','.join('?' for _ in r)+')',tuple(r.values()));workspace.conn.commit();barrier=threading.Barrier(2)
    def finish(state):
        conn=database.get_connection(workspace.database)
        try:
            barrier.wait();return se.finish(conn,r['answer_id'],r['owner_runtime_id'],state,partial=state,reports=[],result=original['result'] if state=='succeeded' else None)
        finally:conn.close()
    with ThreadPoolExecutor(max_workers=2) as pool:winners=list(pool.map(finish,['succeeded','cancelled']))
    assert sorted(winners)==[False,True];before=dict(workspace.conn.execute('SELECT * FROM evidence_answers WHERE answer_id=?',(r['answer_id'],)).fetchone())
    for state in se.TERMINAL:
        assert not se.finish(workspace.conn,r['answer_id'],r['owner_runtime_id'],state,partial='LATE',reports=[])
    assert dict(workspace.conn.execute('SELECT * FROM evidence_answers WHERE answer_id=?',(r['answer_id'],)).fetchone())==before
    assert se.detail(workspace.conn,workspace.vault_id,workspace.project_id,original['answer_id'])==original


def test_bounded_event_queue_cancels_at_seventeenth_and_never_enqueues_more(workspace,tmp_path,monkeypatch):
    from types import SimpleNamespace
    value,body,capture=real_lane(workspace,tmp_path);request,_,_=assemble(workspace,body)
    job=lane.Job(1,str(uuid.uuid4()),workspace.project_id,workspace.vault_id,request['request_sha256'],value.runtime_id,SimpleNamespace(),str(uuid.uuid4()),request)
    stopped=[];monkeypatch.setattr(value,'cancel',lambda *args:stopped.append(args))
    for _ in range(16):value._publish(job,'progress',state='running')
    assert job.events.qsize()==16 and not stopped
    value._publish(job,'progress',state='running');assert job.events.qsize()==16 and len(stopped)==1
    assert job.queued_bytes<=262144 and not capture.exists();value.shutdown()


def test_missing_subscriber_timer_cancels_real_owned_cli(workspace,tmp_path,monkeypatch):
    assert lane.SUBSCRIBER_SECONDS==30
    monkeypatch.setattr(lane,'SUBSCRIBER_SECONDS',.2) # virtualized lease duration, actual process/reap
    binary,capture=fake_cli(tmp_path,fault='wait');owner=str(uuid.uuid4());value=lane.Lane(str(workspace.database),owner,45671,lambda c:{'ai_cli_path':str(binary)})
    _,_,a=admitted(workspace,value,selection(workspace,expected_runtime_id=owner));assert value.job.completed.wait(5)
    saved=se.detail(workspace.conn,workspace.vault_id,workspace.project_id,a['answer_id']);assert saved['state']=='cancelled' and saved['cleanup_state']=='confirmed' and not cli.is_running(-saved['id'])
    value.shutdown()


@pytest.mark.parametrize('fault',['aggregate','text_limit','trailing_done','deadline'])
def test_actual_cli_remaining_bounds_and_no_success_on_late_stream(workspace,available,tmp_path,fault,monkeypatch):
    request,_,_=assemble(workspace,selection(workspace));binary,capture=fake_cli(tmp_path)
    code=binary.read_text()
    if fault=='aggregate':injection="for _ in range(110):print(json.dumps({'type':'system','subtype':'status','padding':'x'*10000}),flush=True)\n"
    elif fault=='text_limit':injection="print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'x'*65537}]}}),flush=True)\n"
    elif fault=='deadline':injection='time.sleep(2)\n'
    else:injection=''
    code=code.replace("outer=json.loads(args[-1])",injection+"outer=json.loads(args[-1])")
    if fault=='trailing_done':code+="\nprint(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'LATE'}]}}),flush=True)\n"
    binary.write_text(code);runtime=cli.ClaudeCliRuntime(cli_path=str(binary),profile=se.PROFILE,timeout=300)
    if fault=='deadline':
        from types import SimpleNamespace
        actual_time=cli.time
        # Advance only this runtime's clock after the child records startup.
        # This tests the fixed 300-second guard without a startup-speed race.
        monkeypatch.setattr(cli,'time',SimpleNamespace(monotonic=lambda:actual_time.monotonic()+(301 if capture.exists() else 0),sleep=actual_time.sleep))
    events=list(runtime.run_turn(-88,request['user_prompt'],cli_session_id=str(uuid.uuid4()),resume=False))
    assert any(e['type']=='error' for e in events) and not cli.is_running(-88)
    assert capture.exists() and '--resume' not in json.loads(capture.read_text())['argv']


@pytest.mark.parametrize('fault',['worker_start','timer_start'])
def test_startup_failure_never_falsely_confirms_a_live_worker(workspace,tmp_path,monkeypatch,fault):
    from types import SimpleNamespace
    entered=threading.Event();release=threading.Event()
    class OwnedRuntime:
        kind='claude_cli'
        def status(self):return SimpleNamespace(available=True)
        def run_turn(self,*args,**kwargs):
            entered.set();release.wait(5)
            yield {'type':'error'}
        def cancel(self,job):release.set();return True
    runtime=OwnedRuntime();monkeypatch.setattr(cli,'get_bound_runtime',lambda *a,**k:runtime)
    owner=str(uuid.uuid4());value=lane.Lane(str(workspace.database),owner,45671,lambda c:{})
    original=threading.Thread.start
    def start(thread):
        if fault=='worker_start' and thread.name=='selected-evidence-answer':raise RuntimeError('Authored worker startup failure')
        if fault=='timer_start' and isinstance(thread,threading.Timer):
            assert entered.wait(5);raise RuntimeError('Authored lease startup failure')
        return original(thread)
    monkeypatch.setattr(threading.Thread,'start',start)
    _,_,a=admitted(workspace,value,selection(workspace,expected_runtime_id=owner))
    assert value.job.completed.wait(5)
    saved=se.detail(workspace.conn,workspace.vault_id,workspace.project_id,a['answer_id'])
    assert saved['state']=='failed' and saved['cleanup_state']=='confirmed'
    assert not value.job.thread.is_alive();value.shutdown()


def test_actual_preview_cache_byte_pressure_refuses_before_four(workspace,available,tmp_path):
    from test_evidence import put_file,save_note
    f=put_file(workspace,'preview-cache.txt',b'a'*20000)
    anchor={'page_number':1,'extraction_contract':se.ev.TEXT_CONTRACT,'page_text_sha256':se.sha('a'*20000),'start_codepoint':0,'end_codepoint':20000,'quote':'a'*20000}
    notes=[save_note(workspace,f,'owner note',anchor=anchor) for _ in range(3)]
    notes.append(save_note(workspace,f,'owner note',anchor={**anchor,'end_codepoint':6000,'quote':'a'*6000}))
    owner=str(uuid.uuid4());value=lane.Lane(str(workspace.database),owner,45671,lambda c:{})
    body=selection(workspace,expected_runtime_id=owner,selections=[{'file_id':f['file_id'],'version_id':f['version_id'],'sha256':f['sha256'],'page_number':1,'range':None}],notes=[{'note_id':n['note_id'],'expected_note_revision':1} for n in notes])
    for _ in range(2):value.preview(workspace.conn,workspace.project_id,body,threading.Event())
    resident=sum(p.size() for p in value.previews.values());assert 262144<resident<=524288
    with pytest.raises(se.ev.EvidenceError,match='512 KiB'):value.preview(workspace.conn,workspace.project_id,body,threading.Event())
    assert len(value.previews)==2 and sum(p.size() for p in value.previews.values())==resident;value.shutdown()


@pytest.mark.parametrize('limit,accepted',[(262144,True),(262145,False)])
def test_event_queue_exact_serialized_byte_ceiling(workspace,tmp_path,monkeypatch,limit,accepted):
    from types import SimpleNamespace
    value,body,capture=real_lane(workspace,tmp_path);request,_,_=assemble(workspace,body)
    job=lane.Job(1,str(uuid.uuid4()),workspace.project_id,workspace.vault_id,request['request_sha256'],value.runtime_id,SimpleNamespace(),str(uuid.uuid4()),request)
    stopped=[];monkeypatch.setattr(value,'cancel',lambda *args:stopped.append(args))
    envelope={'type':'progress','sequence':1,'answer_id':job.answer_id,'request_sha256':job.request_sha256,'project_id':job.project_id,'vault_id':job.vault_id,'owner_runtime_id':job.owner,'fixture_padding':''}
    padding='p'*(limit-len(se.canonical(envelope).encode()));value._publish(job,'progress',fixture_padding=padding)
    assert job.events.qsize()==int(accepted) and len(stopped)==int(not accepted)
    assert job.queued_bytes==(limit if accepted else 0) and not capture.exists();value.shutdown()


@pytest.mark.parametrize('kind,extra',[('count',0),('count',1),('bytes',0),('bytes',1)])
def test_runtime_report_count_and_serialized_byte_bounds(workspace,tmp_path,monkeypatch,kind,extra):
    from types import SimpleNamespace
    from test_selected_evidence_export import completed,seed_snapshot
    original=completed(workspace,tmp_path);owner=str(uuid.uuid4());value=lane.Lane(str(workspace.database),owner,45671,lambda c:{})
    identity=seed_snapshot(workspace,original,1,state='admitted',finished_at_utc=None,started_at_utc=None,result_json=None,partial_text='',reports_json='[]',owner_runtime_id=owner,cleanup_state='not_started')[0]
    row=workspace.conn.execute('SELECT * FROM evidence_answers WHERE answer_id=?',(identity,)).fetchone()
    observation={'model':'m','source':'api_response_model','observed_at_utc':'2026-09-12T00:00:00.000000+00:00'}
    if kind=='count':reports=[dict(observation) for _ in range(64+extra)]
    else:
        reports=[{**observation,'model':'m'*900} for _ in range(16)]
        current=len(se.canonical(reports).encode());needed=16384-current
        assert 0<needed<1000
        reports[-1]['model']+='m'*(needed+extra)
        # Spread any >1000 final model across the earlier reports.
        over=len(reports[-1]['model'])-1000
        if over>0:
            reports[-1]['model']=reports[-1]['model'][:-over]
            for r in reports[:-1]:
                moved=min(over,1000-len(r['model']));r['model']+='m'*moved;over-=moved
            assert over==0
        assert max(len(r['model']) for r in reports)<=1000 and len(se.canonical(reports).encode())==16384+extra
    def turn(*args,**kwargs):
        for observation in reports:yield {'type':'model_report','model_report':observation}
        yield {'type':'text_delta','text':se.canonical(original['result'])}
        yield {'type':'done','subtype':'success'}
    runtime=SimpleNamespace(run_turn=turn,cancel=lambda _:True)
    job=lane.Job(row['id'],identity,workspace.project_id,workspace.vault_id,original['request_sha256'],owner,runtime,str(uuid.uuid4()),original['request']);value.job=job
    # Report limits are a separate domain boundary from the independently
    # exercised event queue; collect publications synchronously here.
    publications=[];monkeypatch.setattr(value,'_publish',lambda j,k,**v:publications.append((k,v)))
    value._run(job);saved=se.detail(workspace.conn,workspace.vault_id,workspace.project_id,identity)
    assert saved['state']==('succeeded' if not extra else 'failed') and saved['cleanup_state']=='confirmed'
    assert len(saved['reports'])<=64 and len(se.canonical(saved['reports']).encode())<=16384
    assert saved['result']==(original['result'] if not extra else None)
    assert job.completed.is_set() and publications[-1][0]=='terminal';value.shutdown()


@pytest.mark.parametrize('family,provider',[('anthropic','anthropic'),('openai','openai'),('google','google')])
@pytest.mark.parametrize('extra',[0,1])
def test_actual_api_exact_one_mib_transport_boundary(workspace,available,family,provider,extra):
    request,_,_=assemble(workspace,selection(workspace));body=provider_response(family,se.canonical(answer(request)))
    body['fixture_padding']='';body['fixture_padding']='p'*(1048576+extra-len(json.dumps(body).encode()))
    assert len(json.dumps(body).encode())==1048576+extra
    with responder(body) as (base,captured):
        runtime=api.ApiKeyRuntime(provider=provider,model='fixture',base_url=base,api_key='SYNTHETIC_API_CANARY',profile=se.PROFILE)
        events=list(runtime.run_turn(-13,request['user_prompt']))
    assert len(captured)==1
    assert any(e['type']=='error' for e in events)==bool(extra)
    assert any(e['type']=='done' for e in events)==(not extra)


@pytest.mark.parametrize('fault',['stop','deadline'])
def test_actual_continuous_api_stream_stops_with_owned_cleanup(workspace,available,fault,monkeypatch,tmp_path):
    from types import SimpleNamespace
    request,_,_=assemble(workspace,selection(workspace));captured=[];streaming=threading.Event();closed=threading.Event()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            raw=self.rfile.read(int(self.headers['Content-Length']));captured.append(json.loads(raw))
            self.send_response(200);self.send_header('Transfer-Encoding','chunked');self.end_headers()
            try:
                for _ in range(1000):
                    self.wfile.write(b'1\r\n \r\n');self.wfile.flush();streaming.set();time.sleep(.01)
                self.wfile.write(b'0\r\n\r\n')
            except (BrokenPipeError,ConnectionResetError):pass
            finally:closed.set()
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);assert server.server_port!=8742
    serving=threading.Thread(target=server.serve_forever);serving.start();runtime=api.ApiKeyRuntime(provider='openai',model='fixture',base_url=f'http://127.0.0.1:{server.server_port}',api_key='SYNTHETIC_API_CANARY',profile=se.PROFILE)
    original_clock=api.time.monotonic
    if fault=='deadline':monkeypatch.setattr(api,'time',SimpleNamespace(monotonic=lambda:original_clock()+(301 if streaming.is_set() else 0)))
    events=[];worker=threading.Thread(target=lambda:events.extend(runtime.run_turn(-14,request['user_prompt'])));start=time.monotonic();worker.start()
    try:
        assert streaming.wait(5)
        if fault=='stop':assert runtime.cancel(-14)
        worker.join(5);assert not worker.is_alive() and time.monotonic()-start<5
        assert closed.wait(5) and len(captured)==1 and any(e['type']=='error' for e in events) and not any(e['type']=='done' for e in events)
        assert runtime._selected_client is None and runtime._selected_response is None
        (tmp_path/'continuous-api-custody.json').write_text(json.dumps({'port':server.server_port,'fault':fault,'request':captured[0],'events':events,'elapsed':time.monotonic()-start,'cleanup':'owned continuous response closed, no retry'}))
    finally:
        runtime.cancel(-14);worker.join(5);server.shutdown();server.server_close();serving.join(5)
