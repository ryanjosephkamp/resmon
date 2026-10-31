/**
 * Every screen the renderer shows at a fixed address, as plain data: the
 * sections, the screens within each, and Settings' groups, in the top bar's
 * order. A screen that needs an id (a run, a paper, a watch, a person) is not
 * here, because there is no address for it until something exists.
 *
 * Deliberately zero imports. The e2e suite, the journeys and the performance
 * harness load this module outside Vite and outside React, so anything it
 * pulled in would have to load there too. `__tests__/screenPaths.test.ts`
 * holds it to `routes.tsx` and to Settings' groups, so a screen cannot be
 * added to the router without being swept and measured.
 */
export interface ScreenPath {
  /** The hash route: what goes after the `#`. */
  path: string;
  /** The screen's name, as its section's tabs say it. */
  name: string;
}

export const SCREEN_PATHS: readonly ScreenPath[] = [
  { path: '/today', name: 'Today' },
  { path: '/watches', name: 'Watches › Searches' },
  { path: '/watches/calendar', name: 'Watches › Calendar' },
  { path: '/watches/people', name: 'Watches › People' },
  { path: '/watches/new', name: 'Watches › New watch' },
  { path: '/search', name: 'Search › Your collection' },
  { path: '/search/ask', name: 'Search › Ask the sources' },
  { path: '/search/saved', name: 'Search › Saved' },
  { path: '/search/wording', name: 'Search › Shared wording' },
  { path: '/library', name: 'Library › Reading queue' },
  { path: '/library/files', name: 'Library › Your files' },
  { path: '/library/evidence', name: 'Library › Evidence' },
  { path: '/ask', name: 'Ask' },
  { path: '/health', name: 'Health › Source wall' },
  { path: '/health/watchdog', name: 'Health › Watchdog' },
  { path: '/health/analytics', name: 'Health › Analytics' },
  { path: '/health/engine', name: 'Health › This engine' },
  { path: '/settings', name: 'Settings › Appearance' },
  { path: '/settings/background', name: 'Settings › In the background' },
  { path: '/settings/email', name: 'Settings › Email' },
  { path: '/settings/notifications', name: 'Settings › Notifications' },
  { path: '/settings/ai', name: 'Settings › AI' },
  { path: '/settings/sources', name: 'Settings › Sources' },
  { path: '/settings/storage', name: 'Settings › Backup' },
  { path: '/settings/tutorials', name: 'Settings › Tutorials' },
  { path: '/settings/about', name: 'Settings › About resmon' },
  { path: '/settings/danger', name: 'Settings › Danger zone' },
];
