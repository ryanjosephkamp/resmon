/**
 * A running run, as its page says it while it goes: how long it has run, the
 * stage it is at, how many of its sources have finished, and what each source
 * still being asked is doing.
 *
 * Everything here is read from the run's own events. The engine sends a
 * heartbeat every two seconds for each source it is still asking, with the
 * time since it began, the requests sent, the retries, and any wait; the page
 * says what the latest one said, and says when it has heard nothing for a
 * while rather than inventing progress. Only the run's clock is the page's
 * own: the time since the run's recorded start.
 */
import { storedInstant, type LiveSource, type ProgressEvent } from './model';

/** "42 s", "4 min 07 s", "1 h 02 min": a clock that ticks without its width jumping. */
export function elapsedWords(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes} min ${String(whole % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** Seconds since a stored instant, at `now`; null when the instant is not recorded. */
export function secondsSince(iso: string | null | undefined, now: number): number | null {
  const at = storedInstant(iso);
  return at ? Math.max(0, (now - at.getTime()) / 1000) : null;
}

/** How long the engine may say nothing about a source it is asking before the page says so. */
export const QUIET_SECONDS = 15;

/** How often the engine sends a source's heartbeat (`sweep_engine._HEARTBEAT_SECONDS`). */
export const HEARTBEAT_SECONDS = 2;

/** What a source being asked is doing, in words: the time beside "asking", and the line under it. */
export interface AskingWords {
  /** "42 s": the heartbeat's time since the source was first asked. */
  time: string | null;
  /** "3 requests, 1 retry · waiting 3 s for arXiv’s pace". */
  detail: string | null;
  /** "No word from the engine about it for 18 s." */
  quiet: string | null;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * A wait the heartbeat reported, in words: whole seconds, at least one, and
 * minutes past a minute (a watch's scheduled run may wait five at once).
 */
export function waitWords(waiting: { kind: string; seconds: number }, name: string): string {
  const whole = Math.max(1, Math.ceil(waiting.seconds));
  const seconds = whole < 60 ? `${whole} s` : elapsedWords(whole);
  switch (waiting.kind) {
    case 'pace': return `waiting ${seconds} for ${name}’s pace`;
    case 'cooldown': return `waiting ${seconds}, as ${name} asked`;
    case 'retry': return `waiting ${seconds} before asking again`;
    default: return `waiting ${seconds}`;
  }
}

/**
 * What a source being asked is doing, in words. Between two heartbeats the
 * time and a wait move on with the page's own clock from when the latest one
 * arrived, for at most one heartbeat's interval: so the line changes every
 * second while heartbeats arrive, never runs ahead of the engine by more than
 * the time it said, and stops when they stop.
 */
export function askingWords(source: LiveSource, name: string, now: number): AskingWords {
  const activity = source.activity;
  if (source.state !== 'asking' || !activity) return { time: null, detail: null, quiet: null };
  const drift = activity.received === null ? 0 : Math.min(HEARTBEAT_SECONDS, Math.max(0, (now - activity.received) / 1000));
  const counts: string[] = [];
  if (activity.requests) counts.push(plural(activity.requests, 'request', 'requests'));
  if (activity.retries) counts.push(plural(activity.retries, 'retry', 'retries'));
  const wait = activity.waiting ? { ...activity.waiting, seconds: Math.max(0, activity.waiting.seconds - drift) } : null;
  const parts = [counts.join(', '), wait ? waitWords(wait, name) : ''].filter(Boolean);
  const silent = secondsSince(activity.at, now);
  return {
    time: activity.elapsed === null ? null : elapsedWords(activity.elapsed + drift),
    detail: parts.length ? parts.join(' · ') : null,
    quiet: silent !== null && silent >= QUIET_SECONDS
      ? `No word from the engine about it for ${elapsedWords(silent)}.` : null,
  };
}

/** The stage a running run is at, and what it can count of it. */
export interface LiveStage {
  /** The engine's stage token, or null before the first. */
  stage: string | null;
  /** "Asking the sources", "Summarizing the papers". */
  words: string;
  /** "3 of 20 papers", where the stage counts something; null where it does not. */
  count: string | null;
}

const STAGE_WORDS: Readonly<Record<string, string>> = {
  querying: 'Asking the sources',
  dedup: 'Storing the papers in your collection',
  linking: 'Linking the papers to this run',
  embedding: 'Embedding the papers, so they can be found by meaning',
  reporting: 'Writing the report',
  summarizing: 'Summarizing the papers',
  finalizing: 'Finishing',
};

/** "3 of 20 papers". */
function ofPapers(done: unknown, total: unknown): string | null {
  if (typeof done !== 'number' || typeof total !== 'number' || total <= 0) return null;
  return `${Math.min(done, total).toLocaleString('en-US')} of ${plural(total, 'paper', 'papers')}`;
}

/**
 * The run's current stage, from its latest `stage` event, with the count the
 * engine sends for it: papers linked, embedded, or summarized. A stage this
 * build has no words for is said in the engine's own message. A person watch
 * that checks retractions asks no source, and its querying stage says what it
 * does instead.
 */
export function liveStage(events: readonly ProgressEvent[]): LiveStage {
  let stage: string | null = null;
  let message = '';
  let count: string | null = null;
  for (const event of events) {
    if (event.type === 'stage') {
      stage = event.stage ?? null;
      message = event.message ?? '';
      count = null;
    } else if (event.type === 'link_progress' && stage === 'linking') {
      count = ofPapers(event.processed, event.total);
    } else if (event.type === 'ai_progress' && event.stage === 'embedding') {
      // The embedding step announces its stage on its own events.
      stage = 'embedding';
      count = ofPapers(event.processed, event.total);
    } else if (event.type === 'ai_progress' && stage === 'summarizing') {
      count = ofPapers(event.completed, event.total);
    }
  }
  if (stage === null) return { stage, words: 'Starting', count: null };
  const retractions = stage === 'querying' && message && !/^Querying repositories/.test(message);
  const words = retractions ? message.replace(/\.{3}$/, '') : STAGE_WORDS[stage] ?? (message.replace(/\.{3}$/, '') || stage);
  return { stage, words, count };
}

/** How many of a run's sources have finished being asked, whatever each answered. */
export function sourcesFinished(sources: readonly LiveSource[]): number {
  return sources.filter((source) => source.state !== 'pending' && source.state !== 'asking').length;
}

/**
 * The Source wall's state for a live source, so a running run is drawn in the
 * marks its finished runs are drawn in (`health/model.ts`), plus the two only
 * a running run has: a source being asked, and one not asked yet.
 */
export function liveMarkState(source: LiveSource): string {
  switch (source.state) {
    case 'pending': return 'not_yet_asked';
    case 'asking': return 'asking';
    case 'answered':
      return source.count === 0 && source.reason === 'answered_empty' ? 'answered_empty' : 'answered';
    case 'in_part': return 'answered_in_part';
    case 'no_answer':
      if (source.rateLimited) return 'rate_limited';
      return source.reason && COULD_NOT_BE_ASKED.has(source.reason) ? 'could_not_be_asked' : 'failed';
    case 'not_queried': return 'could_not_be_asked';
    case 'error': return 'failed';
    case 'stopped':
    case 'cancelled':
    case 'not_reached':
    case 'not_recorded':
      return 'not_recorded';
  }
}

/** The non-answers the Source wall draws as a question never asked (`source_wall.STATE_FOR_NON_ANSWER`). */
const COULD_NOT_BE_ASKED: ReadonlySet<string> = new Set(['missing_key', 'retired', 'window_unanswerable', 'entity_unsupported']);
