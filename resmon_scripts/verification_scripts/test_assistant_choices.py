"""R04c choices: actual resolver and SQLite; no account compatibility inference."""
from __future__ import annotations

import json
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from implementation_scripts import assistant_choices as choices, assistant_store as store, database, assistant_runtime
from implementation_scripts.ai_models import CLAUDE_MODEL_ALIASES, CLAUDE_EFFORT_LEVELS
from implementation_scripts.assistant_tool_calling import PROVIDER_TOOL_CALLING


def cli(**changes):
    return {'version': 1, 'runtime': 'claude_cli', 'provider': 'claude_code', 'model': 'opus', 'effort': 'high', **changes}


@pytest.fixture
def conn(tmp_path):
    c = database.get_connection(tmp_path / 'choices.db')
    database.init_db(conn=c)
    yield c
    c.close()


@pytest.mark.parametrize('provider', PROVIDER_TOOL_CALLING)
def test_every_existing_provider_has_an_explicit_admission_answer(provider):
    value = cli(runtime='api_key', provider=provider, model='literal/id-v1:beta', effort=None)
    if PROVIDER_TOOL_CALLING[provider].offered:
        assert choices.validate(value) == value
    else:
        with pytest.raises(ValueError): choices.validate(value)


@pytest.mark.parametrize('model', CLAUDE_MODEL_ALIASES)
@pytest.mark.parametrize('effort', CLAUDE_EFFORT_LEVELS)
def test_existing_cli_suggestions_remain_literal_requests(model, effort):
    assert choices.resolve({}, cli(model=model, effort=effort))['requested_model'] == model


@pytest.mark.parametrize('value', [None, {}, cli(version=True), cli(version=2), cli(extra='x'), cli(runtime='codex'),
    cli(provider='openai'), cli(model=''), cli(model='x\ny'), cli(model='x\0y'), cli(model='x\ty'),
    cli(model='x'*513), cli(model=7), cli(effort='ultra'), cli(effort=[]),
    cli(runtime='api_key', provider='openai'), cli(runtime='api_key', provider='openai', model=None, effort=None)])
def test_malformed_or_unsupported_request_is_not_coerced(value):
    with pytest.raises(ValueError): choices.validate(value)


def test_descriptor_uses_existing_inventory_without_discovery_calls(monkeypatch):
    from implementation_scripts import ai_models, ai_cli, assistant_api_runtime
    from types import SimpleNamespace
    monkeypatch.setattr(ai_models, 'list_subscription_catalog', lambda *a, **k: pytest.fail('No generic catalog'))
    monkeypatch.setattr(ai_cli, 'discover_cli', lambda *a, **k: SimpleNamespace(found=True, path='/synthetic/private/cli', how='configured', describe=lambda: 'private'))
    monkeypatch.setattr(assistant_api_runtime.ApiKeyRuntime, '_key', lambda self: 'fake-key-never-export')
    descriptor = choices.descriptor({'ai_cli_path': '/synthetic/private/cli', 'ai_custom_base_url': 'https://private.invalid'})
    assert len(descriptor['connections']) == len(PROVIDER_TOOL_CALLING) == 11
    assert len([c for c in descriptor['connections'] if c['runtime'] == 'api_key']) == 8
    assert descriptor['claude_aliases'] == list(CLAUDE_MODEL_ALIASES)
    assert descriptor['claude_efforts'] == list(CLAUDE_EFFORT_LEVELS)
    text = json.dumps(descriptor)
    assert all(value not in text for value in ('/synthetic/private', 'https://private.invalid', 'fake-key-never-export'))


def test_defaults_binding_and_private_route_comparison():
    settings = {'assistant_model': 'opus', 'assistant_effort': 'high', 'ai_cli_path': '/private/synthetic'}
    binding = choices.resolve(settings)
    assert binding['model_basis'] == binding['effort_basis'] == 'settings_default'
    assert choices.route_digest({**settings, 'assistant_model': 'fable'}, 'claude_cli', 'claude_code') == binding['route_digest']
    assert choices.route_digest({**settings, 'ai_cli_path': '/changed'}, 'claude_cli', 'claude_code') != binding['route_digest']
    assert choices.resolve({})['requested_model'] is None
    assert choices.resolve({})['effort_basis'] == 'runtime_default'
    assert set(choices.request_projection(binding)) == set(choices.REQUEST_FIELDS)
    assert 'route_digest' not in json.dumps(choices.public_binding(binding))


def test_admission_and_reports_survive_restart_without_retargeting(conn):
    binding = choices.resolve({}, cli())
    sid = store.create_bound_session(conn, binding)
    saved = store.get_choices(conn, sid)
    database.set_setting(conn, 'assistant_model', 'fable')
    turn = store.admit_turn(conn, sid, 'request A', saved)
    assert not turn['resume'] and turn['history'] == []
    assert turn['requested']['requested_model'] == 'opus'
    uid = turn['user_message_id']
    for model in ('concrete-opus', 'different-model', 'concrete-opus'):
        store.append_report(conn, sid, uid, choices.report(model, 'claude_system_init_model'))
    mid = store.finish_turn(conn, sid, uid, content='reply', tool_calls=None, tool_results=None,
                            input_tokens=None, output_tokens=None, cost_usd=None)
    snap = store.read_snapshot(conn, sid)
    assert snap['turn_choices'][0]['assistant_message_id'] == mid
    assert [r['model'] for r in snap['turn_choices'][0]['reported']] == ['concrete-opus','different-model','concrete-opus']
    assert [r['sequence'] for r in snap['turn_choices'][0]['reported']] == [1,2,3]
    again = store.admit_turn(conn, sid, 'request B', saved)
    assert again['resume'] and again['cli_session_id'] == turn['cli_session_id']
    assert store.read_snapshot(conn, sid)['turn_choices'][1]['reported'] == []


