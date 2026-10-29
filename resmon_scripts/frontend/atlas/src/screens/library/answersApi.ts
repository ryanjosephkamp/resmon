/**
 * Selected-evidence answers over the engine: a preview of exactly what a Send
 * would disclose, the Send, the answer's event stream while it runs, the saved
 * answers, and their exports.
 *
 * The routes read their own bodies, so these calls go out raw (the token and
 * the Library header, as every Evidence call) and come back typed by the
 * response models. Before a screen shows any of it, it is checked here:
 *
 * - every answer is about the vault, project and answer it was asked about;
 * - a request's payload hashes to its `request_sha256`, its user prompt is
 *   exactly `{request_sha256, payload}` in canonical JSON, and each source
 *   hashes to its `source_sha256` and is as many codepoints long as its range;
 * - every citation is a source of that request, and its quote is that
 *   source's text at exactly its codepoint range.
 *
 * The engine validates all of this before it saves an answer. It is checked
 * again because a citation shown as exact must be exact, and this is the
 * last place that can refuse to show one.
 */
import type { components } from '../../api/schema';
import { bridge } from '../../bridge';
import { EngineError, answer as answered, engine } from '../../api/client';
import { evidenceFetch, sha256Hex, type Project } from './evidenceApi';

export type Preview = components['schemas']['SelectedPreview'];
export type Answer = components['schemas']['SelectedAnswer'];
export type Answers = components['schemas']['SelectedAnswers'];
export type AnswerRow = components['schemas']['SelectedAnswerRow'];
export type Request = components['schemas']['SelectedRequest'];
export type Source = components['schemas']['SelectedSource'];
export type Citation = components['schemas']['SelectedCitation'];
export type Mode = 'question' | 'briefing';

/** One explicit selection: a whole page, or an exact range of it. */
export interface Selection {
  file_id: string; version_id: string; sha256: string; page_number: number;
  range: { start_codepoint: number; end_codepoint: number; quote: string; page_text_sha256: string; extraction_contract: string } | null;
}
export interface ChosenNote { note_id: string; expected_note_revision: number }

/** The choice of connection, model and effort a request is made with. */
export interface Choice { version: 1; runtime: 'claude_cli' | 'api_key'; provider: string; model: string | null; effort: string | null }
/** The connections the engine offers, as `/api/assistant/status` declares them. */
export type Connection = components['schemas']['AssistantConnection'];
export type Choices = components['schemas']['AssistantComposerChoices'];

/** The two states an answer can still leave; every other state is final. */
export const terminal = (state: string): boolean => state !== 'admitted' && state !== 'running';

const wrong = (what: string): never => {
  throw new EngineError(0, `The engine’s answer does not match what was asked for (${what}). Nothing was shown.`);
};

/**
 * The engine's canonical JSON: sorted keys, compact separators, literal
 * Unicode, safe integers only. A request's hashes are over these bytes.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : wrong('a number that is not an integer');
  if (typeof value === 'string') return /[\uD800-\uDFFF]/u.test(value) ? wrong('a lone surrogate') : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') return wrong('a value JSON cannot hold');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
}

const codepoints = (text: string): number => Array.from(text).length;

/** A request is the exact bytes it says it is, about this project. */
/** Which project an answer belongs to: its vault and id, and nothing that moves with its revision. */
export type Where = Pick<Project, 'vault_id' | 'project_id'>;

async function checkRequest(request: Request, project: Where): Promise<Request> {
  const p = request.payload;
  if (p.vault_id !== project.vault_id || p.project_id !== project.project_id) wrong('another project');
  if (await sha256Hex(canonical(p)) !== request.request_sha256) wrong('the request hash');
  if (request.user_prompt !== canonical({ request_sha256: request.request_sha256, payload: p })) wrong('the exact user prompt');
  if (await sha256Hex(request.user_prompt) !== request.user_sha256) wrong('the user prompt hash');
  if (await sha256Hex(request.system_text) !== request.system_sha256 || p.system_sha256 !== request.system_sha256) wrong('the system text hash');
  for (const [index, source] of p.sources.entries()) {
    if (source.source_id !== `S${String(index + 1).padStart(2, '0')}`) wrong('a source’s number');
    if (source.vault_id !== project.vault_id || source.project_id !== project.project_id) wrong('a source from another project');
    if (source.end_codepoint - source.start_codepoint !== codepoints(source.text)) wrong('a source’s range');
    const basis = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'source_id' && key !== 'source_sha256'));
    if (await sha256Hex(canonical(basis)) !== source.source_sha256) wrong('a source’s hash');
  }
  return request;
}

