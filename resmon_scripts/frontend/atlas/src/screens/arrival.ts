import { useEffect } from 'react';
import { useNavigationType } from 'react-router-dom';
import { isTyping } from '../shell/shortcuts';

/**
 * Put the caret in a page's field when the page is arrived at, so typing can
 * start at once: on a link, a tab, a shortcut, or the palette, but not on
 * Back or Forward (or a reload), which return to a page as it was left, and
 * not when another field already has the caret.
 */
export function useFocusOnArrival(id: string): void {
  const arrival = useNavigationType();
  useEffect(() => {
    if (arrival === 'POP' || isTyping(document.activeElement)) return;
    document.getElementById(id)?.focus();
    // Once, on arriving; a later render is not an arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
