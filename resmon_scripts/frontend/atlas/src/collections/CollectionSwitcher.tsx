import { useRef, type KeyboardEvent, type ToggleEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../shell/Icon';
import { number } from '../screens/today/format';
import { useCollection } from './current';
import './collections.css';

const MENU_ID = 'collection-menu';
/** Settings › Collections, where collections are made, renamed, and deleted. */
export const COLLECTIONS_PATH = '/settings/collections';

/**
 * The collection the window shows, beside the lockup: its name, and a menu of
 * every collection with how many papers each holds, the one shown ticked.
 * Choosing one shows it in this window and no other, and the engine remembers
 * it as what a new window opens on. The menu ends with New collection and
 * Manage collections, both in Settings › Collections.
 *
 * A native popover, as New Search is: Escape and a click outside close it,
 * and the arrow keys, Home, and End move between its items.
 */
export function CollectionSwitcher() {
  const current = useCollection();
  const navigate = useNavigate();
  const menu = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  if (current.id === null || current.name === null) return null;

  const close = () => menu.current?.hidePopover();
  const choose = (id: number) => {
    close();
    if (id !== current.id) void current.switchTo(id);
  };
  const manage = (create: boolean) => {
    close();
    void navigate(COLLECTIONS_PATH, { state: create ? { create: true } : undefined });
  };
  const onToggle = (event: ToggleEvent<HTMLDivElement>) => {
    if (event.newState !== 'open') return;
    const at = current.list.findIndex((c) => c.id === current.id);
    items.current[Math.max(0, at)]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const live = items.current.filter((item): item is HTMLButtonElement => item !== null);
    const at = live.findIndex((item) => item === document.activeElement);
    const last = live.length - 1;
    const to: Record<string, number> = {
      ArrowDown: at >= last ? 0 : at + 1, ArrowUp: at <= 0 ? last : at - 1, Home: 0, End: last,
    };
    const next = to[event.key];
    if (next === undefined) return;
    event.preventDefault();
    live[next]?.focus();
  };
  const count = current.list.length;

  return (
    <>
      <button type="button" className="scope" popoverTarget={MENU_ID} aria-haspopup="menu"
        aria-label={`Collection: ${current.name}. Choose another collection`} title={current.name}
        data-collection-switch={current.id} aria-busy={current.switching || undefined}>
        <span className="scope-name">{current.name}</span>
        <Icon name="chevron" size={14} />
      </button>
      <div id={MENU_ID} ref={menu} popover="auto" role="menu" aria-label="Collections" className="scope-menu"
        onToggle={onToggle} onKeyDown={onKeyDown}>
        {current.list.map((collection, index) => {
          const shown = collection.id === current.id;
          return (
            <button key={collection.id} ref={(node) => { items.current[index] = node; }} type="button"
              role="menuitemradio" aria-checked={shown} className="scope-item" data-collection={collection.id}
              onClick={() => choose(collection.id)}>
              <span className="scope-check" aria-hidden="true">{shown && <Icon name="check" size={14} />}</span>
              <span className="scope-item-name">{collection.name}</span>
              <span className="scope-count num">{number(collection.papers)}</span>
            </button>
          );
        })}
        <div className="scope-actions" role="none">
          <button ref={(node) => { items.current[count] = node; }} type="button" role="menuitem"
            className="scope-item scope-action" data-collection-action="new" onClick={() => manage(true)}>
            <span className="scope-check" aria-hidden="true"><Icon name="plus" size={14} /></span>
            <span className="scope-item-name">New Collection</span>
          </button>
          <button ref={(node) => { items.current[count + 1] = node; }} type="button" role="menuitem"
            className="scope-item scope-action" data-collection-action="manage" onClick={() => manage(false)}>
            <span className="scope-check" aria-hidden="true"><Icon name="settings" size={14} /></span>
            <span className="scope-item-name">Manage Collections</span>
          </button>
        </div>
      </div>
    </>
  );
}