/** The selected text a citation names, at its exact codepoint range, or null when it is not one. */
export function citedText(sources: Source[], citation: Citation): string | null {
  const source = sources.find((s) => s.source_id === citation.source_id);
  if (!source || citation.start_codepoint < source.start_codepoint || citation.end_codepoint > source.end_codepoint
    || citation.end_codepoint <= citation.start_codepoint) return null;
  return Array.from(source.text).slice(citation.start_codepoint - source.start_codepoint, citation.end_codepoint - source.start_codepoint).join('');
}

async function checkAnswer(raw: Answer, project: Where, answerId?: string, requestSha?: string): Promise<Answer> {
  if (raw.vault_id !== project.vault_id || raw.project_id !== project.project_id) wrong('another project');
  if ((answerId && raw.answer_id !== answerId) || (requestSha && raw.request_sha256 !== requestSha)) wrong('another answer');
  const request = await checkRequest(raw.request, project);
  if (request.request_sha256 !== raw.request_sha256 || request.payload.mode !== raw.mode) wrong('the answer’s request');
  // A structured result is kept only for an answer that finished as one.
  if ((raw.result !== null) !== (raw.state === 'succeeded' || raw.state === 'refused')) wrong('a result in the wrong state');
  for (const item of raw.result?.sections.flatMap((s) => s.items) ?? []) {
    for (const citation of item.citations) {
      if (citedText(request.payload.sources, citation) !== citation.quote) wrong('a citation that is not its source’s text');
    }
  }
  return raw;
}

const base = (p: Pick<Project, 'project_id'>) => `/projects/${p.project_id}`;
const query = (p: Pick<Project, 'vault_id'>, extra: Record<string, string | number | undefined> = {}): string => {
  const params = new URLSearchParams({ expected_vault_id: p.vault_id });
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) params.set(k, String(v));
  return `?${params.toString()}`;
};
async function read<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  return (await evidenceFetch(path, method, body, signal)).json() as Promise<T>;
}

