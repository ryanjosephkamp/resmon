import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { exportReferences, FORMATS, type ReferenceFormat } from '../runs/references';
import { collectionSky } from '../sky/collectionSky';
import { invalidateFor, MAP_KEY } from '../today/freshness';
import { epochDay } from '../today/model';
import { count, number } from '../today/format';
import { errorWords, FileCard, PaperCard, ProjectCard } from './Cards';
import type { Atlas } from './Cover';
import { evidence, type Project } from './evidenceApi';
import { Gallery } from './Gallery';
import {
  FIND_WORDS, LEDE, SHOWS, SORTS, UNDO_SECONDS, pick, pickedWords, removedWords, showFrom, sortFrom,
  type LibraryFileRow, type QueueEntry, type Show,
} from './galleryModel';
import { AddToProject, ConfirmRemoval, PaperPicker, removalSummaries } from './LibraryDialogs';
import {
  ACCEPT, LIBRARY, LIBRARY_KEY, importFile, importWords, keepable, retryLibrary, unsupportedWords,
  type LibraryImported, type LibraryRemoval, type LibraryStatus,
} from './libraryApi';
import { VaultSetup, VaultTrouble } from './VaultPanels';
import './library.css';

/** The queue's most entries a request, and so the page the gallery reads at a time. */
const QUEUE_PAGE = 200;
const FILE_PAGE = 200;

interface Notice { lead: string; name: string | null; rest: string; undo: (() => Promise<void>) | null; id: number }

/**
 * Library: one page for the papers saved to read, the files kept in your own
 * folder, and the Evidence projects built from them, as a gallery of covers.
 *
 * The shelf, the find and the order live in the address (`?show=`, `?q=`,
 * `?sort=`), so Back returns to the shelf as it was. A paper with a PDF in the
 * Library shows the PDF's first page; one without shows its piece of the
 * night chart. Removing a paper or a file can be undone for ten seconds from
 * the notice it leaves; a removed file stays held in the Library folder, and
 * Settings › Library can put it back later.
 */
