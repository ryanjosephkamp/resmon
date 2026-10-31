import {
  createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine } from '../api/client';
import type { components } from '../api/schema';
import { accentProperties, accentTones, type ThemeName } from './accent';

/**
 * The theme and accent the person chose, as the engine keeps them
 * (`/api/appearance`). The engine is the record because this renderer's own
 * storage does not survive a launch: it is served from a new loopback port
 * each time, and localStorage belongs to the origin, port included.
 */
export type Appearance = components['schemas']['Appearance'];
export type ThemeChoice = Appearance['theme'];

export const APPEARANCE_KEY = ['appearance'] as const;
export const FALLBACK_APPEARANCE: Appearance = { theme: 'system', accent: null };

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function systemTheme(): ThemeName {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function resolveTheme(choice: ThemeChoice): ThemeName {
  return choice === 'system' ? systemTheme() : choice;
}

function paint(theme: ThemeName, accent: string | null): void {
  const root = document.documentElement;
  // Every color on the page changes in the same frame. Without this, each
  // element with a color transition would ease from the old theme on its own
  // schedule, and for a moment the page would be both.
  root.dataset.switching = '';
  root.dataset.theme = theme;
  for (const [name, value] of Object.entries(accentProperties(accentTones(accent, theme)))) {
    root.style.setProperty(name, value);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => { delete root.dataset.switching; }));
}

/** Puts an appearance on the page: `data-theme`, and the accent's tones. */
export function applyAppearance(appearance: Appearance): ThemeName {
  const theme = resolveTheme(appearance.theme);
  paint(theme, appearance.accent);
  return theme;
}

function subscribeToSystem(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export function readAppearance(): Promise<Appearance> {
  return answer(engine().GET('/api/appearance'));
}

export interface AppearanceState {
  /** What the engine holds (or the fallback, before it has answered). */
  stored: Appearance;
  /** What the page is drawing: a preview if one is open, else `stored`. */
  shown: Appearance;
  /** The theme in use once `system` is resolved. */
  theme: ThemeName;
  loadError: Error | null;
  saveError: Error | null;
  saving: boolean;
  /** Draws a change without storing it; null ends the preview. */
  preview: (change: Partial<Appearance> | null) => void;
  /** Stores a change, merged into the latest one asked for. */
  save: (change: Partial<Appearance>) => void;
}

const same = (a: Appearance, b: Appearance) =>
  a.theme === b.theme && (a.accent ?? '').toLowerCase() === (b.accent ?? '').toLowerCase();

const AppearanceContext = createContext<AppearanceState | null>(null);

/**
 * The one owner of the page's appearance. One, because each owner applies what
 * it holds to <html>, and two would overwrite each other's preview.
 *
 * `preview` draws a value without storing it, for the picker while it is being
 * dragged; `save` stores it. The page shows a save at once, and if the engine
 * refuses, reads the engine's value back and shows that, so what is drawn
 * never outlives a failure.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: APPEARANCE_KEY, queryFn: readAppearance, staleTime: Infinity });
  const stored = query.data ?? FALLBACK_APPEARANCE;
  const [previewing, setPreviewState] = useState<Appearance | null>(null);
  const shown = previewing ?? stored;

  // What the latest save asked for. A save merges into this rather than into
  // the stored value, because two saves made close together (a theme, then a
  // color) would otherwise each start from the value before either, and the
  // second would put back what the first changed. Measured, not supposed: the
  // Atlas journey lost a theme that way before this existed.
  const intent = useRef<Appearance | null>(null);

  // Following the system means following it while the app is open, too.
  const system = useSyncExternalStore(subscribeToSystem, systemTheme);
  const theme: ThemeName = shown.theme === 'system' ? system : shown.theme;
  // A layout effect, so <html> carries the theme before any screen's own
  // effects run: a canvas reads its colors from the page in an effect, and a
  // child's effects run before its parent's. Painted in an ordinary effect, the
  // first map drawn at launch read a page with no theme on it yet and kept
  // those colors, black, until something else asked it to draw again.
  useLayoutEffect(() => paint(theme, shown.accent), [theme, shown.accent]);

  const mutation = useMutation({
    // One PUT at a time, in the order they were made, so the engine ends on the
    // last one: two in flight at once may be handled in either order.
    scope: { id: 'appearance' },
    mutationFn: (next: Appearance) => answer(engine().PUT('/api/appearance', { body: next })),
    onSuccess: (saved) => {
      // The answer to an older save is not what to show while a newer one is
      // still on its way; the newer one's answer will follow it.
      if (intent.current && !same(intent.current, saved)) return;
      intent.current = null;
      client.setQueryData(APPEARANCE_KEY, saved);
    },
    onError: () => {
      // Whatever the page drew, the engine's own value is the one to show.
      intent.current = null;
      void client.invalidateQueries({ queryKey: APPEARANCE_KEY });
    },
    onSettled: () => setPreviewState(null),
  });

  const { mutate, error: saveError, isPending: saving } = mutation;

  const current = useCallback(
    () => intent.current ?? client.getQueryData<Appearance>(APPEARANCE_KEY) ?? FALLBACK_APPEARANCE,
    [client],
  );
  const save = useCallback((change: Partial<Appearance>) => {
    const next = { ...current(), ...change };
    intent.current = next;
    client.setQueryData(APPEARANCE_KEY, next);
    mutate(next);
  }, [client, current, mutate]);
  const preview = useCallback((change: Partial<Appearance> | null) => {
    setPreviewState(change ? { ...current(), ...change } : null);
  }, [current]);

  const value = useMemo<AppearanceState>(() => ({
    stored,
    shown,
    theme,
    loadError: query.error,
    saveError,
    saving,
    preview,
    save,
  }), [stored, shown, theme, query.error, saveError, saving, preview, save]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceState {
  const state = useContext(AppearanceContext);
  if (!state) throw new Error('useAppearance is used outside AppearanceProvider');
  return state;
}
