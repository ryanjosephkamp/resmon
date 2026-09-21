/**
 * A fresh id for one in-flight submission.
 *
 * The backend treats two requests carrying the same `request_id` as one
 * submission and answers the second with the run the first started. That makes
 * this id worth exactly as much as the discipline around it:
 *
 *   * **Per in-flight request**, which is what the pages do: the submit control
 *     is disabled while the request is running and a ref refuses re-entry in
 *     the window before React re-renders it, so a second click cannot start a
 *     second run — and a *retry* of the same submission carries the same id and
 *     is answered with the run already going.
 *   * **Per page load** would be a bug: the id would be fixed for the life of
 *     the page, and a user's genuine second search would be answered with their
 *     first one's results.
 *
 * Minting a new id on every click would not, on its own, make a double click
 * one run — the two clicks would be two submissions with two ids, which is what
 * the disabled control and the ref are for.
 *
 * `crypto.randomUUID` is available in Electron's renderer and in every browser
 * the app is built for; the fallback exists for the jsdom environments in the
 * test suite, which do not all provide it.
 */
export function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'rq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}