export function Library({ shelf = 'to_read' }: { shelf?: Show }) {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  // `/library/files`, the old address of Your files, opens that shelf; `?show=` names any shelf.
  const show = params.get('show') ? showFrom(params.get('show')) : shelf;
  const sort = sortFrom(show, params.get('sort'));
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const [selecting, setSelecting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dropping, setDropping] = useState(false);
  const [imported, setImported] = useState<{ said: string; refused: string[] } | null>(null);
  const noticeId = useRef(0);
  const navigate = useNavigate();

  const set = useCallback((changes: Record<string, string | null>) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [k, v] of Object.entries(changes)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
      return next;
    }, { replace: true });
  }, [setParams]);
  // The find field follows the address when the shelf or the search changes there (Back, a shelf's button):
  // set while rendering, as React's own pattern for state that follows other state.
  const [following, setFollowing] = useState(`${show}\u0000${q}`);
  if (following !== `${show}\u0000${q}`) { setFollowing(`${show}\u0000${q}`); setDraft(q); }
  useEffect(() => {
    if (draft.trim() === q) return undefined;
    const settle = window.setTimeout(() => set({ q: draft.trim() || null }), 300);
    return () => window.clearTimeout(settle);
  }, [draft, q, set]);

  const status = useQuery({ queryKey: LIBRARY_KEY, queryFn: () => answer(engine().GET('/api/library', LIBRARY)), retry: retryLibrary });
  const vault = status.data?.status === 'ready' ? status.data.vault?.vault_id ?? null : null;
  const queueCounts = useQuery({
    queryKey: ['reading-queue', 'counts'],
    queryFn: () => answer(engine().GET('/api/reading-queue', { params: { query: { limit: 1 } } })),
  });
  // Under Evidence's own key, so a project made or changed there is read again here.
  const projects = useQuery({ queryKey: ['evidence-projects', vault, 'all'], enabled: !!vault, queryFn: () => allProjects(vault!) });
  const reread = projects.refetch;
  useEffect(() => { if (show === 'projects' && vault) void reread(); }, [show, vault, reread]);
  const counts: Record<Show, number | null> = {
    to_read: queueCounts.data?.counts.to_read ?? null,
    read: queueCounts.data?.counts.read ?? null,
    files: status.data?.vault ? status.data.counts.items : status.data ? 0 : null,
    // No folder made yet: no project can exist. A folder that cannot be read now: its projects are not counted.
    projects: projects.data ? projects.data.length : status.data && !status.data.vault ? 0 : null,
  };

  const say = useCallback((words: Omit<Notice, 'id'>) => {
    noticeId.current += 1;
    setNotice({ ...words, id: noticeId.current });
  }, []);
  const refreshQueue = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['reading-queue'] });
    void invalidateFor(client, 'paper-changed');
  }, [client]);
  const refreshFiles = useCallback(() => {
    void client.invalidateQueries({ queryKey: LIBRARY_KEY });
    void client.invalidateQueries({ queryKey: ['library-files'] });
    void client.invalidateQueries({ queryKey: ['library-file'] });
    void client.invalidateQueries({ queryKey: ['library-removed'] });
    void client.invalidateQueries({ queryKey: ['evidence-projects'] });
    void client.invalidateQueries({ queryKey: ['reading-queue'] });
  }, [client]);

  const importing = useMutation({
    mutationFn: async (chosen: File[]) => {
      if (!vault) throw new Error('Make the Library folder first, under Your files.');
      const results: LibraryImported[] = [];
      const refused: string[] = [];
      // One at a time: the engine holds one import lock per Library folder.
      for (const file of chosen) {
        if (!keepable(file.name)) { refused.push(`${file.name}: only PDF, TXT, MD, and TeX files are kept.`); continue; }
        try { results.push(await importFile(vault, file)); } catch (error) { refused.push(`${file.name}: ${errorWords(error)}`); }
      }
      return { results, refused };
    },
    onMutate: () => setImported(null),
    onSuccess: ({ results, refused }) => { setImported({ said: importWords(results, refused.length), refused }); refreshFiles(); },
  });
  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (chosen.length) importing.mutate(chosen);
  };
  // Files dragged in from the Finder are kept as Import files keeps them; nothing else on the page takes a drop.
  const dragged = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const onDragOver = (event: DragEvent) => {
    if (!dragged(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = vault ? 'copy' : 'none';
    if (!dropping) setDropping(true);
  };
  const onDrop = (event: DragEvent) => {
    if (!dragged(event)) return;
    event.preventDefault();
    setDropping(false);
    const chosen = Array.from(event.dataTransfer.files);
    if (!chosen.length) return;
    if (show !== 'files') navigate('/library?show=files', { replace: true });
    if (vault) importing.mutate(chosen);
    else setImported({ said: 'Nothing was kept: make the Library folder first.', refused: [] });
  };

  // A file removed on its own page comes back here with its Undo.
  const location = useLocation();
  const arrived = (location.state as { removed?: { file_id: string; name: string; vault: string } } | null)?.removed;
  useEffect(() => {
    if (!arrived) return;
    say({
      ...removedWords([arrived.name], 'Your files'),
      undo: async () => {
        await answer(engine().POST('/api/library/removed/{file_id}/restore', {
          ...LIBRARY, params: { path: { file_id: arrived.file_id } }, body: { expected_vault_id: arrived.vault },
        }));
        refreshFiles();
      },
    });
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [arrived, say, refreshFiles, navigate, location.pathname, location.search]);

  const unsupported = unsupportedWords(status.error);
  const fileShelf = show === 'files' || show === 'projects';
  const needsVault = fileShelf && status.data && !vault;
  const choose = (next: Show) => {
    setSelecting(false);
    navigate(next === 'to_read' ? '/library' : `/library?show=${next}`, { replace: true });
  };

  const tools = (extra?: ReactNode) => (
    <div className="lib-tools">
      <span className="seg" role="group" aria-label="Show">
        {SHOWS.map((s) => (
          <button key={s.id} type="button" aria-pressed={show === s.id} onClick={() => choose(s.id)}>
            {s.label}{counts[s.id] !== null && <span className="seg-n num">{number(counts[s.id]!)}</span>}
          </button>
        ))}
      </span>
      <label className="map-find lib-find">
        <Icon name="search" size={14} />
        <span className="sr-only">{FIND_WORDS[show]}</span>
        <input type="search" value={draft} placeholder={FIND_WORDS[show]} autoComplete="off" spellCheck={false}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && draft) { e.preventDefault(); setDraft(''); } }} />
      </label>
      <label className="trigger lib-sort">
        <Icon name="sort" size={14} />
        <span className="sr-only">Order</span>
        <select value={sort} onChange={(e) => set({ sort: e.target.value === SORTS[show][0]!.id ? null : e.target.value })}>
          {SORTS[show].map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <Icon name="chevron" size={14} />
      </label>
      <span className="lib-acts">
        {extra}
        {(show === 'to_read' || show === 'read' || (show === 'files' && !!vault))
          && <button type="button" className="btn sm" onClick={() => setSelecting(true)}>Select</button>}
      </span>
    </div>
  );

  return (
    <div className={`page lib-page${dropping ? ' dropping' : ''}`} data-show={show}
      onDragOver={onDragOver} onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false); }} onDrop={onDrop}>
      <h1 className="page-title">Library</h1>
      <p className="page-lede">{LEDE[show]}</p>
      {unsupported && fileShelf && <p className="page-lede" role="alert" data-library="unsupported">{unsupported}</p>}
      {status.isError && !unsupported && fileShelf && <p className="field-error" role="alert">The Library could not be read ({errorWords(status.error)}).</p>}

      {(show === 'to_read' || show === 'read') && (
        <PaperShelf status={show} sort={sort} q={q} vault={vault} selecting={selecting} onSelecting={setSelecting}
          tools={tools} say={say} onChanged={refreshQueue} />
      )}
      {show === 'files' && (
        vault
          ? (
            <FileShelf vault={vault} sort={sort} q={q} selecting={selecting} onSelecting={setSelecting} say={say}
              onChanged={refreshFiles} tools={tools(
                <label className="btn sm primary lib-import" aria-disabled={importing.isPending}>
                  {importing.isPending ? 'Keeping' : 'Import files'}
                  <input type="file" multiple accept={ACCEPT} aria-label="Import PDF, TXT, MD, or TeX" className="sr-only"
                    disabled={importing.isPending} onChange={onChosen} />
                </label>,
              )} imported={imported} />
          )
          : <>{tools()}{status.data && <VaultState status={status.data} />}</>
      )}
      {show === 'projects' && (
        vault
          ? <ProjectShelf projects={projects} q={q} sort={sort} tools={tools()} />
          : <>{tools()}{status.data && <VaultState status={status.data} />}</>
      )}
      {needsVault && imported && <p className="settings-said" role="status">{imported.said}</p>}

      {dropping && (
        <div className="lib-drop" aria-hidden="true">
          <p>{vault ? 'Drop to keep these files in your Library' : 'Make the Library folder first, under Your files'}</p>
        </div>
      )}
      {notice && <UndoNotice key={notice.id} notice={notice} onDone={() => setNotice((n) => (n?.id === notice.id ? null : n))} />}
    </div>
  );
}