export const answers = {
  /**
   * What a new answer needs before anything is selected: this engine process's
   * runtime id, which owns a preview and the answer it admits, and the
   * connections it can send through.
   */
  setup: async (): Promise<{ runtimeId: string; choices: Choices }> => {
    if (!bridge()) throw new EngineError(0, 'Selected answers need this window’s own engine.');
    const health = await answered(engine().GET('/api/health'));
    const runtimeId = health.identity?.runtime_id;
    if (typeof runtimeId !== 'string' || !runtimeId) wrong('the engine’s runtime identity');
    const status = await answered(engine().GET('/api/assistant/status'));
    return { runtimeId: runtimeId as string, choices: status.composer_choices };
  },
  preview: async (p: Project, runtime: string, body: {
    selections: Selection[]; notes: ChosenNote[]; mode: Mode; instruction: string; choices: Choice;
  }, signal?: AbortSignal): Promise<Preview> => {
    const x = await read<Preview>(`${base(p)}/answer-previews`, 'POST', {
      expected_vault_id: p.vault_id, expected_revision: p.revision, expected_runtime_id: runtime, ...body,
    }, signal);
    if (x.vault_id !== p.vault_id || x.project_id !== p.project_id || x.owner_runtime_id !== runtime) wrong('another project or engine');
    const request = await checkRequest(x.request, p);
    if (request.request_sha256 !== x.request_sha256 || request.payload.mode !== body.mode
      || request.payload.instruction !== body.instruction || request.payload.project_revision !== p.revision) wrong('the preview asked for');
    return x;
  },
  send: async (p: Where, preview: Preview): Promise<Answer> => checkAnswer(await read<Answer>(`${base(p)}/answers`, 'POST', {
    expected_vault_id: p.vault_id, expected_runtime_id: preview.owner_runtime_id, preview_id: preview.preview_id,
    request_sha256: preview.request_sha256, confirmed: true,
  }), p, undefined, preview.request_sha256),
  detail: async (p: Where, id: string, signal?: AbortSignal): Promise<Answer> =>
    checkAnswer(await read<Answer>(`${base(p)}/answers/${id}${query(p)}`, 'GET', undefined, signal), p, id),
  cancel: async (p: Where, id: string, runtime: string): Promise<Answer> =>
    checkAnswer(await read<Answer>(`${base(p)}/answers/${id}/cancel`, 'POST', { expected_vault_id: p.vault_id, expected_runtime_id: runtime }), p, id),
  history: async (p: Where, signal?: AbortSignal): Promise<Answers> => {
    const x = await read<Answers>(`${base(p)}/answers${query(p)}`, 'GET', undefined, signal);
    if (x.vault_id !== p.vault_id || x.project_id !== p.project_id) wrong('another project');
    return x;
  },
  /**
   * The answer's event stream while it runs. The engine cancels an answer no
   * one subscribes to within 30 seconds, and one whose subscriber leaves, so
   * this is opened right after a Send and held until the terminal event.
   * Every frame must name this answer, request, project, vault and runtime,
   * in strictly increasing sequence.
   */
  events: async (p: Where, a: Answer, runtime: string, onEvent: (e: AnswerEvent) => void, signal: AbortSignal): Promise<void> => {
    const response = await evidenceFetch(`${base(p)}/answers/${a.answer_id}/events${query(p, { expected_runtime_id: runtime })}`, 'GET', undefined, signal);
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) wrong('an event stream');
    const reader = response.body?.getReader();
    if (!reader) return wrong('an event stream');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    let sequence = -1;
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 8 * 1024 * 1024) wrong('an event stream within its bounds');
        pending += decoder.decode(value, { stream: true });
        for (let at = pending.indexOf('\n\n'); at >= 0; at = pending.indexOf('\n\n')) {
          const frame = pending.slice(0, at);
          pending = pending.slice(at + 2);
          if (!frame.startsWith('data: ')) continue;
          const event = JSON.parse(frame.slice(6)) as AnswerEvent;
          if (event.answer_id !== a.answer_id || event.request_sha256 !== a.request_sha256 || event.project_id !== p.project_id
            || event.vault_id !== p.vault_id || event.owner_runtime_id !== runtime || !(event.sequence > sequence)) wrong('this answer’s events');
          sequence = event.sequence;
          onEvent(event);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  },
  /**
   * A saved answer as one file, `zip` or `html`: refused unless the engine's
   * identity headers name this answer and request, and the bytes are the
   * length and SHA-256 the headers give. Nothing calls a model or reads the
   * original files.
   */
  exportFile: async (p: Where, a: Answer, format: 'zip' | 'html', signal?: AbortSignal): Promise<{ bytes: Uint8Array<ArrayBuffer>; filename: string }> => {
    const response = await evidenceFetch(`${base(p)}/answers/${a.answer_id}/export${query(p, { format })}`, 'GET', undefined, signal);
    const h = (name: string) => response.headers.get(name);
    if (h('X-Resmon-Vault') !== p.vault_id || h('X-Resmon-Project') !== p.project_id || h('X-Resmon-Bundle') !== a.answer_id
      || h('X-Resmon-Version') !== a.request_sha256) {
      await response.body?.cancel();
      wrong('this answer’s export');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (String(bytes.byteLength) !== h('Content-Length') || await sha256Hex(bytes) !== h('X-Resmon-SHA256')) wrong('the export’s length and hash');
    return { bytes, filename: `resmon-answer-${a.answer_id}.${format}` };
  },
};

/** One frame of an answer's event stream. */
export interface AnswerEvent {
  type: 'initial' | 'progress' | 'partial' | 'report' | 'terminal';
  sequence: number; answer_id: string; request_sha256: string; project_id: string; vault_id: string; owner_runtime_id: string;
  state?: string; cleanup_state?: string; partial_text?: string;
  model_report?: Answer['reports'][number]; answer?: Answer;
}
