/**
 * A run's own record, saved as files: the report and the search record as
 * Markdown, and the run's bundle.
 *
 * The first two are text the engine answers, handed to the system as a
 * download, which asks where to save it, as every other export in Atlas does.
 * The bundle cannot travel that way. The engine builds it (the report, its PDF
 * and LaTeX where a LaTeX engine could make them, the log, the metadata and
 * the search record, the archive classic's Export wrote) and writes it to a
 * folder itself, answering with the path: the folder chosen under Settings ›
 * Backup, or the system's temporary folder when none is chosen, which is said
 * rather than left for the person to find out.
 */
import { answer, engine, EngineError } from '../../api/client';

/** Hand text the engine composed to the system as a download. */
export function saveFile(content: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The report as the Markdown resmon wrote, saved under a name that says which run it is. */
export function saveReport(id: number, text: string): void {
  saveFile(text, `resmon-report-${id}.md`, 'text/markdown;charset=utf-8');
}

/** The search record, in the Markdown the engine renders for a methods section. */
export async function saveSearchRecord(id: number): Promise<void> {
  const { data, error, response } = await engine().GET('/api/executions/{exec_id}/search-record', {
    params: { path: { exec_id: id }, query: { format: 'markdown' } },
    parseAs: 'text',
  });
  if (error !== undefined || typeof data !== 'string') {
    const detail = typeof error === 'object' && error && 'detail' in error ? String((error as { detail: unknown }).detail) : null;
    throw new EngineError(response.status, 'The search record could not be saved.', detail);
  }
  saveFile(data, `resmon-search-record-${id}.md`, 'text/markdown;charset=utf-8');
}

/** Where the engine wrote a run's bundle, and whether that is the system's temporary folder. */
export interface WrittenBundle {
  path: string;
  temporary: boolean;
}

/**
 * Ask the engine to write the run's bundle, and say where it went. Whether
 * the folder is the person's own is read from the same setting the engine
 * chose by, rather than guessed from the path's shape.
 */
export async function writeBundle(id: number): Promise<WrittenBundle> {
  const written = (await answer(engine().POST('/api/executions/export', { body: { ids: [id] } }))) as { path?: unknown };
  const path = typeof written.path === 'string' ? written.path : '';
  if (!path) throw new EngineError(0, 'The engine wrote the bundle and did not say where.');
  const folder = (await answer(engine().GET('/api/settings/storage'))).export_directory ?? '';
  return { path, temporary: !folder };
}