/** The Library folder that is not ready: made the first time, or found again, or the engine's own sentence. */
function VaultState({ status }: { status: LibraryStatus }) {
  if (status.status === 'unconfigured') return <VaultSetup limits={status.limits} />;
  return <VaultTrouble status={status} />;
}

async function allProjects(vault: string): Promise<Project[]> {
  const out: Project[] = [];
  let after: number | undefined;
  for (;;) {
    const page = await evidence.projectsPage(vault, after);
    out.push(...page.projects);
    if (!page.has_more || page.next_after_id === null) return out;
    after = page.next_after_id;
  }
}

/** The notice a removal leaves: what went, Undo, and the seconds left. It waits while the pointer or the keyboard is on it. */
function UndoNotice({ notice, onDone }: { notice: Notice; onDone: () => void }) {
  const [left, setLeft] = useState(UNDO_SECONDS);
  const [held, setHeld] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (held || undoing) return undefined;
    if (left <= 0) { onDone(); return undefined; }
    const tick = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(tick);
  }, [left, held, undoing, onDone]);
  const undo = async () => {
    if (!notice.undo) return;
    setUndoing(true);
    try { await notice.undo(); onDone(); } catch (error) { setFailed(errorWords(error)); setUndoing(false); }
  };
  return (
    <div className="lib-notice" role="status" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <span>{notice.lead}{notice.name && <b>{notice.name}</b>}{notice.rest}{failed && <> Undo failed: {failed}</>}</span>
      {notice.undo && <button type="button" className="btn sm" disabled={undoing} onClick={() => void undo()}>{undoing ? 'Undoing' : 'Undo'}</button>}
      <span className="left num" aria-hidden="true">{left} s</span>
      <button type="button" className="iconbtn sm" aria-label="Dismiss" onClick={onDone}><Icon name="close" /></button>
    </div>
  );
}

