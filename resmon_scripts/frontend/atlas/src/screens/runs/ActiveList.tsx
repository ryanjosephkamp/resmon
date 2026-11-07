import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError, stopRefusal } from '../../api/client';
import { breakable } from '../../shell/breakable';
import { Icon } from '../../shell/Icon';
import { useNow } from '../../lib/useNow';
import { WallMark } from '../health/WallMark';
import { clock } from '../today/format';
import {
  ACTIVE_KEY, activeSources, activeTitle, isStalled, placeWords, silentFor, waitingKind,
  type ActiveRun, type WaitingRun,
} from './active';
import { elapsedWords, liveMarkState, liveStage, secondsSince, sourcesFinished } from './live';
import { runKind, type LiveSource, type ProgressEvent } from './model';
import { RunMark } from './RunMark';
import { liveTip, orbitTip } from './runTips';
import { tipWords, useChartTip } from '../../charts/ChartTip';
import { joined, useRoving } from '../../charts/roving';

/** "arXiv", "arXiv and CORE", "arXiv, CORE, and 2 more". */
function namesWords(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')}, and ${names.length - 2} more`;
}

/**
 * What a running run is doing, in one line: while it asks its sources, how
 * many have finished and which it is asking; after, the stage and its count.
 */
export function runningWords(sources: readonly LiveSource[], events: readonly ProgressEvent[], nameOf: (slug: string) => string): string {
  const stage = liveStage(events);
  const finished = sourcesFinished(sources);
  const total = sources.length;
  if (stage.stage === 'querying' || stage.stage === null) {
    const asking = sources.filter((source) => source.state === 'asking').map((source) => nameOf(source.slug));
    const parts = total ? [`${finished} of ${total} finished`] : [stage.words];
    if (asking.length) parts.push(`asking ${namesWords(asking)}`);
    return parts.join(' · ');
  }
  return [stage.words, stage.count].filter(Boolean).join(' · ');
}

/**
 * Each of a run's sources in the Source wall's marks, in the order it chose
 * them. Each mark has the charts' tip and opens the run, whose page has every
 * source's account; the marks are one stop for the keyboard, the arrow keys
 * between them.
 */
export function SourceMarks({ runId, sources, nameOf }: {
  runId: number; sources: readonly LiveSource[]; nameOf: (slug: string) => string;
}) {
  const tip = useChartTip();
  const roving = useRoving(sources.length);
  const largest = Math.max(0, ...sources.map((source) => source.count ?? 0));
  return (
    <ol className="src-marks" aria-label="Its sources">
      {sources.map((source, i) => {
        const content = liveTip(source, nameOf(source.slug), runId);
        return (
          <li key={source.slug} data-source={source.slug} data-state={source.state}>
            <Link to={`/runs/${runId}`} className="src-mark" aria-label={tipWords(content)}
              {...joined(roving.item(i), tip.mark(content))}>
              <WallMark state={liveMarkState(source)} count={source.count} largest={largest} />
            </Link>
          </li>
        );
      })}
      {tip.layer}
    </ol>
  );
}

interface ListProps {
  running: readonly ActiveRun[];
  waiting: readonly WaitingRun[];
  nameOf: (slug: string) => string;
  watchName: (id: number) => string | null;
  /** The panel's narrower rows (the run monitor's), or the Runs tab's. */
  compact?: boolean;
}

/**
 * Running now: each run with its orbit, its title (a link to its page), its
 * kind, how many sources it asks, how long it has run (ticking each second),
 * each source in the wall's marks, what it is doing, and Stop.
 */
