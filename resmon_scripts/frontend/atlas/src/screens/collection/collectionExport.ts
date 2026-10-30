import { engine, EngineError, engineSentence } from '../../api/client';
import { saveFile } from '../runs/downloads';
import { FORMATS, type ReferenceFormat } from '../runs/references';
import type { EngineFilters } from './filters';

/**
 * Every paper the collection's filters match, as one reference file: the
 * engine selects and renders it (`POST /api/explorer/export`), and the bytes go
 * to the system as a download, which asks where to save it, as every export in
 * Atlas does. The engine says how many papers it wrote; that number, not one
 * worked out here, is what the screen reports.
 */
export async function exportCollection(
  filters: EngineFilters,
  format: ReferenceFormat,
): Promise<{ filename: string; records: number | null }> {
  const { data, error, response } = await engine().POST('/api/explorer/export', {
    body: { ...filters, format },
    parseAs: 'text',
  });
  if (error !== undefined || typeof data !== 'string') {
    throw new EngineError(response.status, `The export was not made (HTTP ${response.status}).`, engineSentence(error));
  }
  const ext = FORMATS.find((f) => f.id === format)?.ext ?? format;
  const filename = `resmon-collection.${ext}`;
  saveFile(data, filename, response.headers.get('Content-Type') ?? 'text/plain;charset=utf-8');
  const said = response.headers.get('X-Resmon-Document-Count');
  return { filename, records: said !== null && /^\d+$/.test(said) ? Number(said) : null };
}
