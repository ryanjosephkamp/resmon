/**
 * Runs: what a run asked, what each source did while it ran, and what the
 * record says afterwards.
 *
 * Two accounts of the same sources, kept apart on purpose. The **live** one is
 * folded from the progress events the engine emits as it works (`repo_start`,
 * `repo_done` and the rest); the **recorded** one is `coverage`, which the
 * engine builds from the saved per-source rows at read time. They should
 * agree, and the run screen shows both so that a disagreement can be seen
 * rather than papered over by drawing one from the other.
 */
import type { components } from '../../api/schema';
import { DID_NOT_ANSWER, ZERO_REASONS } from '../../api/zeroReasonVocabulary';

export type RunRow = components['schemas']['RunRow'];
export type Run = components['schemas']['Run'];
export type Coverage = components['schemas']['RunCoverage'];
export type CoverageSource = components['schemas']['RunCoverageSource'];
export type CatalogEntry = components['schemas']['RepositoryCatalogEntry'];

/** The run log's query: every run so far, newest first. */
export const RUNS_KEY = ['runs'] as const;

/**
 * One progress event as `/api/executions/{id}/progress/events` serves it.
 *
 * The route declares no model: the events are a stream of differently shaped
 * records (`sweep_engine` emits a dozen types), so this is the loose union of
 * the fields this screen reads, each optional, narrowed by `type` at the point
 * of use.
 */
export interface ProgressEvent {
  type: string;
  repository?: string;
  result_count?: number | null;
  zero_reason?: string | null;
  zero_message?: string | null;
  credential_name?: string | null;
  error?: string | null;
  status?: string;
  stage?: string;
  message?: string;
  elapsed?: number;
  new_count?: number;
  timestamp?: string;
}

/** The events after which the engine emits nothing more for a run. */
export const FINAL_EVENTS: ReadonlySet<string> = new Set(['complete', 'cancelled', 'error']);

/**
 * What one source did, as the run's own events said while it ran.
 *
 * The same reading the classic run panel makes (`repoDoneStatus`), from the
 * same generated vocabulary: a reason resmon does not know, or a count that is
 * not a count, is `not_recorded` rather than a guess either way. Two states
 * belong only to a run that has ended: `cancelled`, a source that was being
 * asked when the run was stopped, and `not_reached`, one the run never began
 * to ask before its last event.
 */
export type LiveState =
  | 'pending' | 'asking' | 'answered' | 'no_answer' | 'not_queried' | 'not_recorded' | 'error'
  | 'cancelled' | 'not_reached';

export interface LiveSource {
  slug: string;
  state: LiveState;
  count: number | null;
  /** The recorded zero reason, when the source's event carried one. */
  reason: string | null;
  /** The engine's own sentence for a zero, or the error; empty when there is none. */
  note: string;
}

/**
 * The error `sweep_engine` records for a source that was being asked when the
 * run was stopped (`cancel()`): the stop, not a failure of the source.
 */
const CANCELLED_BY_USER = 'cancelled by user';

/** The engine's sentence for such a source, as the run's recorded coverage words it. */
const CANCELLED_NOTE = 'The run was cancelled while this source was being queried.';

/**
 * The short words for each zero reason, the same ones the recorded coverage
 * uses (`source_coverage.outcome`), so the live panel and the record never
 * describe one reason two ways.
 */
export const ZERO_LABELS: Readonly<Record<string, string>> = {
  answered_empty: 'answered, zero',
  rights_filtered: 'answered; nothing storable',
  records_unusable: 'answered; nothing storable',
  window_unanswerable: 'could not answer this window',
  upstream_failure: 'did not answer',
  parse_failure: 'reply unreadable',
  missing_key: 'no API key configured',
  retired: 'withdrawn',
  entity_unsupported: 'entity unsupported',
};

const KNOWN_REASONS: ReadonlySet<string> = new Set(ZERO_REASONS);

/** `answered`, `non_answer` or `unknown` for a source that reported `ok` with this count and reason. */
export function outcomeOf(count: number | null | undefined, reason: string | null | undefined): 'answered' | 'non_answer' | 'unknown' {
  const recognized = typeof count === 'number' && Number.isInteger(count) && count >= 0
    && (reason == null || KNOWN_REASONS.has(reason));
  if (!recognized) return 'unknown';
  if (count > 0) return 'answered';
  if (!reason || reason === 'not_recorded') return 'unknown';
  return DID_NOT_ANSWER.has(reason) ? 'non_answer' : 'answered';
}

