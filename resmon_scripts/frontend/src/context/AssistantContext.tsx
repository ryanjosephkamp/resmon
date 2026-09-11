import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { apiClient, getBaseUrl } from '../api/client';

/**
 * The assistant panel's state, and the one place that talks to the backend.
 *
 * Two things here are not the obvious choice, and both have a reason.
 *
 * **The turn is read with `fetch` and a stream reader, not `EventSource`.**
 * `EventSource` can only issue a GET, and a turn carries the user's message in
 * a body. The reader loop below is the price of that.
 *
 * **A permission card is state, not a notification.** It sits in `pending`
 * until it is answered, because the backend is holding an HTTP request open and
 * a real `claude` process is blocked behind it. Dismissing the card without
 * answering would leave that process waiting for the backend's timeout, so the
 * panel has no dismiss — only Allow and Deny.
 */

export interface AssistantMessage {
  id?: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tool_calls?: AssistantToolCall[] | null;
  tool_results?: unknown[] | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  created_at?: string;
  /** Set while the turn is still streaming; never persisted. */
  streaming?: boolean;
}

export interface AssistantToolCall {
  name: string;
  input?: Record<string, unknown>;
  tool_use_id?: string | null;
  /** 'ok' | 'error' once a result has come back. */
  outcome?: 'ok' | 'error';
}

export interface AssistantSessionSummary {
  id: number;
  title: string;
  runtime: string;
  updated_at: string;
  message_count?: number;
  cost_usd?: number | null;
}

