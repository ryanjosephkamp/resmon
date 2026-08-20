import { useCallback, useEffect, useState } from 'react';
import {
  repositoriesApi,
  RepoCatalogEntry,
  CredentialPresenceMap,
} from '../api/repositories';

interface RepoCatalogState {
  catalog: RepoCatalogEntry[];
  bySlug: Record<string, RepoCatalogEntry>;
  presence: CredentialPresenceMap;
  loading: boolean;
  error: string;
  refreshPresence: () => Promise<void>;
}

/** Load the repository catalog + credential-presence map and keep them in sync. */
export function useRepoCatalog(): RepoCatalogState {
  const [catalog, setCatalog] = useState<RepoCatalogEntry[]>([]);
  const [presence, setPresence] = useState<CredentialPresenceMap>({});
  const [keyringResponsive, setKeyringResponsive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refreshPresence = useCallback(async () => {
    try {
      const res = await repositoriesApi.getCredentials();
      setPresence(res.credentials);
      setKeyringResponsive(res.keyring_responsive);
    } catch (err: any) {
      setError(err?.message || 'Failed to load credential presence.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cat, pres] = await Promise.all([
          repositoriesApi.getCatalog(),
          repositoriesApi.getCredentials(),
        ]);
        if (cancelled) return;
        setCatalog(cat);
        setPresence(pres.credentials);
        setKeyringResponsive(pres.keyring_responsive);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Failed to load catalog.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const bySlug: Record<string, RepoCatalogEntry> = {};
  for (const e of catalog) bySlug[e.slug] = e;

  return { catalog, bySlug, presence, loading, error, refreshPresence };
}
