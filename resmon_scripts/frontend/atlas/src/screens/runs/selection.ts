/**
 * What the Runs tab does with several runs at once, beyond exporting,
 * bundling, and deleting them: save each as a saved search, and run each
 * again now.
 *
 * Save as searches keeps each Deep Dive's or Deep Sweep's own sources,
 * terms, dates, and cap as a saved search named by its terms, linked back to
 * the run, as the run's own page does for one; it summarizes as its run was
 * set to, read from the run's `ai_choice` event. A watch's run is not saved:
 * its search is its watch's, and Saved keeps a copy of every watch.
 *
 * Run Again is Restart for any run that has ended
 * (`POST /api/executions/{id}/restart` with `again`). A search's run is a new
 * run with its own query, terms, dates, limit, and sources, linked back to it.
 * A watch's run is its watch's Run Now: the watch's current search, sent as
 * the watch is set, and refused while the watch is already running, since two
 * runs of one watch would both deliver. Past the run limit the new runs wait
 * their turn, and the question before says so.
 */
import { answer, engine, EngineError } from '../../api/client';
import { savedFromRun } from '../collection/savedSearches';
import { number } from '../today/format';
import { runNumbers, runTitle, type ProgressEvent, type RunRow } from './model';
import { aiChoiceOf } from './summaries';

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "“graphs”", "“graphs” and “nerf”", "“a”, “b”, and “c”". */
export function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  if (quoted.length <= 2) return quoted.join(' and ');
  return `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`;
}

/** The runs among these that can be saved as a search: a Deep Dive's or a Deep Sweep's. */
export function savable(runs: readonly RunRow[]): RunRow[] {
  return runs.filter((run) => savedFromRun(run, false) !== null);
}

/** What came of saving runs as searches. */
export interface SaveOutcome {
  saved: { id: number; name: string }[];
  /** Watches' runs, which are not saved. */
  watches: number[];
  failed: { id: number; reason: string }[];
}

function reasonOf(failure: unknown, id: number, what: string): string {
  if (failure instanceof EngineError && failure.detail) return failure.detail;
  return `Run ${id} was not ${what}: ${failure instanceof Error ? failure.message : String(failure)}.`;
}

/** Save each run that can be one as a saved search, in turn, and say what came of each. */
export async function saveAsSearches(
  runs: readonly RunRow[],
  watchName: (id: number) => string | null,
): Promise<SaveOutcome> {
  const outcome: SaveOutcome = { saved: [], watches: [], failed: [] };
  for (const run of runs) {
    if (savedFromRun(run, false) === null) {
      outcome.watches.push(run.id);
      continue;
    }
    try {
      // Whether it summarized is what its run was set to do, as its page reads it.
      const events = (await answer(engine().GET('/api/executions/{exec_id}/progress/events', {
        params: { path: { exec_id: run.id } },
      }))) as unknown as ProgressEvent[];
      const search = savedFromRun(run, aiChoiceOf(events)?.enabled === true);
      if (!search) continue;
      const name = runTitle(run, run.routine_id ? watchName(run.routine_id) : null);
      await answer(engine().POST('/api/configurations', {
        body: { name, config_type: search.config_type, parameters: search.parameters, link_to_execution_id: run.id },
      }));
      outcome.saved.push({ id: run.id, name });
    } catch (failure) {
      outcome.failed.push({ id: run.id, reason: reasonOf(failure, run.id, 'saved') });
    }
  }
  return outcome;
}

/** The sentence after saving: what was saved, and why a watch's run was not. Failures are said beside it. */
export function savedSentence(outcome: SaveOutcome): string {
  const parts: string[] = [];
  if (outcome.saved.length) {
    parts.push(`Saved ${outcome.saved.length === 1 ? 'a search' : `${number(outcome.saved.length)} searches`}: `
      + `${quotedList(outcome.saved.map((saved) => saved.name))}.`);
  }
  if (outcome.watches.length) {
    const one = outcome.watches.length === 1;
    parts.push(`${capitalized(runNumbers(outcome.watches))} ${one ? 'is a watch’s run' : 'are watches’ runs'}, `
      + `not saved: ${one ? 'its search is its watch’s' : 'their searches are their watches’'}, and Saved keeps a copy `
      + 'of every watch.');
  }
  return parts.join(' ');
}

/** What came of running runs again. */
export interface RerunOutcome {
  started: number[];
  queued: number;
  refused: { id: number; reason: string }[];
}

