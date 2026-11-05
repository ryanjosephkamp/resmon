import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A question asked in place before something that cannot be undone, in the
 * page's own words and type rather than the system's dialog: what it does,
 * then the button that does it and Not now. The question takes the focus
 * when it appears, so the keyboard reaches it first, and Escape is Not now.
 */
export function Confirm({ question, act, onAct, onCancel, busy = false, children, name }: {
  question: string;
  /** The button's words: "Delete 2 runs". */
  act: string;
  onAct: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** Anything more to say under the question. */
  children?: ReactNode;
  /** `data-confirm`, for a test to find this question among others. */
  name: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  return (
    <div ref={box} className="confirm" role="group" aria-label={act} tabIndex={-1} data-confirm={name}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
      <p className="confirm-question">{question}</p>
      {children}
      <div className="form-actions">
        <button type="button" className="btn sm danger" data-confirm-act={name} disabled={busy} onClick={onAct}>{act}</button>
        <button type="button" className="btn sm quiet" disabled={busy} onClick={onCancel}>Not now</button>
      </div>
    </div>
  );
}
