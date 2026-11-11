import { engine, EngineError } from '../../api/client';

export type ReferenceFormat = 'bibtex' | 'ris' | 'csv';

export const FORMATS: readonly { id: ReferenceFormat; label: string; ext: string }[] = [
  { id: 'bibtex', label: 'BibTeX', ext: 'bib' },
  { id: 'ris', label: 'RIS', ext: 'ris' },
  { id: 'csv', label: 'CSV', ext: 'csv' },
];

/**
 * Export a selection's papers and hand the file to the system as a download.
 *
 * The engine renders the file (`POST /api/export/references`): one entry per
 * stored paper, however many of the selected runs found it. It answers text,
 * not JSON, so the body is read as text and saved under the name asked for.
 */
export async function exportReferences(
  selection: { execution_ids?: number[]; document_ids?: number[] },
  format: ReferenceFormat,
  basename: string,
): Promise<void> {
  const { data, error, response } = await engine().POST('/api/export/references', {
    body: { document_ids: selection.document_ids ?? [], execution_ids: selection.execution_ids ?? null, format },
    parseAs: 'text',
  });
  if (error !== undefined || typeof data !== 'string') {
    const detail = typeof error === 'object' && error && 'detail' in error ? String((error as { detail: unknown }).detail) : '';
    throw new EngineError(response.status, `The export failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const ext = FORMATS.find((f) => f.id === format)?.ext ?? format;
  const url = URL.createObjectURL(new Blob([data], { type: response.headers.get('Content-Type') ?? 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${basename}.${ext}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
