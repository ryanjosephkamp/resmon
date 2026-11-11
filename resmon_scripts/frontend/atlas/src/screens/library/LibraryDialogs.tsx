import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { count, publishedWords } from '../today/format';
import { errorWords } from '../fulltext/fullText';
import { allProjects, evidence, type Project } from './evidenceApi';
import { goesWith, shortWho } from './galleryModel';
import { LIBRARY, type LibraryRemoval } from './libraryApi';
import { useCollection, useCollectionWords } from '../../collections/current';
import { invalidatePlacesForFiles } from './PaperPlaces';

/** A sheet over the page, as the shortcuts sheet is: Escape or a click outside closes it, and the keyboard stays inside. */
export function Sheet({ title, onClose, children, wide = false, dismissBlocked = false }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean; dismissBlocked?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => { if (node?.open) node.close(); };
  }, []);
  return (
    <dialog ref={dialog} className={wide ? 'lib-sheet wide' : 'lib-sheet'} aria-labelledby={heading}
      onClose={() => {
        // A native close must not hide an outstanding write's result or strand its mounted form.
        if (dismissBlocked) { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }
        else onClose();
      }} onCancel={(e) => { e.preventDefault(); if (!dismissBlocked) onClose(); }}
      onKeyDown={(e) => { if (dismissBlocked && e.key === 'Escape') e.preventDefault(); }}
      onMouseDown={(event) => { if (event.target === dialog.current) onClose(); }}>
      <h2 id={heading} className="lib-sheet-title">{title}</h2>
      {children}
    </dialog>
  );
}

/**
 * Asked before a file in an Evidence project, or with notes, is removed: what
 * goes with it, project by project. Nothing is removed until Remove is pressed,
 * and Undo puts the file and all of it back.
 */
