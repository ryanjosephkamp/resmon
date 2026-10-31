import { answer, engine, EngineError, engineSentence } from '../../api/client';
import type { components, paths } from '../../api/schema';
import { bridge } from '../../bridge';

/**
 * The assistant's routes. Each reply's type is read off the route in the
 * generated contract, so a reshaped reply fails the typecheck here rather
 * than drawing a field that is no longer sent.
 *
 * One route is not JSON: a turn is a POST whose reply is a server-sent event
 * stream, and `EventSource` can only GET. So the turn is a `fetch` whose body
 * is read frame by frame (`turn` below).
 */
type Json<T> = T extends { responses: { 200: { content: { 'application/json': infer B } } } } ? B
  : T extends { responses: { 201: { content: { 'application/json': infer B } } } } ? B : never;

export type Status = Json<paths['/api/assistant/status']['get']>;
export type Choices = Status['composer_choices'];
export type Connection = Choices['connections'][number];
export type Session = Json<paths['/api/assistant/sessions']['post']>;
export type ChatPage = Json<paths['/api/assistant/sessions/browse']['get']>;
export type Chat = ChatPage['sessions'][number];
export type Detail = Json<paths['/api/assistant/sessions/{session_id}']['get']>;
export type Message = Detail['messages'][number];
export type TurnChoices = Detail['turn_choices'][number];
export type TurnFailure = NonNullable<TurnChoices['failure']>;
export type Exported = Json<paths['/api/assistant/sessions/{session_id}/export']['get']>;
/** What a conversation was fixed to: readable, unreadable, or never recorded (`null`). */
export type Bound = Session['choices'];

/** A request as recorded, readable. */
export type Requested = components['schemas']['AssistantRequested'];
/** A stored value the engine could not read, said so rather than dropped. */
export type Unreadable = components['schemas']['AssistantUnreadable'];

/** What the composer sends for a new conversation: exactly `assistant_choices.validate`'s five keys. */
export type ChoiceRequest = {
  version: 1;
  runtime: 'claude_cli' | 'codex_cli' | 'api_key';
  provider: string;
  model: string | null;
  effort: string | null;
};

/** One frame of a turn, as `send_assistant_message` publishes it. */
export interface TurnEvent {
  type: string;
  text?: string;
  message?: string;
  tool_name?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  request_id?: string;
  session_id?: number;
  user_message_id?: number;
  requested?: TurnChoices['requested'];
  reported?: { model: string; source: string; observed_at_utc: string; sequence?: number; name?: string };
  /** On an error: `cli_auth` (sign in), `stopped`, or `failed`. */
  code?: string;
  cost_usd?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

export const ask = {
  status: (): Promise<Status> => answer(engine().GET('/api/assistant/status')),

  browse: (q: string, cursor?: { through: number; before: number }): Promise<ChatPage> =>
    answer(engine().GET('/api/assistant/sessions/browse', {
      params: { query: { q, ...(cursor ? { through_id: cursor.through, before_id: cursor.before } : {}) } },
    })),

  detail: async (id: number, signal?: AbortSignal): Promise<Detail> => {
    const body = await answer(engine().GET('/api/assistant/sessions/{session_id}', {
      params: { path: { session_id: id } }, signal,
    }));
    // A reply about another conversation is not drawn under this one's title.
    if (body.session.id !== id) throw new EngineError(0, 'The engine answered about a different conversation.');
    return body;
  },

  create: (choices: ChoiceRequest | null): Promise<Session> =>
    answer(engine().POST('/api/assistant/sessions', { body: choices ? { choices } : {} })),

  remove: (id: number) => answer(engine().DELETE('/api/assistant/sessions/{session_id}', {
    params: { path: { session_id: id } },
  })),

  cancel: (id: number) => answer(engine().POST('/api/assistant/sessions/{session_id}/cancel', {
    params: { path: { session_id: id } },
  })),

  answerCard: (requestId: string, allow: boolean) => answer(engine().POST('/api/assistant/permissions/{request_id}', {
    params: { path: { request_id: requestId } }, body: { allow },
  })),

  exportFile: (id: number, format: 'json' | 'markdown'): Promise<Exported> =>
    answer(engine().GET('/api/assistant/sessions/{session_id}/export', {
      params: { path: { session_id: id }, query: { format } },
    })),

  /**
   * Send one message and read the turn's events until the engine ends the
   * stream. Resolves on the stream's end, whatever the turn did; a refusal
   * before the stream starts (409 while another turn holds the conversation,
   * a configuration that changed) is thrown with the engine's own sentence.
   */
  turn: async (id: number, body: { text: string; legacy_adoption?: { choices: ChoiceRequest; confirmed: true } },
    onEvent: (event: TurnEvent) => void, signal: AbortSignal): Promise<void> => {
    const port = bridge()?.getBackendPort() ?? '';
    if (!port) throw new EngineError(0, 'This window has no backend connection yet.');
    const token = bridge()?.getApiToken();
    const response = await fetch(`http://127.0.0.1:${port}/api/assistant/sessions/${id}/messages`, {
      method: 'POST', signal, cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
      const said: unknown = await response.json().catch(() => null);
      throw new EngineError(response.status, `The engine refused that message (HTTP ${response.status})`, engineSentence(said));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = frames(buffer);
      buffer = rest;
      events.forEach(onEvent);
    }
  },
};

/**
 * The complete frames in what has arrived so far, and the partial one left
 * over. Heartbeats (`: heartbeat`) and anything that is not JSON are dropped:
 * a malformed frame is not drawn into a conversation.
 */
export function frames(buffer: string): { events: TurnEvent[]; rest: string } {
  const chunks = buffer.split('\n\n');
  const rest = chunks.pop() ?? '';
  const events: TurnEvent[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event: unknown = JSON.parse(line.slice(6));
        if (event && typeof event === 'object' && typeof (event as TurnEvent).type === 'string') events.push(event as TurnEvent);
      } catch { /* a partial or malformed frame is dropped */ }
    }
  }
  return { events, rest };
}
