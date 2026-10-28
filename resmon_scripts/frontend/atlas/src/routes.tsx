import type { ReactElement } from 'react';
import { Placeholder } from './screens/Placeholder';
import { Run } from './screens/Run';
import { Search } from './screens/Search';
import { Settings } from './screens/Settings';
import { Today } from './screens/Today';

export interface Section {
  path: string;
  label: string;
  /** Words the command palette also matches, beyond the label. */
  keywords: string;
  element: ReactElement;
}

/**
 * The top bar's sections, in its order: the one route table, so the bar, the
 * command palette and the router cannot disagree about what exists.
 */
export const SECTIONS: readonly Section[] = [
  { path: '/today', label: 'Today', keywords: 'new papers morning plate index', element: <Today /> },
  { path: '/watches', label: 'Watches', keywords: 'routines constellations profiles', element: <Placeholder title="Watches" /> },
  { path: '/search', label: 'Search', keywords: 'find papers corpus deep dive sweep runs export', element: <Search /> },
  { path: '/library', label: 'Library', keywords: 'saved reading queue files', element: <Placeholder title="Library" /> },
  { path: '/ask', label: 'Ask', keywords: 'assistant question chat', element: <Placeholder title="Ask" /> },
  { path: '/health', label: 'Health', keywords: 'sources coverage diagnostics watchdog', element: <Placeholder title="Health" /> },
];

export const SETTINGS: Section = {
  path: '/settings',
  label: 'Settings',
  keywords: 'preferences appearance theme accent color',
  element: <Settings />,
};

/**
 * Screens reached from a section rather than from the top bar: a run is
 * opened from Search's run log, from a notification, or from Today.
 */
export const DETAILS: readonly { path: string; element: ReactElement }[] = [
  { path: '/runs/:id', element: <Run /> },
];

export const HOME = '/today';
