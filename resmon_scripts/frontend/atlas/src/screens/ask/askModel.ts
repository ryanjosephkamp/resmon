/**
 * Words for the assistant, and the rules for drawing a turn while it runs.
 *
 * Three distinctions are kept everywhere a conversation is drawn, because the
 * engine keeps them and a screen that merged them would claim more than it
 * knows: what was **requested** is not what the runtime **reported**; a cost
 * the runtime did not report is **not reported**, never zero; and a saved
 * conversation's **completion is unknown**, because resmon stores what was
 * persisted and never observed whether a turn ended or was cut off.
 */
import type { Bound, ChoiceRequest, Choices, Connection, Message, Requested, TurnChoices, TurnEvent } from './askApi';

/** A provider as a person knows it. An unknown one is shown as the engine names it. */
export const PROVIDER_WORDS: Record<string, string> = {
  claude_code: 'Claude Code', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google',
  custom: 'a custom API', local: 'Ollama', codex: 'Codex', xai: 'xAI', meta: 'Meta', deepseek: 'DeepSeek',
  alibaba: 'Alibaba',
};

export const providerWords = (provider: string): string => PROVIDER_WORDS[provider] ?? provider;

/** `mcp__resmon__run_sweep` → `run_sweep`: the name the tool has in resmon. */
export function shortToolName(raw: string): string {
  return raw.startsWith('mcp__') ? raw.split('__').pop() ?? raw : raw;
}

/** The exact call a card holds, as the card draws it: `name(<the input, indented>)`. */
export function callText(tool: string, input: Record<string, unknown> | undefined): string {
  return `${shortToolName(tool)}(${JSON.stringify(input ?? {}, null, 2)})`;
}

/**
 * The sentence a card leads with. Only for the writes resmon knows; any other
 * tool is "Run <name>", never a plausible description of something else, and
 * the exact call is drawn under it either way.
 */
export function describeCall(tool: string, input: Record<string, unknown> | undefined): string {
  const name = shortToolName(tool);
  const value = (key: string) => (input?.[key] === undefined ? '' : ` ${String(input[key])}`);
  switch (name) {
    case 'run_sweep': return 'Search your sources now and store what comes back';
    case 'create_routine': return `Create a watch${input?.name ? ` called “${String(input.name)}”` : ''}, switched off`;
    case 'run_routine': return `Run watch${value('routine_id')} now, outside its schedule`;
    case 'activate_routine': return `Put watch${value('routine_id')} on its schedule`;
    case 'deactivate_routine': return `Take watch${value('routine_id')} off its schedule`;
    case 'update_settings': return `Change your ${String(input?.group ?? '')} settings`;
    default: return `Run ${name}`;
  }
}

/** A request or binding the engine could read. The unreadable form carries `unreadable` and nothing else. */
const isReadable = (value: unknown): value is Requested =>
  !!value && typeof value === 'object' && !('unreadable' in value) && typeof (value as Requested).provider === 'string';

/**
 * What a conversation or a turn asked for, in one line: the connection, the
 * model and the effort. Where nothing was named, the runtime's own default
 * was used, and resmon does not know what that is.
 */
export function requestedWords(choices: Bound | TurnChoices['requested'] | undefined, answered?: string | null): string {
  if (choices === null || choices === undefined) return 'Not recorded: this conversation began before resmon kept its choices.';
  if (!isReadable(choices)) return 'Unreadable: the saved choices are not in a form this version reads.';
  const model = `${choices.requested_model ?? 'the default model (not known here)'}${answered ? ` (${answered})` : ''}`;
  const effort = choices.runtime === 'api_key' ? 'effort not supported by this connection'
    : `effort ${choices.requested_effort ?? 'default (not known here)'}`;
  return `${providerWords(choices.provider)} · ${model} · ${effort}`;
}

/**
 * Which model answered a conversation, from its turns' own reports: "answered
 * by Haiku 5.5", or "last answered by Haiku 5.5" when its answers came from
 * more than one. `null` before any answer reported a model.
 */
export function answeredWords(turns: readonly TurnChoices[]): string | null {
  const names = turns.flatMap((t) => (t.answered_by ? [t.answered_by.name] : []));
  if (!names.length) return null;
  const last = names[names.length - 1] as string;
  return names.every((n) => n === last) ? `answered by ${last}` : `last answered by ${last}`;
}

