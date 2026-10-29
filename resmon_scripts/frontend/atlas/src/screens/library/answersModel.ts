/**
 * Words for selected-evidence answers, and the small rules the screen keeps.
 * The engine's values are shown as what they are: a requested model is not a
 * reported one, a reported token count is not a bill, and a citation is a
 * selected text's identity, not support for a claim.
 */
import type { Answer, Choice, Choices, Connection, Source } from './answersApi';

export const MODE_WORDS: Record<string, string> = { question: 'Question', briefing: 'Briefing' };

/** An answer's state, said plainly. `refused` is the model saying the selection was not enough. */
export const STATE_WORDS: Record<string, string> = {
  admitted: 'Admitted, not started',
  running: 'Running',
  succeeded: 'Answered',
  refused: 'Not enough in the selection',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
};

export const CLEANUP_WORDS: Record<string, string> = {
  not_started: 'nothing was started',
  pending: 'local cleanup still running',
  confirmed: 'local cleanup confirmed',
  unknown: 'local cleanup unknown',
};

export const SECTION_WORDS: Record<string, string> = {
  summary: 'Summary', details: 'Details', limitations: 'Limitations', questions: 'Open questions',
};

export const ITEM_WORDS: Record<string, string> = {
  source_statement: 'From the sources', interpretation: 'Interpretation', note_summary: 'From your notes', question: 'Open question',
};

/** A citation's control, as the journey reads it: `S01 · paper.pdf · page 2`. */
export function citationLabel(source: Source): string {
  return `${source.source_id} · ${source.original_name} · page ${source.page_number}`;
}

/** What was asked for: the connection, the model and the effort, or the runtime's own default where none was named. */
export function requestedWords(requested: Answer['request']['payload']['requested']): string {
  const model = requested.requested_model ?? 'its default model (not known here)';
  const effort = requested.requested_effort ?? (requested.runtime === 'api_key' ? 'not supported' : 'its default (not known here)');
  return `${requested.provider === 'claude_code' ? 'Claude Code' : requested.provider}, ${model}, effort ${effort}`;
}

/** What the runtime reported it used, which can differ from what was asked for. */
export function reportedWords(reports: Answer['reports']): string {
  if (!reports.length) return 'No model was reported.';
  return `Reported model: ${[...new Set(reports.map((r) => r.model))].join(', ')}.`;
}

/** Reported token counts, and nothing about cost, which is not known. */
export function usageWords(usage: Answer['usage']): string {
  if (!usage) return 'No usage was reported. Billing is unknown.';
  const r = usage.reported;
  const parts = [
    r.input_tokens !== undefined && r.input_tokens !== null ? `${r.input_tokens} input` : null,
    r.output_tokens !== undefined && r.output_tokens !== null ? `${r.output_tokens} output` : null,
    r.cache_read_tokens ? `${r.cache_read_tokens} cache read` : null,
    r.cache_creation_tokens ? `${r.cache_creation_tokens} cache written` : null,
  ].filter(Boolean);
  return `Reported tokens: ${parts.join(', ') || 'none'}. Billing is unknown.`;
}

/** A connection's select value, and back. */
export const connectionKey = (c: Pick<Connection, 'runtime' | 'provider'>): string => `${c.runtime ?? 'none'}:${c.provider}`;

/** The choice the dialog starts with: the settings default, or the first connection that can run. */
export function firstChoice(choices: Choices): Choice | null {
  if (choices.default_request) return choices.default_request;
  const usable = choices.connections.find((c) => c.implemented && c.available && c.runtime);
  return usable?.runtime ? { version: 1, runtime: usable.runtime, provider: usable.provider, model: null, effort: null } : null;
}
