/**
 * `screenPaths.ts` is the list the e2e sweep and the performance harness
 * visit, so it has to be every screen the router has an address for and
 * nothing else. The router's table holds React elements and cannot be loaded
 * outside the renderer, so its source is read for the paths it declares.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCREEN_PATHS } from '../screenPaths';
import { GROUPS, groupPath } from '../screens/settings/model';

const ROUTES = readFileSync(join(__dirname, '..', 'routes.tsx'), 'utf8');

/** Every `path: '…'` in the route table, without the ones that need an id. */
function routedWithoutAnId(): string[] {
  const paths = [...ROUTES.matchAll(/\bpath: '([^']+)'/g)].map((m) => m[1] as string);
  expect(paths.length).toBeGreaterThan(10);
  return paths.filter((p) => !p.includes(':'));
}

test('every fixed address the router declares is listed, and nothing else is', () => {
  const expected = new Set([...routedWithoutAnId(), ...GROUPS.map((g) => groupPath(g.slug))]);
  expect(new Set(SCREEN_PATHS.map((s) => s.path))).toEqual(expected);
});

test('each screen is listed once, with a name', () => {
  const paths = SCREEN_PATHS.map((s) => s.path);
  expect(new Set(paths).size).toBe(paths.length);
  for (const screen of SCREEN_PATHS) expect(screen.name.trim()).not.toBe('');
});
