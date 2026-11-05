import { useEffect, useState } from 'react';

/** How long typing pauses before the find field's words become the address's `?q=`. */
export const FIND_PAUSE_MS = 300;

/**
 * The find field's own text, and the address's `q` it settles into after a
 * pause. It follows the address when the shelf or the search changes there
 * (Back, a shelf's button), and not when the change is the field's own:
 * what is typed stays as typed, a trailing space included, so typing
 * "graph ", pausing, and typing "neural" is "graph neural", not "graphneural".
 * Set while rendering, as React's own pattern for state that follows other state.
 */
export function useFindDraft(show: string, q: string, write: (q: string | null) => void): [string, (draft: string) => void] {
  const [draft, setDraft] = useState(q);
  const [written, setWritten] = useState<string | null>(null);
  const [following, setFollowing] = useState({ show, q });
  if (following.show !== show || following.q !== q) {
    setFollowing({ show, q });
    if (following.show !== show || q !== written) setDraft(q);
  }
  useEffect(() => {
    if (draft.trim() === q) return undefined;
    const settle = window.setTimeout(() => { setWritten(draft.trim()); write(draft.trim() || null); }, FIND_PAUSE_MS);
    return () => window.clearTimeout(settle);
  }, [draft, q, write]);
  return [draft, setDraft];
}
