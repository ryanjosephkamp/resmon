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
  error: string | null;
  send: (text: string) => Promise<void>;
  answerPermission: (requestId: string, allow: boolean) => Promise<void>;
  newSession: () => Promise<void>;
  openSession: (id: number) => Promise<void>;
  deleteSession: (id: number) => Promise<void>;
  cancel: () => Promise<void>;
}

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
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
    try {
      const body = await apiClient.get<{ sessions: AssistantSessionSummary[] }>(
        '/api/assistant/sessions',
      );
      setSessions(body.sessions || []);
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
    setError(null);
    try {
      const session = await apiClient.post<{ id: number }>('/api/assistant/sessions', {});
      setSessionId(session.id);
      setMessages([]);
      setPending([]);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshSessions]);

  const openSession = useCallback(async (id: number) => {
    setError(null);
    try {
      const body = await apiClient.get<{ messages: AssistantMessage[] }>(
        `/api/assistant/sessions/${id}`,
      );
      setSessionId(id);
      setMessages(body.messages || []);
      setPending([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const deleteSession = useCallback(async (id: number) => {
    await apiClient.delete(`/api/assistant/sessions/${id}`);
    if (id === sessionId) {
      setSessionId(null);
      setMessages([]);
    }
    await refreshSessions();
  }, [sessionId, refreshSessions]);

  const answerPermission = useCallback(async (requestId: string, allow: boolean) => {
    // Removed from `pending` first: the backend answers immediately and the
    // card must not be tappable twice, which the backend refuses anyway (409).
    setPending((cards) => cards.filter((card) => card.request_id !== requestId));
    try {
      await apiClient.post(`/api/assistant/permissions/${requestId}`, { allow });
    } catch {
      /* Already answered or expired. The transcript will show what happened. */
    }
  }, []);

  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    if (sessionId !== null) {
      try {
        await apiClient.post(`/api/assistant/sessions/${sessionId}/cancel`);
      } catch { /* nothing was running */ }
    }
    setPending([]);
    setAnswering(false);
  }, [sessionId]);

  const applyEvent = useCallback((event: any) => {
    switch (event.type) {
      case 'text_delta':
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, content: last.content + event.text };
          } else {
            next.push({ role: 'assistant', content: event.text, streaming: true });
          }
          return next;
        });
        break;
      case 'tool_call':
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          const call: AssistantToolCall = {
            name: event.tool_name,
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
        setPending((cards) => [...cards, {
          request_id: event.request_id,
          tool_name: event.tool_name,
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

    let id = sessionId;
    if (id === null) {
      const session = await apiClient.post<{ id: number }>('/api/assistant/sessions', {});
      id = session.id;
      setSessionId(id);
    }

    setError(null);
    setAnswering(true);
    setMessages((current) => [...current, { role: 'user', content: trimmed }]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`${getBaseUrl()}/api/assistant/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
        signal: controller.signal,
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
              applyEvent(JSON.parse(line.slice(6)));
            } catch { /* a partial or malformed frame is dropped */ }
          }
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setMessages((current) => current.map((m) => (
        m.streaming ? { ...m, streaming: false } : m
      )));
    } finally {
      setAnswering(false);
      abortRef.current = null;
      setPending([]);
      void refreshSessions();
    }
  }, [sessionId, applyEvent, refreshSessions]);

  const value = useMemo<AssistantContextValue>(() => ({
    isOpen, setOpen, status, statusLoaded, refreshStatus,
    sessions, sessionId, messages, pending, isAnswering, error,
    send, answerPermission, newSession, openSession, deleteSession, cancel,
  }), [isOpen, status, statusLoaded, refreshStatus, sessions, sessionId, messages,
    pending, isAnswering, error, send, answerPermission, newSession, openSession,
    deleteSession, cancel]);

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
};

export function useAssistant(): AssistantContextValue {
  const context = useContext(AssistantContext);
  if (!context) throw new Error('useAssistant must be used inside an AssistantProvider');
  return context;
}
