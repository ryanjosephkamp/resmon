/**
 * What the run screens' marks say in the charts' tip: a source's mark in a
 * running run (and where it opens), a finished run's recorded outcome for one
 * source, the bar of sources finished, a running run's orbit, and the run
 * monitor's mark. Words are the screens' own (`liveLabel`, the engine's
 * labels and sentences); counts are the engine's, whole.
 */
import type { TipContent } from '../../charts/ChartTip';
import { exactCount } from '../../charts/exact';
import { count } from '../today/format';
import { STALLED_SECONDS } from './active';
import { sourcesFinished } from './live';
import { liveLabel, type LiveSource } from './model';

/** A source's mark in a running run: its state as the run's events report it, and the way to the run. */
export function liveTip(source: LiveSource, name: string, runId?: number): TipContent {
  return {
    name,
    value: liveLabel(source),
    notes: source.note ? [source.note] : undefined,
    opens: runId === undefined ? null : `Opens run ${runId}`,
  };
}

/** A finished run's recorded outcome for one source: the engine's label, the records it returned, and its sentence. */
export function recordedTip(source: { label: string; result_count: number | null; note: string }, name: string): TipContent {
  return {
    name,
    value: source.label,
    lines: [{
      value: source.result_count === null ? 'Not recorded' : exactCount(source.result_count),
      label: source.result_count === 1 ? 'record returned' : 'records returned',
    }],
    notes: source.note ? [source.note] : undefined,
  };
}

/** The bar of a running run's sources that have finished being asked, whatever each answered, and which are not. */
export function finishedTip(sources: readonly LiveSource[], nameOf: (slug: string) => string): TipContent {
  const finished = sourcesFinished(sources);
  const asking = sources.filter((source) => source.state === 'asking').map((source) => nameOf(source.slug));
  const waiting = sources.filter((source) => source.state === 'pending').map((source) => nameOf(source.slug));
  return {
    name: 'Sources finished',
    value: `${exactCount(finished)} of ${count(sources.length, 'source')}`,
    lines: [
      ...(asking.length ? [{ value: exactCount(asking.length), label: `being asked: ${asking.join(', ')}`, key: 'accent' as const }] : []),
      ...(waiting.length ? [{ value: exactCount(waiting.length), label: `not asked yet: ${waiting.join(', ')}` }] : []),
    ],
    notes: ['Finished is asked and done, whatever each answered.'],
  };
}

/** A running run's orbit: the share of its sources that have finished, and whether it has gone quiet. */
export function orbitTip(title: string, sources: readonly LiveSource[], stalled: boolean): TipContent {
  return {
    name: title,
    value: sources.length ? `${exactCount(sourcesFinished(sources))} of ${count(sources.length, 'source')} finished` : 'Asks no source',
    notes: stalled ? [`No word from this run for ${STALLED_SECONDS} seconds or more.`] : undefined,
  };
}

/**
 * The run monitor's mark: how many runs are going, how far each has got (an
 * orbit each, for the first three), how many have failed since the panel was
 * last opened, and the panel it opens.
 */
export function monitorTip(
  running: readonly { title: string; sources: readonly LiveSource[]; stalled: boolean }[],
  waiting: number,
  failed: number,
): TipContent {
  return {
    name: 'Runs',
    value: running.length ? `${exactCount(running.length)} running` : 'Nothing running',
    lines: running.map((run, i) => ({
      value: run.sources.length ? `${exactCount(sourcesFinished(run.sources))} of ${exactCount(run.sources.length)}` : '—',
      label: `${run.title}${run.stalled ? ', no word for a while' : ''}`,
      key: i < 3 ? 'accent' as const : undefined,
    })),
    notes: [
      ...(running.length ? ['Sources finished in each running run.'] : []),
      ...(waiting ? [`${count(waiting, 'run')} waiting.`] : []),
      ...(failed ? [`${count(failed, 'run')} failed since the panel was last opened.`] : []),
    ],
    opens: 'Opens the Runs panel',
  };
}
