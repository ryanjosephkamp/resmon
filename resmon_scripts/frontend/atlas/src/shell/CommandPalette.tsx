import { useEffect, useId, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { PLACES, SECTIONS, SETTINGS } from '../routes';
import { useAppearance, type ThemeChoice } from '../theme/appearance';
import { Icon, type IconName } from './Icon';
import { keysText, shortcut, type ShortcutId } from './shortcuts';

interface Command {
  id: string;
  group: string;
  label: string;
  keywords: string;
  icon: IconName;
  /** Shown at the row's end: the current choice, or where it goes. */
  current?: boolean;
  /** Shown at the row's end: the shortcut that does the same from anywhere. */
  keys?: ShortcutId;
  run: () => void;
}

/**
 * Ranks what matches. Every word typed has to appear in the label or the
 * keywords; a label that starts with the query comes first, then a label that
 * contains it, then a keyword match. Order within a rank is the list's own.
 */
export function rank<T extends { label: string; keywords: string }>(items: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  const q = words.join(' ');
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    const hay = `${label} ${item.keywords.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) return;
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2;
    scored.push({ item, score, index });
  });
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((s) => s.item);
}

const THEMES: { choice: ThemeChoice; label: string; icon: IconName }[] = [
  { choice: 'system', label: 'Follow the system', icon: 'system' },
  { choice: 'light', label: 'Light', icon: 'sun' },
  { choice: 'dark', label: 'Dark', icon: 'moon' },
];

/** The commands the shell itself runs, in the order the palette lists them, with what each is also called. */
const SHELL_COMMANDS: readonly { id: ShortcutId; group: string; label: string; keywords: string; icon: IconName }[] = [
  { id: 'new-dive', group: 'Start', label: 'New Deep Dive', keywords: 'search ask the sources one source depth manual', icon: 'plus' },
  { id: 'new-sweep', group: 'Start', label: 'New Deep Sweep', keywords: 'search ask the sources several many sources manual', icon: 'plus' },
  { id: 'new-conversation', group: 'Start', label: 'New conversation', keywords: 'ask assistant chat question', icon: 'plus' },
  { id: 'ask', group: 'Start', label: 'Message the assistant', keywords: 'ask chat question composer write', icon: 'arrow' },
  { id: 'back', group: 'History', label: 'Back', keywords: 'go back previous page history', icon: 'back' },
  { id: 'forward', group: 'History', label: 'Forward', keywords: 'go forward next page history', icon: 'arrow' },
  { id: 'shortcuts', group: 'Help', label: 'Keyboard shortcuts', keywords: 'keys keyboard shortcuts hotkeys help', icon: 'search' },
];

/**
 * ⌘K: every screen, every appearance choice, and every command the shell
 * runs, by name, each with its shortcut where it has one. A modal <dialog>,
 * so the page behind it is inert and Escape closes it; the field is a
 * combobox over a listbox, so a screen reader hears the highlighted row as it
 * moves. The shell holds the dialog, so a shortcut pressed in it can close it
 * before doing what it says.
 *
 * Its field and list are drawn only while it is open. The shell draws again
 * on every change of screen, and so does anything that navigates; a
 * controlled field drawn again has its `name` and `type` written again, so a
 * closed palette's field was changing the page each time a screen opened.
 */
export function CommandPalette({ open, onClose, onRun, dialog, mac }: PaletteProps) {
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
      node.querySelector('input')?.focus();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open, dialog]);

  return (
    <dialog
      ref={dialog}
      className="palette"
      data-shell-dialog=""
      aria-label="Search commands"
      // A close event is queued, and a key can be handled before it: one that
      // arrives after the palette has been opened again is not this opening's.
      onClose={() => { if (!dialog.current?.open) onClose(); }}
      onCancel={onClose}
      onMouseDown={(event) => { if (event.target === dialog.current) onClose(); }}
    >
      {open && <PaletteBody onClose={onClose} onRun={onRun} dialog={dialog} mac={mac} />}
    </dialog>
  );
}

interface PaletteProps {
  open: boolean;
  onClose: () => void;
  /** Runs one of the shell's own commands, as its shortcut would. */
  onRun: (id: ShortcutId) => void;
  dialog: RefObject<HTMLDialogElement | null>;
  mac: boolean;
}

/** The field and the commands, for one opening: each opening starts with an empty field and the first row. */
function PaletteBody({ onClose, onRun, dialog, mac }: Omit<PaletteProps, 'open'>) {
  const navigate = useNavigate();
  const { stored, save } = useAppearance();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  const commands = useMemo<Command[]>(() => [
    ...SHELL_COMMANDS.filter((c) => c.group === 'Start').map((c) => ({ ...c, keys: c.id, run: () => onRun(c.id) })),
    ...[...SECTIONS, SETTINGS].map((section, index) => ({
      id: `go:${section.path}`,
      group: 'Go to',
      label: section.label,
      keywords: section.keywords,
      icon: 'arrow' as const,
      keys: (section === SETTINGS ? 'settings' : `section-${index + 1}`) as ShortcutId,
      run: () => navigate(section.path),
    })),
    ...PLACES.map((place) => ({
      id: `go:${place.path}`,
      group: 'Go to',
      label: place.label,
      keywords: place.keywords,
      icon: 'arrow' as const,
      run: () => navigate(place.path),
    })),
    ...SHELL_COMMANDS.filter((c) => c.group === 'History').map((c) => ({ ...c, keys: c.id, run: () => onRun(c.id) })),
    ...THEMES.map(({ choice, label, icon }) => ({
      id: `theme:${choice}`,
      group: 'Theme',
      label,
      keywords: `theme appearance ${choice} mode`,
      icon,
      current: stored.theme === choice,
      run: () => save({ theme: choice }),
    })),
    {
      id: 'accent:choose',
      group: 'Accent color',
      label: 'Choose an accent color',
      keywords: 'accent color colour picker',
      icon: 'drop',
      run: () => navigate(`${SETTINGS.path}?focus=accent`),
    },
    {
      id: 'accent:default',
      group: 'Accent color',
      label: 'Use the default accent',
      keywords: 'accent color colour reset amber',
      icon: 'reset',
      current: stored.accent === null,
      run: () => save({ accent: null }),
    },
    ...SHELL_COMMANDS.filter((c) => c.group === 'Help').map((c) => ({ ...c, keys: c.id, run: () => onRun(c.id) })),
  ], [navigate, save, stored, onRun]);

  const shown = useMemo(() => rank(commands, query), [commands, query]);
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));
  const activeCommand = shown[activeIndex];

  useEffect(() => {
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listId]);

  // Closed before the command runs, so the focus it hands back goes where it was, and the command can then move it.
  const choose = (command: Command | undefined) => {
    if (!command) return;
    dialog.current?.close();
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const last = shown.length - 1;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(activeIndex >= last ? 0 : activeIndex + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(activeIndex <= 0 ? last : activeIndex - 1); }
    else if (event.key === 'Home' && event.ctrlKey) { event.preventDefault(); setActive(0); }
    else if (event.key === 'End' && event.ctrlKey) { event.preventDefault(); setActive(last); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(activeCommand); }
  };

  return (
    <>
      <div className="palette-field">
        <Icon name="search" />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeCommand ? `${listId}-${activeIndex}` : undefined}
          aria-label="Search commands"
          placeholder="Go to a screen, start a search, or change the theme"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        <kbd aria-hidden="true">esc</kbd>
      </div>
      <ul id={listId} role="listbox" aria-label="Commands" className="palette-list">
        {shown.map((command, index) => {
          const header = index === 0 || shown[index - 1]?.group !== command.group ? command.group : null;
          return [
            header && <li key={`h:${header}`} role="presentation" className="palette-group">{header}</li>,
            <li
              key={command.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className="palette-row"
              onMouseMove={() => { if (index !== activeIndex) setActive(index); }}
              onClick={() => choose(command)}
            >
              <Icon name={command.icon} />
              <span className="palette-label">{command.label}</span>
              {command.current && <span className="palette-current"><Icon name="check" size={14} />Current</span>}
              {command.keys && <kbd className="palette-keys">{keysText(shortcut(command.keys).chord, mac)}</kbd>}
            </li>,
          ];
        })}
      </ul>
      {shown.length === 0 && (
        <p className="palette-empty" role="status">Nothing matches “{query.trim()}”.</p>
      )}
    </>
  );
}