/** The selection bar, in the toolbar's place, so nothing below it moves. */
function SelectBar({ picked, total, allPicked, onAll, onDone, children }: {
  picked: number; total: number | null; allPicked: boolean; onAll: () => void; onDone: () => void; children: ReactNode;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) onDone(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onDone]);
  return (
    <div className="selbar" role="group" aria-label="The picked cards">
      <span className="n">
        <span className={`tick${picked ? (allPicked ? ' on' : ' part') : ''}`} aria-hidden="true" />{pickedWords(picked, total)}
      </span>
      {!allPicked && <button type="button" className="btn quiet sm" onClick={onAll}>Select all{total !== null ? ` ${number(total)}` : ''}</button>}
      {children}
      <span className="grow" />
      <button type="button" className="btn quiet sm" onClick={onDone}>Done</button>
    </div>
  );
}

function useSelection(order: readonly string[], selecting: boolean) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // Leaving select mode lets go of every pick; set while rendering, not after.
  if (!selecting && (picked.size || anchor !== null)) { setPicked(new Set()); setAnchor(null); }
  const onPick = useCallback((key: string, range: boolean) => {
    setPicked((current) => pick(order, current, anchor, key, range));
    setAnchor(key);
  }, [order, anchor]);
  return { picked, setPicked, onPick };
}

