import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { download } from '../library/libraryApi';
import { CliSignIn } from '../settings/CliSignIn';
import { listFor, useModelList } from '../settings/ModelField';
import { LAST_ANSWERED_KEY, lastFor, modelOptionWords, readLastAnswered } from '../settings/modelWords';
import { refusal } from '../settings/ProviderKey';
import { effortsFor } from '../settings/summaryLanes';
import { ask, type Bound, type ChoiceRequest, type Choices, type Detail, type Message, type TurnChoices, type TurnFailure } from './askApi';
import {
  answerFooterWords, answeredWords, basisWords, callText, choiceProblem, connectionKey, connectionOf, costWords, describeCall,
  failureTitle, providerWords, reportWords, requestedWords, savedCalls, shortToolName, type Card, type LiveCall, type LiveMessage,
} from './askModel';
import { CHATS_KEY, STATUS_KEY, chatKey, useAsk } from './AskProvider';

const WHEN = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** SQLite's `datetime('now')` is UTC with no zone marker; read it as UTC. */
function when(stamp: string | null | undefined): string {
  if (!stamp) return 'time not recorded';
  const at = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : `${stamp.replace(' ', 'T')}Z`);
  return Number.isNaN(at.getTime()) ? stamp : WHEN.format(at);
}

/**
 * Ask: the assistant, and every conversation kept with it.
 *
 * The rail is the saved conversations, newest first; the rest of the screen
 * is the one open. A new conversation is fixed to a connection, a model and
 * an effort when its first message is sent, and keeps them whatever the
 * defaults do afterwards. Anything that would change resmon waits behind a
 * card that shows the exact call, and nothing runs until it is answered.
 *
 * The screen is exactly the window's height: the transcript scrolls inside it
 * and the composer stays put, so Send is never below the edge.
 */
export function Ask() {
  const { selected, select, answering } = useAsk();
  return (
    <section className="page page-ask" aria-labelledby="page-title">
      <div className="conv-layout">
        <Rail selected={selected} onSelect={select} answering={answering} />
        <Pane />
      </div>
    </section>
  );
}

