import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { PaperSky, basisWords } from '../sky/PaperSky';
import { count, number, when } from '../today/format';
import { MonthAhead, useCalendar } from './MonthAhead';
import { WatchTabs } from './WatchTabs';
import {
  WATCHES_KEY, instant, promisedFires, scheduleText, watchAsks, type RoutineRow,
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

/**
 * Watches: every routine, what it asks and when, whether it is watching or
 * paused, and how its last run went; the one under the pointer lit as a
 * constellation on the collection map, and the month ahead's promised fires.
 *
 * Paused is not deleted: a paused watch keeps its runs and papers and fires
 * nothing until it is resumed. The fires drawn are the engine's own calendar,
 * which expands only active watches' schedules, so a paused watch draws none
 * rather than a promise the scheduler will not keep.
 */
export function Watches() {
  const [now] = useState(() => new Date());
  const said = (useLocation().state as { said?: string } | null)?.said ?? null;
  const routines = useQuery({ queryKey: WATCHES_KEY, queryFn: () => answer(engine().GET('/api/routines')) });
  const calendar = useCalendar(now);
  const list = useMemo(
    () => [...(routines.data ?? [])].sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name)),
    [routines.data],
  );
  const [lit, setLit] = useState<number | null>(null);
  const shown = lit ?? list[0]?.id ?? null;
  const papers = useWatchPapers(shown);
  const litName = list.find((r) => r.id === shown)?.name ?? '';
  const active = list.filter((r) => r.is_active).length;

  return (
    <div className="collection watches">
      <PaperSky
        marked={papers.data?.document_ids ?? []}
        outline
        shape="tall"
        label={litName ? `Where ${litName}'s papers sit in the collection` : 'The collection'}
        caption={({ placed, ready, basis }) => {
          if (!ready) return 'The collection map is not ready yet; a watch\'s papers are marked once it is.';
          if (!litName) return `Every paper in your collection, ${basisWords(basis)}.`;
          if (!papers.data) return `Reading ${litName}'s papers.`;
          const { total, document_ids: ids } = papers.data;
          if (!total) return `${litName} has not collected any papers yet.`;
          const of = ids.length < total ? `the latest ${number(ids.length)} of its ${count(total, 'paper')}` : count(total, 'paper');
          if (placed === ids.length) return `${litName}: ${of}, ${basisWords(basis)}. Dashed lines go around each close group.`;
          return `${litName}: ${number(placed ?? 0)} of ${of} are on the map; the rest are not placed yet.`;
        }}
      />
      <section className="index watch-index" aria-label="Watches" aria-busy={routines.isFetching}>
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
                lit={routine.id === shown}
                onLight={() => setLit(routine.id)}
              />
            ))}
          </ol>
          <MonthAhead now={now} events={calendar.data ?? null} routines={list} lit={shown} />
        </div>
      </section>
    </div>
  );
}

function WatchRow({ routine, now, next, lit, onLight }: {
  routine: RoutineRow; now: Date; next: string | null; lit: boolean; onLight: () => void;
}) {
  const asks = watchAsks(routine.parameters);
  const words = scheduleText(routine.schedule_cron, routine.parameters);
  const last = instant(routine.last_execution);
  const missed = routine.missed_fires.count - routine.missed_fires.overlap_skipped;
  return (
    <li
      className="watch"
      data-routine={routine.id}
      data-active={routine.is_active ? 'true' : 'false'}
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
        {routine.is_active && next ? (<><span className="sep" /><span>next {when(next, now)}</span></>) : null}
      </div>
      <div className="meta">
        <span>
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
    </li>
  );
}
