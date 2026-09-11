"""Real SQLite serializer and size boundaries; no model, settings or file writer."""
import json
import sqlite3
import pytest
from implementation_scripts import assistant_store as store, assistant_export as export, database

@pytest.fixture
def conn(tmp_path):
    filename = str(tmp_path/'export.db')
    database.init_db(filename)
    c = database.get_connection(filename)
    yield c
    c.close()


def inventory(conn):
    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    return {t: [tuple(r) for r in conn.execute('SELECT * FROM "'+t+'" ORDER BY 1')] for t in tables}


def test_raw_fidelity_allowlist_literal_markdown_and_preservation(conn):
    sid = store.create_session(conn, runtime='synthetic', cli_session_id='DO-NOT-EXPORT', model=None)
    other = store.create_session(conn, runtime='synthetic', title='OTHER CHAT')
    store.add_message(conn, other, role='user', content='NOT THIS TRANSCRIPT')
    hostile = '<script>alert(1)</script>\n[link](https://invalid.example)\n``````\n~~~\nUnicode 雪\n'
    for role in ['user', 'assistant', 'system']:
        store.add_message(conn, sid, role=role, content=hostile, input_tokens=0 if role=='assistant' else None)
    conn.execute("UPDATE assistant_messages SET tool_calls=?,tool_results=? WHERE session_id=?", ('{malformed', '{"a":[1,null,"雪"]}', sid))
    conn.commit()
    before = inventory(conn)
    snap = store.read_snapshot(conn, sid)
    obs = {'turn_claimed': True, 'cli_running': False, 'basis': 'in_memory_observation_not_atomic_with_sqlite'}
    result = export.export_snapshot(snap, 'json', obs)
    doc = json.loads(result['text'])
    assert doc['version'] == 1 and doc['completion_status'] == 'unknown'
    assert doc['session']['title'] is None and doc['session']['model'] is None
    assert list(doc['session']) == ['id','runtime','model','created_at','updated_at','title']
    assert [m['role'] for m in doc['messages']] == ['user','assistant','system']
    assert [m['content'] for m in doc['messages']] == [hostile]*3
    assert doc['messages'][0]['tool_calls'] == {'data':None,'unreadable':True,'raw':'{malformed'}
    assert doc['messages'][0]['tool_results']['data'] == {'a':[1,None,'雪']}
    assert doc['messages'][0]['input_tokens'] is None and doc['messages'][1]['input_tokens'] == 0
    assert 'DO-NOT-EXPORT' not in result['text'] and 'NOT THIS TRANSCRIPT' not in result['text']
    md = export.export_snapshot(snap, 'markdown', obs)['text']
    assert ('```````\n'+hostile+'\n```````') in md
    assert inventory(conn) == before
    assert not conn.in_transaction

@pytest.mark.parametrize('raw', [None, 'null', '[]', 'false', '0', '"text"', '{"object":true}', '', 'NaN', 'Infinity'])
def test_arbitrary_tool_data(raw):
    actual = export.tool_data(raw)
    if raw in ('', 'NaN', 'Infinity'): assert actual == {'data':None,'unreadable':True,'raw':raw}
    else: assert actual == {'data':None if raw is None else json.loads(raw),'unreadable':False}

@pytest.mark.parametrize('fmt', ['json','markdown'])
def test_exact_utf8_size_limit(conn, fmt):
    sid = store.create_session(conn, runtime='synthetic')
    store.add_message(conn, sid, role='user', content='雪')
    snap = store.read_snapshot(conn, sid)
    base = len(export.export_snapshot(snap, fmt, {})['text'].encode('utf-8'))
    for delta in [-1,0,1]:
        snap['raw_messages'][0]['content'] = '雪' + 'a' * (export.MAX_EXPORT_BYTES-base+delta)
        if delta > 0:
            with pytest.raises(ValueError, match='8 MiB'): export.export_snapshot(snap, fmt, {})
        else:
            body = export.export_snapshot(snap, fmt, {})
            assert len(body['text'].encode('utf-8')) == export.MAX_EXPORT_BYTES+delta


