/**
 * Whether a run summarized its papers, with what, and how that went, from
 * two records the engine keeps: the `ai_choice` event every run emits when it
 * starts (what it was set to do), and `ai_lanes`, one row per connection it
 * tried (what each did). A run with neither recorded says so, rather than
 * reading as a run that was not asked to summarize.
 */
import type { components } from '../../api/schema';
import { answeredNames } from '../settings/modelWords';
import { listWords } from '../settings/summaryChoice';
import type { ProgressEvent } from './model';

export type RunAiLane = components['schemas']['RunAiLane'];

/** The `ai_choice` event (`resmon._ai_choice_event`). */
export interface AiChoiceEvent {
  type: 'ai_choice';
  enabled: boolean;
  lane_source: 'run' | 'settings';
  lanes: { label: string; kind: string; provider: string; model: string | null }[];
  adjusted: string[];
  length?: string | null;
  tone?: string | null;
}

export interface RunSummaries {
  /** Whether the run was set to summarize; null where it is not recorded. */
  on: boolean | null;
  /** What it was set to do, in a sentence. */
  head: string;
  /** One sentence per connection it tried, in order. */
  lanes: string[];
  /** Why no connection was tried, where it was set to summarize and none was. */
  note: string | null;
}

export function aiChoiceOf(events: readonly ProgressEvent[]): AiChoiceEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as unknown as Partial<AiChoiceEvent> & { type: string };
    if (event.type === 'ai_choice' && typeof event.enabled === 'boolean') {
      return { lane_source: 'settings', lanes: [], adjusted: [], ...event } as AiChoiceEvent;
    }
  }
  return null;
}

const ADJUSTED: Record<string, string> = {
  length: 'length', tone: 'tone', temperature: 'temperature', extraction_goals: 'what to draw out',
};

const papers = (n: number) => `${n} ${n === 1 ? 'paper' : 'papers'}`;

/**
 * Which model wrote a lane's summaries, as its command reported it. Said only
 * for a lane that wrote some, and only from a report: a lane whose command
 * said nothing about it gets nothing here rather than the alias it was asked for.
 */
export function writtenBy(lane: RunAiLane): string {
  const names = answeredNames(lane.answered_by);
  return names && lane.docs_succeeded > 0 ? ` Written by ${names}.` : '';
}

/** What one connection did, as its row records it. */
export function laneSentence(lane: RunAiLane, running: boolean): string {
  // The lane's own sentence, without its full stop, since it ends this one.
  const reason = (lane.safe_message || lane.error_kind || '').trim().replace(/\.$/, '') || null;
  switch (lane.outcome) {
    case 'ok':
      return `${lane.lane_label}: summarized ${lane.docs_succeeded} of ${papers(lane.docs_attempted)}.${writtenBy(lane)}`;
    case 'partial':
      return `${lane.lane_label}: summarized ${lane.docs_succeeded} of ${papers(lane.docs_attempted)}${reason ? `; ${reason}` : ''}.${writtenBy(lane)}`;
    case 'failed':
      return lane.docs_attempted
        ? `${lane.lane_label}: summarized none of ${papers(lane.docs_attempted)}${reason ? `: ${reason}` : ''}.`
        : `${lane.lane_label}: could not be used${reason ? `: ${reason}` : ''}.`;
    case 'skipped':
      return `${lane.lane_label}: not needed, because an earlier connection covered every paper.`;
    default:
      return running ? `${lane.lane_label}: summarizing now.` : `${lane.lane_label}: was summarizing when the run stopped.`;
  }
}

/**
 * A run's summaries in words, from its choice event and its lane rows. A
 * watch's run takes its choice from the watch, so what was set for it is said
 * to be set for the watch.
 */
/** Whether a lane stopped because its command is not signed in, so the run page can offer the sign-in. */
export function needsSignIn(lane: RunAiLane): boolean {
  return lane.lane_kind === 'subscription' && lane.error_kind === 'cli_auth'
    && (lane.provider === 'claude_code' || lane.provider === 'codex');
}

export function runSummaries(
  run: { status: string; result_count?: number | null; routine_id?: number | null; ai_lanes?: readonly RunAiLane[] },
  events: readonly ProgressEvent[],
): RunSummaries {
  const whose = run.routine_id ? 'its watch' : 'this run';
  const choice = aiChoiceOf(events);
  const rows = run.ai_lanes ?? [];
  const running = run.status === 'running';
  const lanes = rows.map((row) => laneSentence(row, running));
  if (!choice) {
    if (rows.length) return { on: true, head: 'On.', lanes, note: null };
    // An interrupted run keeps no events, so its choice is not known; but a
    // lane's row is written before its first call, so a settled run with none
    // made no attempt, and that is said first, as Restart's own line says it.
    if (running || !run.ai_lanes) return { on: null, head: 'Not recorded with this run.', lanes: [], note: null };
    const stopped = run.status === 'completed' ? '' : ' before it stopped';
    return { on: null, head: `This run recorded no attempt to summarize${stopped}, and not whether it was set to.`, lanes: [], note: null };
  }
  if (!choice.enabled) return { on: false, head: 'Off for this run.', lanes: [], note: null };
  const labels = choice.lanes.map((lane) => lane.label);
  const head = !labels.length
    ? 'On, but no provider was set up in Settings › AI, so no summary was written.'
    : `On, with ${labels.join(', then ')}${choice.lane_source === 'run' ? `, set for ${whose}` : ', from Settings › AI'}.`;
  const adjusted = choice.adjusted.map((key) => ADJUSTED[key] ?? key);
  const asked = labels.length && choice.length && choice.tone
    ? ` Asked for ${choice.length} length, ${choice.tone} tone.` : '';
  const wording = adjusted.length ? `${asked} Its ${listWords(adjusted)} ${adjusted.length === 1 ? 'was' : 'were'} set for ${whose}.` : asked;
  let note: string | null = null;
  if (labels.length && !rows.length) {
    if (running) note = 'Summaries are written once the run has its papers.';
    else if (run.status === 'completed' && run.result_count === 0) note = 'This run found no papers, so there was nothing to summarize.';
    else if (run.status !== 'completed') note = `The run ended (${run.status}) before any paper was summarized.`;
    else note = 'No connection recorded an attempt.';
  }
  return { on: true, head: `${head}${wording}`, lanes, note };
}
