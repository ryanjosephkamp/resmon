/**
 * A run's page has one tab open at a time, and each tab has its own address:
 * `/runs/12/papers`, `/runs/12/map`, `/runs/12/search-record`. `/runs/12`
 * alone opens the default tab, Papers. Back and Forward then return to the tab
 * that was open, as they do for any other page.
 */
export const TABS = ['Papers', 'Map', 'Report', 'Search record', 'Log', 'Metadata', 'Progress'] as const;
export type Tab = typeof TABS[number];

/** The tab a run's page opens on when its address names none. */
export const DEFAULT_TAB: Tab = 'Papers';

/** A tab's name as it reads in an address: `Search record` is `search-record`. */
export function tabSlug(tab: Tab): string {
  return tab.toLowerCase().replace(/ /g, '-');
}

/** The tab an address names, or the default one for no tab or one that is not a tab. */
export function tabOf(slug: string | undefined): Tab {
  return TABS.find((tab) => tabSlug(tab) === slug) ?? DEFAULT_TAB;
}

/** The address of a run's page open at a tab. */
export function runPath(runId: number | string, tab: Tab): string {
  return `/runs/${runId}/${tabSlug(tab)}`;
}