export interface PermissionCard {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export interface AssistantStatus {
  available: boolean;
  reason: string;
  runtime?: { kind: string; path?: string | null; how?: string | null };
  model?: string | null;
  effort?: string | null;
  contract_version?: string;
  others?: { kind: string; installed?: boolean; available: boolean; reason: string }[];
}

interface AssistantContextValue {
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  status: AssistantStatus | null;
  statusLoaded: boolean;
  refreshStatus: () => Promise<void>;
  sessions: AssistantSessionSummary[];
  sessionId: number | null;
  messages: AssistantMessage[];
  pending: PermissionCard[];
  isAnswering: boolean;
  isSelecting: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  answerPermission: (requestId: string, allow: boolean) => Promise<void>;
  newSession: () => Promise<void>;
  openSession: (id: number) => Promise<void>;
  deleteSession: (id: number) => Promise<void>;
  cancel: () => Promise<void>;
}

interface ActiveTurn { id: number | null; stopping: boolean; permissions: Set<string>; cancellation?: Promise<unknown> }

const AssistantContext = createContext<AssistantContextValue | undefined>(undefined);

/** Short name for a tool the panel shows: `mcp__resmon__run_sweep` → `run_sweep`. */
export function shortToolName(raw: string): string {
  return raw.startsWith('mcp__') ? raw.split('__').slice(-1)[0] : raw;
}

/** The sentence a permission card leads with, in the app's words not the tool's. */
export function describeToolCall(rawName: string, input: Record<string, unknown>): string {
  const name = shortToolName(rawName);
  const id = (key: string) => (input?.[key] === undefined ? '' : ` ${String(input[key])}`);
  switch (name) {
    case 'run_sweep':
      return 'Search your sources now and store what comes back';
    case 'create_routine':
      return `Create a monitoring routine${input?.name ? ` called “${String(input.name)}”` : ''}, switched off`;
    case 'run_routine':
      return `Run routine${id('routine_id')} now, outside its schedule`;
    case 'activate_routine':
      return `Put routine${id('routine_id')} on its schedule`;
    case 'deactivate_routine':
      return `Take routine${id('routine_id')} off its schedule`;
    case 'update_settings':
      return `Change your ${String(input?.group ?? '')} settings`;
    default:
      // Never invent a sentence for a tool this list does not know. The exact
      // call is rendered underneath either way, so an unknown tool degrades to
      // "here is precisely what it would run" rather than to a plausible
      // description of something else.
      return `Run ${name}`;
  }
}

export const AssistantProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isOpen, setOpen] = useState(false);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [sessions, setSessions] = useState<AssistantSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [pending, setPending] = useState<PermissionCard[]>([]);
  const [isAnswering, setAnswering] = useState(false);
  const [isSelecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refs claim ownership synchronously, before React can paint a disabled button.
  const selected = useRef<number | null>(null);
  const selectionEpoch = useRef(0);
  const selectionBusy = useRef(false);
  const deleting = useRef(new Set<number>());
  const active = useRef<ActiveTurn | null>(null);
  const blocked = 'Finish or stop the current answer before continuing another chat.';
  const sessionsEpoch = useRef(0);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await apiClient.get<AssistantStatus>('/api/assistant/status'));
    } catch {
      setStatus({ available: false, reason: 'resmon is not answering right now.' });
    } finally {
      setStatusLoaded(true);
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    const epoch = ++sessionsEpoch.current;
    try {
      const body = await apiClient.get<{ sessions: AssistantSessionSummary[] }>(
        '/api/assistant/sessions',
      );
      if (epoch === sessionsEpoch.current) setSessions(body.sessions || []);
    } catch {
      /* the list is a convenience; a failure here must not break the panel */
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (isOpen) {
      void refreshStatus();
      void refreshSessions();
    }
  }, [isOpen, refreshStatus, refreshSessions]);

  // ⌘/ (Ctrl+/ elsewhere) toggles the panel, matching the trigger's tooltip.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((open) => !open);
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const newSession = useCallback(async () => {
    if (active.current) { setError(blocked); return; }
    const epoch = ++selectionEpoch.current;
    selectionBusy.current = true;
    setSelecting(true);
    setError(null);
    try {
      const session = await apiClient.post<{ id: number }>('/api/assistant/sessions', {});
      if (epoch !== selectionEpoch.current || active.current) return;
      selected.current = session.id;
      setSessionId(session.id);
      setMessages([]);
      setPending([]);
      void refreshSessions();
    } catch (err) {
      if (epoch === selectionEpoch.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (epoch === selectionEpoch.current) { selectionBusy.current = false; setSelecting(false); }
    }
  }, [refreshSessions]);

  const openSession = useCallback(async (id: number) => {
    if (active.current) {
      if (active.current.id === id) setOpen(true);
      else setError(blocked);
      return;
    }
    if (deleting.current.has(id)) return;
    const epoch = ++selectionEpoch.current;
    selectionBusy.current = true;
    setSelecting(true);
    setError(null);
    try {
      const body = await apiClient.get<{ session?: { id: number }; messages: AssistantMessage[];
        activity_observation?: { turn_claimed: boolean } }>(`/api/assistant/sessions/${id}`);
      if (epoch !== selectionEpoch.current || active.current) return;
      if (body.session && body.session.id !== id) throw new Error('The conversation response did not match.');
      selected.current = id;
      setSessionId(id);
      setMessages(body.messages || []);
      setPending([]);
      setOpen(true);
      if (body.activity_observation?.turn_claimed) {
        setError('This conversation is already answering in another renderer. Its live stream cannot be reopened here.');
      }
    } catch (err) {
      if (epoch === selectionEpoch.current) {
        selected.current = null;
        setSessionId(null);
        setMessages([]);
        setPending([]);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (epoch === selectionEpoch.current) { selectionBusy.current = false; setSelecting(false); }
    }
  }, []);

  const deleteSession = useCallback(async (id: number) => {
    if (active.current?.id === id || selectionBusy.current) { setError(blocked); return; }
    if (deleting.current.has(id)) return;
    deleting.current.add(id);
    const epoch = selectionEpoch.current;
    try {
      await apiClient.delete(`/api/assistant/sessions/${id}`);
      if (selected.current === id && epoch === selectionEpoch.current) {
        ++selectionEpoch.current;
        selected.current = null;
        setSessionId(null);
        setMessages([]);
      }
      void refreshSessions();
    } catch (err) {
      if (epoch === selectionEpoch.current) setError(err instanceof Error ? err.message : String(err));
    } finally { deleting.current.delete(id); }
  }, [refreshSessions]);

  const answerPermission = useCallback(async (requestId: string, allow: boolean) => {
    const turn = active.current;
    if (!turn || turn.stopping || !turn.permissions.delete(requestId)) return;
    setPending((cards) => cards.filter((card) => card.request_id !== requestId));
    try {
      await apiClient.post(`/api/assistant/permissions/${requestId}`, { allow });
    } catch (err) {
      if (active.current === turn) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const cancel = useCallback(async () => {
    const turn = active.current;
    if (!turn || turn.stopping) return;
    turn.stopping = true;
    if (turn.id === null) return; // Creation settles before this turn is released.
    try {
      turn.cancellation = apiClient.post(`/api/assistant/sessions/${turn.id}/cancel`);
      await turn.cancellation;
    } catch (err) {
      if (active.current === turn) {
        turn.stopping = false;
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    // A cancellation request is not proof the server stopped. Keep ownership
    // and the reader until stream_end/EOF, then refresh the persisted rows.
  }, []);

  const applyEvent = useCallback((event: {
    type: string; text?: string; tool_name?: string; input?: Record<string, unknown>;
    tool_use_id?: string; is_error?: boolean; message?: string; request_id?: string;
    cost_usd?: number | null; input_tokens?: number | null; output_tokens?: number | null;
  }) => {
    switch (event.type) {
      case 'text_delta':
        if (typeof event.text !== 'string') return;
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, content: last.content + event.text };
          } else {
            next.push({ role: 'assistant', content: event.text || '', streaming: true });
          }
          return next;
        });
        break;
      case 'tool_call':
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          const call: AssistantToolCall = {
            name: event.tool_name || 'Unknown tool',
            input: event.input,
            tool_use_id: event.tool_use_id,
          };
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = {
              ...last, tool_calls: [...(last.tool_calls || []), call],
            };
          } else {
            next.push({ role: 'assistant', content: '', streaming: true, tool_calls: [call] });
          }
          return next;
        });
        break;
      case 'tool_result':
        setMessages((current) => current.map((message) => {
          if (!message.streaming || !message.tool_calls) return message;
          return {
            ...message,
            tool_calls: message.tool_calls.map((call) => (
              call.tool_use_id === event.tool_use_id
                ? { ...call, outcome: event.is_error ? 'error' : 'ok' }
                : call
            )),
          };
        }));
        break;
      case 'notice':
        // Something resmon needs to say about the conversation itself — today,
        // only that the CLI lost it and a fresh session answered instead. A
        // system line in the transcript rather than the error banner, because
        // it is not an error: the turn carries on underneath it, and the banner
        // is cleared by the next thing that happens.
        setMessages((current) => [...current, {
          role: 'system', content: String(event.message || ''),
        }]);
        break;
      case 'permission_request':
        if (!event.request_id || !active.current || active.current.stopping) return;
        active.current.permissions.add(event.request_id);
        setPending((cards) => [...cards, {
          request_id: event.request_id!,
          tool_name: event.tool_name || 'Unknown tool',
          input: event.input || {},
        }]);
        break;
      case 'done':
        setMessages((current) => current.map((message) => (
          message.streaming
            ? {
              ...message,
              streaming: false,
              cost_usd: event.cost_usd ?? null,
              input_tokens: event.input_tokens ?? null,
              output_tokens: event.output_tokens ?? null,
            }
            : message
        )));
        break;
      case 'error':
        setError(event.message || 'Something went wrong.');
        setMessages((current) => current.map((m) => (
          m.streaming ? { ...m, streaming: false } : m
        )));
        break;
      default:
        // Unknown event types are dropped rather than rendered. The backend
        // already drops what the CLI emits and the panel does not recognise;
        // this is the same rule applied one layer later, so a future backend
        // cannot render raw JSON into a chat window.
        break;
    }
  }, []);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (active.current || selectionBusy.current || (selected.current !== null && deleting.current.has(selected.current))) return;
    const turn: ActiveTurn = { id: selected.current, stopping: false, permissions: new Set<string>() };
    active.current = turn;
    ++selectionEpoch.current;
    setError(null);
    setAnswering(true);
    try {
      if (turn.id === null) {
        const session = await apiClient.post<{ id: number }>('/api/assistant/sessions', {});
        turn.id = session.id;
        selected.current = session.id;
        setSessionId(session.id);
      }
      if (turn.stopping) return;
      const id = turn.id;
      setMessages((current) => [...current, { role: 'user', content: trimmed }]);
      const response = await fetch(`${getBaseUrl()}/api/assistant/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!response.ok || !response.body) {
        const detail = await response.text();
        let message = detail;
        try {
          const parsed = JSON.parse(detail);
          if (parsed?.detail) message = parsed.detail;
        } catch { /* keep the raw text */ }
        throw new Error(message || 'resmon refused that message.');
      }

      if (turn.stopping) await apiClient.post(`/api/assistant/sessions/${id}/cancel`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        for (const chunk of chunks) {
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              if (active.current === turn) applyEvent(JSON.parse(line.slice(6)));
            } catch { /* a partial or malformed frame is dropped */ }
          }
        }
      }
    } catch (err) {
      if (active.current === turn && !(err instanceof Error && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setMessages((current) => current.map((m) => (
        m.streaming ? { ...m, streaming: false } : m
      )));
    } finally {
      if (active.current === turn) {
        // A delayed cancellation request must finish before another turn on
        // this ID can start, even when the old stream has already ended.
        await turn.cancellation?.catch(() => {});
        try {
          if (turn.id !== null) {
            const body = await apiClient.get<{ session?: { id: number }; messages: AssistantMessage[] }>(
              `/api/assistant/sessions/${turn.id}`);
            if (active.current === turn && Array.isArray(body.messages) && (!body.session || body.session.id === turn.id)) setMessages(body.messages);
          }
        } catch { /* Keep the observed text when the persisted read is unavailable. */ }
        active.current = null;
        setAnswering(false);
        setPending([]);
        void refreshSessions();
      }
    }
  }, [applyEvent, refreshSessions]);

  const value = useMemo<AssistantContextValue>(() => ({
    isOpen, setOpen, status, statusLoaded, refreshStatus,
    sessions, sessionId, messages, pending, isAnswering, isSelecting, error,
    send, answerPermission, newSession, openSession, deleteSession, cancel,
  }), [isOpen, status, statusLoaded, refreshStatus, sessions, sessionId, messages,
    pending, isAnswering, isSelecting, error, send, answerPermission, newSession, openSession,
    deleteSession, cancel]);

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
};

export function useAssistant(): AssistantContextValue {
  const context = useContext(AssistantContext);
  if (!context) throw new Error('useAssistant must be used inside an AssistantProvider');
  return context;
}