def test_admission_ddl_failure_rolls_back_user_and_legacy_binding(conn):
    sid = store.create_session(conn, runtime='claude_cli', cli_session_id='untrusted-old-native')
    before = store.get_session(conn, sid)
    conn.execute("CREATE TRIGGER fail_turn BEFORE INSERT ON assistant_turn_choices BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    with pytest.raises(sqlite3.IntegrityError, match='synthetic failure'):
        store.admit_turn(conn, sid, 'never committed', choices.resolve({}, cli(), legacy=True), legacy=True)
    assert store.get_session(conn, sid) == before
    assert store.list_messages(conn, sid) == []
    assert store.get_choices(conn, sid) is None


def test_route_changed_inside_admission_writes_nothing(conn):
    sid = store.create_bound_session(conn, choices.resolve({}, cli()))
    binding = store.get_choices(conn, sid)
    database.set_setting(conn, 'ai_cli_path', '/synthetic/changed')
    with pytest.raises(ValueError, match='configuration changed'):
        store.admit_turn(conn, sid, 'no rows', binding)
    assert store.list_messages(conn, sid) == []
    assert store.read_turn_choices(conn, sid) == []


@pytest.mark.parametrize('kind', ['claude_cli', 'api_key'])
def test_legacy_binding_has_explicit_future_context_and_single_winner(tmp_path, kind):
    path = tmp_path / 'race.db'
    c = database.get_connection(path); database.init_db(conn=c)
    sid = store.create_session(c, runtime=kind, cli_session_id='old-unverified-native', model='misleading-old-model')
    store.add_message(c, sid, role='user', content='old user')
    store.add_message(c, sid, role='assistant', content='old answer', tool_results=[{'private': 'not replayed'}])
    request = cli() if kind == 'claude_cli' else cli(runtime=kind, provider='openai', effort=None)
    binding = choices.resolve({}, request, legacy=True)
    def adopt(_):
        conn = database.get_connection(path)
        try: return store.admit_turn(conn, sid, 'future', binding, legacy=True)
        except ValueError: return None
        finally: conn.close()
    with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(adopt, range(2)))
    wins = [r for r in results if r is not None]
    assert len(wins) == 1
    assert len(store.list_messages(c, sid)) == 3
    assert len(store.read_turn_choices(c, sid)) == 1
    if kind == 'claude_cli':
        assert wins[0]['history'] == [] and not wins[0]['resume']
        assert wins[0]['cli_session_id'] != 'old-unverified-native'
    else:
        assert [m['content'] for m in wins[0]['history']] == ['old user','old answer']
        assert wins[0]['cli_session_id'] == ''
    assert store.get_session(c, sid)['model'] == 'misleading-old-model'
    c.close()


def test_malformed_metadata_is_unreadable_and_cross_chat_links_are_not_exported(conn):
    a = store.create_bound_session(conn, choices.resolve({}, cli()))
    b = store.create_bound_session(conn, choices.resolve({}, cli(model='fable')))
    uid = store.admit_turn(conn, a, 'A', store.get_choices(conn,a))['user_message_id']
    wrong = store.add_message(conn, b, role='assistant', content='B private text')
    conn.execute('UPDATE assistant_turn_choices SET assistant_message_id=? WHERE user_message_id=?',(wrong,uid));conn.commit()
    item = store.read_snapshot(conn,a)['turn_choices'][0]
    assert item['assistant_message_id'] is None and item['requested'] == {'unreadable':True}
    conn.execute("UPDATE assistant_turn_choices SET assistant_message_id=NULL, requested_json='malformed',reported_json='{}'");conn.commit()
    item = store.read_snapshot(conn,a)['turn_choices'][0]
    assert item['requested'] == item['reported'] == {'unreadable':True}
    assert store.list_messages(conn,a)[0]['content']=='A'


def test_concurrent_finish_links_one_reply_and_report_updates_do_not_get_lost(tmp_path):
    path = tmp_path / 'finish.db'
    c = database.get_connection(path); database.init_db(conn=c)
    sid=store.create_bound_session(c,choices.resolve({},cli()))
    uid=store.admit_turn(c,sid,'one user',store.get_choices(c,sid))['user_message_id']
    def report_one(i):
        other=database.get_connection(path)
        try:return store.append_report(other,sid,uid,choices.report('observed-'+str(i),'api_response_model'))
        finally:other.close()
    with ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(report_one,range(8)))
    reports=store.read_turn_choices(c,sid)[0]['reported']
    assert len(reports)==8 and [r['sequence'] for r in reports]==list(range(1,9))
    def finish(_):
        other=database.get_connection(path)
        try:return store.finish_turn(other,sid,uid,content='one reply',tool_calls=None,tool_results=None,input_tokens=None,output_tokens=None,cost_usd=None)
        except ValueError:return None
        finally:other.close()
    with ThreadPoolExecutor(max_workers=2) as pool:result=list(pool.map(finish,range(2)))
    assert len([x for x in result if x is not None])==1
    assert len(store.list_messages(c,sid))==2
    c.close()
