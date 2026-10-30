import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { count, number } from '../today/format';
import { Answers } from './Answers';
import { evidence, evidenceFetch, EvidenceRefusal, type Anchor, type FileRecord, type Member, type Note, type Project } from './evidenceApi';
import { bundleRefusal, pinOf } from './evidenceModel';
import { LibraryTabs } from './LibraryTabs';
import { Reader } from './Reader';
import { LIBRARY, LIBRARY_KEY, kindOf, sizeWords, type LibraryFile } from './libraryApi';

function errorWords(error: unknown): string {
  if (error instanceof EngineError && error.detail) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Library › Evidence: projects that gather exact versions of files you keep,
 * the passages you take from their pages, and notes on them.
 *
 * A passage is pinned to one page's canonical text by its hash and codepoint
 * offsets, and the engine checks the quote against the retained bytes before
 * it saves it. Reopening a passage resolves it against the same version,
 * extraction contract, hash and range, or says that it does not. Removing a
 * file from a project keeps the records made against it. An export carries the
 * files chosen and their records, and nothing of any other.
 */
export function Evidence() {
  const status = useQuery({ queryKey: LIBRARY_KEY, queryFn: () => answer(engine().GET('/api/library', LIBRARY)) });
  const vault = status.data?.status === 'ready' ? status.data.vault?.vault_id ?? null : null;
  return (
    <div className="page library evidence-page" aria-busy={status.isFetching}>
      <LibraryTabs />
      <div className="library-head"><h1 className="page-title">Evidence</h1></div>
      {status.isPending && <p className="page-lede">Reading the library.</p>}
      {status.data && !vault && (
        <p className="page-lede" data-evidence="no-vault">
          Evidence works on files kept in your library. <Link to="/library/files">Make the library first, under Your files</Link>.
        </p>
      )}
      {vault && <Workspaces vault={vault} />}
    </div>
  );
}

function Workspaces({ vault }: { vault: string }) {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const chosen = params.get('project');
  /** A file brought from Your files, by its id, until it is added or set aside. */
  const handoff = params.get('file');
  const go = (project: string) => setParams(handoff ? { project, file: handoff } : { project });
  const [name, setName] = useState('');
  const brought = useQuery({
    queryKey: ['library-file', vault, handoff],
    enabled: !!handoff,
    queryFn: () => answer(engine().GET('/api/library/files/{file_id}', {
      ...LIBRARY, params: { path: { file_id: handoff! }, query: { expected_vault_id: vault } },
    })),
  });
  const projects = useQuery({ queryKey: ['evidence-projects', vault], queryFn: () => evidence.projects(vault) });
  const create = useMutation({
    mutationFn: (title: string) => evidence.create(vault, title),
    onSuccess: (made) => {
      setName('');
      void client.invalidateQueries({ queryKey: ['evidence-projects', vault] });
      go(made.project_id);
    },
  });
  const list = projects.data?.projects ?? [];
  const open = chosen ?? list[0]?.project_id ?? null;
  return (
    <div className="evidence-split">
      <nav className="ev-projects" aria-label="Evidence projects" aria-busy={projects.isFetching}>
        <form className="ev-new" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(name.trim()); }}>
          <label htmlFor="ev-new-name" className="sr-only">A name for a new project</label>
          <input id="ev-new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="A new project’s name" maxLength={120} autoComplete="off" />
          <button type="submit" className="btn sm" disabled={!name.trim() || create.isPending}>Start</button>
        </form>
        {create.error && <p className="field-error" role="alert">{errorWords(create.error)}</p>}
        {projects.data && !list.length && <p className="index-empty">No project yet. Start one, then add files from your library.</p>}
        <ol>
          {list.map((p) => (
            <li key={p.project_id}>
              <button type="button" className="ev-project" aria-pressed={p.project_id === open} data-project={p.project_id}
                onClick={() => go(p.project_id)}>
                <span className="lib-name">{p.name}</span>
                <span className="meta"><span>{count(p.file_count, 'file')}</span><span className="sep" /><span>{count(p.note_count, 'record')}</span></span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      {open
        ? <Workspace key={open} vault={vault} projectId={open} brought={brought.data?.file ?? null}
            onHandedOff={() => setParams({ project: open })} />
        : brought.data && (
          <section className="ev-workspace">
            <section className="ev-handoff" aria-label="Brought from Your files">
              <p><b>{brought.data.file.original_name}</b>, from Your files. Start a project for it, then add this exact version.</p>
            </section>
          </section>
        )}
      {brought.error && <p className="field-error" role="alert">{errorWords(brought.error)}</p>}
    </div>
  );
}

function Workspace({ vault, projectId, brought, onHandedOff }: {
  vault: string; projectId: string; brought: LibraryFile | null; onHandedOff: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'answers' ? 'answers' : 'files';
  const show = (next: 'files' | 'answers') => setParams((prior) => {
    const kept = new URLSearchParams(prior);
    if (next === 'answers') kept.set('view', 'answers'); else kept.delete('view');
    return kept;
  });
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ['evidence-project', projectId], queryFn: () => evidence.detail(vault, projectId) });
  const project = detail.data?.project ?? null;
  const members = useQuery({ queryKey: ['evidence-members', projectId], enabled: !!project, queryFn: () => evidence.members(project!) });
  const notes = useQuery({ queryKey: ['evidence-notes', projectId], enabled: !!project, queryFn: () => evidence.notes(project!) });
  const [picked, setPicked] = useState<string | null>(null);
  const [reopen, setReopen] = useState<Note | null>(null);
  /** The reopened passage as a pinned range: one object per reopening, so the reader selects it once. */
  const pin = useMemo(() => (reopen ? pinOf(reopen) : null), [reopen]);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  /** The saved record whose body is being edited; choosing a passage stops editing. */
  const [editing, setEditing] = useState<Note | null>(null);
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** Focus mode: the reader takes the window, and the notes come back as a side panel when asked for. */
  const [focus, setFocus] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  /** A write answers with the project at its new revision: keep it, and read the lists again. */
  const changed = (next: Project) => {
    client.setQueryData(['evidence-project', projectId], (old: { project: Project } | undefined) => (old ? { ...old, project: next } : old));
    void client.invalidateQueries({ queryKey: ['evidence-members', projectId] });
    void client.invalidateQueries({ queryKey: ['evidence-notes', projectId] });
    void client.invalidateQueries({ queryKey: ['evidence-projects', vault] });
  };
  /** A write refused because the project moved on: read the project and its files again. */
  const readAgain = () => {
    void client.invalidateQueries({ queryKey: ['evidence-project', projectId] });
    void client.invalidateQueries({ queryKey: ['evidence-members', projectId] });
  };
  const remove = useMutation({
    mutationFn: (file: FileRecord) => evidence.remove(project!, file),
    onSuccess: (done) => { changed(done.project); setPicked(null); },
  });
  const read = (fileId: string) => { setReopen(null); setAnchor(null); setPicked(fileId); };
  const bring = useMutation({
    mutationFn: (file: LibraryFile) => evidence.add(project!, file),
    onSuccess: (done, file) => { changed(done.project); read(file.file_id); onHandedOff(); },
  });

  if (detail.isPending) return <section className="ev-workspace"><p className="record-cap">Reading the project.</p></section>;
  if (detail.isError || !project) return <section className="ev-workspace"><p className="field-error" role="alert">{errorWords(detail.error)}</p></section>;
  const memberList = members.data?.files ?? [];
  const current: Member | undefined = memberList.find((m) => m.file_id === (reopen?.file_id ?? picked)) ?? (reopen ? undefined : memberList[0]);
  const reopenedFile: FileRecord | null = reopen && !current ? reopen.file : null;
  const reading = current?.file ?? reopenedFile;
  const focused = focus && view === 'files' && reading?.media_type === 'application/pdf';

  return (
    <section className="ev-workspace" aria-label={`Project ${project.name}`} data-project={project.project_id} data-revision={project.revision}>
      <header className="ev-head">
        <Rename project={project} onRenamed={changed} />
        <p className="meta">
          <span>{count(project.file_count, 'file')}</span><span className="sep" />
          <span>{count(project.note_count, 'saved record')}</span><span className="sep" />
          <span>revision {number(project.revision)}</span>
        </p>
        <div className="lib-actions">
          <button type="button" className="btn sm" aria-pressed={adding} onClick={() => setAdding((a) => !a)}>Add files</button>
          <button type="button" className="btn sm" aria-pressed={exporting && memberList.length > 0} disabled={!memberList.length}
            onClick={() => setExporting((x) => !x)}>
            Export selected evidence
          </button>
        </div>
      </header>
      {brought && (
        <section className="ev-handoff" aria-label="Brought from Your files">
          <p>
            <b>{brought.original_name}</b>, from Your files: version <code className="path">{brought.version_id}</code>.
          </p>
          <div className="lib-actions">
            {memberList.some((m) => m.file_id === brought.file_id && m.version_id === brought.version_id)
              ? (
                <>
                  <span className="record-cap">This exact version is already in the project.</span>
                  <button type="button" className="btn sm" onClick={() => { read(brought.file_id); onHandedOff(); }}>Read it</button>
                </>
              )
              : (
                <button type="button" className="btn sm primary" disabled={!members.data || bring.isPending} onClick={() => bring.mutate(brought)}>
                  Add {brought.original_name} to this project
                </button>
              )}
            <button type="button" className="btn sm quiet" onClick={onHandedOff}>Not now</button>
          </div>
          {bring.error && <p className="field-error" role="alert">{errorWords(bring.error)}</p>}
        </section>
      )}
      {adding && <AddFiles vault={vault} project={project} members={memberList} onAdded={changed} />}
      {/* With no file left there is nothing to export, so the panel goes rather than keep a choice of files that are gone. */}
      {exporting && memberList.length > 0 && <Bundle project={project} members={memberList} onStale={readAgain} />}

      <div className="ev-views" role="group" aria-label="In this project">
        <button type="button" className="ev-view" aria-pressed={view === 'files'} onClick={() => show('files')}>Files and passages</button>
        <button type="button" className="ev-view" aria-pressed={view === 'answers'} onClick={() => show('answers')}>Answers</button>
      </div>
      {view === 'answers' && <Answers project={project} members={memberList} notes={notes.data?.notes ?? []} />}
      {view === 'files' && (
      <div className="ev-body" ref={body} data-focus={focused ? 'true' : undefined} data-notes={focused && notesOpen ? 'open' : undefined}>
        <section className="ev-members" aria-label="Files in this project">
          <h2 className="record-sub">Files</h2>
          {members.data && !memberList.length && <p className="record-cap">None yet. Add files from your library.</p>}
          <ol>
            {memberList.map((m) => (
              <li key={m.file_id}>
                <button type="button" className="library-file" aria-pressed={m.file_id === current?.file_id} data-file={m.file_id}
                  onClick={() => read(m.file_id)} title={m.file.original_name}>
                  <span className="lib-name">{m.file.original_name}</span>
                  <span className="meta"><span>{kindOf(m.file.media_type)}</span><span className="sep" /><span>{sizeWords(m.file.byte_size)}</span></span>
                </button>
              </li>
            ))}
          </ol>
        </section>

        {reading && (
          <Reader key={`${reading.file_id}:${reopen?.note_id ?? ''}`} project={project}
            file={reading} member={!!current} pin={pin}
            onAnchor={(a) => { setEditing(null); setAnchor(a); }} onRemove={current ? () => remove.mutate(current.file) : undefined} removing={remove.isPending}
            focus={focused} onFocus={setFocus} notesOpen={notesOpen} onNotes={setNotesOpen} focusScope={body} />
        )}

        <NotesPanel project={project} file={current?.file ?? null} member={!!current} anchor={anchor}
          onClose={focused ? () => setNotesOpen(false) : undefined}
          editing={editing} onEdit={(n) => { setAnchor(null); setEditing(n); }}
          notes={notes.data?.notes ?? []} total={notes.data?.total ?? 0}
          onSaved={changed} onClear={() => setAnchor(null)}
          onReopen={(n) => { setAnchor(null); setReopen(n); setPicked(n.file_id); }} />
      </div>
      )}
      {remove.error && <p className="field-error" role="alert">{errorWords(remove.error)}</p>}
    </section>
  );
}

function Rename({ project, onRenamed }: { project: Project; onRenamed: (p: Project) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (name: string) => evidence.rename(project, name),
    onSuccess: (done) => { setDraft(null); onRenamed(done.project); },
  });
  if (draft === null) {
    return (
      <div className="ev-title-row">
        <h2 className="ev-title">{project.name}</h2>
        <button type="button" className="btn sm quiet" onClick={() => setDraft(project.name)}>Rename</button>
      </div>
    );
  }
  return (
    <form className="ev-title-row" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) rename.mutate(draft.trim()); }}>
      <label htmlFor="ev-rename" className="sr-only">The project’s name</label>
      <input id="ev-rename" value={draft} maxLength={120} autoFocus onChange={(e) => setDraft(e.target.value)} />
      <button type="submit" className="btn sm" disabled={!draft.trim() || rename.isPending}>Save</button>
      <button type="button" className="btn sm quiet" onClick={() => setDraft(null)}>Cancel</button>
      {rename.error && <p className="field-error" role="alert">{errorWords(rename.error)}</p>}
    </form>
  );
}

