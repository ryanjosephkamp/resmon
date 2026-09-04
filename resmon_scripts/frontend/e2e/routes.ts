/**
 * The routes the smoke suite sweeps — **imported** from `src/routes.ts`, not
 * copied from it.
 *
 * This file used to be a hand copy of `App.tsx`'s `<Routes>` block, because the
 * spike that wrote it was not permitted to change `src/**`. The cost was
 * written down at the time and it was the biggest residual risk in that
 * report: a route added to the app and not to the copy was unswept and nothing
 * failed. Phase 1.8.7 exported the table instead, so a page cannot exist
 * without a smoke test — adding one to `App.tsx` without adding it to
 * `src/routes.ts` fails `src/__tests__/routes.test.tsx`, and adding it to
 * `src/routes.ts` puts it in `ROUTES` below automatically.
 *
 * The denominator is therefore `allRouteHashes()` in `src/routes.ts`: every
 * top-level route plus every Settings and About tab those pages declare.
 */
import { allRouteHashes } from '../src/routes';

export interface RouteEntry {
  /** Hash path — what goes after the `#`; the app is a `HashRouter`. */
  path: string;
  /** Filename-safe slug for the screenshot. Derived, never written down. */
  slug: string;
  /** Human name, used in the test title and the screenshot caption. */
  name: string;
  /** Where a parent route's index redirect lands, for the two that have one. */
  redirectsTo?: string;
}

/**
 * `About resmon — blog` → `about-resmon-blog`.
 *
 * The number prefix is the route's position, so the screenshots sort the way
 * the sidebar reads. Routes own **01–29**; a spec that screenshots something
 * other than a route (a tab, a seeded zero) numbers from 30, so adding a page
 * cannot silently overwrite another spec's evidence. It did: a fifteenth route
 * and `15-search-record-tab.png` collided in the first review run.
 */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const APP_ROUTES: RouteEntry[] = allRouteHashes().map((entry, i) => ({
  path: entry.hash,
  slug: `${String(i + 1).padStart(2, '0')}-${slugify(entry.name)}`,
  name: entry.name,
  redirectsTo: entry.redirectsTo,
}));

/**
 * `RESMON_E2E_BREAK_ROUTE=/no-such-page` appends a route `App.tsx` does not
 * declare.
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
