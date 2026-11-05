interface NavigationHistory { canGoBack?: boolean; canGoForward?: boolean }

/**
 * Whether there is a page to go to this way. The renderer is a HashRouter, so
 * every page change is a history entry, and the Navigation API knows where in
 * them the window is. Where it is missing, back is judged by the history's
 * length and forward is assumed, which at worst asks for a page that is not
 * there and moves nowhere.
 */
export function canGo(direction: 'back' | 'forward'): boolean {
  const navigation = (window as unknown as { navigation?: NavigationHistory }).navigation;
  if (navigation && typeof navigation.canGoBack === 'boolean') {
    return direction === 'back' ? navigation.canGoBack : !!navigation.canGoForward;
  }
  return direction === 'back' ? window.history.length > 1 : true;
}

/** The page the window shows, without its search: the hash router's path, after the document's. */
function windowPage(): string {
  return `${window.location.pathname}${window.location.hash.split('?')[0]}`;
}

/**
 * `settle` once `ms` have passed, unless the window has gone to another page
 * meanwhile; the cancel, for an effect's cleanup.
 *
 * For a pause in typing that ends by writing the address. That write is made
 * relative to the screen's own address and replaces it. A navigation away
 * (Read on a card, a link, a key) changes the window's address at once, but
 * the router draws the new page in a transition, so the screen and its pause
 * are still there while that is drawn. A pause that ended then put the
 * screen's own address back over the new page's, and the window went back to
 * the screen. A change of the search alone (a shelf, an order, a filter) is
 * the same screen, and the pause settles as before. A memory router, as in a
 * test, leaves the window's address alone, and the pause always settles.
 */
export function afterPause(ms: number, settle: () => void): () => void {
  const from = windowPage();
  const timer = window.setTimeout(() => { if (windowPage() === from) settle(); }, ms);
  return () => window.clearTimeout(timer);
}
