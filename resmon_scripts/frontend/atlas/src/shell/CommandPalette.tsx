import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { SECTIONS, SETTINGS } from '../routes';
import { useAppearance, type ThemeChoice } from '../theme/appearance';
import { Icon, type IconName } from './Icon';

interface Command {
  id: string;
  group: string;
  label: string;
  keywords: string;
  icon: IconName;
  /** Shown at the row's end: the current choice, or where it goes. */
  current?: boolean;
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

/**
 * ⌘K: every screen and every appearance choice, by name. A modal <dialog>, so
 * the page behind it is inert and Escape closes it; the field is a combobox
 * over a listbox, so a screen reader hears the highlighted row as it moves.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { stored, save } = useAppearance();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  const commands = useMemo<Command[]>(() => [
    ...[...SECTIONS, SETTINGS].map((section) => ({
      id: `go:${section.path}`,
      group: 'Go to',
      label: section.label,
      keywords: section.keywords,
      icon: 'arrow' as const,
      run: () => navigate(section.path),
    })),
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
  ], [navigate, save, stored]);

  const shown = useMemo(() => rank(commands, query), [commands, query]);
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));
  const activeCommand = shown[activeIndex];

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      setQuery('');
      setActive(0);
      node.showModal();
      input.current?.focus();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  useEffect(() => {
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listId]);

  const choose = (command: Command | undefined) => {
    if (!command) return;
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
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Search commands"
      onClose={onClose}
      onCancel={onClose}
      onMouseDown={(event) => { if (event.target === dialog.current) onClose(); }}
    >
      <div className="palette-field">
        <Icon name="search" />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeCommand ? `${listId}-${activeIndex}` : undefined}
          aria-label="Search commands"
          placeholder="Go to a screen, or change the theme"
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
            </li>,
          ];
        })}
      </ul>
      {shown.length === 0 && (
        <p className="palette-empty" role="status">Nothing matches “{query.trim()}”.</p>
      )}
    </dialog>
  );
}
