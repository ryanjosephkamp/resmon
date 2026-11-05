import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { activeSignature, useActiveRuns } from './active';
import { RunningList, WaitingList } from './ActiveList';
import { FILTERS, HISTORY_KEY, type RunFilter } from './history';
import { RunHistory } from './RunHistory';

/** What another page hands the Runs tab when it sends a person here. */
export interface RunsNotice {
  /** A run deleted from its own page. */
  deleted?: string;
  /** A search or a restart that waits for a free slot, in the engine's words. */
  queued?: string;
}

/** The watches' names, for a watch's runs. `/api/routines` declares no model. */
interface RoutineName { id: number; name: string }

/** How long the search field waits after the last key before it asks. */
const SEARCH_PAUSE_MS = 250;

/**
 * Runs: everything resmon has run, in one place. The runs going now, live,
 * each with its sources in the Source wall's marks, how long it has run, what
 * it is doing, and Stop; the runs waiting for a free slot, in the order they
 * start; and the history, by day, narrowed to searches, watches' runs, or
 * failed runs, and found by its words.
 *
 * The live half is the one read of the active runs the whole app shares
 * (`useActiveRuns`). The history is read when a run starts, ends, or joins
 * or leaves the queue, never on a timer of its own.
 */
export function Runs() {
  const client = useQueryClient();
  const notice = (useLocation().state as RunsNotice | null) ?? null;
  const active = useActiveRuns();
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = useMemo(() => new Map((catalog.data ?? []).map((entry) => [entry.slug, entry.name])), [catalog.data]);
  const nameOf = (slug: string) => names.get(slug) ?? slug;
  const routines = useQuery({
    queryKey: ['routine-names'],
    queryFn: () => answer(engine().GET('/api/routines')) as Promise<RoutineName[]>,
  });
  const watches = useMemo(() => new Map((routines.data ?? []).map((r) => [r.id, r.name])), [routines.data]);
  const watchName = (id: number) => watches.get(id) ?? null;

  const [filter, setFilter] = useState<RunFilter>('all');
  const [typed, setTyped] = useState('');
  const [words, setWords] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setWords(typed.trim()), SEARCH_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  // A run started, ended, or joined or left the queue: the history is read again, once.
  const signature = activeSignature(active.data);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!signature && !active.data) return;
    if (seen.current !== null && seen.current !== signature) void client.invalidateQueries({ queryKey: HISTORY_KEY });
    seen.current = signature;
  }, [signature, active.data, client]);

  const running = active.data?.running ?? [];
  const waiting = active.data?.waiting ?? [];
  const cap = active.data?.max_concurrent ?? null;

  return (
    <div className="page runs-page" data-runs="page">
      <div className="runs-head">
        <h1 className="page-title">Runs</h1>
      </div>
      <p className="page-lede">
        Every search you ask and every watch&rsquo;s run: what runs now, what waits for a free slot, and what has run.
      </p>
      {notice?.queued && <p className="settings-said runs-notice" role="status" data-runs="queued">{notice.queued}</p>}

      <section className="runs-now" aria-label="Running now" aria-busy={active.isPending}>
        <h2 className="runs-h">Running now{running.length > 0 && <span className="num">{running.length}</span>}</h2>
        {active.isError && <p className="index-cap">What runs now could not be read ({active.error.message}).</p>}
        {active.data && !running.length && (
          <p className="index-empty" data-runs="none-running">
            Nothing is running. resmon runs up to {cap ?? 'its limit of'} {cap === 1 ? 'run' : 'runs'} at once, as
            {' '}<Link to="/settings/background">Settings › In the background</Link> allows; more wait their turn below.
          </p>
        )}
        {running.length > 0 && <RunningList running={running} nameOf={nameOf} watchName={watchName} />}
      </section>

      {waiting.length > 0 && (
        <section className="runs-waiting" aria-label="Waiting">
          <h2 className="runs-h">Waiting<span className="num">{waiting.length}</span></h2>
          <p className="runs-h-note">
            These start on their own, in this order, as runs finish
            {cap !== null && <>; resmon runs {cap} at once</>}.
          </p>
          <WaitingList waiting={waiting} nameOf={nameOf} watchName={watchName} />
        </section>
      )}

      <RunHistory filter={filter} words={words} watchName={watchName} notice={notice?.deleted ?? null}
        slots={{ cap, running: running.length }} tools={(
        <div className="runs-tools">
          <div className="seg" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
            ))}
          </div>
          <label className="runs-find">
            <Icon name="search" size={14} />
            <input type="search" value={typed} onChange={(event) => setTyped(event.target.value)}
              placeholder="Terms, a watch, or a number" aria-label="Find a run" autoComplete="off" spellCheck={false}
              title="Finds a run by its terms, its sources, its watch or saved search, or its number" />
          </label>
        </div>
      )} />
    </div>
  );
}
