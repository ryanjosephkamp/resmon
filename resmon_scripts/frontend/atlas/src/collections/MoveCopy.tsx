import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type ToggleEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { engineSentence } from '../api/client';
import { Icon } from '../shell/Icon';
import { useCollection } from './current';
import { COLLECTIONS_PATH } from './CollectionSwitcher';
import { afterPapersChanged, changePapers, changedWords, undoChange, type Mode, type PapersChanged, type Which } from './papers';
import './collections.css';

/** How long a move or a copy can be undone from its notice. */
const UNDO_SECONDS = 10;

function words(error: unknown): string {
  return engineSentence(error) ?? (error instanceof Error ? error.message : String(error));
}

/**
 * The notice a move or a copy leaves, with its Undo, held by whatever outlives
 * the controls that made it: Search holds it, so Done or Escape on the pick
 * bar right after a move keeps the move's ten seconds of Undo.
 */
export function useChangeNotice(): { show: (done: PapersChanged, said: string) => void; notice: ReactNode } {
  const client = useQueryClient();
  const [held, setHeld] = useState<{ done: PapersChanged; said: string; key: number } | null>(null);
  const keys = useRef(0);
  const show = useCallback((done: PapersChanged, said: string) => {
    keys.current += 1;
    setHeld({ done, said, key: keys.current });
  }, []);
  const notice = held && (
    <ChangeNotice key={held.key} done={held.done} said={held.said}
      onGone={() => setHeld((n) => (n?.key === held.key ? null : n))}
      onUndone={() => void afterPapersChanged(client)} />
  );
  return { show, notice };
}

/**
 * Move to and Copy to, for the papers `which` names in the collection `from`:
 * each opens a menu of the other collections. A copy adds the papers there and
 * every collection they were in keeps them; a move adds them there and takes
 * them out of `from`. Neither deletes a paper. What happened is said in a
 * notice with Undo, which puts every paper back where it was.
 *
 * `canMove` is false where the papers are not in `from` (a paper opened from
 * another collection): only Copy is offered then.
 */
export function MoveCopy({ which, from, count, canMove = true, skip = [], onDone, onNotice, size = 'sm' }: {
  which: Which; from: number | null; count: number; canMove?: boolean;
  /** Collections not offered as a copy's target, because they hold the papers already. */
  skip?: readonly number[];
  onDone?: (done: PapersChanged) => void;
  /** Where the notice goes, when something that outlives these controls holds it (`useChangeNotice`). */
  onNotice?: (done: PapersChanged, said: string) => void;
  size?: 'sm' | 'md';
}) {
  const current = useCollection();
  const client = useQueryClient();
  const own = useChangeNotice();
  const show = onNotice ?? own.show;
  const change = useMutation({
    mutationFn: ({ mode, target }: { mode: Mode; target: number }) => changePapers(mode, target, which, from),
    onSuccess: (done) => {
      const target = current.list.find((c) => c.id === done.collection_id)?.name ?? 'the collection';
      show(done, changedWords(done, target, current.list.find((c) => c.id === done.from_collection_id)?.name));
      void afterPapersChanged(client);
      onDone?.(done);
    },
  });
  const others = current.list.filter((c) => c.id !== from);
  const copyTargets = others.filter((c) => !skip.includes(c.id));
  const busy = change.isPending || count === 0;
  return (
    <>
      <span className="movecopy" role="group" aria-label={`Move or copy ${count === 1 ? 'this paper' : 'these papers'} to another collection`}>
        {canMove && (
          <TargetMenu label="Move To" mode="move" size={size} disabled={busy} targets={others}
            onChoose={(target) => change.mutate({ mode: 'move', target })} />
        )}
        <TargetMenu label="Copy To" mode="copy" size={size} disabled={busy} targets={copyTargets}
          onChoose={(target) => change.mutate({ mode: 'copy', target })} />
      </span>
      {change.error && <p className="field-error" role="alert" data-collection="move-refused">{words(change.error)}</p>}
      {!onNotice && own.notice}
    </>
  );
}

