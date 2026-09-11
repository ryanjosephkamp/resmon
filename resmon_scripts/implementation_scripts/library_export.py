"""Complete recorded-metadata inventory, not a file bundle or integrity scan."""
from __future__ import annotations
import json
import sqlite3
from . import library

MAX_EXPORT_BYTES = 8 * 1024 * 1024
LIMITS = [
    'Recorded metadata only; retained bytes were not freshly checked.',
    'An inventory is not a backup, file bundle or relocation tool.',
    'Restoring a database alone does not restore retained files.',
    'Paper IDs are local to this app database; links are owner associations.',
    'Original basenames may be private. Review before sharing.',
    'No automatic cloud backup of the Library vault is added.',
]


def export_inventory(conn: sqlite3.Connection, vault_id: str, fmt: str = 'json') -> dict:
    if fmt != 'json':
        raise library.LibraryError('invalid_format', 'Library inventory supports JSON only.', 400)
    with library.checked_vault(conn, vault_id):
        conn.execute('SAVEPOINT library_inventory')
        try:
            files = []
            for raw in conn.execute('SELECT * FROM library_files WHERE vault_id=? ORDER BY id', (vault_id,)):
                row = library.file_row(conn, raw['file_id'])
                files.append({**{k: row[k] for k in ('file_id', 'version_id', 'original_name', 'media_type', 'byte_size', 'sha256', 'relative_path')},
                              'imported_at_utc': row['created_at_utc'],
                              'paper_links': [{k: x[k] for k in ('document_id', 'identity_scope', 'basis')}
                                              for x in library.links(conn, row['file_id'])],
                              'availability': 'not_checked'})
            document = {'version': 1, 'kind': 'resmon-library-inventory', 'vault_id': vault_id,
                        'generated_at_utc': library.utc_now(), 'files': files, 'limits': LIMITS}
            text = json.dumps(document, ensure_ascii=False, indent=2) + '\n'
            if len(text.encode('utf-8')) > MAX_EXPORT_BYTES:
                raise library.LibraryError('inventory_limit', 'Inventory exceeds 8 MiB; nothing was truncated.', 413)
            return {'version': 1, 'vault_id': vault_id, 'format': 'json',
                    'filename': f'resmon-library-{vault_id}.json', 'content_type': 'application/json', 'text': text}
        finally:
            conn.execute('RELEASE library_inventory')
