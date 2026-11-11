import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { PaperFullText, useLanded } from '../fulltext/GetPdf';
import { errorWords, useFullText, type FullTextStatus } from '../fulltext/fullText';
import { invalidateFor } from '../today/freshness';
import { AddToProject } from './LibraryDialogs';
import { LIBRARY, LIBRARY_KEY, retryLibrary, unsupportedWords, libraryProblem } from './libraryApi';
import { cannotPrepare, preparePaperFile } from './paperFile';
import { usePaperPlaces } from './PaperPlaces';
import type { components } from '../../api/schema';
import { UndoNotice, type Notice } from './UndoNotice';
import './paperActions.css';

export interface PaperActionProps {
  id: number; title: string; sourceName: string; sourceUrl: string | null;
  /** Rows share one quiet trigger; on a paper's page the actions are already visible. */
  compact?: boolean;
  fullText?: FullTextStatus;
  /** A known queue state is shown while the shared places lookup is pending. */
  queueStatus?: string | null;
  onChanged?: () => void;
  onRemove?: () => void;
  /** A Library card already has its one Read control. */
  hasReadAction?: boolean;
  children?: ReactNode;
}

/** The same Save, PDF, and project actions wherever a paper is encountered. */
export function PaperActions(props: PaperActionProps) {
  // A newly chosen paper owns fresh local controls even when a map reuses its panel.
  return <Actions key={props.id} {...props} title={props.title.trim() || `Paper ${props.id}`} />;
}

function Actions({ id, title, sourceName, sourceUrl, compact = false, fullText, queueStatus, onChanged, onRemove, hasReadAction, children }: PaperActionProps) {
  const client = useQueryClient();
  const target = useId();
  const anchor = `--paper-${target.replace(/[^a-z0-9]/gi, '')}`;
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const projectButton = useRef<HTMLButtonElement>(null);
  const savedFocus = useRef(false);
  const wasProject = useRef(false);
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState(false);
  const [added, setAdded] = useState<{ name: string; id: string } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // When this control's own save or removal last landed: until the paper's
  // places are read again after it, Save waits rather than act on old state.
  const [toggledAt, setToggledAt] = useState(0);
  const shown = !compact || open;
  // Duplicate rows (a paper can occur under two watches) share the acknowledged queue state.
  const saved = usePaperPlaces(id, shown);
  const state = saved.data ? saved.data.shelf?.status ?? null : queueStatus;
  const setShelf = (entry: components['schemas']['ReadingQueueEntry'] | null) => {
    client.setQueryData<components['schemas']['LibraryPaperPlaces']>(['paper-places', id], (prev) => prev ? { ...prev, shelf: entry } : prev);
  };
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['paper', id] });
    void client.invalidateQueries({ queryKey: ['reading-queue'] });
    void client.invalidateQueries({ queryKey: ['run-papers'] });
    void client.invalidateQueries({ queryKey: ['paper-places', id] });
    void invalidateFor(client, 'paper-changed');
    onChanged?.();
  };
  const toggle = useMutation({
    mutationFn: async (wasSaved: boolean) => {
      if (wasSaved) {
        const { entry } = await answer(engine().DELETE('/api/reading-queue/{document_id}', { params: { path: { document_id: id } } }));
        setNotice({ id: Date.now(), lead: 'Removed ', name: title, rest: ' from the reading queue.', undo: async () => {
          const restored = await answer(engine().POST('/api/reading-queue/{document_id}/restore', {
            params: { path: { document_id: id } }, body: {
              status: entry.status, saved_at: entry.saved_at, updated_at: entry.updated_at, read_at: entry.read_at,
            },
          }));
          setShelf(restored.entry);
          refresh();
          if (!restored.restored) return 'This paper was saved again. Its current shelf and dates were kept.';
        } });
        return null;
      }
      return await answer(engine().POST('/api/reading-queue', { body: { document_id: id } }));
    },
    onSuccess: (next) => { setShelf(next); setToggledAt(Date.now()); refresh(); },
  });
  // A background read (the Library's busy poll, a window refocus) never disables Save.
  const rereading = toggledAt > 0 && saved.isFetching && saved.dataUpdatedAt <= toggledAt;
  useEffect(() => {
    if (toggle.isPending || saved.isFetching || !savedFocus.current) return;
    savedFocus.current = false;
    if (!document.activeElement || document.activeElement === document.body) saveButton.current?.focus();
  }, [toggle.isPending, saved.isFetching]);
  useEffect(() => {
    if (wasProject.current && !project) (trigger.current ?? projectButton.current)?.focus();
    wasProject.current = project;
  }, [project]);
  const statuses = useFullText(shown && !fullText ? [id] : []);
  useLanded(statuses.data);
  const status = fullText ?? statuses.data?.get(id);
  const name = (action: string) => `${action} for “${title}”`;
  const close = () => { popover.current?.hidePopover?.(); setOpen(false); trigger.current?.focus(); };
  const saveUnavailable = state === undefined || toggle.isPending || rereading;
  const contents = (
    <>
      <div className="paper-quick-buttons">
        <button type="button" className="btn sm" ref={saveButton} aria-label={name(state ? 'Saved' : 'Save to Read')}
          aria-pressed={!!state} title={state ? 'Remove from the reading queue' : 'Save to Read'}
          aria-disabled={saveUnavailable} onClick={() => {
            if (saveUnavailable) return;
            savedFocus.current = document.activeElement === saveButton.current;
            if (state && onRemove) { close(); onRemove(); } else toggle.mutate(!!state);
          }}>
          <Icon name={state ? 'bookmarked' : 'bookmark'} size={14} />{state ? 'Saved' : 'Save to Read'}
        </button>
        <button type="button" className="btn sm" ref={projectButton} aria-label={name('Add to a Project')}
          onClick={() => { close(); setProject(true); }}>Add to a Project</button>
      </div>
      {saved.isError && <p className="field-error" role="alert">{errorWords(saved.error)}</p>}
      {toggle.error && <p className="field-error" role="alert">{errorWords(toggle.error)}</p>}
      {shown && !(hasReadAction && status?.in_library) && <PaperFullText id={id} sourceUrl={sourceUrl} sourceName={sourceName} title={title} fullText={status} />}
      {children}
    </>
  );
  return (
    <>
      {compact ? (
        <span className="paper-quick">
          <button type="button" className="iconbtn sm" ref={trigger} aria-label={name('Paper Actions')} title="Paper Actions"
            popoverTarget={target} aria-haspopup="dialog" aria-expanded={open}
            style={{ anchorName: anchor } as CSSProperties}><Icon name="more" /></button>
          <div id={target} ref={popover} popover="auto" data-open={open} className="paper-quick-menu" role="dialog" tabIndex={-1} aria-label={name('Paper Actions')}
            style={{ positionAnchor: anchor } as CSSProperties} onToggle={(event) => {
              const next = event.newState === 'open';
              // Commit the controls before focusing them in this native event.
              flushSync(() => setOpen(next));
              // Native toggle runs after showing; light dismissal leaves focus where it went.
              if (next) saveButton.current?.focus();
            }}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(); trigger.current?.focus(); } }}>
            {open && contents}
          </div>
        </span>
      ) : <div className="paper-quick-inline">{contents}</div>}
      {project && <PaperProject id={id} title={title} status={status} onClose={() => { setProject(false); trigger.current?.focus(); }}
        onAdded={(name, projectId) => { setAdded({ name, id: projectId }); setProject(false); trigger.current?.focus(); }} />}
      {added && <p className="record-cap paper-quick-added" role="status">In <Link to={`/library/evidence?project=${encodeURIComponent(added.id)}`}>{added.name}</Link>.</p>}
      {notice && createPortal(<UndoNotice key={notice.id} notice={notice} onDone={() => setNotice(null)} />, document.body)}
    </>
  );
}

