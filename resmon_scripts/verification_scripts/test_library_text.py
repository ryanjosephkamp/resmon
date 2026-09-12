"""Actual retained-byte boundaries; display normalization is never persistence."""
import hashlib
import json
from pathlib import Path
import uuid
import pytest
from implementation_scripts import database as db, library as lib, library_text as reader
from test_library import vault, put


def get(c, vid, item):
    return reader.read_text(c, vid, item['file_id'], item['version_id'])


@pytest.mark.parametrize('name,raw', [('x.txt','Unicode λ\r\nnext\rlast\n'.encode()),('x.md',b'# <script>never()</script>\n![x](https://example.invalid/x)\n')])
def test_exact_bytes_normalized_display_and_no_database_write(vault, name, raw):
    c,vid,root=vault;item=put(c,vid,name,raw)['file'];before=c.total_changes
    result=get(c,vid,item)
    assert result['text']==raw.decode().replace('\r\n','\n').replace('\r','\n')
    assert result['line_count']==len(result['text'].split('\n'))
    assert result['byte_size']==len(raw)
    assert result['sha256']==hashlib.sha256(raw).hexdigest()
    assert (root/item['relative_path']).read_bytes()==raw
    assert c.total_changes==before
    assert set(result)=={'version','kind','vault_id','file_id','version_id','sha256','media_type','encoding','normalization','byte_size','line_count','text'}


@pytest.mark.parametrize('raw,reason', [(b'a'*262144,None),(b'a'*262145,'too_large'),(b'\n'*4999,None),(b'\n'*5000,'too_many_lines')])
def test_real_production_bounds_preserve_readable_or_refused_item(vault,raw,reason):
    c,vid,root=vault;item=put(c,vid,content=raw)['file']
    assert (reader.MAX_TEXT_BYTES,reader.MAX_LINES,reader.MAX_RESPONSE_BYTES)==(262144,5000,2097152)
    if reason:
        with pytest.raises(lib.LibraryError) as caught:get(c,vid,item)
        assert caught.value.reason==reason
    else:assert get(c,vid,item)['byte_size']==len(raw)
    assert (root/item['relative_path']).read_bytes()==raw
    assert lib.open_request(c,vid,item['file_id'],item['version_id'])['file_id']==item['file_id']


@pytest.mark.parametrize('damage', ['invalid_utf8','nul','hash','missing','foreign_version','foreign_vault','marker','pdf','response_limit'])
def test_refusals_do_not_return_or_rewrite_content(vault,monkeypatch,damage):
    c,vid,root=vault;item=put(c,vid,content=b'original text')['file'];path=root/item['relative_path']
    if damage in ('invalid_utf8','nul'):
        raw=b'\xff' if damage=='invalid_utf8' else b'a\0b';path.write_bytes(raw)
        # An authored corrupt catalog claiming these bytes cannot bypass strict decoding.
        c.execute('UPDATE library_files SET byte_size=?,sha256=? WHERE file_id=?',(len(raw),hashlib.sha256(raw).hexdigest(),item['file_id']));c.commit()
    elif damage=='hash':path.write_bytes(b'replaced text')
    elif damage=='missing':path.unlink()
    elif damage=='foreign_version':item['version_id']=str(uuid.uuid4())
    elif damage=='foreign_vault':vid=str(uuid.uuid4())
    elif damage=='marker':(root/'vault.json').write_text('{}')
    elif damage=='pdf':item=put(c,vid,'x.pdf',b'%PDF-1.4\nauthored')['file'];path=root/item['relative_path']
    elif damage=='response_limit':monkeypatch.setattr(reader,'MAX_RESPONSE_BYTES',100)
    before=path.read_bytes() if path.exists() else None;count=lib.counts(c)['items']
    with pytest.raises((lib.LibraryError,OSError)):get(c,vid,item)
    assert (path.read_bytes() if path.exists() else None)==before
    assert lib.counts(c)['items']==count