function AddFiles({ vault, project, members, onAdded }: { vault: string; project: Project; members: Member[]; onAdded: (p: Project) => void }) {
  const files = useQuery({
    queryKey: ['library-files', vault, ''],
    queryFn: () => answer(engine().GET('/api/library/files', { ...LIBRARY, params: { query: { expected_vault_id: vault, q: '', limit: 100 } } })),
  });
  const held = new Set(members.map((m) => m.file_id));
  const [chosen, setChosen] = useState<string[]>([]);
  const add = useMutation({
    // One at a time: each write needs the project's revision the last one left.
    mutationFn: async (ids: string[]) => {
      let current = project;
      for (const id of ids) {
        const file = files.data?.files.find((f) => f.file_id === id);
        if (!file) continue;
        current = (await evidence.add(current, file)).project;
      }
      return current;
    },
    onSuccess: (next) => { setChosen([]); onAdded(next); },
  });
  const available = (files.data?.files ?? []).filter((f) => !held.has(f.file_id));
  return (
    <section className="ev-add" aria-label="Add files from your library">
      {files.data && !available.length && <p className="record-cap">Every kept file is already in this project.</p>}
      <ul>
        {available.map((f) => (
          <li key={f.file_id}>
            <label className="choice">
              <input type="checkbox" checked={chosen.includes(f.file_id)}
                onChange={(e) => setChosen((c) => (e.target.checked ? [...c, f.file_id] : c.filter((x) => x !== f.file_id)))} />
              <span>{f.original_name}</span>
              <span className="record-cap">{kindOf(f.media_type)}, {sizeWords(f.byte_size)}</span>
            </label>
          </li>
        ))}
      </ul>
      <button type="button" className="btn sm primary" disabled={!chosen.length || add.isPending} onClick={() => add.mutate(chosen)}>
        {add.isPending ? 'Adding' : chosen.length ? `Add ${count(chosen.length, 'file')}` : 'Add the chosen files'}
      </button>
      <p className="form-hint">A project holds the exact version of each file you add. Removing one later keeps the records made against it.</p>
      {add.error && <p className="field-error" role="alert">{errorWords(add.error)}</p>}
    </section>
  );
}

