/**
 * Saved searches as a file to keep: the archive Import reads back.
 *
 * The engine's export route writes its archive to a folder of its own
 * choosing and answers with the path, which in a desktop app with no export
 * folder chosen is the system's temporary folder, and nobody is asked where
 * it should go. Every other export in Atlas is handed to the system as a
 * download, which asks. So the archive is made here, in the engine's own
 * shape (`config_manager.export_configs`): one JSON file per saved search,
 * `config_<type>_<name>_<id>.json`, holding its type, its name and its stored
 * parameters at the top level. `import_configs` reads it by its content, and
 * reads it whatever its members are called.
 */
import type { SavedConfiguration } from './savedSearches';

/** One file in an archive. */
export interface ArchiveMember {
  name: string;
  bytes: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 a ZIP member carries (the IEEE polynomial, as `zlib.crc32` computes it). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A moment as the DOS date and time a ZIP header holds, in local time to the even second. */
function dosStamp(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getFullYear());
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/**
 * A ZIP archive of the members, stored rather than compressed: a saved search
 * is a few hundred bytes of JSON, and storing keeps this writer small enough to
 * read. Names are UTF-8 and flagged so (general-purpose bit 11).
 */
export function zipArchive(members: readonly ArchiveMember[], at: Date): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const { time, date } = dosStamp(at);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const member of members) {
    const name = encoder.encode(member.name);
    const crc = crc32(member.bytes);
    const size = member.bytes.byteLength;

    const local = new Uint8Array(30 + name.byteLength + size);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true);
    l.setUint16(8, 0, true);
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, size, true);
    l.setUint32(22, size, true);
    l.setUint16(26, name.byteLength, true);
    l.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(member.bytes, 30 + name.byteLength);

    const central = new Uint8Array(46 + name.byteLength);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.byteLength, true);
    // Extra field, comment, disk number, internal and external attributes: none.
    c.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.byteLength;
  }
  const directorySize = centrals.reduce((n, entry) => n + entry.byteLength, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, members.length, true);
  e.setUint16(10, members.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);

  const archive = new Uint8Array(offset + directorySize + end.byteLength);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    archive.set(part, cursor);
    cursor += part.byteLength;
  }
  return archive;
}

/** The stored parameters as an object; anything else stands for none, as the engine's export reads it. */
function parametersOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return parametersOf(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The member name the engine gives a saved search: `sanitize_filename`, spaces to underscores, lowercased. */
export function memberName(config: Pick<SavedConfiguration, 'id' | 'name' | 'config_type'>): string {
  const slug = config.name.replace(/[<>:"/\\|?*]/g, '_').trim().replace(/ /g, '_').toLowerCase();
  return `config_${config.config_type}_${slug}_${config.id}.json`;
}

/** The archive of these saved searches, one JSON file each, in the order given. */
export function savedArchive(configs: readonly SavedConfiguration[], at: Date): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  return zipArchive(configs.map((config) => ({
    name: memberName(config),
    bytes: encoder.encode(JSON.stringify({
      config_type: config.config_type,
      name: config.name,
      ...parametersOf(config.parameters),
    }, null, 2)),
  })), at);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "resmon-saved-20261029T163412.zip", stamped in local time. */
export function archiveName(at: Date): string {
  return `resmon-saved-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `T${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.zip`;
}