function PaperProject({ id, title, status, onClose, onAdded }: {
  id: number; title: string; status: FullTextStatus | undefined; onClose: () => void; onAdded: (name: string, id: string) => void;
}) {
  const client = useQueryClient();
  const library = useQuery({ queryKey: LIBRARY_KEY, queryFn: () => answer(engine().GET('/api/library', LIBRARY)), retry: retryLibrary,
    refetchInterval: (query) => query.state.data?.changing || query.state.data?.status === 'busy' ? 1000 : false });
  const statuses = useFullText([id]);
  const current = statuses.data?.get(id) ?? status;
  // The sheet owns the folder it opened on, including through a temporary busy answer.
  const [vault, setVault] = useState<string | null>(() => library.data?.vault?.vault_id ?? null);
  if (vault === null && library.data?.vault) setVault(library.data.vault.vault_id);
  const why = current ? cannotPrepare(current) : null;
  const ready = !library.isError && !!vault && library.data?.status === 'ready' && !library.data.changing && library.data.vault?.vault_id === vault;
  const heading = `Add “${title}” to a Project`;
  return <AddToProject vault={vault} files={[]} title={heading} onClose={onClose} blocked={!ready || !current || !!why}
    statusContent={<>
      {(library.isPending || (!current && statuses.isPending)) && <p className="record-cap">Checking the Library and this paper’s PDF.</p>}
      {library.error && <p role="alert" className="field-error">{unsupportedWords(library.error) ?? errorWords(library.error)}</p>}
      {statuses.error && <p role="alert" className="field-error">{errorWords(statuses.error)}</p>}
      {library.data && !ready && <p className="record-cap" role="status">{libraryProblem(library.data)}</p>}
      {!current && statuses.isSuccess && <p className="record-cap">The engine did not answer about this paper’s PDF.</p>}
      {why && <p className="record-cap">The Library needs a PDF before this paper can be added. {why}</p>}
      {!ready && <Link className="btn" to="/library?show=files" onClick={onClose}>Your Files</Link>}
    </>}
    explanation={current?.in_library ? undefined : 'Choose a project. resmon gets the PDF first, then adds it. Closing this menu stops waiting for the PDF. A download or project write already sent may still finish.'}
    prepareFiles={async (signal) => {
      try { return await preparePaperFile(id, vault!, signal, () => { void client.invalidateQueries({ queryKey: ['full-text'] }); }); }
      finally {
        void client.invalidateQueries({ queryKey: ['full-text'] });
        void client.invalidateQueries({ queryKey: ['library-files'] });
        void client.invalidateQueries({ queryKey: ['paper-places', id] });
      }
    }}
    onAdded={(project) => {
      void client.invalidateQueries({ queryKey: ['evidence-projects'] });
      void client.invalidateQueries({ queryKey: ['paper-places', id] });
      void client.invalidateQueries({ queryKey: ['full-text'] });
      void client.invalidateQueries({ queryKey: ['library-files'] });
      void client.invalidateQueries({ queryKey: ['reading-queue'] });
      onAdded(project.name, project.project_id);
    }} />;
}
