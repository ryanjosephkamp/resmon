import { DEFAULT_TAB, TABS, runPath, tabOf, tabSlug } from '../tabs';
import { windowTitle } from '../../../windowTitle';

describe("a run's tabs in its address", () => {
  test('each tab has its own path, named as the tab is', () => {
    expect(TABS.map((tab) => runPath(12, tab))).toEqual([
      '/runs/12/papers', '/runs/12/map', '/runs/12/report', '/runs/12/search-record', '/runs/12/log',
      '/runs/12/metadata', '/runs/12/progress',
    ]);
    expect(tabSlug('Search Record')).toBe('search-record');
  });

  test('every path reads back as its tab', () => {
    for (const tab of TABS) expect(tabOf(tabSlug(tab))).toBe(tab);
  });

  test('an address with no tab, or one that is not a tab, opens the default tab', () => {
    expect(DEFAULT_TAB).toBe('Papers');
    expect(tabOf(undefined)).toBe('Papers');
    expect(tabOf('nonsense')).toBe('Papers');
    expect(tabOf('Map')).toBe('Papers');
  });

  test("a run's window is titled by the run on every tab", () => {
    expect(windowTitle('/runs/12', true)).toBe('Run 12');
    expect(windowTitle('/runs/12/search-record', true)).toBe('Run 12');
    expect(windowTitle('/runs/12/map', false)).toBe('Run 12 — resmon');
  });
});
