import { getBaseUrl } from './client';

export const MAX_BATCH_FILES = 20;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export interface PaperLink { document_id: number; title: string; identity_scope: string; basis: string }
export interface LibraryFile {
  id: number; file_id: string; version_id: string; vault_id: string; sha256: string;
  byte_size: number; media_type: string; original_name: string; relative_path: string;
  created_at_utc: string; paper_links: PaperLink[]; availability: 'not_checked';
}
export interface LibraryStatus {
  version: 1; vault: {vault_id: string; label: string; created_at_utc: string} | null;
  status: string; counts: {items: number; retained_bytes: number; basis: string};
  limits: {file_bytes: number; batch_files: number; vault_bytes: number; items: number};
}
export interface LibraryPage { version: 1; vault_id: string; files: LibraryFile[]; through_id: number; next_before_id: number | null; has_more: boolean }
export interface TextEnvelope {
  version: 1; kind: 'resmon-library-text'; vault_id: string; file_id: string; version_id: string;
  sha256: string; media_type: string; encoding: 'utf-8'; normalization: 'crlf-cr-to-lf-v1';
  byte_size: number; line_count: number; text: string;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Library response.');
  return value as Record<string, unknown>;
}
export function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
function integer(x: unknown, min = 0): x is number { return Number.isSafeInteger(x) && (x as number) >= min; }
function envelope(value: unknown, vault: string): Record<string, unknown> {
  const x = object(value);
  if (x.version !== 1 || x.vault_id !== vault || !uuid(vault)) throw new Error('Library vault response changed. Refresh before acting.');
  return x;
}
export function validateFile(value: unknown, vault: string, expectedFile?: string): LibraryFile {
  const x = object(value);
  const ext = ({'application/pdf':'pdf','text/plain':'txt','text/markdown':'md'} as Record<string,string>)[String(x.media_type)];
  if (!uuid(x.file_id) || !uuid(x.version_id) || x.vault_id !== vault || (expectedFile && x.file_id !== expectedFile)
      || !integer(x.id, 1) || !integer(x.byte_size, 1) || x.byte_size > MAX_FILE_BYTES || !ext
      || typeof x.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(x.sha256)
      || typeof x.original_name !== 'string' || !x.original_name.length || x.original_name.length > 255
      || /[\x00-\x1f\x7f/\\]/.test(x.original_name) || typeof x.created_at_utc !== 'string'
      || x.relative_path !== `files/${x.file_id}/${x.version_id}.${ext}` || x.availability !== 'not_checked'
      || !Array.isArray(x.paper_links)) throw new Error('Invalid Library file identity or metadata.');
  for (const raw of x.paper_links) {
    const link = object(raw);
    if (!integer(link.document_id, 1) || typeof link.title !== 'string' || link.identity_scope !== 'this app database only'
        || link.basis !== 'owner_association') throw new Error('Invalid corpus-local paper association.');
  }
  return x as unknown as LibraryFile;
}
export function validateText(value: unknown, file: LibraryFile): TextEnvelope {
  const x = envelope(value, file.vault_id);
  const allowed = ['version','kind','vault_id','file_id','version_id','sha256','media_type','encoding','normalization','byte_size','line_count','text'];
  if (Object.keys(x).some(k => !allowed.includes(k)) || x.kind !== 'resmon-library-text' || x.file_id !== file.file_id
      || x.version_id !== file.version_id || x.sha256 !== file.sha256 || x.byte_size !== file.byte_size
      || x.media_type !== file.media_type || !['text/plain','text/markdown'].includes(String(x.media_type))
      || x.encoding !== 'utf-8' || x.normalization !== 'crlf-cr-to-lf-v1' || file.byte_size > 262144
      || typeof x.text !== 'string' || /[\r\x00]/.test(x.text) || !integer(x.line_count, 1) || x.line_count > 5000
      || x.text.split('\n').length !== x.line_count || new TextEncoder().encode(JSON.stringify(x)).length > 2097152)
    throw new Error('Text response does not match the selected bounded version.');
  return x as unknown as TextEnvelope;
}
async function request(path: string, method = 'GET', body?: BodyInit, raw = false): Promise<unknown> {
  const response = await fetch(`${getBaseUrl()}/api/library${path}`, {
    method, body, cache: 'no-store', headers: {'X-Resmon-Library':'1', ...(body !== undefined ? {'Content-Type':raw ? 'application/octet-stream' : 'application/json'} : {})},
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const detail = object(value).detail;
    const message = typeof detail === 'string' ? detail : (detail && typeof detail === 'object' ? object(detail).message : null);
    throw new Error(typeof message === 'string' ? message : `Library request refused (${response.status}).`);
  }
  return value;
}
const query = (values: Record<string, string | number | undefined>): string => '?' + new URLSearchParams(
  Object.entries(values).filter(([,v]) => v !== undefined).map(([k,v])=>[k,String(v)]),
).toString();
function status(value: unknown): LibraryStatus {
  const x = object(value); const c = object(x.counts); const l = object(x.limits);
  if (x.version !== 1 || !['unconfigured','ready','unavailable','mismatch','busy','needs_attention'].includes(String(x.status))
      || !integer(c.items) || !integer(c.retained_bytes) || c.basis !== 'recorded_metadata'
      || l.file_bytes !== MAX_FILE_BYTES || l.batch_files !== MAX_BATCH_FILES || l.vault_bytes !== 1073741824 || l.items !== 10000)
    throw new Error('Invalid Library status response.');
  if (x.vault !== null) {
    const v = object(x.vault);
    if (!uuid(v.vault_id) || v.label !== `resmon-library-${v.vault_id}` || typeof v.created_at_utc !== 'string') throw new Error('Invalid vault identity.');
  }
  return x as unknown as LibraryStatus;
}
export const libraryApi = {
  status: async () => status(await request('')),
  create: async (parent: string) => status(await request('/vault','POST',JSON.stringify({parent_directory:parent}))),
  list: async (vault: string, q = '', through?: number, before?: number): Promise<LibraryPage> => {
    const x = envelope(await request('/files'+query({expected_vault_id:vault,q,through_id:through,before_id:before})),vault);
    if (!Array.isArray(x.files) || x.files.length > 50 || !integer(x.through_id) || (through !== undefined && x.through_id !== through)
        || typeof x.has_more !== 'boolean' || !(x.next_before_id === null || integer(x.next_before_id, 1))) throw new Error('Invalid Library page.');
    const files = x.files.map(f=>validateFile(f,vault));
    if (files.some((f,i)=>f.id > (x.through_id as number) || (before !== undefined && f.id >= before) || (i>0 && f.id >= files[i-1].id))
        || (x.has_more ? !files.length || x.next_before_id !== files[files.length-1].id : x.next_before_id !== null)) throw new Error('Library page order changed.');
    return {...x,files} as unknown as LibraryPage;
  },
  detail: async (vault: string, file: string) => validateFile(envelope(await request(`/files/${file}`+query({expected_vault_id:vault})),vault).file,vault,file),
  import: async (vault: string, file: File) => {
    const x = envelope(await request('/files'+query({expected_vault_id:vault,filename:file.name}),'POST',file,true),vault);
    const item = validateFile(x.file,vault);
    if (typeof x.created !== 'boolean' || x.duplicate !== !x.created || !Array.isArray(x.linked_document_ids)) throw new Error('Invalid import receipt.');
    return {file:item,created:x.created};
  },
  link: async (file: LibraryFile, document: number) => {
    const x = envelope(await request(`/files/${file.file_id}/paper-links`,'POST',JSON.stringify({expected_vault_id:file.vault_id,document_id:document})),file.vault_id);
    if (x.file_id !== file.file_id || x.version_id !== file.version_id || x.document_id !== document) throw new Error('Paper link receipt names another item.');
    return x;
  },
  open: async (file: LibraryFile) => {
    const x = envelope(await request(`/files/${file.file_id}/open`,'POST',JSON.stringify({expected_vault_id:file.vault_id,expected_version_id:file.version_id})),file.vault_id);
    if (x.file_id !== file.file_id || x.version_id !== file.version_id || typeof x.path !== 'string' || !x.path.endsWith('/'+file.relative_path)
        || !x.path.startsWith('/') || /[\x00-\x1f]/.test(x.path)) throw new Error('Open response names another retained version.');
    return x.path;
  },
  text: async (file: LibraryFile) => validateText(await request(`/files/${file.file_id}/text`+query({expected_vault_id:file.vault_id,expected_version_id:file.version_id})),file),
  inventory: async (vault: string): Promise<unknown> => request('/export'+query({expected_vault_id:vault,format:'json'})),
};