function NotesPanel({ project, file, member, anchor, onClose, editing, onEdit, notes, total, onSaved, onClear, onReopen }: {
  project: Project; file: FileRecord | null; member: boolean; anchor: Anchor | null;
  /** In focus mode the panel sits beside the pages, and this puts it away again. */
  onClose?: () => void;
  editing: Note | null;
  onEdit: (n: Note | null) => void; notes: Note[]; total: number;
  onSaved: (p: Project) => void; onClear: () => void; onReopen: (n: Note) => void;
}) {
  const [body, setBody] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => (editing ? evidence.edit(project, editing, body) : evidence.save(project, file!, body, anchor)),
    onSuccess: (done) => { setBody(''); onEdit(null); onClear(); setSaid(`Saved ${done.note.kind === 'passage' ? 'the passage' : 'the note'} against this exact version.`); onSaved(done.project); },
    onError: () => setSaid(null),
  });
  const length = Array.from(body).length;
  const heading = editing ? `Edit the saved body · ${editing.file.original_name}` : anchor ? 'New exact passage' : 'New plain note';
  const canSave = !save.isPending && length <= 20_000 && (editing ? true : member && !!file && (anchor ? true : length > 0));
  return (
    <section className="ev-notes" aria-label="Saved evidence notes">
      {onClose && (
        <div className="ev-notes-bar">
          <h2 className="record-sub">Notes</h2>
          <button type="button" className="btn sm quiet" onClick={onClose}>Close the notes</button>
        </div>
      )}
      {(file || editing) && (
        <form className="ev-note-form" onSubmit={(e) => { e.preventDefault(); if (canSave) save.mutate(); }}>
          <h3 className="record-sub">{heading}</h3>
          {(editing?.quote ?? (anchor && !editing ? anchor.quote : null)) && (
            <blockquote className="ev-quote" data-evidence="quote">{editing?.quote ?? anchor?.quote}</blockquote>
          )}
          {anchor && !editing && <p className="record-cap">Page {anchor.page_number}, codepoints {anchor.start_codepoint} to {anchor.end_codepoint}.</p>}
          <label htmlFor="ev-body" className="form-label">{anchor && !editing ? 'Your note on it (optional)' : 'Note'}</label>
          <textarea id="ev-body" value={body} rows={4} onChange={(e) => setBody(e.target.value)} />
          <div className="ev-use">
            <button type="submit" className="btn sm primary" disabled={!canSave}>
              {editing ? 'Save body' : anchor ? 'Save passage' : 'Save note'}
            </button>
            {(anchor || editing) && <button type="button" className="btn sm quiet" onClick={() => { onEdit(null); onClear(); }}>Use plain note</button>}
            <span className="record-cap num">{number(length)} of 20,000 codepoints</span>
          </div>
          {!member && !editing && <p className="record-cap">This file is not in the project, so nothing new can be saved against it.</p>}
          {save.error && <p className="field-error" role="alert">{errorWords(save.error)} Your text is still here.</p>}
        </form>
      )}
      {said && !save.isPending && <p className="settings-said" role="status" data-evidence="saved">{said}</p>}
      <h3 className="record-sub">Saved records</h3>
      {!notes.length && <p className="record-cap">None yet.</p>}
      <ol className="ev-saved">
        {notes.map((n) => (
          <li key={n.note_id} data-note={n.note_id} data-kind={n.kind} data-version={n.version_id}>
            <p className="ev-saved-head">
              <b className="ev-saved-file" title={n.file.original_name}>{n.file.original_name}</b>
              <span className="record-cap">{n.kind}{n.page_number ? ` · page ${n.page_number}` : ''}{n.membership_state === 'removed' ? ' · file removed from the project' : ''}</span>
            </p>
            {n.quote !== null && <blockquote className="ev-quote">{n.quote}</blockquote>}
            {n.body && <p className="ev-body-text">{n.body}</p>}
            <div className="lib-actions">
              {n.kind === 'passage' && <button type="button" className="btn sm" onClick={() => onReopen(n)}>Reopen the passage</button>}
              <button type="button" className="btn sm quiet" onClick={() => { onEdit(n); setBody(n.body); }}>Edit the body</button>
            </div>
          </li>
        ))}
      </ol>
      {total > notes.length && <p className="record-cap">Showing {number(notes.length)} of {number(total)}.</p>}
    </section>
  );
}

