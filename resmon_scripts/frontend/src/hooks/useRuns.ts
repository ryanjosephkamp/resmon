import { useEffect, useRef } from 'react';

/**
 * Generation counters for asynchronous work, one per operation.
 *
 * Three components were written with a single `epoch = useRef(0)` that several
 * independent operations took a ticket from. Anything that bumped the counter
 * discarded the outcome of every other operation still in flight, and a
 * discarded outcome is written nowhere: no result, no refusal, no sentence
 * saying the request was abandoned. The user clicks, the request completes, and
 * the page looks exactly as it did before. For an application whose whole claim
 * is that a quiet result and a broken one never look the same, that is the
 * worst failure available, and it is invisible in review because the code reads
 * like a correct stale-response guard.
 *
 * There are three different reasons to drop an answer, and the bug is what
 * happens when one counter is made to carry all of them:
 *
 *  1. **A later run of the same control.** Press Refresh twice and the first
 *     answer is stale. This is what a generation counter is for, and `begin`
 *     is scoped to one key so it supersedes only its own kind.
 *  2. **The component is gone.** `mounted` carries this, and `current` reads it,
 *     so every guard covers unmount without a counter being involved.
 *  3. **The subject changed** — another project, another file, another saved
 *     item. That is a property of the thing on screen, not of the request, so
 *     it is checked by comparing identity at the moment the answer arrives, not
 *     by bumping a counter. A counter used for this is what makes operations
 *     cancel each other.
 *
 * Anything that is none of those three is an outcome the user is owed, and it
 * is written to the page.
 *
 * Keys are free-form strings so a per-subject operation can carry its subject
 * in the key — `begin(`delete:${id}`)` supersedes only a second delete of the
 * same id, where `begin('delete')` would let deleting one row erase the refusal
 * of another. Sharing one key between two operations is still possible and is
 * occasionally right, but it now has to be spelled out and read as a decision.
 */
export interface Runs {
  /**
   * Claim the newest ticket for `key`, superseding any earlier run of that key
   * and nothing else. Call it synchronously, before the first `await`.
   */
  begin(key: string): number;
  /**
   * True while `ticket` is still the newest run of `key` and the component is
   * mounted — the one condition under which an answer may be applied or
   * reported.
   */
  current(key: string, ticket: number): boolean;
  /**
   * Read `key`'s newest ticket without claiming one, for reason 3: an
   * operation that must not apply its answer if the thing on screen changed
   * underneath it. `token` before the first `await`, `current` after it.
   *
   * This is the one legitimate shape of the bug the rest of this file exists
   * to prevent, and the difference is which way round it runs: `begin` says
   * "this is mine now and anything older is stale", `token` says "I am
   * watching something else and will stand down if it moves". Reaching for
   * `token` where `begin` belongs is how an operation ends up cancellable by
   * every other control on the page, so the subject being watched should be
   * nameable in one word — a selection, a project.
   */
  token(key: string): number;
  /** False once the component has unmounted, or once `end` has been called. */
  readonly mounted: boolean;
  /**
   * Declare the component gone before React commits the unmount. A panel whose
   * Close button unconditionally stops rendering it says so at the click rather
   * than waiting for the cleanup, so an answer arriving in between is not
   * applied to a panel on its way out.
   */
  end(): void;
}

export function useRuns(): Runs {
  const tickets = useRef<Map<string, number> | null>(null);
  const mounted = useRef(true);
  const api = useRef<Runs | null>(null);

  // Remounting after a cleanup — React 18 StrictMode runs the effect twice in
  // one mount — has to put `mounted` back, or every guard in the component
  // reads false for the rest of its life.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  if (api.current === null) {
    tickets.current = new Map<string, number>();
    const map = tickets.current;
    api.current = {
      begin(key: string) {
        const next = (map.get(key) ?? 0) + 1;
        map.set(key, next);
        return next;
      },
      current(key: string, ticket: number) {
        // An unseen key reads as 0, which is the value `token` hands back
        // before anything has happened and a value `begin` never returns, so
        // a watcher that started before the first change is still current and
        // a ticket is only ever compared against its own key's history.
        return mounted.current && (map.get(key) ?? 0) === ticket;
      },
      token(key: string) {
        return map.get(key) ?? 0;
      },
      get mounted() { return mounted.current; },
      end() { mounted.current = false; },
    };
  }
  return api.current;
}
