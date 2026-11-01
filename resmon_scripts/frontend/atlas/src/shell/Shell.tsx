import { useCallback, useEffect, useEffectEvent, useRef, useState, type MouseEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { HOME, SECTIONS, SETTINGS } from '../routes';
import { bridge, isMac } from '../bridge';
import { useAsk } from '../screens/ask/AskProvider';
import { startSearch, type SearchKind } from '../screens/searchStart';
import { CommandPalette } from './CommandPalette';
import { EngineNotice } from './EngineNotice';
import { canGo } from './history';
import { Icon } from './Icon';
import { NewSearch } from './NewSearch';
import { ShortcutsSheet } from './ShortcutsSheet';
import { ShowShortcutsContext } from './shortcutsSheetContext';
import { SwipeNavigation } from './SwipeNavigation';
import {
  COMMAND_ENTER_CHORD, ariaKeys, blockingDialogOpen, commandEnterAction, isMenuCommand, isTyping, keysText, pressed, sectionIndex,
  shortcut, shortcutFor, type ShortcutId,
} from './shortcuts';

const HOME_LABEL = SECTIONS.find((section) => section.path === HOME)?.label ?? 'Today';

/**
 * A click on the bar leaves the focus where it was, as a toolbar does, so the
 * next key pressed (Shift, for a screenshot) does not ring the tab that was
 * clicked. The keyboard still reaches every control in the bar with Tab.
 */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/** The frame every screen sits in: the top bar, the screen, the palette, and the keyboard's shortcuts. */
export function Shell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const palette = useRef<HTMLDialogElement>(null);
  const sheet = useRef<HTMLDialogElement>(null);
  const mac = isMac();
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const showSheet = useCallback(() => {
    palette.current?.close();
    setPaletteOpen(false);
    setSheetOpen(true);
  }, []);
  const navigate = useNavigate();
  const location = useLocation();
  const { answering, requestFocus, select } = useAsk();

  // The shell's own dialogs close before a command runs: closing one hands the
  // focus back to where it was, so closing it later would take back the caret
  // the command had just put somewhere.
  const closeDialogs = () => {
    palette.current?.close();
    sheet.current?.close();
    setPaletteOpen(false);
    setSheetOpen(false);
  };

  // A screen opened again from itself replaces its page rather than adding one.
  const go = (path: string) => void navigate(path, { replace: location.pathname === path });
  const newSearch = (kind: SearchKind) => {
    const { to, options } = startSearch(kind, location);
    void navigate(to, options);
  };

  const run = (id: ShortcutId) => {
    if (id === 'palette') {
      sheet.current?.close();
      setSheetOpen(false);
      setPaletteOpen((open) => !open);
      return;
    }
    if (id === 'shortcuts') {
      palette.current?.close();
      setPaletteOpen(false);
      setSheetOpen((open) => !open);
      return;
    }
    closeDialogs();
    const section = sectionIndex(id);
    if (section !== null) {
      const target = SECTIONS[section];
      if (target) go(target.path);
      return;
    }
    switch (id) {
      case 'ask':
        go('/ask');
        requestFocus();
        break;
      case 'new-conversation':
        select(null);
        go('/ask');
        requestFocus();
        break;
      case 'new-dive':
        newSearch('dive');
        break;
      case 'new-sweep':
        newSearch('sweep');
        break;
      case 'settings':
        go(SETTINGS.path);
        break;
      case 'back':
        if (canGo('back')) void navigate(-1);
        break;
      case 'forward':
        if (canGo('forward')) void navigate(1);
        break;
    }
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    // ⌘Enter in a field that opted in: its place's primary action (`commandEnterAction`).
    if (pressed(COMMAND_ENTER_CHORD, event, mac)) {
      const act = commandEnterAction(event.target);
      if (!act) return;
      event.preventDefault();
      const inside = event.target instanceof Element && !!event.target.closest('dialog[open]');
      if (event.repeat || (blockingDialogOpen(document) && !inside)) return;
      act();
      return;
    }
    const found = shortcutFor(event, mac);
    // `?` is a question mark in a text field; the ⌘ shortcuts work in one.
    if (!found || (!found.chord.command && isTyping(event.target))) return;
    // Taken even when nothing is done with it, so the app menu does not act on it either.
    event.preventDefault();
    if (blockingDialogOpen(document)) return;
    if (event.repeat && found.id !== 'back' && found.id !== 'forward') return;
    run(found.id);
  });
  useEffect(() => {
    const listen = (event: KeyboardEvent) => onKey(event);
    window.addEventListener('keydown', listen);
    return () => window.removeEventListener('keydown', listen);
  }, []);

  // The app menu's New Conversation, New Deep Dive, New Deep Sweep, Settings,
  // and Keyboard Shortcuts, sent by the main process (`electron/main.ts`).
  const onMenu = useEffectEvent((command: string) => {
    if (!isMenuCommand(command) || blockingDialogOpen(document)) return;
    if (command === 'shortcuts') showSheet();
    else run(command);
  });
  useEffect(() => bridge()?.onCommand?.((command) => onMenu(command)), []);

  const keys = (id: ShortcutId) => ariaKeys(shortcut(id).chord, mac);

  return (
    <div className={mac ? 'frame is-mac' : 'frame'}>
      <header className="bar">
        <Link to={HOME} className="lockup" aria-label={`resmon, ${HOME_LABEL}`} onMouseDown={keepFocus}>
          <b aria-hidden="true">res</b><span aria-hidden="true">earch </span>
          <b aria-hidden="true">mon</b><span aria-hidden="true">itor</span>
        </Link>
        <nav className="tabs" aria-label="Sections">
          <ul>
            {SECTIONS.map((section, index) => (
              <li key={section.path}>
                <NavLink
                  to={section.path}
                  onMouseDown={keepFocus}
                  aria-keyshortcuts={[keys(`section-${index + 1}` as ShortcutId), section.path === '/ask' ? keys('ask') : '']
                    .filter(Boolean).join(' ')}
                >
                  {section.label}
                  {section.path === '/ask' && answering && <span className="tab-live" role="img" aria-label=", answering" />}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <span className="spacer" />
        <NewSearch mac={mac} onStart={newSearch} />
        <button
          type="button"
          className="cmdk"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
          aria-keyshortcuts={keys('palette')}
          title="Search commands"
        >
          <Icon name="search" />
          <span className="cmdk-label">Search commands</span>
          <kbd aria-hidden="true">{keysText(shortcut('palette').chord, mac)}</kbd>
        </button>
        <NavLink to={SETTINGS.path} className="iconbtn" aria-label={SETTINGS.label} title={SETTINGS.label}
          aria-keyshortcuts={keys('settings')} onMouseDown={keepFocus}>
          <Icon name="settings" />
        </NavLink>
      </header>
      <EngineNotice />
      <main className="stage">
        <ShowShortcutsContext value={showSheet}>
          <Outlet />
        </ShowShortcutsContext>
      </main>
      <CommandPalette open={paletteOpen} onClose={closePalette} onRun={run} dialog={palette} mac={mac} />
      <ShortcutsSheet open={sheetOpen} onClose={closeSheet} dialog={sheet} mac={mac} />
      <SwipeNavigation />
    </div>
  );
}
