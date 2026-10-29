import { archiveName, crc32, memberName, savedArchive } from '../savedExport';
import type { SavedConfiguration } from '../savedSearches';

/**
 * The archive read back the way a ZIP reader reads it: from the end-of-
 * directory record, through the central directory, to each local header and
 * its bytes. Each field a reader relies on is checked; that Python's
 * `zipfile` takes the same archive is the e2e and journey specs' half.
 */
function readZip(bytes: Uint8Array): { name: string; text: string }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  const directory = view.getUint32(end + 16, true);
  expect(directory + view.getUint32(end + 12, true)).toBe(end);
  const decoder = new TextDecoder();
  const out: { name: string; text: string }[] = [];
  let at = directory;
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint16(local + 8, true)).toBe(0);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    expect(decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength))).toBe(name);
    const data = bytes.subarray(local + 30 + nameLength, local + 30 + nameLength + size);
    expect(crc32(data)).toBe(crc);
    out.push({ name, text: decoder.decode(data) });
    at += 46 + nameLength;
  }
  return out;
}

const config = (over: Partial<SavedConfiguration>): SavedConfiguration => ({
  id: 17, name: 'Perovskites, two preprint servers', config_type: 'manual_sweep',
  parameters: { repositories: ['arxiv', 'biorxiv'], keywords: ['perovskite'], max_results: 100 },
  created_at: '2026-10-29T20:00:00Z', updated_at: '2026-10-29T20:00:00Z', ...over,
} as SavedConfiguration);

describe('the saved-search archive', () => {
  test('CRC-32 is the standard one', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  test('one JSON file per saved search, in the shape the engine exports and Import reads', () => {
    const watch = config({
      id: 18, name: 'Nightly: “tandem” cells', config_type: 'routine',
      parameters: JSON.stringify({ linked_routine_id: 7, schedule_cron: '0 9 * * *', is_active: true, parameters: { repositories: ['arxiv'] } }),
    });
    const members = readZip(savedArchive([config({}), watch], new Date(2026, 9, 29, 16, 34, 12)));
    expect(members.map((m) => m.name)).toEqual([
      'config_manual_sweep_perovskites,_two_preprint_servers_17.json',
      'config_routine_nightly__“tandem”_cells_18.json',
    ]);
    expect(JSON.parse(members[0]!.text)).toEqual({
      config_type: 'manual_sweep', name: 'Perovskites, two preprint servers',
      repositories: ['arxiv', 'biorxiv'], keywords: ['perovskite'], max_results: 100,
    });
    // Parameters stored as text are read; the watch's wrapper travels whole.
    expect(JSON.parse(members[1]!.text)).toMatchObject({ config_type: 'routine', linked_routine_id: 7, is_active: true });
  });

  test('parameters that are not an object travel as none, as the engine’s export treats them', () => {
    const [member] = readZip(savedArchive([config({ parameters: 'not json' })], new Date(2026, 9, 29)));
    expect(JSON.parse(member!.text)).toEqual({ config_type: 'manual_sweep', name: 'Perovskites, two preprint servers' });
  });

  test('a member’s name drops the characters a file name cannot hold, as `sanitize_filename` does', () => {
    expect(memberName({ id: 3, name: ' a/b:c? ', config_type: 'manual_dive' })).toBe('config_manual_dive_a_b_c__3.json');
  });

  test('the file is named for the moment it was made, in local time', () => {
    expect(archiveName(new Date(2026, 9, 29, 16, 4, 2))).toBe('resmon-saved-20261029T160402.zip');
  });
});