export function ConfirmRemoval({ summaries, onConfirm, onCancel, busy }: {
  summaries: readonly LibraryRemoval[]; onConfirm: () => void; onCancel: () => void; busy: boolean;
}) {
  const { several } = useCollection();
  const one = summaries.length === 1;
  return (
    <Sheet title={one ? `Remove ${summaries[0]!.original_name}?` : `Remove ${count(summaries.length, 'file')}?`} onClose={onCancel}>
      <p className="lib-sheet-lede">
        {one ? 'This file is in an Evidence project.' : 'These files are in Evidence projects.'} Removing
        {one ? ' it' : ' them'} takes these with {one ? 'it' : 'them'}. Undo puts everything back as it was, and the
        file is held in the Library folder until you move it to the Trash in Settings › Library.
      </p>
      {summaries.map((s) => (
        <section key={s.file_id} className="lib-goes" data-file={s.file_id}>
          {!one && <h3>{s.original_name}</h3>}
          <ul>{goesWith(s, several).map((line) => <li key={line}>{line}</li>)}</ul>
        </section>
      ))}
      <div className="lib-sheet-acts">
        <button type="button" className="btn" onClick={onCancel}>Keep {one ? 'It' : 'Them'}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Removing' : one ? 'Remove It and These' : `Remove ${count(summaries.length, 'File')} and These`}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * Link a kept file to a paper in the collection, chosen by searching for it
 * rather than by typing its number. A link is the person's association; resmon
 * does not claim the file is that paper.
 */
export function PaperPicker({ vault, file, onClose, onLinked }: {
  vault: string; file: { file_id: string; original_name: string }; onClose: () => void; onLinked: () => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const field = useId();
  useEffect(() => {
    const settle = window.setTimeout(() => setQ(draft.trim()), 250);
    return () => window.clearTimeout(settle);
  }, [draft]);
  // Searched in the collection this window shows; a paper of another is found there.
  const { id: collection } = useCollection();
  const shown = useCollectionWords();
  const found = useQuery({
    queryKey: ['library-link-search', collection, q],
    enabled: q.length >= 2,
    queryFn: () => answer(engine().POST('/api/explorer/search', {
      body: { query: q, limit: 12, sort: 'newest', authors: [], categories: [], sources: [], ...(collection !== null ? { collection } : {}) },
    })),
  });
  const link = useMutation({
    mutationFn: (documentId: number) => answer(engine().POST('/api/library/files/{file_id}/paper-links', {
      ...LIBRARY, params: { path: { file_id: file.file_id } }, body: { expected_vault_id: vault, document_id: documentId },
    })),
    onSuccess: (_reply, documentId) => { void client.invalidateQueries({ queryKey: ['paper-places', documentId] }); onLinked(); onClose(); },
  });
  const results = found.data?.results ?? [];
  return (
    <Sheet title={`Link ${file.original_name} to a Paper`} onClose={onClose} wide>
      <p className="lib-sheet-lede">Find the paper in {shown.name}. A link is your association; resmon does not check that the file is that paper.</p>
      <label className="sr-only" htmlFor={field}>Find a paper by title, author, or words in it</label>
      <div className="map-find lib-find wide">
        <svg className="icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
        <input id={field} type="search" value={draft} autoFocus autoComplete="off" spellCheck={false}
          placeholder="Find a paper by title, author, or words in it" onChange={(e) => { setDraft(e.target.value); link.reset(); }} />
      </div>
      <div className="lib-pick-list" aria-live="polite" aria-busy={found.isFetching}>
        {q.length < 2 && <p className="record-cap">Type two letters or more.</p>}
        {found.isError && <p className="field-error" role="alert">{errorWords(found.error)}</p>}
        {found.data && !results.length && <p className="record-cap">No paper in {shown.name} matches “{q}”.</p>}
        <ul>
          {results.map((paper) => (
            <li key={paper.id}>
              <button type="button" className="lib-pick" disabled={link.isPending} onClick={() => link.mutate(paper.id)} data-document={paper.id}>
                <span className="lib-pick-title">{paper.title}</span>
                <span className="meta">
                  <span className="who">{shortWho(paper.authors)}</span>
                  <span className="sep" /><span>{paper.source_repository}</span>
                  {paper.publication_date && (<><span className="sep" /><span>{publishedWords(paper.publication_date)}</span></>)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {link.error && <p className="field-error" role="alert">{errorWords(link.error)}</p>}
      <div className="lib-sheet-acts"><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </Sheet>
  );
}

/** Put kept files into an Evidence project, each at its exact version. */
export function AddToProject({ vault, files, onClose, onAdded, prepareFiles, title, explanation, blocked, statusContent }: {
  vault: string | null; files: readonly { file_id: string; version_id: string; original_name: string }[];
  onClose: () => void; onAdded: (project: Project, added: number) => void;
  prepareFiles?: (signal: AbortSignal) => Promise<readonly { file_id: string; version_id: string; original_name: string }[]>;
  title?: string; explanation?: string;
  blocked?: boolean; statusContent?: ReactNode;
}) {
  const projects = useQuery({ queryKey: ['evidence-projects', vault, 'all'], enabled: !!vault, queryFn: () => allProjects(vault!) });
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [find, setFind] = useState('');
  const [making, setMaking] = useState(false);
  const [created, setCreated] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const createInFlight = useRef(false);
  const preparing = useRef<AbortController | null>(null);
  const waitingForFile = prepareFiles !== undefined;
  useEffect(() => () => { if (waitingForFile) preparing.current?.abort(); }, [waitingForFile]);
  const close = () => { if (createInFlight.current) return; if (waitingForFile) preparing.current?.abort(); onClose(); };
  const add = useMutation({
    mutationFn: async (chosen: Project | null) => {
      if (!vault || blocked) throw new Error('The Library is not ready. Wait for it before adding a file.');
      const controller = new AbortController();
      preparing.current = controller;
      const ready = prepareFiles ? await prepareFiles(controller.signal) : files;
      if (controller.signal.aborted) throw new Error('Adding to the project was canceled.');
      // Read the chosen project's current revision after a download, which may have taken minutes.
      const existing = chosen ?? created;
      let project: Project;
      if (existing) project = prepareFiles || created === existing ? (await evidence.detail(vault, existing.project_id)).project : existing;
      else {
        createInFlight.current = true;
        setCreating(true);
        try {
          project = (await evidence.create(vault, name.trim())).project;
          // If Add fails, retry this project rather than creating its name again.
          setCreated(project);
        } finally { createInFlight.current = false; setCreating(false); }
      }
      let added = 0;
      for (const file of ready) {
        if (controller.signal.aborted) throw new Error('Adding to the project was canceled.');
        const answered = await evidence.add(project, file);
        void invalidatePlacesForFiles(client, [file]);
        project = answered.project;
        if (answered.added) added += 1;
      }
      return { project, added };
    },
    onSuccess: ({ project, added }) => { if (!preparing.current?.signal.aborted) onAdded(project, added); },
  });
  const ordered = [...(projects.data ?? [])].sort((a, b) => b.updated_at_utc.localeCompare(a.updated_at_utc) || b.id - a.id);
  const shown = ordered.filter((p) => p.name.toLocaleLowerCase('en-US').includes(find.toLocaleLowerCase('en-US').trim()));
  const disabled = add.isPending || blocked || !vault;
  return (
    <Sheet title={title ?? `Add ${count(files.length, 'File')} to a Project`} onClose={close} dismissBlocked={creating}>
      <p className="lib-sheet-lede">A project holds the exact version of each file. Adding a file again changes nothing.</p>
      {explanation && <p className="record-cap">{explanation}</p>}
      {statusContent}
      {add.isPending && <p className="record-cap" role="status">{prepareFiles ? 'Getting the PDF if needed, then adding it to the project.' : 'Adding the files to the project.'}</p>}
      {vault && projects.isPending && <p className="record-cap">Reading projects.</p>}
      {projects.isError && <p className="field-error" role="alert">{errorWords(projects.error)}</p>}
      {ordered.length > 12 && <label>Find a project<input type="search" value={find} onChange={(e) => setFind(e.target.value)} /></label>}
      <ul className="lib-projects">
        {shown.map((p) => (
          <li key={p.project_id}>
            <button type="button" className="lib-pick" disabled={disabled} onClick={() => add.mutate(p)}>
              <span className="lib-pick-title name">{p.name}</span>
              <span className="meta"><span>{count(p.file_count, 'file')}</span></span>
            </button>
          </li>
        ))}
      </ul>
      {ordered.length > 0 && !shown.length && <p className="record-cap">No project matches “{find}”.</p>}
      {!created && <button type="button" className="btn" aria-expanded={making} disabled={disabled} onClick={() => setMaking((value) => !value)}>New Project…</button>}
      {making && <form className="lib-new-project" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(null); }}>
        <label htmlFor="lib-new-project">Project Name</label>
        <input id="lib-new-project" value={name} disabled={!!created || add.isPending} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Its name" autoComplete="off" />
        <button type="submit" className="btn" disabled={!name.trim() || disabled}>{created ? `Retry Add to “${created.name}”` : 'Create and Add'}</button>
      </form>}
      {add.error && <p className="field-error" role="alert">{errorWords(add.error)}</p>}
      {creating && <p className="record-cap" role="status">Creating the project. Cancel is available when this finishes.</p>}
      <div className="lib-sheet-acts"><button type="button" className="btn" disabled={creating} onClick={close}>Cancel</button></div>
    </Sheet>
  );
}

/**
 * Names a new Evidence project and makes it, from the Library's Projects
 * shelf; the caller opens it in Evidence, where files are added to it.
 */
export function NewProject({ vault, onClose, onMade }: { vault: string; onClose: () => void; onMade: (project: Project) => void }) {
  const client = useQueryClient();
  const form = useId();
  const [name, setName] = useState('');
  const make = useMutation({
    mutationFn: () => evidence.create(vault, name.trim()),
    onSuccess: (made) => {
      void client.invalidateQueries({ queryKey: ['evidence-projects', vault] });
      onMade(made.project);
    },
  });
  return (
    <Sheet title="New Project" onClose={onClose} dismissBlocked={make.isPending}>
      <p className="lib-sheet-lede">
        A project gathers exact versions of your files, the passages you pin in them, and the answers drawn from those
        passages. It opens in Evidence, where you add its files.
      </p>
      <form id={form} className="lib-new-project" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !make.isPending) make.mutate(); }}>
        <label htmlFor={`${form}-name`}>Project Name</label>
        <input id={`${form}-name`} value={name} maxLength={120} autoFocus autoComplete="off" disabled={make.isPending}
          onChange={(e) => setName(e.target.value)} placeholder="Its name" />
      </form>
      {make.error && <p className="field-error" role="alert">{errorWords(make.error)}</p>}
      <div className="lib-sheet-acts">
        <button type="button" className="btn" disabled={make.isPending} onClick={onClose}>Cancel</button>
        <button type="submit" form={form} className="btn primary" disabled={!name.trim() || make.isPending}>
          {make.isPending ? 'Creating the Project' : 'Create and Open'}
        </button>
      </div>
    </Sheet>
  );
}

/** What the engine says would go with each file, read before any is removed. */
export async function removalSummaries(files: readonly { vault_id: string; file_id: string; version_id: string }[]): Promise<LibraryRemoval[]> {
  const out: LibraryRemoval[] = [];
  for (const f of files) {
    out.push(await answer(engine().GET('/api/library/files/{file_id}/removal', {
      ...LIBRARY, params: { path: { file_id: f.file_id }, query: { expected_vault_id: f.vault_id, expected_version_id: f.version_id } },
    })));
  }
  return out;
}
