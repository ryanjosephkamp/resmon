import { useMemo, useRef, useState, type ToggleEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { useMinute } from '../../lib/useMinute';
import { useNow } from '../../lib/useNow';
import { clock, dayWord, number } from '../today/format';
import {
  ACTIVE_KEY, activeSignature, activeSources, isStalled, useActiveRuns, type ActiveRun, type ActiveRuns,
} from './active';
import { RunningList, WaitingList } from './ActiveList';
import { readHistory } from './history';
import { sourcesFinished } from './live';
import { runKind, runTitle, storedInstant, type RunRow } from './model';
import { RunMark, type MarkState, type Orbit } from './RunMark';

const PANEL_ID = 'run-monitor-panel';

/** Under the runs key, so whatever invalidates the runs reads these again too. */
const TODAY_KEY = ['runs', 'today'] as const;

/** How many of the newest runs the panel reads for today's: more than a day of runs at once rarely holds. */
const TODAY_READ = 40;

interface RoutineName { id: number; name: string }

const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' });

/** The orbits for the runs going now, at most three: each one's share of sources finished, and whether it has gone quiet. */
export function orbitsOf(running: readonly ActiveRun[], now: number): Orbit[] {
  return running.slice(0, 3).map((run) => {
    const sources = activeSources(run);
    return {
      share: sources.length ? sourcesFinished(sources) / sources.length : 0,
      stalled: isStalled(run, now),
    };
  });
}

/** Which mark the bar draws: a failure the panel has not shown yet is red until it is opened. */
export function markState(running: number, unseenFailures: number, open: boolean): MarkState {
  const failed = unseenFailures > 0 && !open;
  if (running > 0) return failed ? 'runfail' : 'running';
  return failed ? 'failed' : 'idle';
}

/**
 * The bar's words beside the mark: "2 running", "1 failed", "2 running · 1
 * failed"; none while idle. `failed` is the part a narrower window leaves to
 * the struck core, and `count` what the narrowest shows.
 */
export function monitorWords(running: number, failed: number): { full: string; lead: string; failed: string; count: string } | null {
  if (running && failed) {
    return { full: `${number(running)} running · ${number(failed)} failed`, lead: `${number(running)} running`,
      failed: ` · ${number(failed)} failed`, count: `${number(running)}` };
  }
  if (running) return { full: `${number(running)} running`, lead: `${number(running)} running`, failed: '', count: `${number(running)}` };
  if (failed) return { full: `${number(failed)} failed`, lead: `${number(failed)} failed`, failed: '', count: `${number(failed)}` };
  return null;
}

/** A finished run's line in the panel: what it found, or that it failed, and how many sources answered. */
export function todayWords(run: RunRow): { outcome: 'ok' | 'zero' | 'fail' | 'other'; said: string } {
  const { answered } = run.coverage.counts;
  const total = run.coverage.total;
  const asked = total ? `${answered} of ${total} ${total === 1 ? 'source' : 'sources'} answered` : 'no source outcome recorded';
  switch (run.status) {
    case 'completed': {
      const fresh = run.new_results ?? run.new_result_count;
      const found = run.total_results ?? run.result_count;
      if (fresh === 0) return { outcome: 'zero', said: `Nothing new · ${asked}` };
      const papers = found === null || found === undefined ? 'papers not recorded' : `${number(found)} found${fresh ? `, ${number(fresh)} new` : ''}`;
      return { outcome: 'ok', said: `${papers} · ${asked}` };
    }
    case 'failed': return { outcome: 'fail', said: `Failed · ${asked}` };
    case 'cancelled': return { outcome: 'other', said: `Stopped · ${asked}` };
    case 'interrupted': return { outcome: 'other', said: `Interrupted · ${asked}` };
    default: return { outcome: 'other', said: `${run.status} · ${asked}` };
  }
}

function OutcomeMark({ outcome }: { outcome: 'ok' | 'zero' | 'fail' | 'other' }) {
  return (
    <svg className="run-mark" viewBox="0 0 26 26" aria-hidden="true" focusable="false" data-outcome={outcome}>
      {outcome === 'fail' && (
        <>
          <circle className="rm-fault" cx="13" cy="13" r="6" />
          <path className="rm-fault" d="M8.8 17.2 17.2 8.8" />
        </>
      )}
      {outcome === 'ok' && <circle className="rm-done" cx="13" cy="13" r="5" />}
      {(outcome === 'zero' || outcome === 'other') && <circle className="rm-zero" cx="13" cy="13" r="5" />}
    </svg>
  );
}

/**
 * The run monitor, in the top bar between the sections and New search: the
 * plate's ring and core in the accent while nothing runs; an orbit for each
 * running run, up to three, its arc the share of its sources that have
 * finished, turning only while the run's heartbeat arrives and gray once it
 * has gone quiet for fifteen seconds; one ring that spreads when a run ends;
 * and the struck mark in the fixed red when a run has failed since the panel
 * was last opened. Beside it, "2 running" in a wide window, the count alone
 * in a narrower one.
 *
 * A click opens its panel, a native popover, so Escape, a click elsewhere, or
 * the mark again closes it and the focus goes back to the mark: the runs
 * going now with their sources, time, and Stop; those waiting; today's; and
 * the way to the Runs tab. Opening it tells the engine the failures until now
 * are seen, which clears the red. It reads nothing of its own while closed:
 * the active runs are the one read the whole app shares.
 */
export function RunMonitor() {
  const client = useQueryClient();
  const active = useActiveRuns();
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const running = active.data?.running ?? [];
  const waiting = active.data?.waiting ?? [];
  const unseen = active.data?.failed_unseen ?? [];
  const now = useNow(1_000, running.length > 0);
  const today = useMinute();

  // A run that has left the running set has ended: the ring spreads once for it.
  const ids = running.map((run) => run.id).join(',');
  const [heldIds, setHeldIds] = useState(ids);
  const [pulse, setPulse] = useState(0);
  if (ids !== heldIds) {
    const still = new Set(ids.split(','));
    const ended = heldIds.split(',').filter(Boolean).some((id) => !still.has(id));
    setHeldIds(ids);
    if (ended) setPulse((n) => n + 1);
  }

  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity, enabled: open,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = useMemo(() => new Map((catalog.data ?? []).map((entry) => [entry.slug, entry.name])), [catalog.data]);
  const nameOf = (slug: string) => names.get(slug) ?? slug;
  const routines = useQuery({
    queryKey: ['routine-names'], enabled: open || running.length > 0 || waiting.length > 0,
    queryFn: () => answer(engine().GET('/api/routines')) as Promise<RoutineName[]>,
  });
  const watches = useMemo(() => new Map((routines.data ?? []).map((r) => [r.id, r.name])), [routines.data]);
  const watchName = (id: number) => watches.get(id) ?? null;
  // Today's runs, read while the panel is open, and again whenever a run starts or ends.
  const latest = useQuery({
    queryKey: [...TODAY_KEY, activeSignature(active.data)], enabled: open,
    queryFn: () => readHistory({}, 0, TODAY_READ),
  });
  const todays = (latest.data?.runs ?? []).filter((run) => {
    const at = storedInstant(run.start_time);
    return run.status !== 'running' && at !== null && dayWord(at, today) === 'today';
  });

  const seen = useMutation({
    mutationFn: () => answer(engine().POST('/api/executions/seen')),
    // Seen now: the red is gone at once, rather than at the next read.
    onSuccess: (said) => client.setQueryData<ActiveRuns>(ACTIVE_KEY, (data) => data && { ...data, failed_unseen: [], seen_at: said.seen_at }),
    onSettled: () => client.invalidateQueries({ queryKey: ACTIVE_KEY }),
  });
  const onToggle = (event: ToggleEvent<HTMLDivElement>) => {
    const opened = event.newState === 'open';
    setOpen(opened);
    if (opened) {
      panel.current?.focus();
      // Every opening, not only when a failure is known: one can land between two reads, show in
      // Today here, and would otherwise turn the mark red at the next read though it was seen.
      seen.mutate();
    }
  };

  const state = markState(running.length, unseen.length, open);
  const words = monitorWords(running.length, open ? 0 : unseen.length);
  const label = words ? `Runs: ${words.full}` : 'Runs: nothing running';
  const summary = [
    `${number(running.length)} running`,
    waiting.length ? `${number(waiting.length)} waiting` : '',
    `${number(todays.length)} today`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="run-monitor">
      <button type="button" className={`mon${words ? '' : ' idle'}${open ? ' open' : ''}`} popoverTarget={PANEL_ID}
        aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={label} data-monitor={state}
        data-pulse={pulse || undefined}>
        <RunMark state={state} orbits={orbitsOf(running, now)} pulse={pulse} />
        {words && (
          <span className="mon-words" aria-hidden="true">
            <span className="mon-full">{words.lead}{words.failed && <span className="mon-failed">{words.failed}</span>}</span>
            <span className="mon-count">{words.count}</span>
          </span>
        )}
      </button>
      <div id={PANEL_ID} ref={panel} popover="auto" role="dialog" aria-label="Runs" className="mon-panel" tabIndex={-1}
        onToggle={onToggle}>
        {open && (
          <>
            <div className="mp-head">
              <h2>Runs</h2>
              <span className="num" data-monitor="summary">{summary}</span>
            </div>
            <div className="mp-scroll">
              <section className="mp-group" aria-label="Running">
                <h3>Running</h3>
                {running.length
                  ? <RunningList running={running} nameOf={nameOf} watchName={watchName} compact />
                  : <p className="mp-none">Nothing is running.</p>}
              </section>
              {waiting.length > 0 && (
                <section className="mp-group" aria-label="Waiting">
                  <h3>Waiting</h3>
                  <WaitingList waiting={waiting} nameOf={nameOf} watchName={watchName} compact />
                </section>
              )}
              <section className="mp-group" aria-label="Today">
                <h3>Today<span>{MONTH_DAY.format(today)}</span></h3>
                {latest.isPending && <p className="mp-none">Reading today&rsquo;s runs.</p>}
                {latest.data && !todays.length && <p className="mp-none">No run has ended today.</p>}
                <ol className="active-list compact">
                  {todays.map((run) => {
                    const watch = run.routine_id ? watchName(run.routine_id) : null;
                    const { outcome, said } = todayWords(run);
                    return (
                      <li key={run.id} className="active-row is-today" data-run={run.id} data-outcome={outcome}>
                        <OutcomeMark outcome={outcome} />
                        <div className="active-body">
                          <Link to={`/runs/${run.id}`} className={watch ? 'active-title it' : 'active-title'}
                            onClick={() => panel.current?.hidePopover()}>{runTitle(run, watch)}</Link>
                          <p className="active-meta">
                            <b>{runKind(run.execution_type)}</b> · {said}
                            {outcome === 'fail' && (
                              <> · <Link to={`/runs/${run.id}`} className="mp-why" onClick={() => panel.current?.hidePopover()}>Why</Link></>
                            )}
                          </p>
                        </div>
                        <span className="mp-time num">{run.start_time ? clock(run.start_time) : ''}</span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            </div>
            <div className="mp-foot">
              <Link to="/runs" onClick={() => panel.current?.hidePopover()}>Open Runs<Icon name="arrow" size={14} /></Link>
              <Link to="/settings/top-bar" className="mp-hide" onClick={() => panel.current?.hidePopover()}>Hide this in Settings › Top bar</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
