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
