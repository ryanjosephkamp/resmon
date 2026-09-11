"""Real HTTP Library transport in a run-owned uvicorn instance, without providers.

All nine new routes are driven over a real socket. This is browser Origin
protection, not authentication of another local process forging that header.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import uuid
import httpx
import pytest

ROUTES=[('GET',''),('POST','/vault'),('GET','/files'),('POST','/files'),('GET','/files/{file}'),('POST','/files/{file}/paper-links'),('POST','/files/{file}/open'),('GET','/export'),('GET','/files/{file}/text')]
HEADERS={'Origin':'http://127.0.0.1:12345','X-Resmon-Library':'1'}


@pytest.fixture
def http_library(tmp_path, request):
    state=tmp_path/'state';state.mkdir();reports=state/'reports';reports.mkdir()
    repo=Path(__file__).parents[2];backend=repo/'resmon_scripts';port_file=state/'resmon.port'
    env=dict(os.environ);env.update({'RESMON_STATE_DIR':str(state),'RESMON_DB_PATH':str(state/'resmon.db'),'RESMON_REPORTS_DIR':str(reports),'RESMON_PORT_FILE':str(port_file),'RESMON_DISABLE_SCHEDULER':'1','PYTHON_KEYRING_BACKEND':'keyring.backends.null.Keyring'})
    script='''import socket,sys,os,json,datetime
import uvicorn,resmon
from implementation_scripts import library
if sys.argv[2] != 'production': library.MAX_FILE_BYTES=int(sys.argv[2])
s=socket.socket();s.bind(('127.0.0.1',0));s.listen(128)
port=s.getsockname()[1]
assert port!=8742
with open(sys.argv[1],'w') as f:json.dump({'pid':os.getpid(),'port':port,'source':os.getcwd(),'state':os.environ['RESMON_STATE_DIR'],'database':os.environ['RESMON_DB_PATH'],'start':datetime.datetime.now(datetime.timezone.utc).isoformat()},f)
uvicorn.Server(uvicorn.Config(resmon.app,log_level='error')).run(sockets=[s])
'''
    receipt=state/'identity.json';log=state/'backend.log'
    with log.open('w') as out:
        proc=subprocess.Popen([sys.executable,'-c',script,str(receipt),str(getattr(request,'param','production'))],cwd=backend,env=env,stdout=out,stderr=out)
        try:
            for _ in range(300):
                if receipt.exists():break
                assert proc.poll() is None,log.read_text();time.sleep(.02)
            record=json.loads(receipt.read_text());assert record['pid']==proc.pid and record['port']!=8742
            assert record['source']==str(backend) and record['database']==str(state/'resmon.db')
            with httpx.Client(base_url=f"http://127.0.0.1:{record['port']}",timeout=15) as client:
                for _ in range(300):
                    try:
                        response=client.get('/api/library',headers=HEADERS)
                        if response.status_code==200:break
                    except httpx.ConnectError:pass
                    assert proc.poll() is None;time.sleep(.02)
                assert response.status_code==200,response.text
                print('LIBRARY_HTTP_IDENTITY',json.dumps(record),flush=True)
                yield client,record,tmp_path
        finally:
            proc.terminate();code=proc.wait(timeout=15)
            print('LIBRARY_HTTP_CLEANUP',json.dumps({'pid':proc.pid,'exit':code,'reaped':True}),flush=True)


def test_all_nine_origins_refused_before_body_or_effects(http_library):
    client,record,tmp=http_library
    bad=[{}, {'Origin':'null','X-Resmon-Library':'1'},{'Origin':'https://other.invalid','X-Resmon-Library':'1'}, {'Origin':'http://127.0.0.1:12345/path','X-Resmon-Library':'1'}, {'Origin':'http://user@127.0.0.1:12345','X-Resmon-Library':'1'},{'Origin':'http://127.0.0.1:12345'}]
    for method,suffix in ROUTES:
        for headers in bad:
            response=client.request(method,'/api/library'+suffix.replace('{file}',str(uuid.uuid4())),headers=headers,content=b'not even valid JSON')
            assert response.status_code==403,response.text
            if suffix.endswith('/text'):assert response.headers['cache-control']=='no-store'
    assert client.get('/api/library',headers=HEADERS).json()['vault'] is None
    assert not list(tmp.rglob('resmon-library-*'))
    preflight=client.options('/api/library/files',headers={'Origin':HEADERS['Origin'],'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-resmon-library,content-type'})
    assert preflight.status_code==200


def test_real_stream_import_read_open_export_links_and_refusals(http_library):
    from implementation_scripts import database as db
    client,record,tmp=http_library
    parent=tmp/'vault-parent';parent.mkdir()
    response=client.post('/api/library/vault',headers=HEADERS,json={'parent_directory':str(parent)})
    assert response.status_code==201,response.text
    vid=response.json()['vault']['vault_id'];root=parent/response.json()['vault']['label']
    params={'expected_vault_id':vid};raw='HTTP λ\r\nsecond\rlast\n'.encode()
    def chunks():yield raw[:5];yield raw[5:]
    response=client.post('/api/library/files',params={**params,'filename':'http.txt'},headers={**HEADERS,'Content-Type':'application/octet-stream'},content=chunks())
    assert response.status_code==201,response.text
    item=response.json()['file'];fid=item['file_id'];version=item['version_id']
    assert (root/item['relative_path']).read_bytes()==raw
    assert client.get('/api/library/files',params=params,headers=HEADERS).json()['files'][0]['file_id']==fid
    assert client.get('/api/library/files/'+fid,params=params,headers=HEADERS).json()['file']['sha256']==hashlib.sha256(raw).hexdigest()
    read=client.get(f'/api/library/files/{fid}/text',params={**params,'expected_version_id':version},headers=HEADERS)
    assert read.status_code==200 and read.headers['cache-control']=='no-store'
    assert read.json()['text']=='HTTP λ\nsecond\nlast\n'
    opened=client.post(f'/api/library/files/{fid}/open',headers=HEADERS,json={**params,'expected_version_id':version})
    assert opened.status_code==200 and opened.json()['path']==str(root/item['relative_path'])
    c=db.get_connection(record['database']);doc=db.insert_document(c,{'source_repository':'synthetic','external_id':'http','title':'Synthetic HTTP paper','metadata_hash':'synthetic'});c.commit();c.close()
    linked=client.post(f'/api/library/files/{fid}/paper-links',headers=HEADERS,json={**params,'document_id':doc})
    assert linked.status_code==200 and linked.json()['document_id']==doc
    exported=client.get('/api/library/export',headers=HEADERS,params={**params,'format':'json'}).json();inventory=json.loads(exported['text'])
    assert len(inventory['files'])==1 and inventory['files'][0]['paper_links'][0]['document_id']==doc
    assert str(parent) not in exported['text']
    for unknown in ({'source_path':'/not/allowed'},{'expected_vault_id':str(uuid.uuid4())}):
        res=client.get(f'/api/library/files/{fid}/text',params={**params,'expected_version_id':version,**unknown},headers=HEADERS)
        assert res.status_code in (400,409) and 'text' not in res.json()
    wrong=client.get(f'/api/library/files/{fid}/text',params={**params,'expected_version_id':str(uuid.uuid4())},headers=HEADERS)
    assert wrong.status_code==409 and wrong.headers['cache-control']=='no-store'
    # The original confirmation endpoint, operating solely on this synthetic corpus.
    refused=client.post('/api/admin/erase-corpus',json={'confirm':'WRONG'});assert refused.status_code==400
    erased=client.post('/api/admin/erase-corpus',json={'confirm':'CONFIRM'});assert erased.status_code==200,erased.text
    assert (root/item['relative_path']).read_bytes()==raw
    assert client.get('/api/library/files/'+fid,params=params,headers=HEADERS).json()['file']['paper_links']==[]
    reset=client.post('/api/admin/reset-settings',json={'confirm':'CONFIRM'});assert reset.status_code==200
    assert client.get('/api/library',headers=HEADERS).json()['vault']['vault_id']==vid
    (root/item['relative_path']).write_bytes(b'changed')
    assert client.get(f'/api/library/files/{fid}/text',params={**params,'expected_version_id':version},headers=HEADERS).status_code==409
    (root/'vault.json').write_text('{}')
    assert client.get('/api/library',headers=HEADERS).json()['status']=='mismatch'


@pytest.mark.parametrize('http_library',[16],indirect=True)
def test_actual_chunked_body_crosses_limit_without_retained_row_or_partial_file(http_library):
    client,record,tmp=http_library
    parent=tmp/'vault-parent';parent.mkdir()
    response=client.post('/api/library/vault',headers=HEADERS,json={'parent_directory':str(parent)})
    assert response.status_code==201
    vault=response.json()['vault'];root=parent/vault['label']
    original=tmp/'original.txt';original.write_bytes(b'first chunk-second chunk')
    before=original.read_bytes()
    def chunks():
        yield before[:12]
        yield before[12:]
    result=client.post('/api/library/files',params={'expected_vault_id':vault['vault_id'],'filename':'original.txt'},headers={**HEADERS,'Content-Type':'application/octet-stream'},content=chunks())
    assert result.status_code==413,result.text
    assert original.read_bytes()==before
    status=client.get('/api/library',headers=HEADERS).json()
    assert status['counts']['items']==0 and status['counts']['retained_bytes']==0 and status['status']=='ready'
    assert list((root/'files').iterdir())==[]
    assert not (root/'.import.lock').exists()


def test_real_disconnect_and_false_content_length_never_publish_partial_rows(http_library):
    client, record, tmp = http_library
    parent = tmp / 'vault-parent'; parent.mkdir()
    created = client.post('/api/library/vault', headers=HEADERS, json={'parent_directory': str(parent)})
    assert created.status_code == 201
    vault = created.json()['vault']; root = parent / vault['label']
    # A declared body of 100 bytes is interrupted after 7 actual bytes. This is
    # a real socket disconnect, not a mocked request.stream exception.
    target = f"/api/library/files?expected_vault_id={vault['vault_id']}&filename=interrupted.txt"
    with socket.create_connection(('127.0.0.1', record['port']), timeout=10) as connection:
        request = (f'POST {target} HTTP/1.1\r\nHost: 127.0.0.1:{record["port"]}\r\nOrigin: {HEADERS["Origin"]}\r\nX-Resmon-Library: 1\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\n\r\n').encode() + b'partial'
        connection.sendall(request)
        # Observe entry into the actual importer before closing this socket.
        for _ in range(300):
            if list(root.glob('.staging-*')): break
            time.sleep(.01)
        assert list(root.glob('.staging-*')), 'request did not enter the importer'
    for _ in range(300):
        if not (root / '.import.lock').exists(): break
        time.sleep(.01)
    assert not (root / '.import.lock').exists()
    assert list((root / 'files').iterdir()) == []
    assert not list(root.glob('.staging-*'))
    assert client.get('/api/library', headers=HEADERS).json()['counts']['items'] == 0
    # Conflicting length declarations are rejected by the real HTTP parser.
    with socket.create_connection(('127.0.0.1', record['port']), timeout=10) as connection:
        malformed = (f'POST {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: {HEADERS["Origin"]}\r\nX-Resmon-Library: 1\r\nContent-Type: application/octet-stream\r\nContent-Length: 1\r\nContent-Length: 20\r\nConnection: close\r\n\r\nx').encode()
        connection.sendall(malformed); response = connection.recv(4096)
    assert b'400 Bad Request' in response
    assert client.get('/api/library', headers=HEADERS).json()['counts']['items'] == 0
