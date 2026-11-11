"""A paper's recorded shelf and associations, without reading the Library inventory."""
from __future__ import annotations

import os
from pathlib import Path
import sqlite3

from . import library


def _file_availability(root: int, row: dict) -> str:
    """Check only this retained path; presence does not establish its contents."""
    files = None
    folder = None
    fd = None
    try:
        files = library._open_dir('files', root)
        folder = library._open_dir(row['file_id'], files)
        fd = library._regular(Path(row['relative_path']).name, folder)
        return 'not_checked'
    except FileNotFoundError:
        return 'missing'
    except (library.LibraryError, OSError):
        # A refused or unreadable retained path belongs to this file, not the vault marker.
        return 'unavailable'
    finally:
        if fd is not None:
            os.close(fd)
        if folder is not None:
            os.close(folder)
        if files is not None:
            os.close(files)


def places(conn: sqlite3.Connection, document_id: int) -> dict:
    """Indexed paper/file lookups and current membership, never retained notes alone.

    Folder status checks its marker and import lock, not the whole catalog's
    consistency. Each linked path is checked separately; bytes are verified by
    the reader and before a project add. No paths or file contents are returned.
    """
    library.document_exists(conn, document_id)
    shelf = conn.execute('SELECT * FROM reading_queue WHERE document_id=?', (document_id,)).fetchone()
    files = [dict(row) for row in conn.execute('''SELECT f.* FROM library_file_documents l
        JOIN library_files f ON f.file_id=l.file_id WHERE l.document_id=? ORDER BY f.id''', (document_id,))]
    state = {'status': 'unconfigured'}
    changing = library.vault_changing()
    if changing:
        state['changing'] = changing
    vault = conn.execute('SELECT vault_id FROM library_vault WHERE singleton=1').fetchone()
    for row in files:
        row['availability'] = 'not_checked'
    if vault:
        try:
            with library.checked_vault(conn, vault[0]) as (_, root):
                try:
                    os.stat('.import.lock', dir_fd=root, follow_symlinks=False)
                    state['status'] = 'busy'
                except FileNotFoundError:
                    state['status'] = 'ready'
                if not changing:
                    for row in files:
                        row['availability'] = _file_availability(root, row)
        except library.LibraryError as exc:
            state['status'] = 'mismatch' if exc.reason == 'mismatch' else 'needs_attention'
        except FileNotFoundError:
            state['status'] = 'missing'
        except OSError:
            state['status'] = 'unavailable'
    projects: dict[str, dict] = {}
    for row in files:
        # There are at most 100 projects. Probe each project's unique membership
        # index for this file; no scan of all project files or saved notes.
        for project in conn.execute('''SELECT p.project_id,p.name,p.updated_at_utc FROM evidence_projects p
            WHERE p.vault_id=? AND EXISTS (SELECT 1 FROM evidence_project_files m
                WHERE m.project_id=p.project_id AND m.file_id=? AND m.version_id=?)''',
                                    (row['vault_id'], row['file_id'], row['version_id'])):
            projects[project['project_id']] = dict(project)
    return {'document_id': document_id, 'shelf': dict(shelf) if shelf else None, 'library': state,
            'files': [{k: row[k] for k in ('file_id', 'version_id', 'vault_id', 'original_name', 'media_type', 'availability')}
                      for row in files],
            'projects': sorted(projects.values(), key=lambda p: (p['updated_at_utc'], p['project_id']), reverse=True)}