function TargetMenu({ label, mode, targets, disabled, onChoose, size }: {
  label: string; mode: Mode; targets: readonly { id: number; name: string; papers: number }[];
  disabled: boolean; onChoose: (target: number) => void; size: 'sm' | 'md';
}) {
  const id = useId().replace(/:/g, '');
  const menuId = `collection-${mode}-${id}`;
  // The menu hangs from its button: both name the same anchor (``--anchor`` in collections.css).
  const anchor = { '--anchor': `--${menuId}` } as CSSProperties;
  const menu = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLElement | null)[]>([]);
  const onToggle = (event: ToggleEvent<HTMLDivElement>) => {
    if (event.newState === 'open') items.current[0]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const live = items.current.filter((item): item is HTMLElement => item !== null);
    const at = live.findIndex((item) => item === document.activeElement);
    const last = live.length - 1;
    const to: Record<string, number> = { ArrowDown: at >= last ? 0 : at + 1, ArrowUp: at <= 0 ? last : at - 1, Home: 0, End: last };
    const next = to[event.key];
    if (next === undefined) return;
    event.preventDefault();
    live[next]?.focus();
  };
  return (
    <>
      <button type="button" className={`btn ${size === 'sm' ? 'sm ' : ''}movecopy-open`} popoverTarget={menuId}
        aria-haspopup="menu" disabled={disabled} data-collection-mode={mode} style={anchor}>
        {label}<Icon name="chevron" size={14} />
      </button>
      <div id={menuId} ref={menu} popover="auto" role="menu" aria-label={label} className="scope-menu movecopy-menu"
        style={anchor} onToggle={onToggle} onKeyDown={onKeyDown}>
        {targets.map((target, index) => (
          <button key={target.id} ref={(node) => { items.current[index] = node; }} type="button" role="menuitem"
            className="scope-item" data-collection-target={target.id}
            onClick={() => { menu.current?.hidePopover(); onChoose(target.id); }}>
            <span className="scope-check" aria-hidden="true" />
            <span className="scope-item-name">{target.name}</span>
            <span className="scope-count num">{target.papers.toLocaleString('en-US')}</span>
          </button>
        ))}
        {targets.length === 0 && (
          <p className="scope-empty">
            {mode === 'copy' ? 'Every other collection holds it already, or there is no other.' : 'There is no other collection yet.'}
          </p>
        )}
        <Link ref={(node) => { items.current[targets.length] = node; }} to={COLLECTIONS_PATH} state={{ create: true }}
          role="menuitem" className="scope-item scope-action" onClick={() => menu.current?.hidePopover()}>
          <span className="scope-check" aria-hidden="true"><Icon name="plus" size={14} /></span>
          <span className="scope-item-name">New Collection</span>
        </Link>
      </div>
    </>
  );
}

/** What a move or a copy did, with Undo for ten seconds; it waits while the pointer or the keyboard is on it. */
function ChangeNotice({ done, said, onGone, onUndone }: {
  done: PapersChanged; said: string; onGone: () => void; onUndone: () => void;
}) {
  const [left, setLeft] = useState(UNDO_SECONDS);
  const [held, setHeld] = useState(false);
  const undo = useMutation({
    mutationFn: () => undoChange(done),
    onSuccess: () => { onUndone(); onGone(); },
  });
  const nothing = done.added.length === 0 && done.removed.length === 0;
  useEffect(() => {
    if (held || undo.isPending) return undefined;
    if (left <= 0) { onGone(); return undefined; }
    const tick = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(tick);
  }, [left, held, undo.isPending, onGone]);
  return (
    <div className="collection-notice" role="status" data-collection="moved"
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <span>{said}{undo.error && <> Undo failed: {words(undo.error)}</>}</span>
      {!nothing && (
        <button type="button" className="btn sm" disabled={undo.isPending} onClick={() => undo.mutate()}>
          {undo.isPending ? 'Undoing' : 'Undo'}
        </button>
      )}
      <span className="left num" aria-hidden="true">{left} s</span>
      <button type="button" className="iconbtn sm" aria-label="Dismiss" onClick={onGone}><Icon name="close" /></button>
    </div>
  );
}
