import { useEffect, useEffectEvent, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { bridge } from '../bridge';
import { canGo } from './history';
import { Icon } from './Icon';
import { isTyping } from './shortcuts';
import { SWIPE, feed, type Direction, type Gesture } from './swipe';

/** What pans or edits under the pointer, and so takes a sideways swipe itself. */
const TAKES_SWIPES = 'canvas, [data-pans]';

/**
 * Whether what is under the pointer takes a swipe this way itself: a text
 * field, a map or anything else that pans, or a box that can still scroll
 * that way. A box already at that edge does not, as in a browser.
 */
function claimed(target: EventTarget | null, direction: Direction): boolean {
  if (isTyping(target)) return true;
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    if (node.matches(TAKES_SWIPES)) return true;
    const style = getComputedStyle(node);
    if (style.touchAction === 'none') return true;
    const scrolls = /(auto|scroll)/.test(style.overflowX) || node === document.scrollingElement;
    if (scrolls && node.scrollWidth > node.clientWidth + 1) {
      const room = direction === 'back' ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
      if (room) return true;
    }
  }
  return false;
}

interface Shown { toward: Direction; progress: number; went: boolean }

/**
 * Two-finger swipe, back and forward (the decision is `swipe.ts`), with the
 * arrow at the window's edge that grows as the swipe travels.
 *
 * On macOS it follows the system's own setting, as Safari does: a two-finger
 * swipe moves between pages only where "Swipe between pages" lets two fingers
 * scroll there, which the main process reads. Where three fingers are set
 * instead, the window's `swipe` event does it (`electron/main.ts`). The swipe
 * goes through the main process, which then takes a `swipe` event that lands
 * just after it as the same gesture rather than a second one. Outside the
 * app, it is always on.
 */
export function SwipeNavigation() {
  const navigate = useNavigate();
  const [shown, setShown] = useState<Shown | null>(null);
  const gesture = useRef<Gesture | null>(null);
  // The page a gesture began on: a page that changes under a gesture, by any means, ends it.
  const began = useRef<string | null>(null);
  const enabled = useRef(true);
  const hide = useRef<number | undefined>(undefined);

  useEffect(() => {
    const ask = () => {
      const answer = bridge()?.swipeNavigation?.();
      if (answer) void answer.then((on) => { enabled.current = on; }, () => undefined);
    };
    ask();
    // The setting can change while the app is open; it is read again whenever the window comes forward.
    window.addEventListener('focus', ask);
    return () => window.removeEventListener('focus', ask);
  }, []);

  const go = (direction: Direction) => {
    const viaMain = bridge()?.swipeHistory;
    if (viaMain) void viaMain(direction).catch(() => undefined);
    else void navigate(direction === 'back' ? -1 : 1);
  };
  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (!enabled.current) return;
    const fresh = !gesture.current || event.timeStamp - gesture.current.last > SWIPE.quietMs;
    if (fresh) began.current = window.location.href;
    let previous = gesture.current;
    if (previous && !fresh && began.current !== window.location.href) previous = { ...previous, phase: 'spent' };
    const step = feed(previous, {
      dx: event.deltaX, dy: event.deltaY, t: event.timeStamp, ctrl: event.ctrlKey, coarse: event.deltaMode !== 0,
    }, { canGo, claimed: (direction) => claimed(event.target, direction) });
    gesture.current = step.gesture;
    // The tail of a swipe that went leaves its arrow to fade on its own clock.
    if (step.gesture.phase === 'spent' && !step.go) return;
    window.clearTimeout(hide.current);
    if (step.go) {
      go(step.go);
      setShown({ toward: step.go, progress: 1, went: true });
      hide.current = window.setTimeout(() => setShown(null), 280);
      return;
    }
    setShown(step.toward && step.progress > 0 ? { toward: step.toward, progress: step.progress, went: false } : null);
    // A swipe that stops short of going is let go: its arrow leaves once the fingers have.
    hide.current = window.setTimeout(() => setShown(null), SWIPE.quietMs);
  });

  useEffect(() => {
    const listen = (event: WheelEvent) => onWheel(event);
    window.addEventListener('wheel', listen, { passive: true });
    return () => {
      window.removeEventListener('wheel', listen);
      window.clearTimeout(hide.current);
    };
  }, []);

  if (!shown) return null;
  return (
    <div
      className="swipe-arrow"
      data-toward={shown.toward}
      data-went={shown.went || undefined}
      style={{ '--swipe': shown.progress.toFixed(3) } as CSSProperties}
      aria-hidden="true"
    >
      <Icon name={shown.toward === 'back' ? 'back' : 'arrow'} />
    </div>
  );
}