/**
 * Each selected source's live state, in the order the run selected them.
 *
 * `ended` says the run is no longer running. Its events then say all they
 * will: a source still waiting after the run's last event was never asked, and
 * one still being asked has no recorded outcome. Without a last event (an
 * interrupted run keeps none) neither is known, so both are `not_recorded`.
 */
export function liveSources(selected: readonly string[], events: readonly ProgressEvent[], ended = false): LiveSource[] {
  const bySlug = new Map<string, LiveSource>();
  const order = [...selected];
  const at = (slug: string): LiveSource => {
    let source = bySlug.get(slug);
    if (!source) {
      source = { slug, state: 'pending', count: null, reason: null, note: '' };
      bySlug.set(slug, source);
      if (!order.includes(slug)) order.push(slug);
    }
    return source;
  };
  for (const slug of selected) at(slug);
  for (const event of events) {
    const slug = event.repository;
    if (!slug) continue;
    const source = at(slug);
    switch (event.type) {
      case 'repo_start':
        source.state = 'asking';
        break;
      case 'repo_done': {
        const outcome = outcomeOf(event.result_count, event.zero_reason);
        source.count = typeof event.result_count === 'number' ? event.result_count : null;
        source.reason = event.zero_reason ?? null;
        source.state = outcome === 'answered' ? 'answered'
          : outcome === 'unknown' ? 'not_recorded'
            : event.zero_reason === 'missing_key' ? 'not_queried' : 'no_answer';
        source.note = event.zero_reason && event.zero_message ? event.zero_message : '';
        break;
      }
      case 'repo_skipped_missing_key':
        source.state = 'not_queried';
        source.reason = 'missing_key';
        source.note = event.credential_name
          ? `Not queried: no API key is configured (${event.credential_name}).`
          : 'Not queried: no API key is configured.';
        break;
      case 'repo_error':
        if (event.error === CANCELLED_BY_USER) {
          source.state = 'cancelled';
          source.note = CANCELLED_NOTE;
        } else {
          source.state = 'error';
          source.note = event.error ? String(event.error) : '';
        }
        break;
      default:
        break;
    }
  }
  if (ended) {
    const finished = events.some((event) => FINAL_EVENTS.has(event.type));
    for (const source of bySlug.values()) {
      if (source.state === 'pending' && finished) {
        source.state = 'not_reached';
        source.note = 'The run ended before it asked this source.';
      } else if (source.state === 'pending' || source.state === 'asking') {
        source.state = 'not_recorded';
        source.note = finished
          ? 'The run ended while this source was being asked, and what it answered was not recorded.'
          : 'The run kept no events for this source, so what it did is not recorded here.';
      }
    }
  }
  return order.map((slug) => bySlug.get(slug) as LiveSource);
}

/** The words the screen shows for a live state: for a zero, its reason's own words. */
export function liveLabel(source: LiveSource): string {
  switch (source.state) {
    case 'pending': return 'waiting';
    case 'asking': return 'asking';
    case 'answered':
      return source.count && source.count > 0
        ? `${source.count.toLocaleString('en-US')} found`
        : ZERO_LABELS[source.reason ?? ''] ?? 'answered, zero';
    case 'no_answer': return ZERO_LABELS[source.reason ?? ''] ?? 'did not answer';
    case 'not_queried': return 'no API key configured';
    case 'not_recorded':
      return source.count === 0 && (!source.reason || source.reason === 'not_recorded')
        ? 'zero, reason not recorded' : 'outcome not recorded';
    case 'error': return 'error';
    case 'cancelled': return 'cancelled';
    case 'not_reached': return 'not asked';
  }
}

/** The sources a run selected, from the engine's parse of its parameters. */
export function selectedSources(run: Pick<RunRow, 'repositories' | 'coverage'>): string[] {
  if (run.repositories && run.repositories.length) return run.repositories;
  return run.coverage.sources.map((source) => source.source);
}

/** What a run is called: its watch for a routine's run, otherwise its terms. */
export function runTitle(run: Pick<RunRow, 'query' | 'keywords'>, watchName?: string | null): string {
  if (watchName) return watchName;
  if (run.keywords && run.keywords.length) return run.keywords.join(', ');
  return run.query?.trim() || 'A search with no terms recorded';
}

/** The words for a run's kind. */
export function runKind(executionType: string): string {
  switch (executionType) {
    case 'deep_dive': return 'Deep Dive';
    case 'deep_sweep': return 'Deep Sweep';
    case 'automated_sweep': return 'Watch run';
    default: return executionType.replace(/_/g, ' ');
  }
}

