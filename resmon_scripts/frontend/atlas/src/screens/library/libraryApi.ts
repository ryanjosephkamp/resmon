/**
 * The owned Library over the engine: the header its guard asks for, the one
 * route the typed client cannot send (an import is raw bytes), and the words
 * for what it keeps.
 *
 * Every Library route refuses a request without `X-Resmon-Library: 1` from this
 * window's own origin (`LibraryOriginGuard`), so each call passes `LIBRARY`.
 * A vault id rides on every read, so a read can never fall through to another
 * vault's files.
 */
import type { components } from '../../api/schema';
import { bridge } from '../../bridge';
import { EngineError, engineSentence } from '../../api/client';

export type LibraryStatus = components['schemas']['LibraryStatus'];
export type LibraryFile = components['schemas']['LibraryFile'];
export type LibraryImported = components['schemas']['LibraryImported'];

export const LIBRARY = { headers: { 'X-Resmon-Library': '1' } } as const;
export const LIBRARY_KEY = ['library'] as const;

/** The three kinds the Library keeps, by the media type it records. */
export const KIND: Record<string, string> = {
  'application/pdf': 'PDF',
  'text/plain': 'Text',
  'text/markdown': 'Markdown',
};

export function kindOf(media: string): string {
  return KIND[media] ?? media;
}

/** Whether the engine will read a kept file as text here: TXT and MD, never a PDF. */
export function readable(media: string): boolean {
  return media === 'text/plain' || media === 'text/markdown';
}

const BYTES = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** "12 KB", "3.4 MB": decimal units, as file managers show them. */
export function sizeWords(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1_000_000) return `${BYTES.format(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return `${BYTES.format(bytes / 1_000_000)} MB`;
  return `${BYTES.format(bytes / 1_000_000_000)} GB`;
}

/** What one batch of imports did, in the words the import reports. */
export function importWords(results: readonly LibraryImported[], refused: number): string {
  const kept = results.filter((r) => r.created).length;
  const reused = results.length - kept;
  const parts = [`${kept} retained`, `${reused} exact ${reused === 1 ? 'duplicate' : 'duplicates'} reused`];
  if (refused) parts.push(`${refused} refused`);
  return `${parts.join(', ')}.`;
}

/**
 * Import one file's bytes. Not through the typed client: the route reads a raw
 * `application/octet-stream` body, which `openapi.json` has no shape for. The
 * same port, token and Library header as every other call.
 */
export async function importFile(vaultId: string, file: File, documentId?: number): Promise<LibraryImported> {
  const link = bridge();
  const port = link?.getBackendPort();
  if (!port) throw new EngineError(0, 'This window has no backend connection yet.');
  const params = new URLSearchParams({ expected_vault_id: vaultId, filename: file.name });
  if (documentId) params.set('document_id', String(documentId));
  const token = link?.getApiToken();
  const response = await fetch(`http://127.0.0.1:${port}/api/library/files?${params.toString()}`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...LIBRARY.headers,
      'Content-Type': 'application/octet-stream',
    },
    body: await file.arrayBuffer(),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new EngineError(response.status, `/api/library/files answered HTTP ${response.status}`, engineSentence(body));
  }
  return body as LibraryImported;
}

/** Hand a text the engine composed to the system as a download. */
export function download(content: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
