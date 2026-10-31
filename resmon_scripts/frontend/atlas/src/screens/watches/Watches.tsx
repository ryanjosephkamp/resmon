import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { MapPaper } from '../sky/MapPaper';
import { PaperSky, basisWords, type PaperSkyHandle, type SkyChoice } from '../sky/PaperSky';
import type { CatalogEntry } from '../runs/model';
import { count, number, when } from '../today/format';
import {
  BACKGROUND_PATH, BACKGROUND_WORDS, SCHEDULER_KEY, firingNotice, firingOf, firingState, nextWords, type Firing, type FiringNotice,
} from './firing';
import { useCalendar } from './MonthAhead';
import { WatchTabs } from './WatchTabs';
import {
  WATCHES_KEY, instant, promisedFires, scheduleText, watchAsks, watchWarnings, type RoutineRow, type WatchWarning,
} from './model';

/** The papers a watch's runs collected, for its constellation. */
export function useWatchPapers(id: number | null) {
  return useQuery({
    queryKey: ['routine-documents', id],
    enabled: id !== null,
    queryFn: () => answer(engine().GET('/api/routines/{routine_id}/documents', {
      params: { path: { routine_id: id ?? 0 } },
    })),
  });
}

/** Read once a minute: the background service can start or stop while the list is open. */
export function useSchedulerStatus() {
  return useQuery({
    queryKey: SCHEDULER_KEY,
    queryFn: () => answer(engine().GET('/api/scheduler/status')),
    refetchInterval: 60_000,
  });
}

/**
 * Watches: every routine, what it asks and when, whether it is watching or
 * paused, and how its last run went; the one under the pointer lit as a
 * constellation on the collection map. The month ahead's promised fires are
 * the Calendar tab's (`Calendar.tsx`); each row's next fire is read from the
 * same calendar.
 *
 * Paused is not deleted: a paused watch keeps its runs and papers and fires
 * nothing until it is resumed. The fires drawn are the engine's own calendar,
 * which expands only active watches' schedules, so a paused watch draws none.
 * Watching is not running, either: a window's own engine runs no scheduler,
 * so whether anything will run a watching watch is the scheduler status's
 * answer, and the list says "next" only where it is yes (`firing.ts`).
 */