/**
 * An instant the engine stored, which it always stores in UTC. A stamp
 * without an offset is read as UTC too, never as the reader's local time.
 */
export function storedInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const zoned = /(?:Z|[+-]\d\d:?\d\d)$/i.test(iso) ? iso : `${iso}Z`;
  const at = new Date(zoned);
  return Number.isNaN(at.getTime()) ? null : at;
}

const SECONDS = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const MINUTES = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

/** "October 28, 2026 at 9:14 AM", in the reader's own time zone. */
export function dayAndTime(at: Date): string {
  return `${DAY.format(at)} at ${MINUTES.format(at)}`;
}

/** "4:34:12 PM": a progress event's time, in the reader's own time zone like every other time here. */
export function eventTime(iso: string | null | undefined): string {
  const at = storedInstant(iso);
  return at ? SECONDS.format(at) : '';
}

/** Why an interrupted run stopped, as a sentence, from the stored token. */
export function interruptedSentence(run: Pick<RunRow, 'interrupted_reason' | 'last_seen_at_utc'>): string {
  const why: Record<string, string> = {
    owner_dead: 'the process running it stopped',
    daemon_restart: 'resmon was shut down',
  };
  const reason = why[run.interrupted_reason ?? ''] ?? 'the reason was not recorded';
  const last = storedInstant(run.last_seen_at_utc);
  const seen = last ? `; last seen working ${dayAndTime(last)}` : '';
  return `Interrupted: ${reason}${seen}.`;
}

/**
 * Why a run's report or log cannot be shown, in the run's own terms.
 *
 * The engine answers 404 both when it recorded no file and when the file it
 * recorded has gone from disk; the run's `result_path` and `log_path` say
 * which. Where none was recorded the run's status says why: a run still going
 * writes its report at the end, and one that was stopped, interrupted or failed
 * ended before it did. Anything other than a 404 is the engine not answering,
 * in its own words where it gave some.
 */
export function absentRecordWords(
  run: Pick<RunRow, 'status' | 'result_path' | 'log_path'>,
  kind: 'report' | 'log',
  running: boolean,
  status: number,
  detail: string | null,
): string {
  if (running) return `The ${kind} is written when the run finishes.`;
  if (status !== 404) {
    return `The ${kind} could not be read${detail ? `: ${detail}` : '. The engine did not answer; try the tab again.'}`;
  }
  const path = kind === 'report' ? run.result_path : run.log_path;
  if (path) return `resmon wrote a ${kind} for this run, but the file is no longer at ${path}.`;
  const sources = kind === 'report' ? ' What each source did is above, and in the Search record tab.' : '';
  switch (run.status) {
    case 'cancelled': return `resmon recorded no ${kind} for this run: it was stopped before it finished.${sources}`;
    case 'interrupted': return `resmon recorded no ${kind} for this run: it was interrupted before it finished.${sources}`;
    case 'failed': return `resmon recorded no ${kind} for this run: it failed before it finished.${sources}`;
    case 'completed': return `This run finished, and resmon recorded no ${kind} for it.`;
    default: return `resmon recorded no ${kind} for this run.`;
  }
}

/** Runs that can be started again with the same parameters. */
export const RESTARTABLE: ReadonlySet<string> = new Set(['interrupted', 'failed', 'cancelled']);