/**
 * Under an answer: the model that wrote it, as its runtime reported it, the
 * effort that was asked for, and the cost. "Haiku 5.5 · high effort ·
 * Reported cost $0.0123, not an invoice". The effort is the request's: no
 * runtime reports the effort it used.
 *
 * Codex reports tokens and never a price, so a Codex answer says its tokens
 * where another says its cost: "1,200 tokens in, 80 out, as Codex reported".
 */
export function answerFooterWords(turn: TurnChoices | undefined, cost: number | null | undefined,
  tokens?: { input_tokens?: number | null; output_tokens?: number | null }): string {
  const parts: string[] = [];
  const requested = turn?.requested;
  if (turn) {
    parts.push(turn.answered_by ? turn.answered_by.name : 'Model not reported');
    if (isReadable(requested) && requested.runtime !== 'api_key') {
      parts.push(requested.requested_effort ? `${requested.requested_effort} effort` : 'default effort');
    }
  }
  parts.push(isReadable(requested) && requested.runtime === 'codex_cli'
    ? tokenWords(tokens?.input_tokens, tokens?.output_tokens)
    : costWords(cost));
  return parts.join(' · ');
}

const COUNT = new Intl.NumberFormat('en-US');

/** Tokens a runtime reported, in and out. Not a cost, and never drawn as one. */
export function tokenWords(input: number | null | undefined, output: number | null | undefined): string {
  if (input === null || input === undefined || output === null || output === undefined) return 'Tokens not reported';
  return `${COUNT.format(input)} tokens in, ${COUNT.format(output)} out, as Codex reported`;
}

/** The heading of a turn that produced no answer. */
export function failureTitle(code: string): string {
  return code === 'stopped' ? 'Stopped before it answered' : 'No answer';
}

const BASIS_WORDS: Record<string, string> = {
  explicit: 'chosen for this conversation',
  settings_default: 'the default in Settings → AI when it began',
  runtime_default: 'not named, so the runtime chose',
  not_supported: 'not supported',
};

/** Where each requested value came from, as the engine recorded it. */
export function basisWords(choices: Bound | TurnChoices['requested'] | undefined): string {
  if (!isReadable(choices)) return '';
  return `Model: ${BASIS_WORDS[choices.model_basis] ?? choices.model_basis}. `
    + `Effort: ${BASIS_WORDS[choices.effort_basis] ?? choices.effort_basis}.`;
}

const REPORT_SOURCES: Record<string, string> = {
  claude_system_init_model: 'announced by the Claude CLI as it started',
  claude_result_model_usage: 'billed for this answer, as the Claude CLI reported',
  codex_event_model: 'named by Codex in its own events',
  codex_header_model: 'named in the header Codex printed as it started',
  api_response_model: 'named in the provider’s reply',
  google_response_modelVersion: 'named in Google’s reply',
};

/** One runtime report, as a separate claim from the request. */
export function reportWords(report: { model: string; source: string; name?: string }): string {
  const named = report.name && report.name !== report.model ? `${report.name} (${report.model})` : report.model;
  return `${named}, ${REPORT_SOURCES[report.source] ?? report.source}`;
}

/** A cost the runtime did not report is not zero. */
export function costWords(cost: number | null | undefined): string {
  return cost === null || cost === undefined ? 'Cost not reported' : `Reported cost $${cost.toFixed(4)}, not an invoice`;
}

/** The choices the composer starts from: the settings default, else the first connection that can run. */
export function firstChoice(choices: Choices | undefined): ChoiceRequest | null {
  if (!choices) return null;
  // Built key by key: the engine refuses a choice with any key but these five,
  // and its reply may carry more than it declares.
  const d = choices.default_request;
  if (d) return { version: 1, runtime: d.runtime as ChoiceRequest['runtime'], provider: d.provider, model: d.model, effort: d.effort };
  const usable = choices.connections.find((c) => c.implemented && c.available && c.runtime);
  return usable?.runtime ? { version: 1, runtime: usable.runtime as ChoiceRequest['runtime'], provider: usable.provider, model: null, effort: null } : null;
}

export const connectionKey = (c: { runtime?: string | null; provider: string }): string => `${c.runtime ?? 'none'}:${c.provider}`;

/** The connection a choice names, from the engine's list. */
export function connectionOf(choices: Choices | undefined, choice: { runtime?: string | null; provider: string } | null): Connection | undefined {
  return choice ? choices?.connections.find((c) => connectionKey(c) === connectionKey(choice)) : undefined;
}

