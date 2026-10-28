import type { ReactElement } from 'react';
import { Placeholder } from './screens/Placeholder';
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
  { path: '/search', label: 'Search', keywords: 'find papers corpus deep dive sweep', element: <Placeholder title="Search" /> },
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

export const HOME = '/today';
