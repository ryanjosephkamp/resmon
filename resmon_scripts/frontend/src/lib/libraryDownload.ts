import { object, uuid } from '../api/library';
export const MAX_INVENTORY_BYTES = 8 * 1024 * 1024;
const exactKeys = (x: Record<string,unknown>, allowed: string[]) => Object.keys(x).length === allowed.length && Object.keys(x).every(k=>allowed.includes(k));
export function validateInventory(value: unknown, vault: string): {filename: string; text: string} {
  const x = object(value);
  if (!uuid(vault) || x.version !== 1 || x.vault_id !== vault || x.format !== 'json'
      || x.filename !== `resmon-library-${vault}.json` || x.content_type !== 'application/json' || typeof x.text !== 'string'
      || new TextEncoder().encode(x.text).length > MAX_INVENTORY_BYTES) throw new Error('Invalid or oversized Library inventory envelope.');
  const doc = object(JSON.parse(x.text) as unknown);
  if (!exactKeys(doc,['version','kind','vault_id','generated_at_utc','files','limits']) || doc.version !== 1
      || doc.kind !== 'resmon-library-inventory' || doc.vault_id !== vault || typeof doc.generated_at_utc !== 'string'
      || !Array.isArray(doc.files) || doc.files.length > 10000 || !Array.isArray(doc.limits) || !doc.limits.every(v=>typeof v==='string'))
    throw new Error('Inventory does not identify this complete vault metadata format.');
  const ids = new Set<string>(); const versions = new Set<string>();
  for (const raw of doc.files) {
    const f = object(raw); const ext = ({'application/pdf':'pdf','text/plain':'txt','text/markdown':'md'} as Record<string,string>)[String(f.media_type)];
    if (!exactKeys(f,['file_id','version_id','original_name','media_type','byte_size','sha256','relative_path','imported_at_utc','paper_links','availability'])
        || !uuid(f.file_id) || !uuid(f.version_id) || ids.has(f.file_id) || versions.has(f.version_id)
        || typeof f.original_name !== 'string' || !f.original_name.length || f.original_name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(f.original_name)
        || !ext || !Number.isSafeInteger(f.byte_size) || (f.byte_size as number) < 1 || (f.byte_size as number) > 67108864
        || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)
        || f.relative_path !== `files/${f.file_id}/${f.version_id}.${ext}` || typeof f.imported_at_utc !== 'string'
        || f.availability !== 'not_checked' || !Array.isArray(f.paper_links)) throw new Error('Invalid or private inventory fields.');
    ids.add(f.file_id); versions.add(f.version_id);
    const links = new Set<number>();
    for (const rawLink of f.paper_links) {
      const link = object(rawLink);
      if (!exactKeys(link,['document_id','identity_scope','basis']) || !Number.isSafeInteger(link.document_id) || (link.document_id as number)<1
          || links.has(link.document_id as number) || link.identity_scope !== 'this app database only' || link.basis !== 'owner_association') throw new Error('Invalid inventory paper association.');
      links.add(link.document_id as number);
    }
  }
  return {filename: x.filename as string, text:x.text};
}
export function downloadInventory(value: unknown, vault: string): void {
  const result = validateInventory(value,vault);
  const url = URL.createObjectURL(new Blob([result.text],{type:'application/json'}));
  const anchor = document.createElement('a'); anchor.href=url; anchor.download=result.filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
