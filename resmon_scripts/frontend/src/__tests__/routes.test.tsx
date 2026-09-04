/**
 * The route table is a denominator, not a copy.
 *
 * Before phase 1.8.7, `e2e/routes.ts` was a hand copy of `App.tsx`'s `<Routes>`
 * block: a route added to the app and not to the copy was unswept by the smoke
 * suite and **nothing failed**. That was the weakest row in the UI spike's
 * ledger (PR #59) and this file is what closes it. `src/routes.ts` is now the
 * single list; `App.tsx` renders from it and the Playwright suite imports it.
 *
 * Three ways the table could go stale, and a guard for each:
 *
 * 1. A route is added to `App.tsx` as hand-written JSX, bypassing the table.
 *    Caught by asserting no `<Route>` in `App.tsx` carries a literal `path=`
 *    attribute — the only `<Route>` allowed is the one the map renders.
 * 2. A page is wired up without a table entry, or an entry has no page.
 *    Caught by comparing `PAGE_ELEMENTS`'s keys with the table's paths.
 * 3. A Settings or About tab is added to the child page's own `<Routes>` block
 *    without reaching the table. Caught by parsing that page's source — which
 *    is why `childrenFrom` exists.
 *
 * Every guard reads source text rather than importing a module, for two
 * reasons. It is the only way to observe an absence — a hand-written `<Route>`
 * and a mapped one are indistinguishable once React has built the element
 * tree, and a child route declared inside `SettingsPage.tsx` is reachable from
 * no export at all. And importing `App.tsx` here is not available anyway:
 * `CalendarPage` pulls in `@fullcalendar/react`, which ships ESM that this
 * jest configuration does not transform.
 */
import * as fs from 'fs';
import * as path from 'path';
import { APP_ROUTES, allRouteHashes, routeHash } from '../routes';

const SRC = path.join(__dirname, '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(SRC, relative), 'utf8');
}

describe('the route table is the single source of truth', () => {
  it('App.tsx declares no route with a literal path', () => {
    const source = read('App.tsx');
    // Every `<Route ...>` element in the file, attributes included. The one
    // the map renders spans several lines, hence the [\s\S].
    const elements = source.match(/<Route\b[\s\S]*?\/>/g) ?? [];
    expect(elements.length).toBeGreaterThan(0);
    const literal = elements.filter((el) => /path\s*=\s*["'{`]\s*['"/]/.test(el)
      && !/path=\{route\.path\}/.test(el));
    // A route added here instead of to `src/routes.ts` would render in the
    // app and be invisible to `npm run e2e`.
    expect(literal).toEqual([]);
  });

  it('every route has a page and every page has a route', () => {
    const source = read('App.tsx');
    const block = source.match(
      /PAGE_ELEMENTS: Record<string, React\.ReactElement> = \{([\s\S]*?)\n\};/,
    );
    expect(block).toBeTruthy();
    const entries = [...(block as RegExpMatchArray)[1]
      .matchAll(/'([^']+)':\s*<(\w+)\s*\/>/g)];
    const elementKeys = entries.map((m) => m[1]).sort();
    expect(elementKeys).toEqual(APP_ROUTES.map((r) => r.path).sort());

    // Two routes rendering the same page would be a copy-paste slip that the
    // key comparison above cannot see.
    const components = entries.map((m) => m[2]);
    expect(new Set(components).size).toBe(components.length);
    for (const component of components) {
      expect(source).toContain(`import ${component} from './pages/${component}'`);
    }
  });

  it('paths are unique and rooted', () => {
    const paths = APP_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p.startsWith('/')).toBe(true);
  });

  it('a splat route says where its children are declared, and a plain one has none', () => {
    for (const route of APP_ROUTES) {
      if (route.path.endsWith('/*')) {
        expect(route.childrenFrom).toBeTruthy();
        expect(route.children?.length).toBeGreaterThan(0);
      } else {
        expect(route.children).toBeUndefined();
        expect(route.childrenFrom).toBeUndefined();
      }
    }
  });

  it.each(APP_ROUTES.filter((r) => r.childrenFrom).map((r) => [r.name, r] as const))(
    '%s: the table matches the tabs the page itself declares',
    (_name, route) => {
      const source = read(route.childrenFrom as string);
      const declared = [...source.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
      expect(declared).toEqual(route.children);

      // The index redirect is a fact about the page, so it is read from the
      // page rather than written down twice.
      const redirect = source.match(/<Route\s+index\s+element=\{<Navigate\s+to="([^"]+)"/);
      expect(redirect).toBeTruthy();
      expect(route.redirectsTo).toBe(`${routeHash(route)}/${(redirect as RegExpMatchArray)[1]}`);
    },
  );

  it('allRouteHashes covers every parent and every child exactly once', () => {
    const hashes = allRouteHashes().map((h) => h.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    const expected = APP_ROUTES.reduce(
      (n, r) => n + 1 + (r.children?.length ?? 0), 0,
    );
    expect(hashes.length).toBe(expected);
    for (const route of APP_ROUTES) {
      expect(hashes).toContain(routeHash(route));
      for (const child of route.children ?? []) {
        expect(hashes).toContain(`${routeHash(route)}/${child}`);
      }
    }
  });
});
