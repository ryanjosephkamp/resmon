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
import { count, number } from '../today/format';

export type LibraryStatus = components['schemas']['LibraryStatus'];
export type LibraryFile = components['schemas']['LibraryFile'];
export type LibraryImported = components['schemas']['LibraryImported'];
export type LibraryRemoval = components['schemas']['LibraryRemoval'];
export type LibraryRemovedFile = components['schemas']['LibraryRemovedFile'];

export const LIBRARY = { headers: { 'X-Resmon-Library': '1' } } as const;
export const LIBRARY_KEY = ['library'] as const;

/**
 * The engine's own sentence when the Library cannot exist on this computer
 * (its files are kept through descriptor-relative access, which Windows does
 * not have), or null for any other failure.
 */
export function unsupportedWords(error: unknown): string | null {
  if (!(error instanceof EngineError) || error.reason !== 'unsupported_platform') return null;
  return error.detail ?? 'The library is not available on this computer.';
}

/** A refusal that says the Library cannot exist here is final; asking again changes nothing. */
export function retryLibrary(failures: number, error: Error): boolean {
  return unsupportedWords(error) === null && failures < 1;
}

/** The four kinds the Library keeps, by the media type it records. */
export const KIND: Record<string, string> = {
  'application/pdf': 'PDF',
  'text/plain': 'Text',
  'text/markdown': 'Markdown',
  'text/x-tex': 'TeX',
};

export function kindOf(media: string): string {
  return KIND[media] ?? media;
}

/** Whether the engine reads a kept file as text: every kind but a PDF, which the PDF reader draws. */
export function readable(media: string): boolean {
  return media === 'text/plain' || media === 'text/markdown' || media === 'text/x-tex';
}

/** Whether a kind has a rich view beside its plain text: Markdown rendered, TeX highlighted with its math drawn. */
export function rich(media: string): boolean {
  return media === 'text/markdown' || media === 'text/x-tex';
}

/** What the file chooser and a drop accept: the four kinds, by name and by type. */
export const ACCEPT = '.pdf,.txt,.md,.tex,application/pdf,text/plain,text/markdown,text/x-tex';

/** Whether a file chosen or dropped is one of the four kinds, by its name. */
export function keepable(name: string): boolean {
  return /\.(pdf|txt|md|tex)$/i.test(name);
}

const BYTES = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** "12 KB", "3.4 MB": decimal units, as file managers show them. */
export function sizeWords(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1_000_000) return `${BYTES.format(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return `${BYTES.format(bytes / 1_000_000)} MB`;
  return `${BYTES.format(bytes / 1_000_000_000)} GB`;
}

/**
 * What one batch of imports did: "6 files added. None was already in the
 * Library." A file already there (the same bytes) is not kept twice, and one
 * that could not be added has its reason listed below the sentence.
 */
export function importWords(results: readonly LibraryImported[], refused: number): string {
  const added = results.filter((r) => r.created).length;
  const already = results.length - added;
  const was = (n: number) => (n === 1 ? 'was' : 'were');
  const parts = [
    added ? `${count(added, 'file')} added.` : 'No files added.',
    already ? `${number(already)} ${was(already)} already in the Library.` : 'None was already in the Library.',
  ];
  if (refused) parts.push(`${number(refused)} could not be added.`);
  return parts.join(' ');
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

function endpoint(): { base: string; headers: Record<string, string> } {
  const link = bridge();
  const port = link?.getBackendPort();
  if (!port) throw new EngineError(0, 'This window has no backend connection yet.');
  const token = link?.getApiToken();
  return { base: `http://127.0.0.1:${port}`, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...LIBRARY.headers } };
}

async function refusal(response: Response, route: string): Promise<EngineError> {
  const body: unknown = await response.json().catch(() => null);
  const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : null;
  const reason = detail && typeof detail === 'object' ? (detail as { reason?: unknown }).reason : null;
  return new EngineError(response.status, `${route} answered HTTP ${response.status}`, engineSentence(body),
    typeof reason === 'string' ? reason : null);
}

/** One version of one kept file, as plain values: what every read of its bytes names. */
export interface Version { vault_id: string; file_id: string; version_id: string; sha256: string; byte_size: number }

/** The most bytes the engine reads of a kept file: the one limit import and every reader share. */
export const MAX_READ_BYTES = 64 * 1024 * 1024;

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A kept PDF's bytes, for drawing outside Evidence. The engine's identity
 * headers must name this file, version and hash, and the bytes must be the
 * recorded size and hash, or nothing is drawn.
 */
export async function pdfBytes(file: Version, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (file.byte_size > MAX_READ_BYTES) throw new EngineError(0, 'The file is larger than the reader draws.');
  const { base, headers } = endpoint();
  const query = new URLSearchParams({ expected_vault_id: file.vault_id, expected_version_id: file.version_id });
  const route = `/api/library/files/${file.file_id}/pdf`;
  const response = await fetch(`${base}${route}?${query.toString()}`, { headers, signal, cache: 'no-store' });
  if (!response.ok) throw await refusal(response, route);
  const identity: Record<string, string> = {
    'X-Resmon-Vault': file.vault_id, 'X-Resmon-File': file.file_id, 'X-Resmon-Version': file.version_id, 'X-Resmon-SHA256': file.sha256,
  };
  if (Object.entries(identity).some(([name, value]) => response.headers.get(name) !== value)) {
    await response.body?.cancel();
    throw new EngineError(0, 'The engine answered with another file than the one asked for. Nothing was drawn.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== file.byte_size || await sha256Hex(bytes) !== file.sha256) {
    throw new EngineError(0, 'The file’s bytes do not match its recorded size and hash. Nothing was drawn.');
  }
  return bytes;
}

/** The first-page picture the engine keeps for this version, as a `data:` URL, or null when none is kept yet. */
export async function keptPicture(file: Version, signal?: AbortSignal): Promise<string | null> {
  const { base, headers } = endpoint();
  const query = new URLSearchParams({ expected_vault_id: file.vault_id, expected_version_id: file.version_id });
  const route = `/api/library/files/${file.file_id}/picture`;
  const response = await fetch(`${base}${route}?${query.toString()}`, { headers, signal, cache: 'no-store' });
  if (response.status === 404) {
    const said = await refusal(response, route);
    if (said.reason === 'no_picture') return null;
    throw said;
  }
  if (!response.ok) throw await refusal(response, route);
  const type = response.headers.get('Content-Type') ?? '';
  if (!/^image\/(webp|png|jpeg)$/.test(type)) throw new EngineError(0, 'The kept picture is not an image the gallery shows.');
  return dataUrl(new Blob([await response.arrayBuffer()], { type }));
}

/** Hand the engine the picture drawn of this version, to keep beside the database. */
export async function keepPicture(file: Version, picture: Blob): Promise<void> {
  const { base, headers } = endpoint();
  const query = new URLSearchParams({ expected_vault_id: file.vault_id, expected_version_id: file.version_id });
  const route = `/api/library/files/${file.file_id}/picture`;
  const response = await fetch(`${base}${route}?${query.toString()}`, {
    method: 'PUT', headers: { ...headers, 'Content-Type': picture.type }, body: picture, cache: 'no-store',
  });
  if (!response.ok) throw await refusal(response, route);
}

export function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('The picture could not be read.'));
    reader.readAsDataURL(blob);
  });
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