/** A setting the run's stored parameters record as on or off, or null when they do not record it. */
function recordedFlag(parameters: string | null | undefined, key: string): boolean | null {
  if (!parameters) return null;
  try {
    const parsed: unknown = JSON.parse(parameters);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

/** What Restart does with a run's AI summaries and with its email and deliveries. */
export interface RestartFacts {
  ai: string;
  delivery: string;
  /** A watch's run: the watch whose settings decide where a restarted run is sent. */
  watchId: number | null;
}

/**
 * What a person needs to know before pressing Restart, from what the run
 * recorded and from what Restart does (`restart_execution`). It copies the
 * search verbatim; it summarizes only when the run recorded an attempt to,
 * with today's AI settings; and the delivery hook sends only a watch's run,
 * as that watch is set when the run finishes, never a search asked by hand.
 * The run's parameters hold the search alone, so whether AI or email was on
 * is said to be not recorded unless they hold it.
 */
export function restartFacts(run: Pick<RunRow, 'parameters' | 'execution_type' | 'routine_id'>): RestartFacts {
  const ai = recordedFlag(run.parameters, 'ai_enabled');
  const email = recordedFlag(run.parameters, 'email_enabled');
  const watchRun = run.execution_type === 'automated_sweep' && run.routine_id !== null;
  const aiThen = ai === null ? 'Not recorded with this run.' : `${ai ? 'On' : 'Off'} when this run started, as its parameters record.`;
  const emailThen = email === null ? 'Not recorded with this run.' : `Email was ${email ? 'on' : 'off'} when this run started, as its parameters record.`;
  return {
    ai: `${aiThen} Restart summarizes only if this run recorded an attempt to, using what Settings › AI holds now.`,
    delivery: watchRun
      ? `${emailThen} A restarted run is emailed and delivered as its watch is set when the run finishes.`
      : 'None. resmon emails and delivers only a watch’s runs, and this search was asked by hand.',
    watchId: watchRun ? run.routine_id : null,
  };
}

/** "run 4", "runs 4 and 9", "runs 4, 9, and 12". */
export function runNumbers(ids: readonly number[]): string {
  const words = ids.map(String);
  if (words.length === 1) return `run ${words[0]}`;
  const list = words.length === 2 ? words.join(' and ') : `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`;
  return `runs ${list}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A run as the question before deleting it names it. */
export interface DeletableRun {
  id: number;
  status: string;
  title: string;
}

/**
 * The question asked before runs are deleted, or null when none of them can
 * be. It says what `DELETE /api/executions/{id}` removes (the run's row, and
 * with it what each source answered, its links to the papers it found, and
 * its record of where its report was sent) and what it leaves: the papers,
 * and the report and log files on disk. A run still running is not sent,
 * because the engine refuses it; the question names it, so the refusal is not
 * the first the person hears of it.
 */
export function deleteQuestion(runs: readonly DeletableRun[]): string | null {
  const going = runs.filter((run) => run.status === 'running');
  const doomed = runs.filter((run) => run.status !== 'running');
  const first = doomed[0];
  if (!first) return null;
  const one = doomed.length === 1;
  const head = one
    ? `Delete run ${first.id}, “${first.title}”?`
    : `Delete ${doomed.length} runs${doomed.length <= 6 ? ` (${runNumbers(doomed.map((run) => run.id))})` : ''}?`;
  const goes = one
    ? 'resmon deletes its record, with its line in the run log, what each source answered, which papers it found, and where its report was sent.'
    : 'resmon deletes their records, with each one’s line in the run log, what each source answered, which papers it found, and where its report was sent.';
  const stays = one
    ? 'The papers stay in your collection, and its report and log files stay in the reports folder.'
    : 'The papers stay in your collection, and their report and log files stay in the reports folder.';
  const verb = going.length === 1 ? 'is' : 'are';
  const kept = going.length
    ? ` ${capitalized(runNumbers(going.map((run) => run.id)))} ${verb} still running, and ${verb} not deleted.`
    : '';
  return `${head} ${goes} ${stays}${kept} This cannot be undone.`;
}

/** Why the chosen runs that are still running are left out of a delete. */
export function stillRunning(ids: readonly number[]): string {
  return `${capitalized(runNumbers(ids))} ${ids.length === 1 ? 'is' : 'are'} still running. A run can be deleted once it has stopped.`;
}

/** What came of deleting runs: deleted, already gone (the engine had no such run), or refused with the engine's reason. */
export interface DeleteOutcome {
  deleted: number[];
  gone: number[];
  refused: { id: number; reason: string }[];
}

/** The sentence after a delete, for the runs that went. A refusal is said beside it, in the engine's words. */
export function deletedSentence(outcome: DeleteOutcome): string | null {
  const parts: string[] = [];
  if (outcome.deleted.length) {
    parts.push(outcome.deleted.length === 1 ? `Deleted run ${outcome.deleted[0]}.` : `Deleted ${outcome.deleted.length} runs.`);
  }
  if (outcome.gone.length) {
    parts.push(`${capitalized(runNumbers(outcome.gone))} ${outcome.gone.length === 1 ? 'was' : 'were'} already gone.`);
  }
  return parts.length ? parts.join(' ') : null;
}

/**
 * A file name for an export of several runs: their numbers while they fit,
 * otherwise how many there are and the first and last. Sixty numbers joined
 * would pass the 255 bytes a file name may have, and the download would fail.
 */
export function runsFileStem(prefix: string, ids: readonly number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (sorted.length <= 8) return `${prefix}-${sorted.join('-')}`;
  return `${prefix}-${sorted.length}-runs-${sorted[0]}-to-${sorted[sorted.length - 1]}`;
}