export function Watches() {
  const [now] = useState(() => new Date());
  const said = (useLocation().state as { said?: string } | null)?.said ?? null;
  const routines = useQuery({ queryKey: WATCHES_KEY, queryFn: () => answer(engine().GET('/api/routines')) });
  const calendar = useCalendar(now);
  const status = useSchedulerStatus();
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const list = useMemo(
    () => [...(routines.data ?? [])].sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name)),
    [routines.data],
  );
  const [lit, setLit] = useState<number | null>(null);
  const shown = lit ?? list[0]?.id ?? null;
  const papers = useWatchPapers(shown);
  const litName = list.find((r) => r.id === shown)?.name ?? '';
  const active = list.filter((r) => r.is_active).length;
  const notice = status.data ? firingNotice(status.data) : null;
  // A paper chosen on the map opens in the list's place; the list waits behind it.
  const [opened, setOpened] = useState<SkyChoice | null>(null);
  const sky = useRef<PaperSkyHandle>(null);
  const names = useMemo(() => new Map((catalog.data ?? []).map((e) => [e.slug, e.name])), [catalog.data]);
  const nameOf = (slug: string) => names.get(slug) ?? slug;

  return (
    <div className="collection watches">
      <PaperSky
        ref={sky}
        marked={papers.data?.document_ids ?? []}
        outline={litName || null}
        shape="tall"
        wheel="zoom"
        chosen={opened?.id ?? null}
        onChoose={setOpened}
        sourceName={nameOf}
        label={litName ? `Where ${litName}'s papers sit in the collection` : 'The collection'}
        caption={({ placed, ready, basis }) => {
          if (!ready) return 'The collection map is not ready yet; a watch\'s papers are marked once it is.';
          if (!litName) return `Every paper in your collection, ${basisWords(basis)}.`;
          if (!papers.data) return `Reading ${litName}'s papers.`;
          const { total, document_ids: ids } = papers.data;
          if (!total) return `${litName} has not collected any papers yet.`;
          const of = ids.length < total ? `the latest ${number(ids.length)} of its ${count(total, 'paper')}` : count(total, 'paper');
          if (placed === ids.length) return `${litName}: ${of}, ${basisWords(basis)}, with the dashed line Today draws around them.`;
          return `${litName}: ${number(placed ?? 0)} of ${of} are on the map; the rest are not placed yet.`;
        }}
      />
      {opened && (
        <MapPaper
          key={opened.id}
          id={opened.id}
          cell={opened.cell}
          region={opened.region}
          sourceName={nameOf}
          backLabel="Back to the watches"
          onBack={() => { setOpened(null); sky.current?.focus(); }}
          onShow={() => sky.current?.show(opened.id)}
        />
      )}
      <section className="index watch-index" aria-label="Watches" aria-busy={routines.isFetching} hidden={opened !== null}>
        <div className="results-head">
          <WatchTabs />
          <div className="watches-head">
            <h1 className="page-title">Watches</h1>
            <Link to="/watches/new" className="btn primary" data-editor="new"><Icon name="plus" size={14} />New watch</Link>
          </div>
          <p className="count-sentence">
            {routines.data
              ? `${count(list.length, 'watch', 'watches')}${list.length ? `, ${number(active)} watching and ${number(list.length - active)} paused` : ''}`
              : ''}
          </p>
          {said && <p className="run-note" role="status" data-editor="said">{said}</p>}
          {notice && <FiringNote notice={notice} />}
        </div>
        <div className="index-scroll">
          {routines.isPending && <p className="index-cap">Reading your watches.</p>}
          {routines.isError && <p className="index-cap">Your watches could not be read ({routines.error.message}).</p>}
          {routines.data && !list.length && (
            <p className="index-empty">
              Nothing is watched yet. A watch is a search resmon runs on a schedule and keeps the papers of.{' '}
              <Link to="/watches/new">Make one</Link>, or start from a search under <Link to="/search/saved">Saved</Link>.
            </p>
          )}
          <ol className="watch-list">
            {list.map((routine) => (
              <WatchRow
                key={routine.id}
                routine={routine}
                now={now}
                next={promisedFires(calendar.data ?? [], routine.id, now)[0]?.start ?? null}
                firing={routine.is_active ? firingOf(status.data, routine.id) : undefined}
                lit={routine.id === shown}
                onLight={() => setLit(routine.id)}
                catalog={catalog.data ?? []}
              />
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}

/** Why some watching watches will not run, with the way to Settings › In the background where that is the lever. */
export function FiringNote({ notice }: { notice: FiringNotice }) {
  return (
    <p className="firing-note" role="note" data-firing-note="">
      {notice.background ? linked(notice.text, BACKGROUND_WORDS, BACKGROUND_PATH) : notice.text}
    </p>
  );
}

/** The sentence with its first `words` as a link to `to`; as it is where the words are not in it. */
function linked(text: string, words: string, to: string) {
  const at = text.indexOf(words);
  if (at < 0) return <>{text} <Link to={to}>{words}</Link></>;
  return <>{text.slice(0, at)}<Link to={to}>{words}</Link>{text.slice(at + words.length)}</>;
}

/** What a watch's stored parameters keep it from finding, with the way to change them. */
export function WatchWarnings({ id, warnings }: { id: number; warnings: readonly WatchWarning[] }) {
  if (!warnings.length) return null;
  return (
    <ul className="watch-warnings" aria-label="What keeps this watch from finding new papers">
      {warnings.map((w) => (
        <li key={w.kind} className="watch-warning" data-warning={w.kind}>
          {linked(w.text, 'Change', `/watches/${id}/edit`)}
        </li>
      ))}
    </ul>
  );
}

function WatchRow({ routine, now, next, firing, lit, onLight, catalog }: {
  routine: RoutineRow; now: Date; next: string | null; firing: Firing; lit: boolean; onLight: () => void;
  catalog: readonly CatalogEntry[];
}) {
  const asks = watchAsks(routine.parameters);
  const words = scheduleText(routine.schedule_cron, routine.parameters);
  const last = instant(routine.last_execution);
  const missed = routine.missed_fires.count - routine.missed_fires.overlap_skipped;
  const due = routine.is_active ? nextWords(firing, next ? when(next, now) : null) : null;
  const warnings = watchWarnings(routine.parameters, now, catalog);
  return (
    <li
      className="watch"
      data-routine={routine.id}
      data-active={routine.is_active ? 'true' : 'false'}
      data-firing={routine.is_active ? firingState(firing) : undefined}
      data-lit={lit ? 'true' : undefined}
      onMouseEnter={onLight}
      onFocus={onLight}
    >
      <Link to={`/watches/${routine.id}`} className="watch-name it">{routine.name}</Link>
      <div className="meta">
        <span className="watch-state" data-active={routine.is_active ? 'true' : 'false'}>
          {routine.is_active ? 'Watching' : 'Paused'}
        </span>
        <span className="sep" />
        {words ? <span>{words}</span> : <code className="cron">{routine.schedule_cron}</code>}
        {due && (<><span className="sep" /><span className="watch-next" data-firing={firingState(firing)}>{due}</span></>)}
      </div>
      <div className="meta">
        <span className="asks" title={`${asks.person ? 'A person' : asks.query || asks.keywords.join(', ') || 'No keywords'} in ${count(asks.sources.length, 'source')}`}>
          {asks.person ? 'A person' : asks.query || asks.keywords.join(', ') || 'No keywords'}
          {' '}in {count(asks.sources.length, 'source')}
        </span>
        <span className="sep" />
        <span>
          {last ? `last ran ${when(last.toISOString(), now)}` : 'has not run yet'}
          {routine.last_status && last ? ` · ${routine.last_status}` : ''}
        </span>
        {missed > 0 && (<><span className="sep" /><span className="watch-missed">{count(missed, 'fire')} missed while resmon was closed</span></>)}
      </div>
      <WatchWarnings id={routine.id} warnings={warnings} />
    </li>
  );
}