/** Run each run again, in turn: started, waiting for a free slot, or refused in the engine's words. */
export async function runAgain(runs: readonly RunRow[]): Promise<RerunOutcome> {
  const outcome: RerunOutcome = { started: [], queued: 0, refused: [] };
  for (const run of runs) {
    try {
      const started = await answer(engine().POST('/api/executions/{exec_id}/restart', {
        params: { path: { exec_id: run.id } }, body: { request_id: crypto.randomUUID(), again: true },
      }));
      if (started.execution_id !== null) outcome.started.push(started.execution_id);
      else outcome.queued += 1;
    } catch (failure) {
      outcome.refused.push({ id: run.id, reason: reasonOf(failure, run.id, 'run again') });
    }
  }
  return outcome;
}

/**
 * The question before Run Again: what it starts, how it summarizes and is
 * sent, how many wait for a free slot, and which chosen runs it leaves alone
 * because they are still running. Null when none of them can be run again.
 */
export function runAgainQuestion(
  runs: readonly RunRow[],
  slots: { free: number | null; cap: number | null },
  watchName: (id: number) => string | null = () => null,
): string | null {
  const going = runs.filter((run) => run.status === 'running');
  const again = runs.filter((run) => run.status !== 'running');
  if (!again.length) return null;
  const one = again.length === 1;
  const isWatch = (run: RunRow) => run.execution_type === 'automated_sweep' && run.routine_id !== null;
  const watched = again.filter(isWatch);
  const searches = again.filter((run) => !isWatch(run));
  const parts: string[] = [];
  const first = again[0]!;
  const title = runTitle(first, first.routine_id ? watchName(first.routine_id) : null);
  if (one && searches.length) {
    parts.push(`Run ${first.id}, “${title}”, again, with its own terms, dates, limit, and sources, as a new run linked back to it?`,
      'It summarizes only if its run was set to, with what Settings › AI holds now.');
  } else if (one) {
    parts.push(`Run ${first.id}, “${title}”, again as its watch’s Run Now?`,
      'It runs with the watch’s current settings (its terms, sources, dates, and summaries), is emailed and delivered as '
      + 'the watch is set, and does not start while the watch is already running.');
  } else {
    parts.push(`Run ${number(again.length)} runs again?`);
    if (searches.length) {
      parts.push('A search runs with its own terms, dates, limit, and sources, as a new run linked back to it, and '
        + 'summarizes only if its run was set to, with what Settings › AI holds now.');
    }
    if (watched.length) {
      const ids = runNumbers(watched.map((run) => run.id));
      parts.push(watched.length === 1
        ? `A watch’s run (${ids}) runs as its watch’s Run Now: with the watch’s current settings (its terms, sources, `
          + 'dates, and summaries), emailed and delivered as the watch is set, and not while the watch is already running.'
        : `Watches’ runs (${ids}) run as their watches’ Run Now: with each watch’s current settings (its terms, sources, `
          + 'dates, and summaries), emailed and delivered as the watch is set, and not while that watch is already running.');
    }
  }
  if (slots.free !== null && slots.cap !== null && again.length > slots.free) {
    const waiting = again.length - Math.max(0, slots.free);
    const who = waiting === again.length ? (one ? 'it' : 'they') : number(waiting);
    const single = waiting === 1;
    parts.push(`resmon runs ${slots.cap} at once, so ${who} ${single ? 'waits' : 'wait'} for a free slot, under Waiting `
      + `above, and ${single ? 'starts on its' : 'start on their'} own.`);
  }
  if (going.length) {
    parts.push(`${capitalized(runNumbers(going.map((run) => run.id)))} ${going.length === 1 ? 'is' : 'are'} still running, `
      + `and ${going.length === 1 ? 'is' : 'are'} not run again.`);
  }
  return parts.join(' ');
}

/** The sentence after Run Again: what started and what waits. Refusals are said beside it, in the engine's words. */
export function ranAgainSentence(outcome: RerunOutcome): string | null {
  const parts: string[] = [];
  if (outcome.started.length) parts.push(`Started ${runNumbers(outcome.started)}.`);
  if (outcome.queued) {
    const single = outcome.queued === 1;
    parts.push(`${number(outcome.queued)} ${single ? 'waits' : 'wait'} for a free slot, under Waiting, and `
      + `${single ? 'starts on its' : 'start on their'} own.`);
  }
  return parts.length ? parts.join(' ') : null;
}
