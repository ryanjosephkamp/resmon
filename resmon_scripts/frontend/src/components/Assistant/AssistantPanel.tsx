import { TranscriptMessages } from './TranscriptMessages';
import React from 'react';
import {
  describeToolCall,
  shortToolName,
  useAssistant,
} from '../../context/AssistantContext';

/**
 * The assistant, as a second fixed element beside the floating progress widget.
 *
 * The pill and panel follow the widget's pattern deliberately — same corner
 * behaviour, same minimised/expanded shape — because a second floating thing
 * that behaved differently would be a second thing to learn.
 *
 * **It overlays the page without reflow.** The panel is `position: fixed`, so the main
 * content's layout does not move when it opens; `e2e/assistant.spec.ts` asserts
 * the main content's bounding box before and after on every route, which is the
 * rebuild-pressure measurement decision 7 asks for.
 */

const PermissionCards: React.FC = () => {
  const { pending, answerPermission } = useAssistant();
  if (!pending.length) return null;
  return (
    <>
      {pending.map((card) => (
        <div className="assistant-permission" key={card.request_id} data-testid="permission-card">
          <div className="assistant-permission-title">
            {describeToolCall(card.tool_name, card.input)}
          </div>
          {/* The exact call, always. A card that only paraphrased would be
              showing one thing while something else ran. */}
          <pre className="assistant-permission-call">
            {shortToolName(card.tool_name)}({JSON.stringify(card.input ?? {}, null, 2)})
          </pre>
          <div className="assistant-permission-actions">
            <button
              type="button"
              className="assistant-btn assistant-btn--primary"
              onClick={() => answerPermission(card.request_id, true)}
            >
              Allow
            </button>
            <button
              type="button"
              className="assistant-btn"
              onClick={() => answerPermission(card.request_id, false)}
            >
              Deny
            </button>
          </div>
          <div className="assistant-permission-note">
            Nothing runs until you answer. resmon is holding the assistant here.
          </div>
        </div>
      ))}
    </>
  );
};

const Unavailable: React.FC = () => {
  const { status } = useAssistant();
  const others = status?.others || [];
  return (
    <div className="assistant-unavailable" data-testid="assistant-unavailable">
      <h4>The assistant is not available</h4>
      <p>{status?.reason}</p>
      {others.map((other) => (
        <p className="assistant-unavailable-other" key={other.kind}>{other.reason}</p>
      ))}
      <p className="assistant-unavailable-where">
        Set the path to your <code>claude</code> command in Settings → AI, under Assistant.
      </p>
    </div>
  );
};

const Transcript: React.FC = () => {
  const { messages, isAnswering } = useAssistant();
  const endRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, isAnswering]);

  if (!messages.length) {
    return (
      <div className="assistant-empty">
        <p>Ask about your routines, your corpus, or what a run found.</p>
        <p className="assistant-empty-note">
          Everything it tells you comes from resmon itself. Anything that changes
          something waits for you to allow it.
        </p>
      </div>
    );
  }

  return (
    <>
      <TranscriptMessages messages={messages} />
      <PermissionCards />
      {isAnswering && <div className="assistant-thinking">Working…</div>}
      <div ref={endRef} />
    </>
  );
};

const SessionList: React.FC<{ onPick: () => void }> = ({ onPick }) => {
  const { sessions, sessionId, openSession, deleteSession, isAnswering } = useAssistant();
  if (!sessions.length) return <p className="assistant-empty-note">No earlier conversations.</p>;
  return (
    <ul className="assistant-sessions">
      {sessions.map((session) => (
        <li key={session.id} className={session.id === sessionId ? 'is-current' : undefined}>
          <button
            type="button"
            className="assistant-session-open"
            disabled={isAnswering && session.id !== sessionId}
            onClick={() => { void openSession(session.id); onPick(); }}
          >
            {session.title}
          </button>
          <button
            type="button"
            className="assistant-session-delete"
            disabled={isAnswering && session.id === sessionId}
            aria-label={`Delete ${session.title}`}
            onClick={() => { void deleteSession(session.id); }}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
};

const AssistantPanel: React.FC = () => {
  const {
    isOpen, setOpen, status, statusLoaded, isAnswering, isSelecting, error,
    send, newSession, cancel,
  } = useAssistant();
  const [draft, setDraft] = React.useState('');
  const [showSessions, setShowSessions] = React.useState(false);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const historyRef = React.useRef<HTMLButtonElement>(null);
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    // Only an open/close transition moves focus, never a streamed message.
    if (isOpen) {
      if (composerRef.current?.disabled) historyRef.current?.focus();
      else composerRef.current?.focus();
    }
    else if (wasOpen.current) triggerRef.current?.focus();
    wasOpen.current = isOpen;
  }, [isOpen]);


  // The trigger is rendered whatever the status is; an assistant that vanished
  // when its CLI was missing would look like a feature resmon does not have,
  // rather than one waiting on a setting the user can change.
  if (!isOpen) {
    return (
      <button
        type="button"
        ref={triggerRef}
        className="assistant-trigger"
        data-testid="assistant-trigger"
        title="Ask resmon (⌘/)"
        aria-label="Open the resmon assistant"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">✦</span>
        <span className="assistant-trigger-label">Ask</span>
      </button>
    );
  }

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (isSelecting || isAnswering) return;
    const text = draft;
    setDraft('');
    void send(text);
  };

  return (
    <section
      className="assistant-panel"
      data-testid="assistant-panel"
      role="complementary"
      aria-label="resmon assistant"
    >
      <header className="assistant-header">
        <h4>Assistant</h4>
        <div className="assistant-header-actions">
          <button
            type="button"
            onClick={() => setShowSessions((value) => !value)}
            ref={historyRef}
            aria-expanded={showSessions}
            title="Earlier conversations"
            aria-label="Earlier conversations"
          >
            ☰
          </button>
          <button type="button" onClick={() => { void newSession(); setShowSessions(false); }}
                  disabled={isAnswering} title="New conversation" aria-label="New conversation">＋</button>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close the assistant">
            ×
          </button>
        </div>
      </header>

      {showSessions && (
        <div className="assistant-session-drawer">
          <a href="#/chats" onClick={() => setOpen(false)}>Browse saved Chats</a>
          <SessionList onPick={() => setShowSessions(false)} />
        </div>
      )}

      <div className="assistant-body">
        {statusLoaded && status && !status.available ? <Unavailable /> : <Transcript />}
      </div>

      {error && <div className="assistant-error" role="alert">{error}</div>}

      <form className="assistant-composer" onSubmit={onSubmit}>
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              (event.currentTarget.form as HTMLFormElement)?.requestSubmit();
            }
          }}
          placeholder={status?.available === false
            ? 'The assistant is not available'
            : 'Ask about your monitoring…'}
          rows={2}
          aria-label="Message the assistant"
          disabled={status?.available === false || isSelecting}
        />
        {isAnswering ? (
          <button type="button" className="assistant-btn" onClick={() => { void cancel(); }}>
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="assistant-btn assistant-btn--primary"
            disabled={!draft.trim() || status?.available === false || isSelecting}
          >
            Send
          </button>
        )}
      </form>
    </section>
  );
};

export default AssistantPanel;