function Rail({ selected, onSelect, answering }: { selected: number | null; onSelect: (id: number | null) => void; answering: boolean }) {
  const [q, setQ] = useState('');
  const chats = useInfiniteQuery({
    queryKey: [...CHATS_KEY, q],
    queryFn: ({ pageParam }) => ask.browse(q, pageParam),
    initialPageParam: undefined as { through: number; before: number } | undefined,
    getNextPageParam: (last) => (last.has_more && last.next_before_id !== null && last.next_before_id !== undefined
      ? { through: last.through_id, before: last.next_before_id } : undefined),
  });
  const rows = chats.data?.pages.flatMap((page) => page.sessions) ?? [];
  return (
    <section className="conv-rail" aria-label="Saved chats" aria-busy={chats.isPending}>
      <div className="conv-rail-head">
        <h1 id="page-title" className="page-title">Ask</h1>
        <button type="button" className="btn sm" onClick={() => onSelect(null)} aria-pressed={selected === null}>
          New conversation
        </button>
      </div>
      <input
        className="conv-filter" type="search" value={q} maxLength={200} onChange={(e) => setQ(e.target.value)}
        aria-label="Filter saved titles" placeholder="Filter by title"
      />
      {chats.isPending && <p className="conv-quiet" role="status">Reading the saved conversations…</p>}
      {chats.isError && <p className="field-error" role="alert">The engine did not list the conversations ({chats.error.message}).</p>}
      {chats.isSuccess && rows.length === 0 && (
        <p className="conv-quiet">{q ? 'No saved title contains that text.' : 'No conversations yet. Each one you have here is kept.'}</p>
      )}
      <ol className="conv-list">
        {rows.map((chat) => (
          <li key={chat.id}>
            <button type="button" className="conv-row" aria-pressed={chat.id === selected} onClick={() => onSelect(chat.id)}>
              <strong>{chat.title}</strong>
              <span className="conv-quiet">
                {when(chat.updated_at)} · {chat.message_count} saved {chat.message_count === 1 ? 'message' : 'messages'}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {chats.hasNextPage && (
        <button type="button" className="btn quiet sm" disabled={chats.isFetchingNextPage} onClick={() => void chats.fetchNextPage()}>
          Older conversations
        </button>
      )}
      {answering && <p className="conv-quiet conv-rail-note">One answer runs at a time.</p>}
    </section>
  );
}

function Pane() {
  const { selected, status, live, answering, failure } = useAsk();
  // Read again on every arrival: whether a connection can run changes in
  // Settings → AI and in the keychain, and neither tells this screen.
  useQuery({ queryKey: STATUS_KEY, queryFn: ask.status, refetchOnMount: 'always' });
  const detail = useQuery({
    queryKey: chatKey(selected ?? 0),
    queryFn: ({ signal }) => ask.detail(selected as number, signal),
    enabled: selected !== null,
  });
  const mine = live && live.session === selected ? live : null;
  const shown = selected === null ? null : detail.data ?? null;
  // A failure the engine kept with its turn is drawn there, under the message
  // it failed to answer, and is not said a second time above the composer.
  const kept = !!failure?.turn && !!shown?.turn_choices.some((t) => t.user_message_id === failure.turn && t.failure);
  const fault = mine?.error ?? (failure && failure.session === selected && !kept ? failure.text : null);
  const busyElsewhere = answering && !mine && !(selected === null && live === null);

  // The transcript follows its newest line, as long as the reader has not
  // scrolled up to read something earlier; a card always brings it down,
  // because the runtime is waiting on it.
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const cards = useRef(0);
  const last = mine?.messages[mine.messages.length - 1];
  const growth = [selected, shown?.snapshot.message_count, mine?.messages.length, last?.text.length, last?.calls.length, fault].join('|');
  useLayoutEffect(() => { following.current = true; }, [selected]);
  useLayoutEffect(() => {
    const el = log.current;
    const card = (mine?.cards.length ?? 0) > cards.current;
    cards.current = mine?.cards.length ?? 0;
    if (el && (following.current || card)) el.scrollTop = el.scrollHeight;
  }, [growth, mine?.cards.length]);
  const onScroll = () => {
    const el = log.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  return (
    <section className="conv-pane" aria-label="Conversation">
      {/* Keyed by conversation, so a confirmation or a notice never carries over to another one. */}
      <Header key={`head-${selected ?? 'new'}`} detail={shown} />
      <div className="conv-log" aria-label="Transcript" role="log" ref={log} onScroll={onScroll}>
        {selected !== null && detail.isPending && <p className="conv-quiet" role="status">Reading the conversation…</p>}
        {detail.isError && selected !== null && (
          <p className="field-error" role="alert">The engine did not return this conversation ({detail.error.message}).</p>
        )}
        {selected === null && !mine && <Empty />}
        {shown && <Saved detail={shown} />}
        {mine && <LiveTurn messages={mine.messages} turns={mine.turns} cards={mine.cards} />}
        {mine && <p className="conv-working" role="status">Working…</p>}
      </div>
      <Composer key={`compose-${selected ?? 'new'}`} detail={shown} statusError={status.isError ? status.error.message : null}>
        {fault && <p className="conv-error" role="alert">{fault}</p>}
        {busyElsewhere && <p className="conv-note">Another conversation is answering. Finish or stop it before sending here.</p>}
      </Composer>
    </section>
  );
}

function Empty() {
  return (
    <div className="conv-empty">
      <p>Ask about your watches, your collection, or what a run found.</p>
      <p className="conv-quiet">
        Everything it tells you comes from resmon itself, through the same tools an outside harness uses.
        Anything that would change something waits for you to allow it.
      </p>
    </div>
  );
}

/** The open conversation's title, what it is fixed to, and what can be done with it. */
function Header({ detail }: { detail: Detail | null }) {
  const { selected, remove, live } = useAsk();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const save = async (format: 'json' | 'markdown') => {
    if (!detail) return;
    setNotice(null);
    try {
      const file = await ask.exportFile(detail.session.id, format);
      if (file.session_id !== detail.session.id) throw new Error('the engine exported a different conversation');
      download(file.text, file.filename, file.content_type);
      setNotice(`Saved as ${file.filename}. It holds the saved messages only.`);
    } catch (error) {
      setNotice(`Not exported: ${error instanceof Error ? error.message : String(error)}.`);
    }
  };
  if (selected === null || !detail) {
    return (
      <header className="conv-head">
        <h2 className="conv-title">{selected === null ? 'New conversation' : 'Conversation'}</h2>
      </header>
    );
  }
  const running = live?.session === detail.session.id;
  return (
    <header className="conv-head">
      <div className="conv-head-row">
        <h2 className="conv-title">{detail.session.title}</h2>
        <div className="conv-actions">
          <button type="button" className="btn sm" onClick={() => void save('markdown')}>Export Markdown</button>
          <button type="button" className="btn sm" onClick={() => void save('json')}>Export JSON</button>
          {!confirming && (
            <button type="button" className="btn quiet sm" disabled={running} onClick={() => setConfirming(true)}>Delete</button>
          )}
          {confirming && (
            <span className="conv-confirm" role="group" aria-label="Confirm delete">
              <span>Delete this conversation and its messages?</span>
              <button type="button" className="btn sm" onClick={() => void remove(detail.session.id)}>Delete it</button>
              <button type="button" className="btn quiet sm" onClick={() => setConfirming(false)}>Keep it</button>
            </span>
          )}
        </div>
      </div>
      <p className="conv-fixed">
        <span className="conv-label">Fixed for this conversation</span>{' '}
        {requestedWords(detail.session.choices, answeredWords(detail.turn_choices))}
      </p>
      <p className="conv-quiet conv-saved">
        {detail.snapshot.message_count} saved {detail.snapshot.message_count === 1 ? 'message' : 'messages'}
        {' '}· Historical completion unknown. resmon keeps what was saved, and does not know whether a turn
        finished or was cut off.
        {detail.activity_observation.turn_claimed && !running && ' It was answering when read, so this copy may be missing its last turn.'}
      </p>
      {notice && <p className="conv-quiet" role="status">{notice}</p>}
    </header>
  );
}

/**
 * The saved transcript: each message as it was stored, each turn's requested
 * and reported choices, and, under a message that got no answer, why not.
 */
function Saved({ detail }: { detail: Detail }) {
  const { answering, failure } = useAsk();
  const turns = useMemo(() => new Map(detail.turn_choices.map((t) => [t.user_message_id, t])), [detail.turn_choices]);
  const answers = useMemo(() => new Map(detail.turn_choices.flatMap((t) => (
    t.assistant_message_id === null ? [] : [[t.assistant_message_id, t] as const]))), [detail.turn_choices]);
  if (!detail.messages.length) return <p className="conv-quiet">No saved messages.</p>;
  const lastUser = [...detail.messages].reverse().find((m) => m.role === 'user')?.id;
  return (
    <ol className="conv-messages">
      {detail.messages.map((message) => {
        const turn = message.role === 'user' ? turns.get(message.id) : undefined;
        return (
          <li key={message.id} className="conv-msg" data-role={message.role}>
            <SavedMessage message={message} turn={message.role === 'assistant' ? answers.get(message.id) : undefined} />
            {turn && <TurnDisclosure turn={turn} />}
            {turn?.failure && (
              <FailedTurn failure={turn.failure} retry={message.id === lastUser && !answering ? message.content : null}
                provider={signInProvider(turn.requested)}
                fresh={failure?.session === detail.session.id && failure.turn === message.id} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function SavedMessage({ message, turn }: { message: Message; turn?: TurnChoices }) {
  const calls = savedCalls(message);
  return (
    <>
      <p className="conv-who">{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'resmon'}</p>
      {message.content && <div className="conv-text">{message.content}</div>}
      {calls === null
        ? <details className="conv-raw"><summary>Saved tool calls (not in a form this version reads)</summary><pre>{JSON.stringify(message.tool_calls, null, 2)}</pre></details>
        : calls.map((call, i) => <CallRow key={call.id ?? i} call={call} live={false} />)}
      {message.tool_results !== null && message.tool_results !== undefined && (
        <details className="conv-raw"><summary>Saved tool results</summary><pre>{JSON.stringify(message.tool_results, null, 2)}</pre></details>
      )}
      {message.role === 'assistant' && <p className="conv-quiet conv-cost">{answerFooterWords(turn, message.cost_usd, message)}</p>}
    </>
  );
}

/** The command whose sign-in a failed turn offers: the one the turn asked for. */
function signInProvider(requested: TurnChoices['requested']): string {
  return requested && 'provider' in requested && requested.provider === 'codex' ? 'codex' : 'claude_code';
}

/**
 * A turn that produced no answer, kept as that and never as the assistant
 * speaking. A sign-in failure offers the command's own sign-in right here; a
 * cost is shown only where the runtime reported one; and what the turn wrote
 * or called before it ended is there to read, under its own name.
 */
function FailedTurn({ failure, retry, provider, fresh }: {
  failure: TurnFailure;
  retry: string | null;
  /** `claude_code` or `codex`: the command the turn ran on. */
  provider: string;
  /** The turn that has just ended here, whose failure is announced as it arrives; an old one is not. */
  fresh: boolean;
}) {
  const { send } = useAsk();
  const calls = Array.isArray(failure.tool_calls) ? (failure.tool_calls as LiveCall[]) : [];
  const partial = failure.partial_text.trim();
  // The command's own words are often the whole of what it wrote, and are
  // already in the message.
  const wrote = partial && !failure.message.includes(partial) ? partial : '';
  return (
    <div className="conv-failed" role="group" aria-label="This turn got no answer" data-code={failure.code}>
      <p className="conv-failed-title">{failureTitle(failure.code)}</p>
      <p className="conv-failed-message" role={fresh ? 'alert' : undefined}>{failure.message}</p>
      {failure.code === 'cli_auth' && <CliSignIn provider={provider} purpose="ask" checkOnOpen={false} />}
      {failure.cost_usd !== null && failure.cost_usd !== undefined && (
        <p className="conv-quiet">{costWords(failure.cost_usd)}</p>
      )}
      {(wrote || calls.length > 0) && (
        <details>
          <summary>What it wrote before it ended</summary>
          {wrote && <div className="conv-text">{wrote}</div>}
          {calls.map((call, i) => <CallRow key={call.id ?? i} call={call} live={false} />)}
        </details>
      )}
      {retry !== null && (
        <button type="button" className="btn sm" onClick={() => void send(retry)}>Try again</button>
      )}
    </div>
  );
}

/** One turn's request and the runtime's own reports, kept as two claims. */
function TurnDisclosure({ turn }: { turn: TurnChoices }) {
  const reported = turn.reported;
  return (
    <details className="conv-turn">
      <summary>What this turn asked for, and what answered</summary>
      <p className="conv-requested"><span className="conv-label">Requested</span> {requestedWords(turn.requested)}</p>
      <p className="conv-quiet">{basisWords(turn.requested)}</p>
      <div className="conv-reported">
        <span className="conv-label">Runtime-reported model</span>
        {Array.isArray(reported)
          ? reported.length ? <ol>{reported.map((r) => <li key={r.sequence}>{reportWords(r)}</li>)}</ol> : ' Not reported.'
          : ' Unreadable.'}
      </div>
      {turn.answered_by && (
        <p className="conv-answered">
          Shown as the answering model: {turn.answered_by.name}, from the report {turn.answered_by.source === 'claude_result_model_usage'
            ? 'of what the answer was billed for' : 'above'}.
        </p>
      )}
      <p className="conv-quiet">
        Each is what was sent or what the runtime said about itself. The runtime does not report the effort it used.
      </p>
    </details>
  );
}

function CallRow({ call, live, held = false }: { call: LiveCall; live: boolean; held?: boolean }) {
  const state = call.outcome ?? (held ? 'held' : live ? 'running' : 'saved');
  const words = { ok: 'answered', error: 'failed', held: 'waiting for your answer', running: 'running', saved: 'called' }[state];
  return (
    <details className="conv-call" data-state={state}>
      <summary>
        <span className="conv-call-mark" aria-hidden="true" />
        <span className="conv-call-name">{shortToolName(call.name)}</span>
        <span className="conv-quiet"> {words}</span>
      </summary>
      <pre>{JSON.stringify(call.input ?? {}, null, 2)}</pre>
    </details>
  );
}

function LiveTurn({ messages, turns, cards }: { messages: LiveMessage[]; turns: TurnChoices[]; cards: Card[] }) {
  return (
    <>
      <ol className="conv-messages">
        {messages.map((message, i) => (
          <li key={i} className="conv-msg" data-role={message.role} data-live="">
            <p className="conv-who">{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'resmon'}</p>
            {message.text && <div className="conv-text">{message.text}</div>}
            {message.calls.map((call, j) => (
              <CallRow key={call.id ?? j} call={call} live held={cards.some((card) => shortToolName(card.tool) === shortToolName(call.name))} />
            ))}
            {message.role === 'user' && turns[0] && <TurnDisclosure turn={turns[0]} />}
          </li>
        ))}
      </ol>
      {cards.map((card) => <ApprovalCard key={card.requestId} card={card} />)}
    </>
  );
}

/**
 * The engine is holding the runtime until this is answered. So there is no
 * dismiss: a card closed without an answer would leave the runtime waiting
 * for the engine's timeout. The call underneath is the exact call, never a
 * paraphrase, because a person can only check what they can read.
 */
function ApprovalCard({ card }: { card: Card }) {
  const { answerCard } = useAsk();
  const [sent, setSent] = useState(false);
  const answerIt = (allow: boolean) => { setSent(true); void answerCard(card.requestId, allow); };
  return (
    <div className="conv-card" role="group" aria-label="Allow this call?">
      <p className="conv-card-title">{describeCall(card.tool, card.input)}</p>
      <pre className="conv-card-call">{callText(card.tool, card.input)}</pre>
      <div className="conv-card-actions">
        <button type="button" className="btn primary sm" disabled={sent} onClick={() => answerIt(true)}>Allow</button>
        <button type="button" className="btn sm" disabled={sent} onClick={() => answerIt(false)}>Deny</button>
      </div>
      <p className="conv-quiet">Nothing runs until you answer. resmon is holding the assistant here.</p>
    </div>
  );
}

/** The composer, and above it the choices a new conversation will be fixed to. */
function Composer({ detail, statusError, children }: { detail: Detail | null; statusError: string | null; children?: ReactNode }) {
  const { selected, status, draft, setDraft, send, stop, answering, stopping, live, focusTick } = useAsk();
  const [text, setText] = useState('');
  const [adopting, setAdopting] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const choices = status.data?.composer_choices;
  const bound: Bound | undefined = detail?.session.choices;
  const legacy = selected !== null && detail !== null && bound === null;
  const unreadable = !!bound && 'unreadable' in bound;
  const fresh = selected === null;
  const mine = live?.session === selected || (fresh && answering && live === null);

  // A bound conversation runs on its own connection, so that is the one whose
  // availability decides whether it can be sent to now.
  const connection = !fresh && bound && !('unreadable' in bound) ? connectionOf(choices, bound) : connectionOf(choices, draft);
  const problem = statusError ? `The engine did not say whether the assistant can run (${statusError}).`
    : !status.data ? null
      : unreadable ? 'This conversation’s saved choices are not in a form this version reads, so it cannot be continued. It can be read and exported.'
        : fresh || legacy ? choiceProblem(choices, draft)
          : connection && !connection.available ? connection.reason : null;
  const disabled = !!problem || !status.data || (answering && !mine);

  // Each ⌘/ puts the caret here once: when it arrives, or as soon as the
  // composer can take it.
  const focused = useRef(0);
  useEffect(() => {
    if (focusTick === focused.current || disabled) return;
    focused.current = focusTick;
    box.current?.focus();
  }, [focusTick, disabled]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (disabled || answering || !text.trim()) return;
    if (legacy && !adopting) { setAdopting(true); return; }
    const message = text;
    setText('');
    setAdopting(false);
    void send(message, legacy && draft ? draft : undefined);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="conv-compose">
      {children}
      {choices && (fresh || legacy) && !mine && (
        <ChoiceControls choices={choices} value={draft} onChange={setDraft} legacy={legacy} />
      )}
      {adopting && draft && (
        <div className="conv-adopt" role="group" aria-label="Continue a conversation saved before choices were kept">
          <p>
            This conversation was saved before resmon kept a conversation’s connection, so what it used is unknown.
            Sending fixes it to {requestedWords({ ...draft, requested_model: draft.model, requested_effort: draft.effort,
              model_basis: 'explicit', effort_basis: 'explicit', binding_basis: 'legacy_confirmed' } as unknown as Bound)} from now on.
            {draft.runtime === 'api_key'
              ? ` The saved text of your messages and its answers will be sent to ${providerWords(draft.provider)}; saved tool results are not.`
              : ` A new ${providerWords(draft.provider)} session starts: it receives your new message, not the earlier conversation.`}
          </p>
          <button type="button" className="btn primary sm" onClick={() => submit()}>Confirm and send</button>
          <button type="button" className="btn quiet sm" onClick={() => setAdopting(false)}>Not now</button>
        </div>
      )}
      {problem && (
        <p className="conv-unavailable">
          {problem}{' '}
          {!unreadable && <Link to="/settings/ai">Open Settings › AI</Link>}
        </p>
      )}
      <form className="conv-composer" onSubmit={submit}>
        <textarea
          ref={box}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          aria-label="Message the assistant"
          aria-keyshortcuts="Meta+Slash Control+Slash"
          placeholder={problem ? 'The assistant cannot be sent to yet' : 'Ask about your monitoring…'}
          disabled={disabled}
        />
        {answering && mine
          ? <button type="button" className="btn sm" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Stopping…' : 'Stop'}</button>
          : <button type="submit" className="btn primary sm" disabled={disabled || answering || !text.trim() || adopting}>Send</button>}
      </form>
    </div>
  );
}

/** The connection, model and effort a conversation will be fixed to. Changing them here changes no default. */
function ChoiceControls({ choices, value, onChange, legacy }: {
  choices: Choices; value: ChoiceRequest | null; onChange: (choice: ChoiceRequest) => void; legacy: boolean;
}) {
  const connection = connectionOf(choices, value);
  const api = value?.runtime === 'api_key';
  const cli = value?.runtime === 'claude_cli';
  const codex = value?.runtime === 'codex_cli';
  // Which model each alias last resolved to, from answers already kept.
  const last = useQuery({ queryKey: LAST_ANSWERED_KEY, queryFn: readLastAnswered, enabled: cli || codex, refetchOnMount: 'always' });
  const command = codex ? 'codex' : 'claude_code';
  const modelWords = (model: string) => modelOptionWords(command, model, lastFor(last.data, command, model), choices.claude_aliases);
  // Codex lists its own models, and each one's effort levels, when asked
  // (`codex debug models`, run by the engine). Asked on Load models, never on
  // its own: it starts a process.
  const catalog = useModelList();
  const listed = codex ? listFor(catalog, 'codex') : null;
  const efforts = codex
    ? [...new Set([...effortsFor(listed, value?.model ?? '', []), ...(value?.effort ? [value.effort] : [])])]
    : choices.claude_efforts;
  return (
    <fieldset className="conv-choices">
      <legend className="conv-label">{legacy ? 'Choices from now on' : 'Choices for this conversation'}</legend>
      <div className="conv-choice">
        <label htmlFor="conv-connection">Connection</label>
        <select
          id="conv-connection"
          value={value ? connectionKey(value) : ''}
          onChange={(e) => {
            const next = choices.connections.find((c) => connectionKey(c) === e.target.value);
            if (!next?.runtime || !next.implemented) return;
            const runtime = next.runtime as ChoiceRequest['runtime'];
            const same = runtime === value?.runtime;
            onChange({ version: 1, runtime, provider: next.provider,
              model: same ? value.model : null,
              effort: same && runtime !== 'api_key' ? value.effort : null });
          }}
        >
          <option value="" disabled>Choose a connection</option>
          {choices.connections.map((c) => (
            <option key={connectionKey(c)} value={connectionKey(c)} disabled={!c.implemented}>
              {c.runtime === 'api_key' ? providerWords(c.provider) : c.label}
              {!c.implemented ? ', not offered' : !c.available ? ', needs setting up' : ''}
            </option>
          ))}
        </select>
      </div>
      {value && (
        <div className="conv-choice">
          <label htmlFor="conv-model">Model</label>
          <input
            id="conv-model" list={api ? undefined : codex ? 'conv-codex-models' : 'conv-claude-aliases'} maxLength={512}
            value={value.model ?? ''} spellCheck={false} autoComplete="off"
            placeholder={api ? 'A model ID is required' : 'Blank: the CLI’s default'}
            onChange={(e) => onChange({ ...value, model: e.target.value || null })}
          />
          {cli && (
            <datalist id="conv-claude-aliases">
              {choices.claude_aliases.map((a) => <option key={a} value={a} label={modelWords(a)} />)}
            </datalist>
          )}
          {codex && (
            <datalist id="conv-codex-models">
              {(listed?.models ?? []).map((m) => <option key={m} value={m} label={modelWords(m)} />)}
            </datalist>
          )}
        </div>
      )}
      {value && codex && connection?.available && (
        <button type="button" className="btn sm conv-load-models" data-ask="load-models" disabled={catalog.isPending}
          onClick={() => catalog.mutate({ provider: 'codex', purpose: 'ask' })}>
          {catalog.isPending ? 'Loading' : listed ? 'Load again' : 'Load models'}
        </button>
      )}
      {value && !api && (
        <div className="conv-choice">
          <label htmlFor="conv-effort">Effort</label>
          <select id="conv-effort" value={value.effort ?? ''} onChange={(e) => onChange({ ...value, effort: e.target.value || null })}>
            <option value="">The CLI’s default</option>
            {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </div>
      )}
      {value && api && <p className="conv-quiet conv-no-effort">Effort: not supported by this connection.</p>}
      {/* For Codex only where it says more than the field does: the default, or what a model last answered as. */}
      {value && (cli || (codex && modelWords(value.model ?? '') !== value.model)) && (
        <p className="conv-quiet conv-model-words" data-ask="model-words">Model: {modelWords(value.model ?? '')}.</p>
      )}
      {codex && catalog.error && (
        <p className="field-error" role="alert" data-ask="model-list-error">{refusal(catalog.error)}</p>
      )}
      {codex && connection?.available && !listed && !catalog.error && (
        <p className="conv-quiet" data-ask="model-list">
          Load models to choose from what Codex lists, with each model’s effort levels.
        </p>
      )}
      {codex && listed && (
        <p className="conv-quiet" data-ask="model-list" data-count={listed.models.length}>
          {listed.models.length
            ? `${listed.provenance || 'Listed by Codex.'} Type another to send it as written.`
            : 'Codex listed no models. Type a model’s ID instead.'}
        </p>
      )}
      {/* An unavailable connection's reason is said once, below, beside the way to Settings › AI. For
          a command, the command itself is asked whether it is signed in, which says more than the
          engine's "sign-in unverified" can; model acceptance is in the limits below. Codex's reason
          also says what it is given: resmon's read-only tools only. */}
      {connection?.available && !cli && <p className="conv-quiet conv-reason" data-ask="connection-reason">{connection.reason}</p>}
      {(cli || codex) && connection?.available && <CliSignIn key={command} provider={command} purpose="ask" checkOnOpen />}
      {!value && choices.default_error && <p className="conv-quiet">{choices.default_error}</p>}
      <details className="conv-limits">
        <summary>What these choices establish</summary>
        <p>{choices.limitations}</p>
        <p>
          A model is sent as typed. The Claude names offered are aliases, not a list of what an account can use;
          Codex’s are what its own catalog lists when loaded. These choices are fixed when the first message is
          sent, and change no default.
        </p>
      </details>
    </fieldset>
  );
}
