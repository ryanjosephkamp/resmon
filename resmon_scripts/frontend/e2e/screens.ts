/**
 * The screens the smoke suite sweeps: every screen Atlas shows at a fixed
 * address, Settings' groups included, **imported** from
 * `atlas/src/screenPaths.ts`. `atlas/src/__tests__/screenPaths.test.ts` holds
 * that list to the router, so a screen added to the app is a screen with a
 * smoke test.
 */
import { SCREEN_PATHS } from '../atlas/src/screenPaths';

export interface ScreenEntry {
  /** Hash path: what goes after the `#`. */
  path: string;
  /** Filename-safe slug for the screenshot. Derived, never written down. */
  slug: string;
  /** The screen's name, used in the test title and the screenshot caption. */
  name: string;
}

/** `Watches › New watch` → `watches-new-watch`. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Numbered in the top bar's order, so the screenshots sort the way a person
 * meets the screens, and prefixed `atlas-smoke-` so no other spec's pictures
 * share their names.
 */
const APP_SCREENS: ScreenEntry[] = SCREEN_PATHS.map((screen, i) => ({
  path: screen.path,
  slug: `atlas-smoke-${String(i + 1).padStart(2, '0')}-${slugify(screen.name)}`,
  name: screen.name,
}));

/**
 * `RESMON_E2E_BREAK_ROUTE=/no-such-page` appends an address the app does not
 * route.
 *
 * This is how "the CI job fails when a screen fails to load" is
 * *demonstrated* rather than asserted: `ui-smoke.yml` takes a `break_route`
 * input that sets it. Atlas sends an address it does not route back to Today,
 * so the smoke case for it fails on the address it ends at. It is deliberately
 * not a code change: a demonstration that needs a commit to reproduce stops
 * being reproducible the moment the commit is reverted.
 */
export const SCREENS: ScreenEntry[] = process.env.RESMON_E2E_BREAK_ROUTE
  ? [
    ...APP_SCREENS,
    { path: process.env.RESMON_E2E_BREAK_ROUTE, slug: 'atlas-smoke-99-deliberately-broken', name: 'Deliberately broken route' },
  ]
  : APP_SCREENS;
