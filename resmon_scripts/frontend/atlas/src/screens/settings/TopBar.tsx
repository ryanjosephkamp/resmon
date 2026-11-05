import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { isMac } from '../../bridge';
import { sectionFor } from '../../routes';
import { Icon } from '../../shell/Icon';
import { keysText, shortcut, type ShortcutId } from '../../shell/shortcuts';
import {
  DEFAULT_TOP_BAR, START_PAGES, arrange, isDefault, moved, pageName, shownOrHidden,
  type Arranged, type SectionId, type StartPage,
} from '../../shell/topBar';
import { useTopBar } from '../../shell/useTopBar';
import { useAppearance } from '../../theme/appearance';

/** A section's key, as this platform writes it: ⌘3, or Ctrl+3. */
function keyFor(arranged: Arranged, id: SectionId, mac: boolean): string {
  return keysText(shortcut(`section-${arranged.keys.indexOf(id) + 1}` as ShortcutId).chord, mac);
}

/** A row being dragged: where it started, where it would go, and how far the pointer has moved. */
interface Drag {
  id: SectionId;
  from: number;
  to: number;
  /** Pixels from where the pointer went down. */
  dy: number;
  /** One row's height, rule included: every row is the same height. */
  step: number;
  startY: number;
  pointer: number;
}

/**
 * Settings › Top bar: the sections' order and which the bar shows, the page a
 * window opens on, where the resmon name goes, and the run monitor. Each
 * change is stored at once, and the bar above draws it as it is made, so the
 * bar is the preview.
 */
