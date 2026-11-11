import { useEffect, useLayoutEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { bridge, isMac, type WindowState } from '../bridge';
import { APPEARANCE_KEY, useAppearance } from '../theme/appearance';
import { WEB_LINKS_KEY, readWebLinks } from './webLinks';
import { TOP_BAR_KEY } from './useTopBar';
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
 * and the look (the theme, the accent, the run monitor's switch, and the top
 * bar's arrangement) read again when another window changes it, as the main
 * process tells this one (`relayToOtherWindows`), and when this window comes
 * to the front. The look is otherwise read once, and nothing else here is held
 * that long: a page reads its data again each time it opens.
 */
export function WindowFrame() {
  const { pathname } = useLocation();
  const client = useQueryClient();
  // The system's own parts of the window (macOS's tab bar, the dialogs) follow the theme the app shows.
  const { shown } = useAppearance();
  useEffect(() => { bridge()?.setThemeSource?.(shown.theme); }, [shown.theme]);
  // Where a followed link opens: the main process opens links, and holds what a window last read here.
  const links = useQuery({ queryKey: WEB_LINKS_KEY, queryFn: readWebLinks, staleTime: Infinity });
  useEffect(() => { if (links.data) bridge()?.setWebLinks?.(links.data); }, [links.data]);
  useEffect(() => {
    const refresh = () => {
      // Not while this window's own change is on its way: its answer is the one to show.
      if (client.isMutating() !== 0) return;
      void client.invalidateQueries({ queryKey: APPEARANCE_KEY });
      void client.invalidateQueries({ queryKey: TOP_BAR_KEY });
      void client.invalidateQueries({ queryKey: WEB_LINKS_KEY });
    };
    window.addEventListener('focus', refresh);
    const stop = bridge()?.onAppearanceChanged?.(refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      stop?.();
    };
  }, [client]);
  useEffect(() => {
    const title = windowTitle(pathname, isMac());
    document.title = title;
    bridge()?.setWindowTitle?.(title);
  }, [pathname]);
  // Before the first paint, so a new tab never draws its bar under the tab bar first.
  useLayoutEffect(() => {
    const api = bridge();
    applyWindowState(api?.windowState?.());
    return api?.onWindowState?.((state) => applyWindowState(state));
  }, []);
  return null;
}
