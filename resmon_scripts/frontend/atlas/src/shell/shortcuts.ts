/**
 * The keyboard shortcuts: one table, so the keys the shell answers, the keys
 * the command palette shows beside a command, the Keyboard shortcuts sheet,
 * and the app menu's accelerators (`electron/main.ts`) cannot disagree.
 *
 * ⌘ on macOS and Ctrl elsewhere. Every shortcut but `?` holds that key, so it
 * works from inside a text field, where plain keys are typing. None takes a
 * key the app menu or the editing keys already use: ⌘W still closes the
 * window, and ⌘[ and ⌘] are the History menu's own pair.
 */

export type ShortcutId =
  | 'palette' | 'shortcuts' | 'ask' | 'new-conversation' | 'new-dive' | 'new-sweep'
  | 'section-1' | 'section-2' | 'section-3' | 'section-4' | 'section-5' | 'section-6'
  | 'settings' | 'back' | 'forward';

/** The commands the app menu sends the renderer (`resmon:command`), by the same ids. */
export const MENU_COMMANDS = ['new-conversation', 'new-dive', 'new-sweep', 'settings', 'shortcuts'] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];

export function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === 'string' && (MENU_COMMANDS as readonly string[]).includes(value);
}

/** A key, with ⌘ (Ctrl off macOS) and Shift or without. */
export interface Chord {
  key: string;
  command?: boolean;
  shift?: boolean;
  /** Only in `also`: the app menu answers those, and Alt+← is one. */
  alt?: boolean;
}

export interface Shortcut {
  id: ShortcutId;
  chord: Chord;
  /** A second chord that does the same, shown beside the first on the sheet only. */
  also?: { mac: Chord; other: Chord };
}

const cmd = (key: string, shift = false): Chord => ({ key, command: true, shift });

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'palette', chord: cmd('k') },
  { id: 'shortcuts', chord: { key: '?' } },
  { id: 'new-conversation', chord: cmd('n') },
  { id: 'new-dive', chord: cmd('d') },
  { id: 'new-sweep', chord: cmd('d', true) },
  { id: 'ask', chord: cmd('/') },
  { id: 'section-1', chord: cmd('1') },
  { id: 'section-2', chord: cmd('2') },
  { id: 'section-3', chord: cmd('3') },
  { id: 'section-4', chord: cmd('4') },
  { id: 'section-5', chord: cmd('5') },
  { id: 'section-6', chord: cmd('6') },
  { id: 'settings', chord: cmd(',') },
  // The History menu's alternates: ⌘← and ⌘→ on macOS, Alt+← and Alt+→ elsewhere (`installApplicationMenu`).
  { id: 'back', chord: cmd('['), also: { mac: cmd('ArrowLeft'), other: { key: 'ArrowLeft', alt: true } } },
  { id: 'forward', chord: cmd(']'), also: { mac: cmd('ArrowRight'), other: { key: 'ArrowRight', alt: true } } },
];

export function shortcut(id: ShortcutId): Shortcut {
  const found = SHORTCUTS.find((s) => s.id === id);
  if (!found) throw new Error(`No shortcut ${id}`);
  return found;
}

/** The section a ⌘1 to ⌘6 shortcut opens, counted from 0 in the top bar's order; null for any other. */
export function sectionIndex(id: ShortcutId): number | null {
  const match = /^section-(\d)$/.exec(id);
  return match ? Number(match[1]) - 1 : null;
}

/** The part of a keyboard event a shortcut is matched against. */
export interface KeyPress {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether this key press is the chord. ⌘ is the command key on macOS and Ctrl
 * elsewhere, and the other one, or Alt, held as well makes it a different
 * chord. A digit is also matched by its key's position, so ⌘1 works on a
 * layout that types another character there.
 */
export function pressed(chord: Chord, event: KeyPress, mac: boolean): boolean {
  const command = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (other || event.altKey || command !== !!chord.command) return false;
  // `?` is typed with Shift on most layouts, and with none on some.
  if (chord.key === '?') return event.key === '?';
  if (event.shiftKey !== !!chord.shift) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === chord.key) return true;
  return /^\d$/.test(chord.key) && event.code === `Digit${chord.key}`;
}

