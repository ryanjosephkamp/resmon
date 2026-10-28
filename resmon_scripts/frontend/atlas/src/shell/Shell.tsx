import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { SECTIONS, SETTINGS } from '../routes';
import { isMac } from '../bridge';
import { CommandPalette } from './CommandPalette';
import { Icon } from './Icon';

/** The frame every screen sits in: the top bar, the screen, the palette. */
export function Shell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const mac = isMac();
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((mac ? event.metaKey : event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mac]);

  return (
    <div className={mac ? 'frame is-mac' : 'frame'}>
      <header className="bar">
        <span className="lockup" role="img" aria-label="resmon">
          <b aria-hidden="true">res</b><span aria-hidden="true">earch </span>
          <b aria-hidden="true">mon</b><span aria-hidden="true">itor</span>
        </span>
        <nav className="tabs" aria-label="Sections">
          <ul>
            {SECTIONS.map((section) => (
              <li key={section.path}><NavLink to={section.path}>{section.label}</NavLink></li>
            ))}
          </ul>
        </nav>
        <span className="spacer" />
        <button
          type="button"
          className="cmdk"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
          aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
        >
          <Icon name="search" />
          <span>Search commands</span>
          <kbd aria-hidden="true">{mac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <NavLink to={SETTINGS.path} className="iconbtn" aria-label={SETTINGS.label} title={SETTINGS.label}>
          <Icon name="settings" />
        </NavLink>
      </header>
      <main className="stage">
        <Outlet />
      </main>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}
