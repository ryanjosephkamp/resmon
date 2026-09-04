/**
 * Every page the renderer can show, in one list, so that nothing can add a
 * page without the verification layer noticing.
 *
 * `App.tsx` renders from this table rather than from hand-written `<Route>`
 * JSX, and `e2e/routes.ts` imports it rather than keeping a copy. That is the
 * whole point of the file: before it, `e2e/routes.ts` was a hand copy of
 * `App.tsx`'s `<Routes>` block, so a route added to the app and not to the
 * copy was unswept and **nothing failed** — the weakest denominator in the
 * spike's ledger and the first thing phase 1.8.7 was asked to fix.
 * `mcp_server.TOOLS` is the model: a surface with a list in the code, and
 * checks parametrised over the list.
 *
 * Deliberately zero imports. The Playwright suite loads this module outside
 * webpack, outside jsdom and outside React, so anything it pulled in would
 * have to load there too.
 *
 * **What is data here and what is derived.** `path` is the only navigational
 * fact written down; `hash` is computed from it, and for the two splat routes
 * both the child list and the index redirect are *parsed out of the page's own
 * source* by `src/__tests__/routes.test.ts` and asserted against this table.
 * A hand-maintained field is a field that drifts, so there are as few as the
 * shape allows.
 */

/** One top-level route: a `<Route>` in `App.tsx`. */
export interface AppRoute {
  /** Exactly what `<Route path=...>` receives, splat included. */
  path: string;
  /** Human name. Used in the sidebar-independent test titles and captions. */
  name: string;
  /**
   * For a splat route, the page module whose own `<Routes>` block declares the
   * children below. The guard test parses that file and fails when the two
   * disagree, so a new Settings tab cannot appear unswept.
   */
  childrenFrom?: string;
  /** Child paths, relative, exactly as the parent page declares them. */
  children?: string[];
  /** Where the parent's index route redirects, as an absolute hash. */
  redirectsTo?: string;
}

export const APP_ROUTES: readonly AppRoute[] = [
  { path: '/', name: 'Dashboard' },
  { path: '/dive', name: 'Deep Dive' },
  { path: '/sweep', name: 'Deep Sweep' },
  { path: '/routines', name: 'Routines' },
  { path: '/calendar', name: 'Calendar' },
  { path: '/results', name: 'Results' },
  { path: '/analytics', name: 'Analytics' },
  { path: '/watchdog', name: 'Watchdog' },
  { path: '/explorer', name: 'Explorer' },
  { path: '/configurations', name: 'Configurations' },
  { path: '/monitor', name: 'Monitor' },
  { path: '/repositories', name: 'Repositories' },
  {
    path: '/settings/*',
    name: 'Settings',
    childrenFrom: 'pages/SettingsPage.tsx',
    children: ['email', 'cloud', 'ai', 'storage', 'notifications', 'advanced'],
    redirectsTo: '/settings/email',
  },
  {
    path: '/about-resmon/*',
    name: 'About resmon',
    childrenFrom: 'pages/AboutResmonPage.tsx',
    children: ['tutorials', 'issues', 'blog', 'about-app'],
    redirectsTo: '/about-resmon/tutorials',
  },
];

/** The hash a user navigates to for a route — the path without its splat. */
export function routeHash(route: AppRoute): string {
  return route.path.endsWith('/*') ? route.path.slice(0, -2) : route.path;
}

/**
 * Every hash the app can show, parent and child alike, in navigation order.
 *
 * The smoke suite's denominator. A parent with children contributes its own
 * hash (which lands on the index redirect) **and** one hash per child, because
 * a Settings tab that throws on mount is a page a user sees and the parent's
 * hash would never reach it.
 */
export function allRouteHashes(): { hash: string; name: string; redirectsTo?: string }[] {
  const out: { hash: string; name: string; redirectsTo?: string }[] = [];
  for (const route of APP_ROUTES) {
    const base = routeHash(route);
    out.push({ hash: base, name: route.name, redirectsTo: route.redirectsTo });
    for (const child of route.children ?? []) {
      out.push({ hash: `${base}/${child}`, name: `${route.name} — ${child}` });
    }
  }
  return out;
}
