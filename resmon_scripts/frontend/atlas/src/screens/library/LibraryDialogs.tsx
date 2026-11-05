import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { count, publishedWords } from '../today/format';
import { errorWords } from './Cards';
import { evidence, type Project } from './evidenceApi';
import { goesWith, shortWho } from './galleryModel';
import { LIBRARY, type LibraryRemoval } from './libraryApi';
import { useCollection } from '../../collections/current';

/** A sheet over the page, as the shortcuts sheet is: Escape or a click outside closes it, and the keyboard stays inside. */
export function Sheet({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => { if (node?.open) node.close(); };
  }, []);
  return (
    <dialog ref={dialog} className={wide ? 'lib-sheet wide' : 'lib-sheet'} aria-labelledby={heading}
      onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}
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
          <ul>{goesWith(s).map((line) => <li key={line}>{line}</li>)}</ul>
        </section>
      ))}
      <div className="lib-sheet-acts">
        <button type="button" className="btn" onClick={onCancel}>Keep {one ? 'it' : 'them'}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Removing' : one ? 'Remove it and these' : `Remove ${count(summaries.length, 'file')} and these`}
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
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const field = useId();
  useEffect(() => {
    const settle = window.setTimeout(() => setQ(draft.trim()), 250);
    return () => window.clearTimeout(settle);
  }, [draft]);
  // Searched in the collection this window shows; a paper of another is found there.
  const { id: collection } = useCollection();
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
    onSuccess: () => { onLinked(); onClose(); },
  });
  const results = found.data?.results ?? [];
  return (
    <Sheet title={`Link ${file.original_name} to a paper`} onClose={onClose} wide>
      <p className="lib-sheet-lede">Find the paper in your collection. A link is your association; resmon does not check that the file is that paper.</p>
      <label className="sr-only" htmlFor={field}>Find a paper by title, author, or words in it</label>
      <div className="map-find lib-find wide">
        <svg className="icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
        <input id={field} type="search" value={draft} autoFocus autoComplete="off" spellCheck={false}
          placeholder="Find a paper by title, author, or words in it" onChange={(e) => { setDraft(e.target.value); link.reset(); }} />
      </div>
      <div className="lib-pick-list" aria-live="polite" aria-busy={found.isFetching}>
        {q.length < 2 && <p className="record-cap">Type two letters or more.</p>}
        {found.isError && <p className="field-error" role="alert">{errorWords(found.error)}</p>}
        {found.data && !results.length && <p className="record-cap">No paper in your collection matches “{q}”.</p>}
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
export function AddToProject({ vault, files, onClose, onAdded }: {
  vault: string; files: readonly { file_id: string; version_id: string; original_name: string }[];
  onClose: () => void; onAdded: (project: Project, added: number) => void;
}) {
  const projects = useQuery({ queryKey: ['evidence-projects', vault], queryFn: () => evidence.projects(vault) });
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: async (chosen: Project | null) => {
      let project = chosen ?? (await evidence.create(vault, name.trim())).project;
      let added = 0;
      for (const file of files) {
        const answered = await evidence.add(project, file);
        project = answered.project;
        if (answered.added) added += 1;
      }
      return { project, added };
    },
    onSuccess: ({ project, added }) => onAdded(project, added),
  });
  return (
    <Sheet title={`Add ${count(files.length, 'file')} to a project`} onClose={onClose}>
      <p className="lib-sheet-lede">A project holds the exact version of each file. Adding a file again changes nothing.</p>
      {projects.isError && <p className="field-error" role="alert">{errorWords(projects.error)}</p>}
      <ul className="lib-projects">
        {(projects.data?.projects ?? []).map((p) => (
          <li key={p.project_id}>
            <button type="button" className="lib-pick" disabled={add.isPending} onClick={() => add.mutate(p)}>
              <span className="lib-pick-title name">{p.name}</span>
              <span className="meta"><span>{count(p.file_count, 'file')}</span></span>
            </button>
          </li>
        ))}
      </ul>
      <form className="lib-new-project" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(null); }}>
        <label htmlFor="lib-new-project">Or a new project</label>
        <input id="lib-new-project" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Its name" autoComplete="off" />
        <button type="submit" className="btn" disabled={!name.trim() || add.isPending}>Make it and add</button>
      </form>
      {add.error && <p className="field-error" role="alert">{errorWords(add.error)}</p>}
      <div className="lib-sheet-acts"><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
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
