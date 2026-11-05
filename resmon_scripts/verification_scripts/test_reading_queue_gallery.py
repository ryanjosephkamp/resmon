"""What the Library's gallery reads from the reading queue: search, order, a paper's PDF,
where it came from, and Undo of a removal."""
import json

import pytest

from implementation_scripts import database as db, library as lib, reading_queue as rq


@pytest.fixture
def queue(tmp_path):
    c = db.get_connection(tmp_path / 'q.db'); db.init_db(conn=c)
    papers = [
        ('Zebra stripes and heat', 'Ada Lovelace', 'arxiv', '2021-05-01'),
        ('Alpha decay rates', 'Grace Hopper', 'pubmed', '2024-01-02'),
        ('Muon g-2 lattice', 'Ada Byron', 'crossref', '2023-07-09'),
    ]
    ids = []
    for i, (title, author, source, date) in enumerate(papers):
        ids.append(db.insert_document(c, {'source_repository': source, 'external_id': str(i), 'title': title,
                                          'authors': json.dumps([author]), 'publication_date': date,
                                          'metadata_hash': f'h{i}'}))
    c.commit()
    for n, doc in enumerate(ids):
        rq.save(c, doc)
        c.execute('UPDATE reading_queue SET saved_at=?, updated_at=? WHERE document_id=?',
                  (f'2026-11-0{n + 1} 08:00:00', f'2026-11-0{n + 1} 08:00:00', doc))
    c.commit()
    yield c, ids, tmp_path
    c.close()


def titles(page):
    return [e['document']['title'] for e in page['entries']]


def test_search_and_every_order(queue):
    c, ids, _ = queue
    assert titles(rq.list_entries(c)) == ['Muon g-2 lattice', 'Alpha decay rates', 'Zebra stripes and heat']
    assert titles(rq.list_entries(c, sort='title')) == ['Alpha decay rates', 'Muon g-2 lattice', 'Zebra stripes and heat']
    assert titles(rq.list_entries(c, sort='published')) == ['Alpha decay rates', 'Muon g-2 lattice', 'Zebra stripes and heat']
    assert titles(rq.list_entries(c, sort='source')) == ['Zebra stripes and heat', 'Muon g-2 lattice', 'Alpha decay rates']
    found = rq.list_entries(c, q='ada')
    assert titles(found) == ['Muon g-2 lattice', 'Zebra stripes and heat'] and found['total'] == 2 and found['q'] == 'ada'
    assert titles(rq.list_entries(c, q='PUBMED')) == ['Alpha decay rates']
    assert found['counts'] == {'to_read': 3, 'read': 0, 'all': 3}, 'counts are the whole queue, not the search'
    with pytest.raises(ValueError):
        rq.list_entries(c, sort='random')


def test_map_order_keeps_its_key_and_says_saved_without_a_map(queue):
    c, ids, _ = queue
    page = rq.list_entries(c, sort='map', map_order={ids[2]: (0, 5), ids[0]: (0, 9)})
    assert titles(page) == ['Muon g-2 lattice', 'Zebra stripes and heat', 'Alpha decay rates'] and page['sort'] == 'map'
    assert titles(rq.list_entries(c, sort='map', limit=1, offset=1, map_order={ids[2]: (0, 5), ids[0]: (0, 9)})) == [
        'Zebra stripes and heat']
    unmapped = rq.list_entries(c, sort='map')
    assert unmapped['sort'] == 'saved' and titles(unmapped)[0] == 'Muon g-2 lattice'


def test_each_entry_names_its_linked_pdf_and_the_run_that_found_it(queue):
    c, ids, tmp_path = queue
    parent = tmp_path / 'parent'; parent.mkdir()
    vid = lib.create_vault(c, str(parent))['vault']['vault_id']
    for name, content in [('older.pdf', b'%PDF-1.4\nolder'), ('notes.md', b'# notes'), ('newer.pdf', b'%PDF-1.4\nnewer')]:
        with lib.Import(c, vid, name, ids[0]) as upload:
            upload.write(content)
            upload.finish()
    watch = db.insert_routine(c, {'name': 'muon-watch', 'schedule_cron': '0 6 * * *', 'parameters': '{}'})
    run = db.insert_execution(c, {'execution_type': 'automated_sweep', 'routine_id': watch, 'parameters': '{}',
                                  'start_time': '2026-11-03T06:00:00'})
    search = db.insert_execution(c, {'execution_type': 'deep_dive', 'parameters': '{}', 'start_time': '2026-11-01T06:00:00'})
    db.link_execution_document(c, search, ids[1])
    db.link_execution_document(c, run, ids[2])
    later = db.insert_execution(c, {'execution_type': 'deep_dive', 'parameters': '{}', 'start_time': '2026-11-04T06:00:00'})
    db.link_execution_document(c, later, ids[2])
    entries = {e['document_id']: e for e in rq.list_entries(c)['entries']}
    assert entries[ids[0]]['pdf']['original_name'] == 'newer.pdf' and entries[ids[0]]['pdf']['vault_id'] == vid
    assert entries[ids[1]]['pdf'] is None and entries[ids[2]]['pdf'] is None
    assert entries[ids[0]]['found_by'] is None
    assert entries[ids[1]]['found_by'] == {'execution_id': search, 'kind': 'search', 'watch_id': None,
                                           'watch_name': None, 'at': '2026-11-01T06:00:00'}
    assert entries[ids[2]]['found_by']['watch_name'] == 'muon-watch' and entries[ids[2]]['found_by']['execution_id'] == run


def test_undo_puts_an_entry_back_with_its_own_state_and_dates(queue):
    c, ids, _ = queue
    rq.set_status(c, ids[1], 'read')
    was = rq.get_entry(c, ids[1])
    removed = rq.remove(c, ids[1])
    assert removed == was and rq.get_entry(c, ids[1]) is None
    assert rq.remove(c, ids[1]) is None
    entry, restored = rq.restore(c, ids[1], removed['status'], removed['saved_at'], removed['updated_at'], removed['read_at'])
    assert restored and entry == was
    # Saved again in between: what is there now stays, and the answer says nothing was put back.
    rq.remove(c, ids[0])
    rq.save(c, ids[0])
    now = rq.get_entry(c, ids[0])
    entry, restored = rq.restore(c, ids[0], 'read', '2020-01-01 00:00:00', '2020-01-01 00:00:00', '2020-01-01 00:00:00')
    assert not restored and entry == now
    with pytest.raises(ValueError):
        rq.restore(c, ids[2], 'gone', 'a', 'b', None)
    with pytest.raises(rq.UnknownDocument):
        rq.restore(c, 999999, 'to_read', 'a', 'b', None)