export function RunningList({ running, nameOf, watchName, compact = false }: Omit<ListProps, 'waiting'>) {
  const now = useNow(1_000, running.length > 0);
  const tip = useChartTip();
  const client = useQueryClient();
  const stop = useMutation({
    mutationFn: (id: number) => answer(engine().POST('/api/executions/{exec_id}/cancel', { params: { path: { exec_id: id } } })),
    onSettled: () => client.invalidateQueries({ queryKey: ACTIVE_KEY }),
  });
  return (
    <ol className={`active-list${compact ? ' compact' : ''}`} data-runs="running">
      {tip.layer}
      {running.map((run) => {
        const sources = activeSources(run);
        const events = run.events as unknown as ProgressEvent[];
        const finished = sourcesFinished(sources);
        const silent = silentFor(run, now);
        const stalled = isStalled(run, now);
        const ran = secondsSince(run.start_time, now);
        const stopping = stop.variables === run.id && (stop.isPending || stop.isSuccess);
        const tooLate = stop.variables === run.id ? stopRefusal(stop.error) : null;
        const title = activeTitle(run, watchName);
        return (
          <li key={run.id} className="active-row" data-run={run.id} data-stalled={stalled ? 'true' : undefined}>
            {/* The orbit's tip says the share it draws; the run's title beside it is the way to the run. */}
            <span className="active-orbit" {...tip.mark(orbitTip(title, sources, stalled))}>
              <RunMark state="running" orbits={[{ share: sources.length ? finished / sources.length : 0, stalled }]} />
            </span>
            <div className="active-body">
              <Link to={`/runs/${run.id}`} className={run.routine_id ? 'active-title it' : 'active-title'}>{breakable(title)}</Link>
              <p className="active-meta">
                <b>{runKind(run.execution_type)}</b>
                {sources.length > 0 && <> · {sources.length === 1 ? nameOf(sources[0]!.slug) : `${sources.length} sources`}</>}
                {ran !== null && <> · <span className="num" data-runs="elapsed">{elapsedWords(ran)}</span></>}
              </p>
              <div className="active-said">
                {sources.length > 0 && <SourceMarks runId={run.id} sources={sources} nameOf={nameOf} />}
                <span data-runs="said">{runningWords(sources, events, nameOf)}</span>
              </div>
              {stalled && silent !== null && (
                <p className="active-note" data-runs="stalled">No word from this run for {elapsedWords(silent)}.</p>
              )}
              {tooLate && <p className="active-note" role="status" data-runs="finishing">{tooLate}</p>}
              {stop.variables === run.id && stop.error && !tooLate && (
                <p className="field-error" role="alert">
                  {stop.error instanceof EngineError && stop.error.detail ? stop.error.detail : stop.error.message}
                </p>
              )}
            </div>
            <button type="button" className="btn sm" data-runs="stop" disabled={stopping || tooLate !== null}
              aria-label={`Stop ${title}`} onClick={() => stop.mutate(run.id)}>
              <Icon name="stop" size={14} />{stopping ? 'Stopping' : tooLate !== null ? 'Finishing' : 'Stop'}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** "due at 6:46 PM", "Run now at 6:46 PM", "asked at 6:47 PM". */
function queuedWords(run: WaitingRun): string {
  const at = run.queued_at ? clock(run.queued_at) : null;
  if (!at) return 'waiting';
  if (run.kind === 'watch') return run.run_now ? `Run now at ${at}` : `due at ${at}`;
  return `asked at ${at}`;
}

/**
 * Waiting: the runs that start, in this order, when a run finishes. A run you
 * asked for can be taken out of the queue before it starts; a watch's runs
 * as its watch says, and pausing the watch is how those stop.
 */
export function WaitingList({ waiting, nameOf, watchName, compact = false }: Omit<ListProps, 'running'>) {
  const client = useQueryClient();
  const withdraw = useMutation({
    mutationFn: (ticket: string) => answer(engine().DELETE('/api/executions/waiting/{ticket}', { params: { path: { ticket } } })),
    onSettled: () => client.invalidateQueries({ queryKey: ACTIVE_KEY }),
  });
  return (
    <ol className={`active-list${compact ? ' compact' : ''}`} data-runs="waiting">
      {waiting.map((run) => {
        const title = activeTitle(run, watchName);
        const sources = run.repositories ?? [];
        return (
          <li key={run.ticket} className="active-row is-waiting" data-ticket={run.ticket} data-kind={run.kind}>
            <svg className="run-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle className="rm-waiting" cx="12" cy="12" r="6" />
            </svg>
            <div className="active-body">
              <span className={run.kind === 'watch' ? 'active-title it' : 'active-title'}>{breakable(title)}</span>
              <p className="active-meta">
                <b>{waitingKind(run)}</b>
                {sources.length > 0 && <> · {sources.length === 1 ? nameOf(sources[0]!) : `${sources.length} sources`}</>}
                {' · '}{queuedWords(run)} · {placeWords(run.position)}
                {run.restarted_from !== null && run.restarted_from !== undefined && (
                  <> · repeats <Link to={`/runs/${run.restarted_from}`}>run {run.restarted_from}</Link></>
                )}
              </p>
              {withdraw.variables === run.ticket && withdraw.error && (
                <p className="field-error" role="alert">
                  {withdraw.error instanceof EngineError && withdraw.error.detail ? withdraw.error.detail : withdraw.error.message}
                </p>
              )}
            </div>
            {run.kind === 'manual' ? (
              <button type="button" className="btn sm quiet" data-runs="withdraw" aria-label={`Do not run ${title}`}
                disabled={withdraw.isPending && withdraw.variables === run.ticket} onClick={() => withdraw.mutate(run.ticket)}>
                Don&rsquo;t run
              </button>
            ) : <span />}
          </li>
        );
      })}
    </ol>
  );
}
