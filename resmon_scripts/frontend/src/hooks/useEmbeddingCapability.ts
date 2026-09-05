import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';

/**
 * Can this resmon rank papers by meaning, and if not, why not.
 *
 * One hook because the answer gates several controls, and they must agree. The
 * rule from phase 1.9's decisions is that a feature whose dependency is missing
 * is **absent**, not present-and-broken: no sort option, no similar-papers
 * panel, in the same way a missing agent CLI reads. A control that appears and
 * then explains itself away is worse than one that was never offered.
 *
 * `available` needs both halves — a loadable extension **and** something in the
 * index. An extension that loaded over an empty index is a library, not a
 * ranking capability, and gating on the library alone would offer a sort that
 * returns everything unranked.
 *
 * `reason` is never empty when `available` is false, and it is the backend's
 * sentence rather than one composed here. "The extension will not load", "no
 * model is configured" and "nothing is embedded yet" send a user to three
 * different places, and the backend is the only thing that knows which.
 */
export interface EmbeddingCapability {
  available: boolean;
  extension: string | null;
  reason: string | null;
  model: string | null;
  indexed: number;
}

interface StatusResponse {
  capability: EmbeddingCapability;
  coverage: { embedded: number; total: number; model: string | null };
}

/** What to show before the first answer arrives: no controls, no explanation. */
const UNKNOWN: EmbeddingCapability = {
  available: false,
  extension: null,
  reason: null,
  model: null,
  indexed: 0,
};

export function useEmbeddingCapability(): {
  capability: EmbeddingCapability;
  loaded: boolean;
  refresh: () => Promise<void>;
} {
  const [capability, setCapability] = useState<EmbeddingCapability>(UNKNOWN);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const status = await apiClient.get<StatusResponse>('/api/embeddings/status');
      setCapability(status.capability ?? UNKNOWN);
    } catch {
      // A backend too old to know about embeddings answers 404, and an
      // unreachable one throws. Both mean "no ranking here", and neither is
      // worth an error banner on a page whose main job still works.
      setCapability(UNKNOWN);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { capability, loaded, refresh };
}