/** The shortcut this key press is, if any. */
export function shortcutFor(event: KeyPress, mac: boolean): Shortcut | null {
  return SHORTCUTS.find((s) => pressed(s.chord, event, mac)) ?? null;
}

const NAMED: Record<string, { mac: string; other: string }> = {
  ArrowLeft: { mac: '←', other: '←' }, ArrowRight: { mac: '→', other: '→' }, Enter: { mac: '↩', other: 'Enter' },
};

/**
 * The chord as this platform writes it: `⇧⌘D` on macOS, in Apple's modifier
 * order, and `Ctrl+Shift+D` elsewhere.
 */
export function keysText(chord: Chord, mac: boolean): string {
  const named = NAMED[chord.key];
  const key = chord.key.length === 1 ? chord.key.toUpperCase() : named ? named[mac ? 'mac' : 'other'] : chord.key;
  if (mac) return `${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.command ? '⌘' : ''}${key}`;
  return [chord.command && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', key].filter(Boolean).join('+');
}

const ARIA_KEYS: Record<string, string> = { '/': 'Slash', ',': 'Comma', '[': 'BracketLeft', ']': 'BracketRight' };

/** The chord for `aria-keyshortcuts`. */
export function ariaKeys(chord: Chord, mac: boolean): string {
  const key = ARIA_KEYS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  if (chord.key === '?') return '?';
  return [chord.command && (mac ? 'Meta' : 'Control'), chord.shift && 'Shift', key].filter(Boolean).join('+');
}

/**
 * ⌘Enter (Ctrl+Enter off macOS) in a field does its place's primary action:
 * saves the note, sends the message, saves the watch. A field opts in with
 * this attribute, or a form does for every field in it. Its value names the
 * button to press, by id; left empty, the form's own submit button is
 * pressed, as a click on it would. Nothing happens where that button is
 * disabled, so the place's own rule for when it can act still holds. Plain
 * Enter is left to the field.
 */
export const COMMAND_ENTER = 'data-command-enter';
export const COMMAND_ENTER_CHORD: Chord = { key: 'Enter', command: true };

/** Find in the document the Library's reader shows, while the keyboard is in its project (`Reader.tsx`). */
export const FIND_CHORD: Chord = { key: 'f', command: true };

/** A field's or a form's opt-in to ⌘Enter, for spreading onto it: the button to press, or its form's submit. */
export function commandEnter(button?: string): { 'data-command-enter': string } {
  return { [COMMAND_ENTER]: button ?? '' } as { 'data-command-enter': string };
}

/**
 * What ⌘Enter in this element does: the press of the button its opt-in names,
 * or of its form's submit button, or the form's submit where it has none.
 * Null where it has not opted in, or where that button is disabled.
 */
export function commandEnterAction(target: EventTarget | null): (() => void) | null {
  if (!(target instanceof Element)) return null;
  const holder = target.closest(`[${COMMAND_ENTER}]`);
  if (!holder) return null;
  const named = holder.getAttribute(COMMAND_ENTER);
  const form = holder instanceof HTMLFormElement ? holder
    : target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
      ? target.form ?? holder.closest('form') : holder.closest('form');
  const button = named
    ? holder.ownerDocument.getElementById(named)
    : form?.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]') ?? null;
  if (button) {
    if (!(button instanceof HTMLButtonElement || button instanceof HTMLInputElement) || button.matches(':disabled')) return null;
    return () => button.click();
  }
  return !named && form ? () => form.requestSubmit() : null;
}

/** Where a key is typing: a text field, a text area, a list box, or editable text. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(target.type);
}

/**
 * Whether a modal dialog the shortcuts must not reach past is open. The
 * shell's own (the command palette, the Keyboard shortcuts sheet) carry
 * `data-shell-dialog` and do not count: a shortcut pressed in one closes it
 * and does what it says.
 */
export function blockingDialogOpen(doc: Document): boolean {
  const modal = (dialog: Element) => {
    try { return dialog.matches(':modal'); } catch { return true; }
  };
  return Array.from(doc.querySelectorAll('dialog[open], [aria-modal="true"]'))
    .some((node) => !node.hasAttribute('data-shell-dialog') && (node.tagName !== 'DIALOG' || modal(node)));
}
