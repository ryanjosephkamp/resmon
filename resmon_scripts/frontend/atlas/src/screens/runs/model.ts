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
 * not a count, is `not_recorded` rather than a guess either way.
 */
export type LiveState = 'pending' | 'asking' | 'answered' | 'no_answer' | 'not_queried' | 'not_recorded' | 'error';

export interface LiveSource {
  slug: string;
  state: LiveState;
  count: number | null;
  /** The engine's own sentence for a zero, or the error; empty when there is none. */
  note: string;
}

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

/** Each selected source's live state, in the order the run selected them. */
export function liveSources(selected: readonly string[], events: readonly ProgressEvent[]): LiveSource[] {
  const bySlug = new Map<string, LiveSource>();
  const order = [...selected];
  const at = (slug: string): LiveSource => {
    let source = bySlug.get(slug);
    if (!source) {
      source = { slug, state: 'pending', count: null, note: '' };
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
        source.state = outcome === 'answered' ? 'answered'
          : outcome === 'unknown' ? 'not_recorded'
            : event.zero_reason === 'missing_key' ? 'not_queried' : 'no_answer';
        source.note = event.zero_reason && event.zero_message ? event.zero_message : '';
        break;
      }
      case 'repo_skipped_missing_key':
        source.state = 'not_queried';
        source.note = event.credential_name
          ? `Not queried: no API key is configured (${event.credential_name}).`
          : 'Not queried: no API key is configured.';
        break;
      case 'repo_error':
        source.state = 'error';
        source.note = event.error ? String(event.error) : '';
        break;
      default:
        break;
    }
  }
  return order.map((slug) => bySlug.get(slug) as LiveSource);
}

/** The words the screen shows for a live state. */
export function liveLabel(source: LiveSource): string {
  switch (source.state) {
    case 'pending': return 'waiting';
    case 'asking': return 'asking';
    case 'answered':
      return source.count && source.count > 0
        ? `${source.count.toLocaleString('en-US')} found`
        : 'answered, nothing found';
    case 'no_answer': return 'did not answer';
    case 'not_queried': return 'not queried';
    case 'not_recorded': return 'reason not recorded';
    case 'error': return 'error';
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

/** Why an interrupted run stopped, as a sentence, from the stored token. */
export function interruptedSentence(run: Pick<RunRow, 'interrupted_reason' | 'last_seen_at_utc'>): string {
  const why: Record<string, string> = {
    owner_dead: 'the process running it stopped',
    daemon_restart: 'resmon was shut down',
  };
  const reason = why[run.interrupted_reason ?? ''] ?? 'the reason was not recorded';
  const seen = run.last_seen_at_utc
    ? `; last seen working ${run.last_seen_at_utc.slice(0, 16).replace('T', ' ')} UTC`
    : '';
  return `Interrupted: ${reason}${seen}.`;
}

/** Runs that can be started again with the same parameters. */
export const RESTARTABLE: ReadonlySet<string> = new Set(['interrupted', 'failed', 'cancelled']);
