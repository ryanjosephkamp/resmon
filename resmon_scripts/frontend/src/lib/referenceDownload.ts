/**
 * Download one reference-export file from the backend and hand it to the user.
 *
 * Extracted from `ResultsPage` when the Reading queue gained the same three
 * buttons, so there is one place where the request is made, one place where a
 * failure is turned into a sentence, and one shape of file the user receives.
 * Two copies of this would be two places for a `resp.ok` check to be forgotten,
 * and phase 2.1a exists because that check was once missing: a failed export
 * wrote the error body into a `.bib` file and the interface said nothing.
 *
 * Deliberately not on `apiClient`: that helper parses JSON, and BibTeX, RIS and
 * CSV are text. The `Content-Disposition` the backend sets is ignored here
 * because a renderer-initiated `Blob` download names its own file; the header
 * still matters to anything speaking to the API directly.
 */
import { getBaseUrl } from '../api/client';

export type ReferenceFormat = 'bibtex' | 'ris' | 'csv';

/** The file extension a format's download is given. */
export function referenceExtension(fmt: ReferenceFormat): string {
  return fmt === 'bibtex' ? 'bib' : fmt;
}

/**
 * POST a selection to `/api/export/references` and save the bytes it returns.
 *
 * `body` is passed through untouched, so a caller chooses between
 * `execution_ids` and `document_ids` — the backend refuses both together, and
 * that refusal is a message worth showing rather than one to pre-empt here.
 *
 * Throws with the backend's own `detail` when it has one. The caller decides
 * where that sentence is rendered.
 */
export async function downloadReferences(
  body: Record<string, unknown>,
  fmt: ReferenceFormat,
  filenameStem: string,
): Promise<void> {
  const resp = await fetch(`${getBaseUrl()}/api/export/references`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ...body, format: fmt }),
  });
  if (!resp.ok) {
    let message = `Reference export failed (HTTP ${resp.status})`;
    try {
      const error: unknown = await resp.json();
      if (error && typeof error === 'object' && 'detail' in error
          && typeof error.detail === 'string' && error.detail.trim()) {
        message += `: ${error.detail.trim()}`;
      }
    } catch { /* An unreadable error body still has a useful HTTP status. */ }
    throw new Error(message);
  }
  const text = await resp.text();

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameStem}.${referenceExtension(fmt)}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
