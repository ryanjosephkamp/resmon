import { useEffect, useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { bridge, isMac, type WindowState } from '../bridge';
import { APPEARANCE_KEY, useAppearance } from '../theme/appearance';
import { windowTitle } from '../windowTitle';

export { windowTitle };

/**
 * The room left above the top bar for macOS's tab bar, which macOS draws over
 * the top of the window while the windows are in tabs (`electron/windows.ts`).
 * Set on the root, so the frame and anything fixed to the window's top move
 * down by the same amount.
 */
export function applyWindowState(state: WindowState | undefined, root: HTMLElement = document.documentElement): void {
  const strip = state && state.tabStrip > 0 ? Math.round(state.tabStrip) : 0;
  if (strip > 0) {
    root.style.setProperty('--tab-strip', `${strip}px`);
    root.dataset.tabStrip = String(strip);
  } else {
    root.style.removeProperty('--tab-strip');
    delete root.dataset.tabStrip;
  }
}

/**
 * The window's own frame: its title, from the screen it shows; the room for
 * macOS's tab bar; the system's own parts of the window in the app's theme;
 * and the theme and accent read again when the window comes to the front,
 * since another window may have changed them meanwhile. The appearance is
 * otherwise read once, and nothing else here is held that long: a page reads
 * its data again each time it opens.
 */
export function WindowFrame() {
  const { pathname } = useLocation();
  const client = useQueryClient();
  // The system's own parts of the window (macOS's tab bar, the dialogs) follow the theme the app shows.
  const { shown } = useAppearance();
  useEffect(() => { bridge()?.setThemeSource?.(shown.theme); }, [shown.theme]);
  useEffect(() => {
    const refresh = () => {
      // Not while this window's own change is on its way: its answer is the one to show.
      if (client.isMutating() === 0) void client.invalidateQueries({ queryKey: APPEARANCE_KEY });
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [client]);
  useEffect(() => {
    document.title = windowTitle(pathname, isMac());
  }, [pathname]);
  // Before the first paint, so a new tab never draws its bar under the tab bar first.
  useLayoutEffect(() => {
    const api = bridge();
    applyWindowState(api?.windowState?.());
    return api?.onWindowState?.((state) => applyWindowState(state));
  }, []);
  return null;
}
