/**
 * Evidence over the engine: projects, the exact files in them, their pages'
 * text, and the notes and passages kept against those files.
 *
 * The Evidence routes read their own request bodies (to bound them and refuse
 * duplicate keys), so `openapi.json` has no request shapes for them and the
 * typed client cannot send them. These calls go out raw, with the token and the
 * Library header the guard asks for, and come back typed by the response
 * models. Every answer is checked against the vault and project it was asked
 * about, and a page's text against the hash the engine gave it, before a
 * screen uses it: a passage is pinned to that text, so it must be exactly it.
 */
import type { components } from '../../api/schema';
import { bridge } from '../../bridge';
import { EngineError, engineSentence } from '../../api/client';
import { LIBRARY } from './libraryApi';

export type Project = components['schemas']['EvidenceProject'];
export type FileRecord = components['schemas']['EvidenceFileRecord'];
export type Member = components['schemas']['EvidenceMember'];
export type Note = components['schemas']['EvidenceNote'];
export type PageText = components['schemas']['EvidencePageText'];
export type Projects = components['schemas']['EvidenceProjects'];
export type Members = components['schemas']['EvidenceMembers'];
export type Notes = components['schemas']['EvidenceNotes'];
export type ProjectDetail = components['schemas']['EvidenceProjectDetail'];
export type NoteSaved = components['schemas']['EvidenceNoteSaved'];

/** What a passage is pinned to: one page's canonical text, by its hash and codepoint offsets. */
export interface Anchor {
  page_number: number;
  extraction_contract: string;
  page_text_sha256: string;
  start_codepoint: number;
  end_codepoint: number;
  quote: string;
}

/** A refusal with the engine's `reason`, so a caller can tell a busy reader from a real refusal. */
export class EvidenceRefusal extends EngineError {
  constructor(status: number, message: string, detail: string | null, readonly reason: string | null) {
    super(status, message, detail);
  }
}

/**
 * The engine reads one PDF page at a time and answers a second read with
 * `reader_busy` until the first finishes or is cancelled, which a reader
 * switching pages or files can meet. That one refusal is worth waiting for.
 */
export function readerBusy(error: unknown): boolean {
  return error instanceof EvidenceRefusal && error.reason === 'reader_busy';
}

function endpoint(): { base: string; token: string | null } {
  const link = bridge();
  const port = link?.getBackendPort() ?? '';
  // Evidence never falls back to a default instance, and never to the daemon's port.
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535 || port === '8742') {
    throw new EngineError(0, 'Evidence needs this window’s own engine, and it has none yet.');
  }
  return { base: `http://127.0.0.1:${port}/api/evidence`, token: link?.getApiToken() ?? null };
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) params.set(k, String(v));
  return `?${params.toString()}`;
}

export async function evidenceFetch(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<Response> {
  const { base, token } = endpoint();
  const response = await fetch(`${base}${path}`, {
    method, signal, cache: 'no-store',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...LIBRARY.headers,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const said: unknown = await response.json().catch(() => null);
    const detail = said && typeof said === 'object' ? (said as { detail?: unknown }).detail : null;
    const reason = detail && typeof detail === 'object' ? (detail as { reason?: unknown }).reason : null;
    throw new EvidenceRefusal(response.status, `Evidence answered HTTP ${response.status}`, engineSentence(said),
      typeof reason === 'string' ? reason : null);
  }
  return response;
}

async function read<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  return (await evidenceFetch(path, method, body, signal)).json() as Promise<T>;
}

/** An answer about another vault or project than the one asked about is not used. */
function same<T extends { vault_id: string; project_id?: string }>(answer: T, vault: string, project?: string): T {
  if (answer.vault_id !== vault || (project !== undefined && answer.project_id !== project)) {
    throw new EngineError(0, 'The engine answered about a different library or project. Refresh before going on.');
  }
  return answer;
}

export async function sha256Hex(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The largest PDF the reader draws, as the engine bounds a kept file. */
const MAX_PDF_BYTES = 16 * 1024 * 1024;

/** A body read to its end, refused the moment it passes `limit` bytes. */
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) throw new EngineError(0, 'The engine sent no file.');
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new EngineError(0, 'The file is larger than the reader draws.');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  return bytes;
}

const revisioned = (p: Project) => ({ expected_vault_id: p.vault_id, expected_revision: p.revision });

