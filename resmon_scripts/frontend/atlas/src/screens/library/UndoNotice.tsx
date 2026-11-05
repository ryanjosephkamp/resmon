import { useEffect, useState } from 'react';
import { Icon } from '../../shell/Icon';
import { errorWords } from './Cards';
import { UNDO_SECONDS } from './galleryModel';

/** What a notice says, and its Undo. `name` is set in bold between `lead` and `rest`. */
export interface Notice {
  lead: string;
  name: string | null;
  rest: string;
  /** Undo it; a sentence it answers with is said in the notice's place, where it did less than all. */
  undo: (() => Promise<string | void>) | null;
  id: number;
}

/**
 * The notice a change that can be undone leaves at the stage's foot: what it
 * did, Undo, and the seconds left. It waits while the pointer or the keyboard
 * is on it. A removal from the Library leaves one, and so does a save of many
 * papers to read.
 */
export function UndoNotice({ notice, onDone, name }: { notice: Notice; onDone: () => void; name?: string }) {
  const [left, setLeft] = useState(UNDO_SECONDS);
  const [held, setHeld] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  useEffect(() => {
    if (held || undoing) return undefined;
    if (left <= 0) { onDone(); return undefined; }
    const tick = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(tick);
  }, [left, held, undoing, onDone]);
  const undo = async () => {
    if (!notice.undo) return;
    setUndoing(true);
    try {
      const said = await notice.undo();
      if (said) { setAfter(said); setUndoing(false); setLeft(UNDO_SECONDS); } else onDone();
    } catch (error) { setFailed(errorWords(error)); setUndoing(false); }
  };
  return (
    <div className="lib-notice" role="status" data-notice={name} onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      {after
        ? <span>{after}</span>
        : <span>{notice.lead}{notice.name && <b>{notice.name}</b>}{notice.rest}{failed && <> Undo failed: {failed}</>}</span>}
      {notice.undo && !after && (
        <button type="button" className="btn sm" disabled={undoing} onClick={() => void undo()}>{undoing ? 'Undoing' : 'Undo'}</button>
      )}
      <span className="left num" aria-hidden="true">{left} s</span>
      <button type="button" className="iconbtn sm" aria-label="Dismiss" onClick={onDone}><Icon name="close" /></button>
    </div>
  );
}
