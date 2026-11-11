import { useCallback, useRef } from 'react';

/**
 * Keeps a source form's scroll padding equal to its two pinned bars: the source list's heads at the
 * top of the column (`.catalog-top`) and the action bar at its foot (`.ask-go`). A row scrolled into
 * view, or a field reached with Tab, then lands between the bars rather than under one, however tall
 * either grows with what it holds: Select All and the filter above, the notes below.
 *
 * The heights are written to the form as `--ask-top-bar` and `--ask-foot-bar`, which `atlas.css`
 * reads into `scroll-padding`. Without ResizeObserver (jsdom), the stylesheet's fallbacks stand.
 */
export function useStickyClearance(): (form: HTMLElement | null) => void {
  const stop = useRef<(() => void) | null>(null);
  return useCallback((form: HTMLElement | null) => {
    stop.current?.();
    stop.current = null;
    if (!form || typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return;
    const measure = () => {
      const top = form.querySelector<HTMLElement>('.catalog-top');
      const foot = form.querySelector<HTMLElement>('.ask-go');
      form.style.setProperty('--ask-top-bar', `${top?.offsetHeight ?? 0}px`);
      form.style.setProperty('--ask-foot-bar', `${foot?.offsetHeight ?? 0}px`);
    };
    const sizes = new ResizeObserver(measure);
    let watched: HTMLElement[] = [];
    const watch = () => {
      const bars = Array.from(form.querySelectorAll<HTMLElement>('.catalog-top, .ask-go'));
      if (bars.length !== watched.length || bars.some((bar, index) => bar !== watched[index])) {
        sizes.disconnect();
        bars.forEach((bar) => sizes.observe(bar));
        watched = bars;
      }
      measure();
    };
    // A bar can mount after the form does (the catalog waits for its sources).
    const tree = new MutationObserver(watch);
    tree.observe(form, { childList: true, subtree: true });
    watch();
    stop.current = () => { sizes.disconnect(); tree.disconnect(); };
  }, []);
}