def test_empty_and_missing_snapshot(conn):
    sid = store.create_session(conn, runtime='synthetic')
    snap = store.read_snapshot(conn, sid)
    assert snap['snapshot']['last_message_id'] is None
    assert json.loads(export.export_snapshot(snap, 'json', {})['text'])['messages'] == []
    assert store.read_snapshot(conn, sid+1) is None


def test_choice_metadata_and_messages_share_one_wal_snapshot(conn, monkeypatch):
    from implementation_scripts import assistant_choices as choices
    path = conn.execute('PRAGMA database_list').fetchone()[2]
    conn.execute('PRAGMA journal_mode=WAL')
    binding = choices.resolve({}, {'version':1,'runtime':'claude_cli','provider':'claude_code','model':'opus','effort':None})
    sid = store.create_bound_session(conn, binding)
    uid = store.admit_turn(conn, sid, 'before', store.get_choices(conn,sid))['user_message_id']
    original = store.read_turn_choices
    def commit_between_reads(reader, selected):
        writer = database.get_connection(path)
        try:
            store.append_report(writer,sid,uid,choices.report('later report','api_response_model'))
            store.finish_turn(writer,sid,uid,content='later reply',tool_calls=None,tool_results=None,input_tokens=None,output_tokens=None,cost_usd=None)
        finally: writer.close()
        return original(reader,selected)
    monkeypatch.setattr(store,'read_turn_choices',commit_between_reads)
    snapshot = store.read_snapshot(conn,sid)
    assert snapshot['turn_choices'][0]['reported'] == []
    assert snapshot['turn_choices'][0]['assistant_message_id'] is None
    assert [m['content'] for m in snapshot['messages']] == ['before']
    for fmt in ['json','markdown']:
        text = export.export_snapshot(snapshot,fmt,{})['text']
        assert 'later reply' not in text and 'later report' not in text
    monkeypatch.setattr(store,'read_turn_choices',original)
    reopened = store.read_snapshot(conn,sid)
    assert reopened['turn_choices'][0]['reported'][0]['model'] == 'later report'
    assert [m['content'] for m in reopened['messages']] == ['before','later reply']


@pytest.mark.parametrize('fmt',['json','markdown'])
def test_literal_choices_unknowns_and_metadata_count_towards_size_limit(conn,fmt):
    from implementation_scripts import assistant_choices as choices
    model = '<img src=x onerror=alert(1)> `雪` [literal](https://invalid.example)'
    binding = choices.resolve({}, {'version':1,'runtime':'claude_cli','provider':'claude_code','model':model,'effort':None})
    sid = store.create_bound_session(conn,binding)
    uid = store.admit_turn(conn,sid,'user',store.get_choices(conn,sid))['user_message_id']
    hostile = '```\n<script>literal</script>\n雪'
    store.append_report(conn,sid,uid,choices.report(hostile,'claude_system_init_model'))
    snap = store.read_snapshot(conn,sid)
    before = inventory(conn)
    rendered = export.export_snapshot(snap,fmt,{})['text']
    assert 'route_digest' not in rendered and binding['route_digest'] not in rendered
    if fmt == 'json':
        data=json.loads(rendered)
        assert data['choices']['requested_model']==model
        assert data['turn_choices'][0]['reported'][0]['model']==hostile
        assert data['turn_choices'][0]['assistant_message_id'] is None
    else:
        assert model in rendered and json.dumps(hostile,ensure_ascii=False)[1:-1] in rendered
    # Oversized reported metadata must refuse just as oversized message text does.
    snap['turn_choices'][0]['reported'][0]['model']='x'*(export.MAX_EXPORT_BYTES+1)
    with pytest.raises(ValueError,match='8 MiB'):export.export_snapshot(snap,fmt,{})
    assert inventory(conn)==before