export const evidence = {
  projects: async (vault: string) => same(await read<Projects>(`/projects${query({ expected_vault_id: vault })}`), vault),
  create: async (vault: string, name: string) => same(await read<ProjectDetail>('/projects', 'POST', { expected_vault_id: vault, name }), vault),
  detail: async (vault: string, id: string) => same(await read<ProjectDetail>(`/projects/${id}${query({ expected_vault_id: vault })}`), vault, id),
  rename: async (p: Project, name: string) => same(await read<ProjectDetail>(`/projects/${p.project_id}`, 'PATCH', { ...revisioned(p), name }), p.vault_id, p.project_id),
  members: async (p: Project) => same(await read<Members>(`/projects/${p.project_id}/files${query({ expected_vault_id: p.vault_id })}`), p.vault_id, p.project_id),
  add: async (p: Project, file: { file_id: string; version_id: string }) => same(
    await read<ProjectDetail & { added: boolean }>(`/projects/${p.project_id}/files`, 'POST', { ...revisioned(p), file_id: file.file_id, version_id: file.version_id }),
    p.vault_id, p.project_id),
  remove: async (p: Project, file: FileRecord) => same(
    await read<ProjectDetail & { removed: boolean }>(`/projects/${p.project_id}/files/${file.file_id}`, 'DELETE', { ...revisioned(p), version_id: file.version_id }),
    p.vault_id, p.project_id),
  notes: async (p: Project) => same(await read<Notes>(`/projects/${p.project_id}/notes${query({ expected_vault_id: p.vault_id })}`), p.vault_id, p.project_id),
  save: async (p: Project, file: FileRecord, body: string, anchor: Anchor | null) => same(
    await read<NoteSaved>(`/projects/${p.project_id}/notes`, 'POST', {
      ...revisioned(p), file_id: file.file_id, version_id: file.version_id, kind: anchor ? 'passage' : 'note', body, anchor,
    }), p.vault_id, p.project_id),
  edit: async (p: Project, note: Note, body: string) => same(
    await read<NoteSaved>(`/projects/${p.project_id}/notes/${note.note_id}`, 'PATCH', {
      ...revisioned(p), expected_note_revision: note.revision, body,
    }), p.vault_id, p.project_id),
  /**
   * The exact version's bytes, for drawing its pages: the engine's identity
   * headers must name this vault, project, file, version and hash, and the
   * bytes must be the recorded size and hash, or nothing is drawn.
   */
  pdf: async (p: Pick<Project, 'vault_id' | 'project_id'>, file: Pick<FileRecord, 'file_id' | 'version_id' | 'sha256' | 'byte_size'>,
    signal?: AbortSignal) => {
    if (file.byte_size > MAX_PDF_BYTES) throw new EngineError(0, 'The file is larger than the reader draws.');
    const response = await evidenceFetch(
      `/projects/${p.project_id}/reader/${file.file_id}${query({ expected_vault_id: p.vault_id, version_id: file.version_id, representation: 'pdf' })}`,
      'GET', undefined, signal);
    const identity: Record<string, string> = {
      'X-Resmon-Vault': p.vault_id, 'X-Resmon-Project': p.project_id, 'X-Resmon-File': file.file_id,
      'X-Resmon-Version': file.version_id, 'X-Resmon-SHA256': file.sha256,
    };
    if (Object.entries(identity).some(([name, value]) => response.headers.get(name) !== value)) {
      await response.body?.cancel();
      throw new EngineError(0, 'The engine answered with another file than the one asked for. Nothing was drawn.');
    }
    const bytes = await boundedBytes(response, MAX_PDF_BYTES);
    if (bytes.byteLength !== file.byte_size || await sha256Hex(bytes) !== file.sha256) {
      throw new EngineError(0, 'The file’s bytes do not match its recorded size and hash. Nothing was drawn.');
    }
    return bytes;
  },
  /** One page's canonical text, with its hash checked here against the text itself. */
  text: async (p: Project, file: FileRecord, page: number, signal?: AbortSignal) => {
    const answer = same(await read<PageText>(
      `/projects/${p.project_id}/reader/${file.file_id}${query({ expected_vault_id: p.vault_id, version_id: file.version_id, page, representation: 'text' })}`,
      'GET', undefined, signal), p.vault_id, p.project_id);
    if (answer.file_id !== file.file_id || answer.version_id !== file.version_id || answer.sha256 !== file.sha256 || answer.page_number !== page) {
      throw new EngineError(0, 'The page answered is not the page asked for. Nothing was shown.');
    }
    if (answer.status === 'extracted' && answer.page_text_sha256 !== await sha256Hex(answer.text)) {
      throw new EngineError(0, 'The page text does not match its own hash. Nothing was shown.');
    }
    return answer;
  },
};
