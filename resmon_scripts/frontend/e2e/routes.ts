/**
 * The renderer's routes, **copied by hand** from `src/App.tsx`'s `<Routes>`
 * block at commit 8fa38ba.
 *
 * It is a copy on purpose, and this comment is the record of that. Making the
 * route table the single source of truth — exporting it from `App.tsx` and
 * importing it here — is a change to `src/**`, which this spike is not
 * permitted to make, and it is phase 1.8.7's decision rather than a spike's.
 * Until then, adding a route to `App.tsx` without adding it here leaves the
 * new route unswept and nothing fails. That gap is stated in
 * `docs/ui-verification-feasibility.md` and is the denominator caveat on P2.
 *
 * `path` is what goes after the `#` — the app is a `HashRouter`.
 * The two splat routes (`/settings/*`, `/about-resmon/*`) redirect from their
 * index to a child, so `redirectsTo` records where they actually land.
 */
export interface RouteEntry {
  /** Hash path, exactly as `App.tsx` declares it, minus the `/*` splat. */
  path: string;
  /** Filename-safe slug for the screenshot. */
  slug: string;
  /** Human name, used in the test title and the screenshot caption. */
  name: string;
  /** Where an index redirect lands, for the routes that have one. */
  redirectsTo?: string;
}

const APP_ROUTES: RouteEntry[] = [
  { path: '/', slug: '01-dashboard', name: 'Dashboard' },
  { path: '/dive', slug: '02-deep-dive', name: 'Deep Dive' },
  { path: '/sweep', slug: '03-deep-sweep', name: 'Deep Sweep' },
  { path: '/routines', slug: '04-routines', name: 'Routines' },
  { path: '/calendar', slug: '05-calendar', name: 'Calendar' },
  { path: '/results', slug: '06-results', name: 'Results' },
  { path: '/analytics', slug: '07-analytics', name: 'Analytics' },
  { path: '/watchdog', slug: '08-watchdog', name: 'Watchdog' },
  { path: '/explorer', slug: '09-explorer', name: 'Explorer' },
  { path: '/configurations', slug: '10-configurations', name: 'Configurations' },
  { path: '/monitor', slug: '11-monitor', name: 'Monitor' },
  { path: '/repositories', slug: '12-repositories', name: 'Repositories' },
  { path: '/settings', slug: '13-settings', name: 'Settings', redirectsTo: '/settings/email' },
  {
    path: '/about-resmon',
    slug: '14-about-resmon',
    name: 'About resmon',
    redirectsTo: '/about-resmon/tutorials',
  },
];

/**
 * `RESMON_E2E_BREAK_ROUTE=/no-such-page` appends a route that `App.tsx` does
 * not declare.
 *
 * This is how "the CI job fails when a route fails to load" is *demonstrated*
 * rather than asserted — `ui-smoke.yml` takes a `break_route` input that sets
 * it. React Router renders nothing for an unmatched path while the sidebar and
 * header paint normally, so it reproduces the exact failure a smoke suite must
 * catch and the exact one a body-level assertion misses.
 *
 * It is deliberately not a code change: a demonstration that needs a commit to
 * reproduce stops being reproducible the moment the commit is reverted.
 */
export const ROUTES: RouteEntry[] = process.env.RESMON_E2E_BREAK_ROUTE
  ? [
    ...APP_ROUTES,
    {
      path: process.env.RESMON_E2E_BREAK_ROUTE,
      slug: '99-deliberately-broken',
      name: 'Deliberately broken route',
    },
  ]
  : APP_ROUTES;
