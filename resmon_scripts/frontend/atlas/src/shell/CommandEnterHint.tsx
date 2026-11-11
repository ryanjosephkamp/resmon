import { isMac } from '../bridge';
import { COMMAND_ENTER_CHORD, ariaKeys, keysText } from './shortcuts';

/** `aria-keyshortcuts` for a button that ⌘Enter in its fields presses. */
export function commandEnterKeys(): string {
  return ariaKeys(COMMAND_ENTER_CHORD, isMac());
}

/**
 * The ⌘↩ beside a button that ⌘Enter in its fields presses (`commandEnter` in
 * `shortcuts.ts`): said once, quietly, where there is room for it. The button
 * names the keys to a screen reader with `commandEnterKeys`.
 */
export function CommandEnterHint() {
  const mac = isMac();
  return (
    <kbd className="enter-hint" aria-hidden="true" title={mac ? '⌘Return in a field here does this' : 'Ctrl+Enter in a field here does this'}>
      {keysText(COMMAND_ENTER_CHORD, mac)}
    </kbd>
  );
}
