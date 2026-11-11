import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';
const IDENTITIES = ['data-focus-key', 'data-month', 'id', 'aria-label', 'href', 'name',
  'data-file', 'data-document', 'data-paper', 'data-run', 'data-project'];
const LIMIT = 200;
const WAIT_MS = 5000;
const quoted = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');

/** A control's identity after its page is drawn again, without holding its detached DOM. */
function selectorFor(node: Element, root: HTMLElement): string | null {
  const tail: string[] = [];
  for (let part: Element | null = node; part && part !== root; part = part.parentElement) {
    const tag = part.tagName.toLowerCase();
    for (const attribute of IDENTITIES) {
      const value = part.getAttribute(attribute);
      if (value === null) continue;
      const head = `${tag}[${attribute}="${quoted(value)}"]`;
      if (root.querySelectorAll(head).length === 1) return [head, ...tail].join(' > ');
    }
    const siblings = part.parentElement ? Array.from(part.parentElement.children).filter((child) => child.tagName === part!.tagName) : [];
    tail.unshift(`${tag}:nth-of-type(${siblings.indexOf(part) + 1})`);
  }
  return tail.length ? tail.join(' > ') : null;
}

/**
 * Back and Forward return focus to the control left on that history entry.
 * Remember a semantic identity, since a screen and its virtual rows unmount.
 * Wait for data to draw the control, and leave scrolling to StageScroll.
 */
export function HistoryFocus({ stage }: { stage: RefObject<HTMLElement | null> }) {
  const location = useLocation();
  const type = useNavigationType();
  const address = `${location.pathname}${location.search}`;
  const slot = `${location.key}\0${address}`;
  const here = useRef(slot);
  const memory = useRef(new Map<string, string>());
  const first = useRef(true);

  useEffect(() => {
    const root = stage.current;
    if (!root) return undefined;
    const remember = (event: Event) => {
      const node = event.target instanceof Element ? event.target.closest(FOCUSABLE) : null;
      if (!node || !root.contains(node)) return;
      const selector = selectorFor(node, root);
      if (selector === null) return;
      memory.current.delete(here.current);
      memory.current.set(here.current, selector);
      while (memory.current.size > LIMIT) memory.current.delete(memory.current.keys().next().value!);
    };
    for (const name of ['focusin', 'pointerdown', 'click']) root.addEventListener(name, remember, true);
    return () => {
      for (const name of ['focusin', 'pointerdown', 'click']) root.removeEventListener(name, remember, true);
    };
  }, [stage]);

  useLayoutEffect(() => {
    here.current = slot;
    if (first.current) { first.current = false; return undefined; }
    const root = stage.current;
    const selector = memory.current.get(slot);
    if (type !== 'POP' || !root || !selector) return undefined;
    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = () => {
      stopped = true;
      observer?.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('pointerdown', stop, true);
      window.removeEventListener('keydown', stop, true);
    };
    const restore = () => {
      if (stopped) return;
      const target = root.querySelector<HTMLElement>(selector);
      if (!target || typeof target.focus !== 'function') return;
      target.focus({ preventScroll: true });
      stop();
    };
    restore();
    if (!stopped) {
      observer = new MutationObserver(restore);
      observer.observe(root, { subtree: true, childList: true, attributes: true });
      timer = setTimeout(stop, WAIT_MS);
      window.addEventListener('pointerdown', stop, true);
      window.addEventListener('keydown', stop, true);
    }
    return stop;
  }, [slot, type, stage]);
  return null;
}