function PaperShelf({ status, sort, q, vault, selecting, onSelecting, tools, say, onChanged }: {
  status: 'to_read' | 'read'; sort: string; q: string; vault: string | null; selecting: boolean;
  onSelecting: (on: boolean) => void; tools: (extra?: ReactNode) => ReactNode;
  say: (n: Omit<Notice, 'id'>) => void; onChanged: () => void;
}) {
  const shelfName = status === 'read' ? 'Read' : 'To read';
  const queue = useInfiniteQuery({
    queryKey: ['reading-queue', 'gallery', status, sort, q],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => answer(engine().GET('/api/reading-queue', {
      params: { query: { status, sort, q, limit: QUEUE_PAGE, offset: pageParam } },
    })),
    getNextPageParam: (last) => (last.offset + last.entries.length < last.total ? last.offset + last.entries.length : undefined),
  });
  const entries = useMemo(() => queue.data?.pages.flatMap((p) => p.entries) ?? [], [queue.data]);
  const total = queue.data?.pages[0]?.total ?? null;
  const catalog = useQuery({ queryKey: ['catalog'], staleTime: Infinity, queryFn: () => answer(engine().GET('/api/repositories/catalog')) });
  const names = useMemo(() => new Map((catalog.data ?? []).map((e) => [e.slug, e.name])), [catalog.data]);
  const sourceName = useCallback((slug: string) => names.get(slug) ?? slug, [names]);
  const map = useQuery({ queryKey: MAP_KEY, queryFn: () => answer(engine().GET('/api/map')) });
  const atlas = useMemo<Atlas | null>(() => {
    if (!map.data || map.data.state !== 'ready') return null;
    return { sky: collectionSky(map.data, epochDay(new Date())).sky, regions: map.data.regions };
  }, [map.data]);
  const order = useMemo(() => entries.map((e) => `p:${e.document_id}`), [entries]);
  const { picked, setPicked, onPick } = useSelection(order, selecting);
  const chosen = entries.filter((e) => picked.has(`p:${e.document_id}`));

  const removeEntries = useCallback(async (gone: QueueEntry[]) => {
    const removed: QueueEntry[] = [];
    for (const entry of gone) {
      const answered = await answer(engine().DELETE('/api/reading-queue/{document_id}', { params: { path: { document_id: entry.document_id } } }));
      removed.push(answered.entry);
    }
    onChanged();
    const titles = gone.map((e) => e.document?.title ?? `Paper ${e.document_id}`);
    say({
      ...removedWords(titles, shelfName),
      undo: async () => {
        for (const entry of removed) {
          await answer(engine().POST('/api/reading-queue/{document_id}/restore', {
            params: { path: { document_id: entry.document_id } },
            body: { status: entry.status, saved_at: entry.saved_at, updated_at: entry.updated_at, read_at: entry.read_at },
          }));
        }
        onChanged();
      },
    });
  }, [onChanged, say, shelfName]);
  const remove = useMutation({ mutationFn: removeEntries });
  const bulk = useMutation({
    mutationFn: async (to: 'read' | 'to_read') => {
      for (const entry of chosen) {
        await answer(engine().PUT('/api/reading-queue/{document_id}', { params: { path: { document_id: entry.document_id } }, body: { status: to } }));
      }
    },
    onSuccess: () => { setPicked(new Set()); onChanged(); },
  });
  const exporting = useMutation({
    mutationFn: (format: ReferenceFormat) => exportReferences({ document_ids: chosen.map((e) => e.document_id) }, format, 'resmon-library'),
  });
  const selectAll = async () => {
    let data = queue.data;
    while (queue.hasNextPage && data && data.pages[data.pages.length - 1]!.offset + data.pages[data.pages.length - 1]!.entries.length < (total ?? 0)) {
      data = (await queue.fetchNextPage()).data;
    }
    setPicked(new Set((data?.pages.flatMap((p) => p.entries) ?? entries).map((e) => `p:${e.document_id}`)));
  };
  const actionable = chosen.length > 0 && !bulk.isPending && !remove.isPending;

  return (
    <>
      {selecting
        ? (
          <SelectBar picked={chosen.length} total={total} allPicked={total !== null && chosen.length === total && total > 0}
            onAll={() => void selectAll()} onDone={() => onSelecting(false)}>
            <button type="button" className="btn sm" disabled={!actionable} onClick={() => bulk.mutate(status === 'read' ? 'to_read' : 'read')}>
              {status === 'read' ? 'Mark unread' : 'Mark read'}
            </button>
            <span className="seg export" role="group" aria-label="Export the picked papers">
              <span className="seg-label" title="Export"><Icon name="download" size={14} /></span>
              {FORMATS.map((f) => (
                <button key={f.id} type="button" disabled={!chosen.length || exporting.isPending} onClick={() => exporting.mutate(f.id)}>{f.label}</button>
              ))}
            </span>
            <button type="button" className="btn sm" disabled={!actionable} onClick={() => { remove.mutate(chosen); setPicked(new Set()); }}>Remove</button>
          </SelectBar>
        )
        : tools()}
      {(bulk.error || exporting.error || remove.error) && (
        <p className="field-error" role="alert">{errorWords(bulk.error ?? exporting.error ?? remove.error)}</p>
      )}
      {queue.isPending && <p className="index-cap lib-reading">Reading the reading queue.</p>}
      {queue.isError && <p className="field-error" role="alert">The reading queue could not be read ({errorWords(queue.error)}).</p>}
      {queue.data && total === 0 && (q ? <p className="index-empty lib-empty">No saved paper’s title, authors, or source contains “{q}”.</p>
        : status === 'read' ? <p className="index-empty lib-empty">Nothing is marked read yet. Mark read on a cover in To read, or on a paper’s page.</p>
          : <EmptyQueue />)}
      {entries.length > 0 && (
        <Gallery items={entries} keyOf={(e) => `p:${e.document_id}`} label={`${shelfName}: saved papers`} total={total}
          more={{ has: !!queue.hasNextPage, reading: queue.isFetchingNextPage, read: () => void queue.fetchNextPage() }}>
          {(entry, _i, narrow) => (
            <PaperCard entry={entry} atlas={atlas} vault={vault} sourceName={sourceName} narrow={narrow} onChanged={onChanged}
              picking={{ on: selecting, picked: picked.has(`p:${entry.document_id}`), onPick }}
              onRemove={(e) => remove.mutate([e])} />
          )}
        </Gallery>
      )}
    </>
  );
}

