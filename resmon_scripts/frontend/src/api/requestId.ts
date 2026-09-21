/**
 * A fresh id for one submission, generated at the moment the user acts.
 *
 * The backend treats two requests carrying the same `request_id` as one
 * submission and answers the second with the run the first started. That makes
 * *when* this is called the whole of the guarantee:
 *
 *   * at click time, which is here — a double click, a retried request or a
 *     component that remounted mid-flight all carry the same id, and resmon
 *     runs one search;
 *   * at page load, which would be a bug — the id would be fixed for the life
 *     of the page, and a user's genuine second search would be answered with
 *     their first one's results.
 *
 * `crypto.randomUUID` is available in Electron's renderer and in every browser
 * the app is built for; the fallback exists for the jsdom environments in the
 * test suite, which do not all provide it. Both produce a value unique enough
 * for a key whose only job is to be different from the last one.
 */
export function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'rq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}
