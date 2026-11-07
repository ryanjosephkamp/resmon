/**
 * The top bar as arranged: the order, the hidden sections, the keys, the
 * start page and the resmon name's page, and the rule that puts a missing
 * section back. The page list is held to the engine's (`openapi.json`), to
 * the router's sections (`routes.tsx`), and to the screens' names.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCREEN_PATHS } from '../../screenPaths';
import {
  DEFAULT_TOP_BAR, SECTION_IDS, START_PAGES, arrange, isDefault, moved, pageName, sectionAddress, sectionOf,
  shownOrHidden, wholeOrder, type TopBar,
} from '../topBar';

const bar = (change: Partial<TopBar>): TopBar => ({ ...DEFAULT_TOP_BAR, ...change });

describe('the default bar', () => {
  test('every section, in the order the bar has always had, opening on Today, the resmon name going there too', () => {
    const arranged = arrange(DEFAULT_TOP_BAR);
    expect(arranged.order).toEqual(['today', 'watches', 'search', 'runs', 'library', 'ask', 'health']);
    expect(arranged.shown).toEqual(arranged.order);
    expect(arranged.keys).toEqual(arranged.order);
    expect(arranged.keyPaths).toEqual(['/today', '/watches', '/search', '/runs', '/library', '/ask', '/health']);
    expect(arranged.start).toBe('/today');
    expect(arranged.lockup).toBe('/today');
    expect(isDefault(DEFAULT_TOP_BAR)).toBe(true);
  });
});

describe('the keys follow the bar', () => {
  test('⌘1 is the bar\'s first tab, and the hidden sections take the keys after the shown ones', () => {
    const arranged = arrange(bar({ order: ['search', 'today', 'library', 'runs', 'watches', 'health', 'ask'], hidden: ['today', 'health'] }));
    expect(arranged.shown).toEqual(['search', 'library', 'runs', 'watches', 'ask']);
    expect(arranged.keys).toEqual(['search', 'library', 'runs', 'watches', 'ask', 'today', 'health']);
    expect([...arranged.hidden]).toEqual(['today', 'health']);
  });

  test('every section hidden leaves the bar empty and every key still with a section', () => {
    const arranged = arrange(bar({ hidden: [...SECTION_IDS] }));
    expect(arranged.shown).toEqual([]);
    expect(arranged.keys).toEqual([...SECTION_IDS]);
  });
});

describe('an order is always whole', () => {
  test('a missing section goes back after the section it follows by default, shown', () => {
    expect(wholeOrder(['ask', 'today', 'watches', 'search', 'library', 'health']))
      .toEqual(['ask', 'today', 'watches', 'search', 'runs', 'library', 'health']);
    expect(wholeOrder(['health', 'ask', 'library'])).toEqual(['today', 'watches', 'search', 'runs', 'health', 'ask', 'library']);
    expect(wholeOrder([])).toEqual([...SECTION_IDS]);
  });

  test('a name it does not know, and a repeat, are dropped', () => {
    // Library, Ask, and Health follow Runs by default, so they go after it; Watches and Search follow Today.
    expect(wholeOrder(['runs', 'dashboard', 'runs', 'today'])).toEqual(['runs', 'library', 'ask', 'health', 'today', 'watches', 'search']);
    const arranged = arrange({ order: ['dashboard', 'ask'], hidden: ['dashboard', 'ask'], start: '/today', lockup: null } as unknown as TopBar);
    expect(arranged.order).toHaveLength(7);
    expect([...arranged.hidden]).toEqual(['ask']);
  });

  test('a page it has no screen for opens Today, and the resmon name then follows the start page', () => {
    const arranged = arrange({ ...DEFAULT_TOP_BAR, start: '/nowhere', lockup: '/settings' } as unknown as TopBar);
    expect(arranged.start).toBe('/today');
    expect(arranged.lockup).toBe('/today');
    expect(arrange(bar({ start: '/search/saved' })).lockup).toBe('/search/saved');
    expect(arrange(bar({ start: '/search/saved', lockup: '/health/watchdog' })).lockup).toBe('/health/watchdog');
  });
});

describe('changing it', () => {
  test('a section moved keeps the others in their order, and its hidden state', () => {
    const start = bar({ hidden: ['runs'] });
    expect(moved(start, 'health', 0).order).toEqual(['health', 'today', 'watches', 'search', 'runs', 'library', 'ask']);
    expect(moved(start, 'today', 6).order).toEqual(['watches', 'search', 'runs', 'library', 'ask', 'health', 'today']);
    expect(moved(start, 'runs', 1)).toEqual({ ...start, order: ['today', 'runs', 'watches', 'search', 'library', 'ask', 'health'], hidden: ['runs'] });
    // Past either end is the end.
    expect(moved(start, 'search', 99).order[6]).toBe('search');
    expect(moved(start, 'search', -3).order[0]).toBe('search');
  });

  test('a section hidden and shown again goes back to its own place', () => {
    const hidden = shownOrHidden(DEFAULT_TOP_BAR, 'watches', false);
    expect(hidden.hidden).toEqual(['watches']);
    expect(hidden.order).toEqual(DEFAULT_TOP_BAR.order);
    expect(isDefault(hidden)).toBe(false);
    const again = shownOrHidden(hidden, 'watches', true);
    expect(again.hidden).toEqual([]);
    expect(isDefault(again)).toBe(true);
    // Hidden is kept in the bar's order.
    expect(shownOrHidden(shownOrHidden(DEFAULT_TOP_BAR, 'health', false), 'today', false).hidden).toEqual(['today', 'health']);
  });
});

describe('the pages and the sections, held to the engine, the router, and the screens', () => {
  const openapi = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'docs', 'api-contract', 'openapi.json'), 'utf8')) as {
    components: { schemas: Record<string, { properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> }> };
  };
  const schema = openapi.components.schemas.TopBar!.properties;

  test('the start pages are exactly the pages the engine accepts, and the sections its sections', () => {
    expect(START_PAGES.map((page) => page.path)).toEqual(schema.start!.enum);
    expect([...SECTION_IDS]).toEqual(schema.order!.items!.enum);
  });

  test('the router declares the sections in the default order', () => {
    const routes = readFileSync(join(__dirname, '..', '..', 'routes.tsx'), 'utf8');
    const table = routes.slice(routes.indexOf('export const SECTIONS'), routes.indexOf('];', routes.indexOf('export const SECTIONS')));
    expect([...table.matchAll(/\bpath: '([^']+)'/g)].map((m) => m[1])).toEqual(SECTION_IDS.map(sectionAddress));
  });

  test('every start page is a screen, named as the screens are, under its own section', () => {
    for (const page of START_PAGES) {
      expect(SCREEN_PATHS.find((screen) => screen.path === page.path)?.name).toBe(page.name);
      expect(sectionOf(page.path)).toBe(page.section);
    }
    expect(pageName('/search/saved')).toBe('Search › Saved');
    expect(pageName('/today')).toBe('Today');
    expect(sectionOf('/settings/top-bar')).toBeNull();
  });
});
