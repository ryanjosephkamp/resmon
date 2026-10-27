import { useCallback, useEffect, useState } from 'react';
import { repositoriesApi } from '../api/repositories';

/**
 * A source's name as the catalog spells it ("Semantic Scholar"), for a slug as
 * the database stores it ("semantic_scholar").
 *
 * Pages that list runs, papers and coverage printed the slug, so the same
 * source read "semantic_scholar" on the Watchdog and "Semantic Scholar" on the
 * Source wall beside it. The names come from the catalog the backend serves,
 * not from a copy here, so a source added to the catalog is named everywhere
 * at once. A slug the catalog does not carry (a retired source, or the catalog
 * not loaded yet) is shown as the slug: that is what is known about it.
 *
 * The catalog is fetched once per renderer and shared by every page.
 */
let cache: Record<string, string> | null = null;
let pending: Promise<Record<string, string>> | null = null;

function loadNames(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = repositoriesApi.getCatalog()
      .then((entries) => {
        cache = Object.fromEntries(entries.map((e) => [e.slug, e.name]));
        return cache;
      })
      .catch(() => {
        // Not cached: the next page to mount asks again.
        pending = null;
        return {};
      });
  }
  return pending;
}

/** For tests: forget the shared catalog. */
export function resetSourceNamesForTests(): void {
  cache = null;
  pending = null;
}

export function useSourceNames(): (slug: string) => string {
  const [names, setNames] = useState<Record<string, string>>(() => cache ?? {});
  useEffect(() => {
    // A page mounted after the catalog arrived already started from it.
    if (cache) return undefined;
    let live = true;
    void loadNames().then((loaded) => { if (live) setNames(loaded); });
    return () => { live = false; };
    // Once per mount: the catalog does not change while the app runs.
  }, []);
  return useCallback((slug: string) => names[slug] ?? slug, [names]);
}
