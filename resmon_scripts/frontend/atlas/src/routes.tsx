import type { ReactElement } from 'react';
import { Ask } from './screens/ask/Ask';
import { Collection } from './screens/collection/Collection';
import { Analytics } from './screens/health/Analytics';
import { Engine } from './screens/health/Engine';
import { SourceWall } from './screens/health/SourceWall';
import { Watchdog } from './screens/health/Watchdog';
import { Paper } from './screens/collection/Paper';
import { Saved } from './screens/collection/Saved';
import { SharedWording } from './screens/collection/SharedWording';
import { Evidence } from './screens/library/Evidence';
import { Files } from './screens/library/Files';
import { ReadingQueue } from './screens/library/ReadingQueue';
import { Run } from './screens/Run';
import { Search } from './screens/Search';
import { Settings } from './screens/Settings';
import { Today } from './screens/Today';
import { Watch } from './screens/watches/Watch';
import { WatchEditor } from './screens/watches/WatchEditor';
import { Watches } from './screens/watches/Watches';
import { People } from './screens/watches/people/People';
import { Person } from './screens/watches/people/Person';

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
  { path: '/watches', label: 'Watches', keywords: 'routines constellations profiles people authors orcid schedule calendar delivery coverage new watch create', element: <Watches /> },
  { path: '/search', label: 'Search', keywords: 'find papers collection corpus explorer deep dive sweep runs export shared wording text reuse passages', element: <Collection /> },
  { path: '/library', label: 'Library', keywords: 'saved reading queue to read files pdf owned library vault import evidence passages notes projects', element: <ReadingQueue /> },
  { path: '/ask', label: 'Ask', keywords: 'assistant question chat chats conversations saved transcript export model', element: <Ask /> },
  { path: '/health', label: 'Health', keywords: 'sources coverage diagnostics source wall watchdog findings broken analytics statistics charts keywords yield engine runtime identity', element: <SourceWall /> },
];

export const SETTINGS: Section = {
  path: '/settings',
  label: 'Settings',
  keywords: 'preferences appearance theme accent color background service daemon email smtp password notifications ai model key summaries summarize assistant claude provider',
  element: <Settings />,
};

/**
 * Screens reached from a section rather than from the top bar: a run is
 * opened from Search's run log, from a notification, or from Today.
 */
export const DETAILS: readonly { path: string; element: ReactElement }[] = [
  { path: '/search/ask', element: <Search /> },
  { path: '/search/saved', element: <Saved /> },
  { path: '/search/wording', element: <SharedWording /> },
  { path: '/settings/:group', element: <Settings /> },
  { path: '/library/files', element: <Files /> },
  { path: '/library/evidence', element: <Evidence /> },
  { path: '/health/watchdog', element: <Watchdog /> },
  { path: '/health/analytics', element: <Analytics /> },
  { path: '/health/engine', element: <Engine /> },
  { path: '/runs/:id', element: <Run /> },
  { path: '/papers/:id', element: <Paper /> },
  { path: '/watches/people', element: <People /> },
  { path: '/watches/people/:id', element: <Person /> },
  { path: '/watches/new', element: <WatchEditor /> },
  { path: '/watches/:id/edit', element: <WatchEditor /> },
  { path: '/watches/:id', element: <Watch /> },
];

export const HOME = '/today';