/** Why a choice cannot be sent yet, or `null` when it can. */
export function choiceProblem(choices: Choices | undefined, choice: ChoiceRequest | null): string | null {
  if (!choice) return 'Choose a connection first.';
  const connection = connectionOf(choices, choice);
  if (!connection) return 'That connection is not one the engine offers.';
  if (!connection.available) return connection.reason;
  if (choice.runtime === 'api_key' && !choice.model?.trim()) return 'This connection needs a model ID: there is no default to fall back on.';
  return null;
}

/* ------------------------------------------------------------ a live turn */

export interface LiveCall { name: string; input?: Record<string, unknown>; id?: string; outcome?: 'ok' | 'error' }
export interface LiveMessage { role: 'user' | 'assistant' | 'notice'; text: string; calls: LiveCall[] }
export interface Card { requestId: string; tool: string; input: Record<string, unknown> }

/** What a turn has shown so far, before the engine's saved copy replaces it. */
export interface Live {
  session: number;
  messages: LiveMessage[];
  turns: TurnChoices[];
  cards: Card[];
  error: string | null;
}

export function startLive(session: number, text: string): Live {
  return { session, messages: [{ role: 'user', text, calls: [] }], turns: [], cards: [], error: null };
}

/** The assistant message being written, opened on the first text or call. */
function speaking(messages: LiveMessage[]): LiveMessage[] {
  const last = messages[messages.length - 1];
  return last?.role === 'assistant' ? messages : [...messages, { role: 'assistant', text: '', calls: [] }];
}

function withLast(messages: LiveMessage[], change: (m: LiveMessage) => LiveMessage): LiveMessage[] {
  const next = speaking(messages);
  return [...next.slice(0, -1), change(next[next.length - 1] as LiveMessage)];
}

/**
 * One event applied to the live turn. Unknown event types are dropped rather
 * than drawn: the engine already drops what a runtime emits and resmon does
 * not recognize, and this is the same rule one layer later.
 */
export function applyEvent(live: Live, event: TurnEvent): Live {
  switch (event.type) {
    case 'turn_choices':
      if (event.session_id !== live.session || !event.user_message_id || !event.requested) return live;
      return { ...live, turns: [...live.turns, {
        user_message_id: event.user_message_id, assistant_message_id: null, version: 1,
        created_at_utc: '', requested: event.requested, reported: [], answered_by: null, failure: null,
      } as TurnChoices] };
    case 'turn_model_report': {
      const report = event.reported;
      if (event.session_id !== live.session || !report) return live;
      return { ...live, turns: live.turns.map((t) => t.user_message_id === event.user_message_id && Array.isArray(t.reported)
        ? { ...t, reported: [...t.reported, { sequence: t.reported.length + 1, ...report }] } as TurnChoices : t) };
    }
    case 'text_delta':
      if (typeof event.text !== 'string') return live;
      return { ...live, messages: withLast(live.messages, (m) => ({ ...m, text: m.text + event.text })) };
    case 'tool_call':
      return { ...live, messages: withLast(live.messages, (m) => ({
        ...m, calls: [...m.calls, { name: event.tool_name || 'an unnamed tool', input: event.input, id: event.tool_use_id }],
      })) };
    case 'tool_result':
      return { ...live, messages: live.messages.map((m) => ({
        ...m, calls: m.calls.map((c) => (c.id && c.id === event.tool_use_id ? { ...c, outcome: event.is_error ? 'error' : 'ok' } : c)),
      })) };
    case 'notice':
      return { ...live, messages: [...live.messages, { role: 'notice', text: String(event.message ?? ''), calls: [] }] };
    case 'permission_request':
      if (!event.request_id) return live;
      return { ...live, cards: [...live.cards, { requestId: event.request_id, tool: event.tool_name || 'an unnamed tool', input: event.input ?? {} }] };
    case 'error':
      return { ...live, error: event.message || 'The turn failed without saying why.' };
    default:
      return live;
  }
}

/** A saved message's tool calls, where they are the shape resmon writes; `null` when they are something else. */
export function savedCalls(message: Message): LiveCall[] | null {
  const calls: unknown = message.tool_calls;
  if (calls === null || calls === undefined) return [];
  if (!Array.isArray(calls) || !calls.every((c) => c && typeof c === 'object' && typeof (c as LiveCall).name === 'string')) return null;
  return calls as LiveCall[];
}
