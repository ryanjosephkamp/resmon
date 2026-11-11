import type { QueryClient } from '@tanstack/react-query';

/** The list shared by the switcher, Settings, and the move/copy menus. */
export const COLLECTIONS_KEY = ['collections'] as const;

/** Every view whose answer depends on which papers a collection holds. */
export const PAPER_VIEW_KEYS = [
  ['explorer'], ['explorer-facets'], ['analytics-overview'], ['keyword-contribution'], ['publication-volume'],
  ['today'], ['map'], ['map-facets'], ['paper'], ['reading-queue'], ['related-terms'],
] as const;

export const COLLECTION_COUNT_KEYS = [COLLECTIONS_KEY, ...PAPER_VIEW_KEYS] as const;

/** Invalidate every collection's counts and membership views, including answers kept for a later visit. */
export async function invalidateCollectionCounts(client: QueryClient): Promise<void> {
  await Promise.all(COLLECTION_COUNT_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
}

/** The shared list was refreshed elsewhere: its changed memberships also invalidate the views of its papers. */
export async function invalidatePaperViews(client: QueryClient): Promise<void> {
  await Promise.all(PAPER_VIEW_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
}
