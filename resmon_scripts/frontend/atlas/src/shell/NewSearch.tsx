import { useId, useRef, type KeyboardEvent, type ToggleEvent } from 'react';
import { KINDS, type SearchKind } from '../screens/searchStart';
import { Icon } from './Icon';
import { ariaKeys, keysText, shortcut } from './shortcuts';

const MENU_ID = 'new-search-menu';

/**
 * The top bar's New search: a Deep Dive or a Deep Sweep from any screen, in
 * one click, each with its shortcut beside it. A native popover, so Escape and
 * a click outside close it; the arrow keys move between its two items. The
 * button takes the focus on a click, unlike the bar's links: the menu's first
 * item takes it from there, and is ringed only when the keyboard opened it.
 */
export function NewSearch({ mac, onStart }: { mac: boolean; onStart: (kind: SearchKind) => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  const start = (kind: SearchKind) => {
    menu.current?.hidePopover();
    onStart(kind);
  };
  const onToggle = (event: ToggleEvent<HTMLDivElement>) => {
    if (event.newState === 'open') items.current[0]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = items.current.findIndex((item) => item === document.activeElement);
    const last = KINDS.length - 1;
    const to: Record<string, number> = {
      ArrowDown: at >= last ? 0 : at + 1, ArrowUp: at <= 0 ? last : at - 1, Home: 0, End: last,
    };
    const next = to[event.key];
    if (next === undefined) return;
    event.preventDefault();
    items.current[next]?.focus();
  };

  return (
    <>
      <button type="button" className="newsearch" popoverTarget={MENU_ID} aria-haspopup="menu" title="New search">
        <Icon name="plus" size={14} />
        <span className="newsearch-label">New search</span>
        <Icon name="chevron" size={14} />
      </button>
      <div id={MENU_ID} ref={menu} popover="auto" role="menu" aria-label="New search" className="newsearch-menu"
        onToggle={onToggle} onKeyDown={onKeyDown}>
        {KINDS.map((kind, index) => {
          const { chord } = shortcut(kind.shortcut);
          return (
            <button
              key={kind.kind}
              ref={(node) => { items.current[index] = node; }}
              type="button"
              role="menuitem"
              className="newsearch-item"
              data-kind={kind.kind}
              aria-labelledby={`${id}-${kind.kind}`}
              aria-describedby={`${id}-${kind.kind}-says`}
              aria-keyshortcuts={ariaKeys(chord, mac)}
              onClick={() => start(kind.kind)}
            >
              <span id={`${id}-${kind.kind}`} className="newsearch-name">{kind.name}</span>
              <kbd aria-hidden="true">{keysText(chord, mac)}</kbd>
              <span id={`${id}-${kind.kind}-says`} className="newsearch-says">{kind.says}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