/** Five places a paper is saved to read from, each a slot in the grid's own shape with a way there. */
const SLOTS: readonly { title: string; line: string; to: string; go: string; glyph: ReactNode }[] = [
  { title: 'On a paper', line: 'Press Save to read on any paper’s page.', to: '/search', go: 'Open Your collection',
    glyph: <path d="M14 7h20v34l-10-7-10 7Z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" /> },
  { title: 'From a run', line: 'Save to read beside a paper in a run’s Papers tab.', to: '/search/ask', go: 'Open your runs',
    glyph: <><circle cx="24" cy="24" r="16" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".5" /><circle cx="24" cy="24" r="16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="34 100" transform="rotate(-90 24 24)" /><circle cx="24" cy="24" r="3.5" fill="currentColor" /></> },
  { title: 'From Today', line: 'Save a new paper from the morning’s index.', to: '/today', go: 'Open Today',
    glyph: <><circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" strokeWidth="2.2" /><text x="24" y="30" textAnchor="middle" className="slot-n">4</text></> },
  { title: 'On the map', line: 'Choose a paper on the map, then Save to read.', to: '/today', go: 'Open the map',
    glyph: <><path d="M4 16h40M4 32h40M16 4v40M32 4v40" stroke="currentColor" strokeWidth="1" opacity=".45" /><circle cx="24" cy="24" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" /><circle cx="24" cy="24" r="2.4" fill="currentColor" /><circle cx="12" cy="11" r="1.4" fill="currentColor" /><circle cx="37" cy="14" r="1.2" fill="currentColor" /><circle cx="35" cy="37" r="1.5" fill="currentColor" /><circle cx="10" cy="35" r="1.1" fill="currentColor" /></> },
  { title: 'In Your collection', line: 'Find a paper in Search, open it, and Save to read.', to: '/search', go: 'Open Search',
    glyph: <><rect x="9" y="9" width="12" height="12" rx="3" fill="currentColor" /><rect x="9" y="27" width="12" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M27 15h13M27 33h13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></> },
];

function EmptyQueue() {
  return (
    <section className="lib-empty-queue" aria-label="Where papers come from">
      <div className="empty-head">
        <h2>Nothing saved to read yet</h2>
        <p>Papers you save to read appear here as covers, newest first. Five places save them.</p>
      </div>
      <ul className="slots">
        {SLOTS.map((s) => (
          <li key={s.title} className="slot">
            <div className="slot-sheet"><svg viewBox="0 0 48 48" aria-hidden="true">{s.glyph}</svg></div>
            <h3>{s.title}</h3>
            <p>{s.line}</p>
            <Link to={s.to}>{s.go}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FileShelf({ vault, sort, q, selecting, onSelecting, say, onChanged, tools, imported }: {
  vault: string; sort: string; q: string; selecting: boolean; onSelecting: (on: boolean) => void;
  say: (n: Omit<Notice, 'id'>) => void; onChanged: () => void; tools: ReactNode;
  imported: { said: string; refused: string[] } | null;
}) {
  const files = useInfiniteQuery({
    queryKey: ['library-files', 'gallery', vault, sort, q],
    initialPageParam: { offset: 0, through: undefined as number | undefined },
    queryFn: ({ pageParam }) => answer(engine().GET('/api/library/files', {
      ...LIBRARY,
      params: { query: { expected_vault_id: vault, q, sort, limit: FILE_PAGE, offset: pageParam.offset, ...(pageParam.through !== undefined ? { through_id: pageParam.through } : {}) } },
    })),
    getNextPageParam: (last) => (last.has_more ? { offset: last.offset + last.files.length, through: last.through_id } : undefined),
  });
  const list = useMemo(() => files.data?.pages.flatMap((p) => p.files) ?? [], [files.data]);
  const total = files.data?.pages[0]?.total ?? null;
  const order = useMemo(() => list.map((f) => `f:${f.file_id}`), [list]);
  const { picked, setPicked, onPick } = useSelection(order, selecting);
  const chosen = list.filter((f) => picked.has(`f:${f.file_id}`));
  const [confirming, setConfirming] = useState<{ files: LibraryFileRow[]; summaries: LibraryRemoval[] } | null>(null);
  const [linking, setLinking] = useState<LibraryFileRow | null>(null);
  const [adding, setAdding] = useState<LibraryFileRow[] | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const removeNow = useMutation({
    mutationFn: async ({ gone, cascade }: { gone: LibraryFileRow[]; cascade: boolean }) => {
      const done: LibraryFileRow[] = [];
      for (const file of gone) {
        await answer(engine().DELETE('/api/library/files/{file_id}', {
          ...LIBRARY, params: { path: { file_id: file.file_id } },
          body: { expected_vault_id: vault, expected_version_id: file.version_id, cascade },
        }));
        done.push(file);
      }
      return done;
    },
    onSuccess: (done) => {
      setConfirming(null);
      setPicked(new Set());
      onChanged();
      say({
        ...removedWords(done.map((f) => f.original_name), 'Your files'),
        undo: async () => {
          for (const file of done) {
            await answer(engine().POST('/api/library/removed/{file_id}/restore', {
              ...LIBRARY, params: { path: { file_id: file.file_id } }, body: { expected_vault_id: vault },
            }));
          }
          onChanged();
        },
      });
    },
  });
  /** Ask first when any file is in a project or has notes; otherwise remove at once, with Undo. */
  const ask = useMutation({
    mutationFn: async (gone: LibraryFileRow[]) => ({ gone, summaries: await removalSummaries(gone) }),
    onSuccess: ({ gone, summaries }) => {
      const asking = summaries.filter((s) => s.needs_confirmation);
      if (asking.length) setConfirming({ files: gone, summaries: asking });
      else removeNow.mutate({ gone, cascade: false });
    },
  });
  const selectAll = async () => {
    let data = files.data;
    while (data && data.pages[data.pages.length - 1]!.has_more) data = (await files.fetchNextPage()).data;
    setPicked(new Set((data?.pages.flatMap((p) => p.files) ?? list).map((f) => `f:${f.file_id}`)));
  };
  const busy = ask.isPending || removeNow.isPending;

  return (
    <>
      {selecting
        ? (
          <SelectBar picked={chosen.length} total={total} allPicked={total !== null && chosen.length === total && total > 0}
            onAll={() => void selectAll()} onDone={() => onSelecting(false)}>
            <button type="button" className="btn sm" disabled={!chosen.length} onClick={() => setAdding(chosen)}>Add to a project</button>
            <button type="button" className="btn sm" disabled={!chosen.length || busy} onClick={() => ask.mutate(chosen)}>Remove</button>
          </SelectBar>
        )
        : tools}
      {imported && <p className="settings-said" role="status" data-library="imported">{imported.said}</p>}
      {imported && imported.refused.length > 0 && (
        <ul className="field-error library-refusals" role="alert">{imported.refused.map((r) => <li key={r}>{r}</li>)}</ul>
      )}
      {said && <p className="settings-said" role="status">{said}</p>}
      {(ask.error || removeNow.error) && <p className="field-error" role="alert">{errorWords(ask.error ?? removeNow.error)}</p>}
      {files.isPending && <p className="index-cap lib-reading">Reading your files.</p>}
      {files.isError && <p className="field-error" role="alert">Your files could not be read ({errorWords(files.error)}).</p>}
      {files.data && total === 0 && (
        <p className="index-empty lib-empty">
          {q ? `No file name contains “${q}”.` : 'Nothing is kept yet. Import a PDF, TXT, MD, or TeX file, or drop files on this page.'}
        </p>
      )}
      {list.length > 0 && (
        <Gallery items={list} keyOf={(f) => `f:${f.file_id}`} label="Your files" total={total}
          more={{ has: !!files.hasNextPage, reading: files.isFetchingNextPage, read: () => void files.fetchNextPage() }}>
          {(file, _i, narrow) => (
            <FileCard file={file} narrow={narrow} picking={{ on: selecting, picked: picked.has(`f:${file.file_id}`), onPick }}
              onRemove={(f) => ask.mutate([f])} onLink={setLinking} />
          )}
        </Gallery>
      )}
      {confirming && (
        <ConfirmRemoval summaries={confirming.summaries} busy={removeNow.isPending}
          onCancel={() => setConfirming(null)} onConfirm={() => removeNow.mutate({ gone: confirming.files, cascade: true })} />
      )}
      {linking && <PaperPicker vault={vault} file={linking} onClose={() => setLinking(null)} onLinked={onChanged} />}
      {adding && (
        <AddToProject vault={vault} files={adding} onClose={() => setAdding(null)}
          onAdded={(project, added) => {
            setAdding(null);
            setSaid(`Added ${count(added, 'file')} to ${project.name}.${added < adding.length ? ` ${count(adding.length - added, 'file')} ${adding.length - added === 1 ? 'was' : 'were'} already in it.` : ''}`);
            onChanged();
          }} />
      )}
    </>
  );
}

function ProjectShelf({ projects, q, sort, tools }: {
  projects: ReturnType<typeof useQuery<Project[]>>; q: string; sort: string; tools: ReactNode;
}) {
  const shown = useMemo(() => {
    const found = (projects.data ?? []).filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
    return sort === 'name'
      ? [...found].sort((a, b) => a.name.localeCompare(b.name, 'en-US'))
      : [...found].sort((a, b) => b.updated_at_utc.localeCompare(a.updated_at_utc) || b.id - a.id);
  }, [projects.data, q, sort]);
  return (
    <>
      {tools}
      {projects.isPending && <p className="index-cap lib-reading">Reading your projects.</p>}
      {projects.isError && <p className="field-error" role="alert">Your projects could not be read ({errorWords(projects.error)}).</p>}
      {projects.data && !shown.length && (
        <p className="index-empty lib-empty">
          {q ? `No project’s name contains “${q}”.` : <>No project yet. <Link to="/library/evidence">Make one in Evidence</Link>, then add files to it from Your files.</>}
        </p>
      )}
      {shown.length > 0 && (
        <Gallery items={shown} keyOf={(p) => p.project_id} label="Evidence projects" total={shown.length}
          more={{ has: false, reading: false, read: () => undefined }}>
          {(project) => <ProjectCard project={project} />}
        </Gallery>
      )}
      <p className="lib-foot"><Link to="/library/evidence">Open Evidence</Link> to make a project, read its files, and pin passages.</p>
    </>
  );
}

