import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { EngineError } from '../../api/client';
import { ask, type ChoiceRequest, type Status } from './askApi';
import { applyEvent, firstChoice, startLive, type Live } from './askModel';

export const STATUS_KEY = ['ask', 'status'] as const;
export const CHATS_KEY = ['ask', 'chats'] as const;
export const chatKey = (id: number) => ['ask', 'chat', id] as const;

/** A failure, and the conversation it belongs to (`null`: the one not yet started). */
interface Failure { session: number | null; text: string }

interface AskValue {
  status: UseQueryResult<Status>;
  /** The conversation open on the Ask screen; `null` is a new one, not yet started. */
  selected: number | null;
  select: (id: number | null) => void;
  /** The choices a new conversation will be fixed to when its first message is sent. */
  draft: ChoiceRequest | null;
  setDraft: (choice: ChoiceRequest) => void;
  /** The turn running now, in whichever conversation it belongs to. */
  live: Live | null;
  answering: boolean;
  stopping: boolean;
  failure: Failure | null;
  send: (text: string, adopt?: ChoiceRequest) => Promise<void>;
  answerCard: (requestId: string, allow: boolean) => Promise<void>;
  stop: () => Promise<void>;
  remove: (id: number) => Promise<void>;
  /** Bumped by ⌘/ (Ctrl+/), so the Ask screen puts the caret in the composer. */
  focusTick: number;
  requestFocus: () => void;
}

const AskContext = createContext<AskValue | null>(null);

const sentence = (error: unknown): string =>
  (error instanceof EngineError && error.detail) || (error instanceof Error ? error.message : String(error));

/**
 * The assistant's state, held above the screens.
 *
 * **Above, because a turn outlives the screen.** A turn is one HTTP response
 * the engine streams for as long as the runtime works, and an approval card
 * is the engine holding the runtime until someone answers. Held in the Ask
 * screen, leaving it to look at a watch would close the stream mid-answer,
 * and the engine denies a card nobody is listening for. Here, the answer goes
 * on while Ask is not on screen, and is there when it is.
 *
 * **One turn at a time.** The engine refuses a second turn on a conversation
 * that is answering; this refuses a second turn anywhere, because the window
 * has one composer and one place to put an approval card.
 */
export function AskProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: ask.status });
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraftState] = useState<ChoiceRequest | null>(null);
  const seeded = useRef(false);
  const [live, setLive] = useState<Live | null>(null);
  const [answering, setAnswering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  // Claimed synchronously, before React can draw a disabled Send.
  const turn = useRef<{ id: number | null; stopping: boolean } | null>(null);
  const liveRef = useRef<Live | null>(null);

  useEffect(() => {
    const choices = status.data?.composer_choices;
    if (seeded.current || !choices) return;
    seeded.current = true;
    setDraftState(firstChoice(choices));
  }, [status.data]);

  const setDraft = useCallback((choice: ChoiceRequest) => {
    seeded.current = true;
    setDraftState(choice);
  }, []);

  const select = useCallback((id: number | null) => {
    setSelected(id);
    setFailure((f) => (f && f.session === id ? f : null));
  }, []);

  const update = (change: (current: Live) => Live) => {
    setLive((current) => {
      const next = current ? change(current) : current;
      liveRef.current = next;
      return next;
    });
  };

  const send = useCallback(async (text: string, adopt?: ChoiceRequest) => {
    const message = text.trim();
    if (!message || turn.current) return;
    const mine = { id: selected, stopping: false };
    turn.current = mine;
    setAnswering(true);
    setStopping(false);
    setFailure(null);
    let id = selected;
    try {
      if (id === null) {
        const made = await ask.create(draft);
        id = made.id;
        mine.id = id;
        setSelected(id);
        void client.invalidateQueries({ queryKey: CHATS_KEY });
      }
      const started = startLive(id, message);
      liveRef.current = started;
      setLive(started);
      // Stopped while the conversation was being made: nothing was sent.
      if (mine.stopping) return;
      const controller = new AbortController();
      const at = id;
      await ask.turn(at, { text: message, ...(adopt ? { legacy_adoption: { choices: adopt, confirmed: true as const } } : {}) },
        (event) => update((current) => (current.session === at ? applyEvent(current, event) : current)), controller.signal);
    } catch (error) {
      if (liveRef.current) update((current) => ({ ...current, error: sentence(error) }));
      else setFailure({ session: id, text: sentence(error) });
    } finally {
      // The engine's saved copy replaces what was drawn live, so the live copy
      // is dropped only once the saved one is in hand: never a blank between.
      if (id !== null) {
        await client.fetchQuery({ queryKey: chatKey(id), queryFn: () => ask.detail(id as number), staleTime: 0 }).catch(() => undefined);
      }
      const ended = liveRef.current;
      if (ended?.error) setFailure({ session: ended.session, text: ended.error });
      liveRef.current = null;
      setLive(null);
      turn.current = null;
      setAnswering(false);
      setStopping(false);
      void client.invalidateQueries({ queryKey: CHATS_KEY });
    }
  }, [client, draft, selected]);

  const answerCard = useCallback(async (requestId: string, allow: boolean) => {
    if (!turn.current || turn.current.stopping) return;
    update((current) => ({ ...current, cards: current.cards.filter((c) => c.requestId !== requestId) }));
    try {
      await ask.answerCard(requestId, allow);
    } catch (error) {
      update((current) => ({ ...current, error: sentence(error) }));
    }
  }, []);

  const stop = useCallback(async () => {
    const mine = turn.current;
    if (!mine || mine.stopping) return;
    mine.stopping = true;
    setStopping(true);
    if (mine.id === null) return; // the create settles first, and cancels then
    try {
      await ask.cancel(mine.id);
      // A cancel request is not proof the runtime stopped: the stream stays
      // open until the engine ends it, and the turn is over only then.
    } catch (error) {
      mine.stopping = false;
      setStopping(false);
      update((current) => ({ ...current, error: sentence(error) }));
    }
  }, []);

  const remove = useCallback(async (id: number) => {
    if (turn.current?.id === id) {
      setFailure({ session: id, text: 'Stop the answer before deleting this conversation.' });
      return;
    }
    try {
      await ask.remove(id);
      client.removeQueries({ queryKey: chatKey(id) });
      setSelected((current) => (current === id ? null : current));
      void client.invalidateQueries({ queryKey: CHATS_KEY });
    } catch (error) {
      setFailure({ session: id, text: sentence(error) });
    }
  }, [client]);

  const requestFocus = useCallback(() => setFocusTick((n) => n + 1), []);

  const value = useMemo<AskValue>(() => ({
    status, selected, select, draft, setDraft, live, answering, stopping, failure,
    send, answerCard, stop, remove, focusTick, requestFocus,
  }), [status, selected, select, draft, setDraft, live, answering, stopping, failure, send, answerCard, stop, remove, focusTick, requestFocus]);

  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}

export function useAsk(): AskValue {
  const value = useContext(AskContext);
  if (!value) throw new Error('useAsk needs an AskProvider above it');
  return value;
}