/**
 * Export: 1 to 20 chosen files, every record made against those exact
 * versions, and their bytes if asked. Nothing of a file left out goes in.
 *
 * The choice is read against the project's files as they are now, so a file
 * removed from the project leaves the choice, its bytes leave the size, and
 * Save stays off until something that is still here is chosen.
 */
function Bundle({ project, members, onStale }: { project: Project; members: Member[]; onStale: () => void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [include, setInclude] = useState(false);
  const current = members.filter((m) => chosen.includes(m.file_id));
  const toggle = (fileId: string, on: boolean) => {
    const kept = current.map((m) => m.file_id).filter((id) => id !== fileId);
    setChosen(on ? [...kept, fileId] : kept);
  };
  const download = useMutation({
    mutationFn: async () => {
      const selected = current.map((m) => ({ file_id: m.file_id, version_id: m.version_id }));
      if (!selected.length) throw new EngineError(0, 'Choose at least one of this project’s files first.');
      const response = await evidenceFetch(`/projects/${project.project_id}/bundle`, 'POST', {
        expected_vault_id: project.vault_id, expected_revision: project.revision, selected, include_files: include,
      });
      const bundleId = response.headers.get('X-Resmon-Bundle') ?? 'bundle';
      const bytes = await response.arrayBuffer();
      const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength)).join(',');
      if (signature !== '80,75,3,4') throw new EngineError(0, 'The answer is not a ZIP archive. Nothing was saved.');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `resmon-evidence-${project.project_id}-${bundleId}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return { bundleId, size: bytes.byteLength, files: selected.length, include };
    },
    onError: (error) => { if (error instanceof EvidenceRefusal && error.reason === 'stale_revision') onStale(); },
  });
  const bytes = current.reduce((n, m) => n + m.file.byte_size, 0);
  return (
    <section className="ev-bundle" aria-label="Export selected evidence">
      <p className="form-hint">Choose 1 to 20 files. Every record saved against those exact versions goes with them; nothing of a file left out does.</p>
      <ul>
        {members.map((m) => (
          <li key={m.file_id}>
            <label className="choice">
              <input type="checkbox" checked={chosen.includes(m.file_id)} disabled={!chosen.includes(m.file_id) && current.length >= 20}
                onChange={(e) => toggle(m.file_id, e.target.checked)} />
              <span>{m.file.original_name}</span>
            </label>
          </li>
        ))}
      </ul>
      <label className="choice">
        <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />
        <span>
          Include the files themselves
          {current.length ? ` (${sizeWords(bytes)} recorded)` : ''}, re-checked against their hashes first
        </span>
      </label>
      <button type="button" className="btn sm primary" disabled={!current.length || download.isPending} onClick={() => download.mutate()}>
        {download.isPending ? 'Building the archive' : 'Save the archive'}
      </button>
      {download.data && (
        <p className="settings-said" role="status" data-evidence="exported">
          Saved a {download.data.include ? 'files-and-records' : 'records-only'} archive of {count(download.data.files, 'file')}, {sizeWords(download.data.size)}.
        </p>
      )}
      {download.error && <p className="field-error" role="alert">{bundleRefusal(download.error)}</p>}
      <p className="form-hint">An archive is a portable copy of what you chose, not a backup: it is not encrypted, and it names the files and carries their notes.</p>
    </section>
  );
}

