import { createContext, useContext } from 'react';

/** Opens the Keyboard Shortcuts sheet, which the shell holds, from a screen (Settings › About resmon). */
export const ShowShortcutsContext = createContext<(() => void) | null>(null);

/** The way to open the Keyboard Shortcuts sheet; null outside the shell. */
export function useShowShortcuts(): (() => void) | null {
  return useContext(ShowShortcutsContext);
}