export function TopBarSettings() {
  const { stored, arranged, save, saveError, loadError } = useTopBar();
  const appearance = useAppearance();
  const mac = isMac();
  // What the last change did, for a screen reader. Saying it also draws the change in this same frame: the
  // query cache tells its readers a tick later, and a native select is put back to its old value until then.
  const [said, setSaid] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  const list = useRef<HTMLOListElement>(null);
  // A moved row's button keeps the focus, though the row's place in the list changed under it: a row moved
  // down is taken out and put back, which drops the focus it held.
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    list.current?.querySelector<HTMLElement>(`[data-move="${refocus.current}"]`)?.focus();
    refocus.current = null;
  });

  // Escape puts a row being dragged back where it was.
  useEffect(() => {
    if (!drag) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setDrag(null);
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [drag]);

  const order = arranged.order;
  const label = (id: SectionId) => sectionFor(id).label;
  // The keys as they will be once a row being dragged is let go where it is now.
  const keyed = drag ? arrange(moved(stored, drag.id, drag.to)) : arranged;

  const moveTo = (id: SectionId, to: number) => {
    if (to === order.indexOf(id) || to < 0 || to >= order.length) return;
    const next = moved(stored, id, to);
    save(next);
    setSaid(`${label(id)} is now ${to + 1} of ${order.length}, on ${keyFor(arrange(next), id, mac)}.`);
  };

  const choosePages = (start: StartPage, lockup: StartPage | null) => {
    save({ ...stored, start, lockup });
    setSaid(lockup === null
      ? `A launch, a new window, and the resmon name open ${pageName(start)}.`
      : `A launch and a new window open ${pageName(start)}; the resmon name opens ${pageName(lockup)}.`);
  };

  const show = (id: SectionId, on: boolean) => {
    save(shownOrHidden(stored, id, on));
    setSaid(on ? `${label(id)} is back in the top bar.` : `${label(id)} is out of the top bar. Its shortcut and the command palette still open it.`);
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>, id: SectionId) => {
    if (event.button !== 0 || !list.current) return;
    const rows = list.current.querySelectorAll<HTMLElement>(':scope > li');
    const first = rows[0]?.getBoundingClientRect();
    const second = rows[1]?.getBoundingClientRect();
    if (!first) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const from = order.indexOf(id);
    setDrag({ id, from, to: from, dy: 0, step: second ? second.top - first.top : first.height, startY: event.clientY, pointer: event.pointerId });
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dy = event.clientY - drag.startY;
    const to = Math.max(0, Math.min(order.length - 1, Math.round(drag.from + dy / drag.step)));
    setDrag({ ...drag, dy, to });
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    setDrag(null);
    moveTo(drag.id, drag.to);
  };

  /** Where a row is drawn while another is dragged: the dragged one under the pointer, the ones it passed a row over. */
  const shift = (index: number): number => {
    if (!drag) return 0;
    if (index === drag.from) return drag.dy;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.step;
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return drag.step;
    return 0;
  };

  // Each page by its full name, Search › Saved, which is what a closed list shows.
  const pageOptions = () => order.map((id) => {
    const pages = START_PAGES.filter((page) => page.section === id);
    const groupName = arranged.hidden.has(id) ? `${label(id)} (not in the top bar)` : label(id);
    return (
      <optgroup key={id} label={groupName}>
        {pages.map((page) => (
          <option key={page.path} value={page.path}>{page.name}</option>
        ))}
      </optgroup>
    );
  });

  return (
    <section className="settings-group top-bar-settings" aria-labelledby="top-bar-title">
      <h2 id="top-bar-title" className="group-title">Top bar</h2>
      <p className="group-lede">
        Which sections the bar shows, in what order, and the page resmon opens on. Kept in resmon’s own database,
        so every window and every launch has the same bar. Settings keeps its place at the bar’s right end,
        and {keysText(shortcut('settings').chord, mac)} opens it from anywhere.
      </p>

      <div className="bar-sections" data-settings="sections">
        <h3 className="field-title" id="bar-sections-title">Sections</h3>
        <p className="field-lede">
          Drag a section by its handle, or move it with its arrows; the list reads the bar from the left.{' '}
          {keysText(shortcut('section-1').chord, mac)} to {keysText(shortcut('section-7').chord, mac)} follow
          the bar, then go on to the hidden sections. Hiding a section only takes it out of the bar: its shortcut,
          the command palette, and links to it still open it.
        </p>
        <ol
          ref={list}
          className="bar-order"
          aria-labelledby="bar-sections-title"
          data-dragging={drag ? '' : undefined}
        >
          {order.map((id, index) => {
            const hidden = arranged.hidden.has(id);
            const name = label(id);
            return (
              <li
                key={id}
                className="bar-order-row"
                data-section={id}
                data-hidden={hidden || undefined}
                data-lifted={drag?.id === id || undefined}
                style={drag ? { transform: `translateY(${shift(index)}px)` } : undefined}
              >
                <span
                  className="bar-order-handle"
                  title={`Drag to move ${name}`}
                  onPointerDown={(event) => onPointerDown(event, id)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => setDrag(null)}
                >
                  <Icon name="grip" />
                  <kbd>{keyFor(keyed, id, mac)}</kbd>
                  <span className="bar-order-name">{name}</span>
                </span>
                <span className="bar-order-moves">
                  <button
                    type="button" className="iconbtn" data-move={`${id}:up`}
                    aria-label={`Move ${name} up`} title="Move up" aria-disabled={index === 0 || undefined}
                    onClick={() => { if (index > 0) { refocus.current = `${id}:up`; moveTo(id, index - 1); } }}
                  >
                    <Icon name="up" />
                  </button>
                  <button
                    type="button" className="iconbtn" data-move={`${id}:down`}
                    aria-label={`Move ${name} down`} title="Move down" aria-disabled={index === order.length - 1 || undefined}
                    onClick={() => { if (index < order.length - 1) { refocus.current = `${id}:down`; moveTo(id, index + 1); } }}
                  >
                    <Icon name="down" />
                  </button>
                </span>
                <button
                  type="button" className="switch bar-order-switch" role="switch" aria-checked={!hidden}
                  aria-label={`Show ${name} in the top bar`} data-switch={`show-${id}`}
                  onClick={() => show(id, hidden)}
                >
                  <span className="switch-track"><span className="switch-knob" /></span>
                  <span aria-hidden="true">{hidden ? 'Hidden' : 'Shown'}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="sr-only" role="status">{said}</p>
      </div>

      <div className="form-grid bar-pages">
        <label className="form-field" data-settings="start-page">
          <span className="form-label">Start page</span>
          <select
            value={arranged.start}
            onChange={(event) => choosePages(event.target.value as StartPage, stored.lockup)}
          >
            {pageOptions()}
          </select>
          <span className="form-hint">What a launch opens on, and a new window ({keysText(shortcut('new-window').chord, mac)}).</span>
        </label>
        <label className="form-field" data-settings="lockup">
          <span className="form-label">The resmon name</span>
          <select
            value={stored.lockup ?? ''}
            onChange={(event) => choosePages(arranged.start, (event.target.value || null) as StartPage | null)}
          >
            <option value="">The start page ({pageName(arranged.start)})</option>
            {pageOptions()}
          </select>
          <span className="form-hint">Where “research monitor”, at the bar’s left end, goes when you click it.</span>
        </label>
      </div>

      <div className="form-actions">
        <button type="button" className="btn" data-settings="reset-top-bar" disabled={isDefault(stored)}
          onClick={() => { save(DEFAULT_TOP_BAR); setSaid('The top bar is back to its default arrangement.'); }}>
          <Icon name="reset" />
          Reset the top bar
        </button>
        <span className="form-hint">
          {isDefault(stored)
            ? 'This is the default: every section shown, in the first order, opening on Today.'
            : 'Shows every section again, in the first order, and opens on Today.'}
        </span>
      </div>

      {(saveError || loadError) && (
        <p className="field-error" role="alert">
          {saveError
            ? `The engine did not store that (${saveError.message}). The bar shows what it holds.`
            : `The engine did not answer (${loadError?.message}). Changes cannot be saved until it does.`}
        </p>
      )}

      <div className="monitor-setting" data-settings="run-monitor">
        <h3 className="field-title">Run monitor</h3>
        <button type="button" className="switch" role="switch" aria-checked={appearance.stored.run_monitor} data-switch="run_monitor"
          onClick={() => appearance.save({ run_monitor: !appearance.stored.run_monitor })}>
          <span className="switch-track"><span className="switch-knob" /></span>
          Show the run monitor in the top bar
        </button>
        <p className="form-hint">
          The mark between the sections and New search: what runs now, what waits, and what failed since you last
          looked. Hidden, runs still notify you, and the Runs tab still lists them.
        </p>
        {appearance.saveError && (
          <p className="field-error" role="alert">
            The engine did not store that ({appearance.saveError.message}). The switch shows what it holds.
          </p>
        )}
      </div>
    </section>
  );
}
