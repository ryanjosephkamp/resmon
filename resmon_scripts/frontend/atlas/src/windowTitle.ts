/**
 * A window's title, from the page it shows. Deliberately zero imports beyond
 * `screenPaths.ts` (which has none), so the e2e suite holds a window's title
 * to this rule rather than restating it per platform.
 */
import { SCREEN_PATHS } from './screenPaths';

/** Screens with an id in their address, named by what they show. */
const DETAIL_TITLES: readonly { pattern: RegExp; title: (id: string) => string }[] = [
  { pattern: /^\/runs\/(\d+)(?:\/[a-z-]+)?$/, title: (id) => `Run ${id}` },
  { pattern: /^\/papers\/[^/]+$/, title: () => 'Paper' },
  { pattern: /^\/watches\/people\/[^/]+$/, title: () => 'Watches › Person' },
  { pattern: /^\/watches\/[^/]+\/edit$/, title: () => 'Edit Watch' },
  { pattern: /^\/watches\/[^/]+$/, title: () => 'Watch' },
];

/**
 * A window's title: the screen it shows, which is what macOS's tabs, the
 * Window menu, and the taskbar elsewhere name it by, so two windows on two
 * screens can be told apart. Elsewhere the app's name follows, since the
 * system frame shows the title alone.
 */
export function windowTitle(pathname: string, mac: boolean): string {
  const fixed = SCREEN_PATHS.find((screen) => screen.path === pathname)?.name;
  const detail = DETAIL_TITLES.map(({ pattern, title }) => {
    const found = pattern.exec(pathname);
    return found ? title(found[1] ?? '') : null;
  }).find((title) => title !== null);
  const name = fixed ?? detail ?? null;
  if (!name) return 'resmon';
  return mac ? name : `${name} — resmon`;
}
