/**
 * A run's own record, and saved searches, saved as files: each is something
 * the engine answers, handed to the system as a download, which asks where to
 * save it, as every export in Atlas does.
 *
 * The report and the search record are Markdown text. The run's bundle (the
 * report, its PDF and LaTeX where a LaTeX engine could make them, the log, the
 * metadata, and the search record), several runs' bundles in one archive, and
 * the saved-search archive are ZIPs the engine builds.
 */
import { EngineError, engineSentence, engine } from '../../api/client';
import { runsFileStem } from './model';

/** Hand bytes or text the engine composed to the system as a download. */
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
    throw new EngineError(response.status, 'The search record could not be saved.', engineSentence(error));
  }
  saveFile(data, `resmon-search-record-${id}.md`, 'text/markdown;charset=utf-8');
}

/**
 * A ZIP the engine answered, saved under this name. An answer that does not
 * begin as a ZIP does is not handed on as one: a file that will not open is
 * worse than a refusal that says so.
 */
export async function saveZip(
  request: Promise<{ data?: ArrayBuffer; error?: unknown; response: Response }>,
  filename: string,
  what: string,
): Promise<void> {
  const { data, error, response } = await request;
  if (error !== undefined || !(data instanceof ArrayBuffer)) {
    throw new EngineError(response.status, `${what} could not be saved.`, engineSentence(error));
  }
  if (new Uint8Array(data, 0, Math.min(4, data.byteLength)).join(',') !== '80,75,3,4') {
    throw new EngineError(0, `The engine’s answer is not a ZIP archive, so ${what.toLowerCase()} was not saved.`);
  }
  saveFile(data, filename, 'application/zip');
}

/** The run's bundle, built by the engine, saved where the person chooses. */
export function saveBundle(id: number): Promise<void> {
  return saveZip(engine().GET('/api/executions/{exec_id}/bundle', {
    params: { path: { exec_id: id } },
    parseAs: 'arrayBuffer',
  }), `resmon-bundle-${id}.zip`, 'The bundle');
}

/**
 * Several runs' bundles in one archive, one folder per run, built by the engine as it builds one run's.
 * The runs go in by number, as the file name lists them, whatever order they were ticked or drawn in.
 */
export function saveRunsBundle(ids: readonly number[]): Promise<void> {
  return saveZip(engine().POST('/api/executions/archive', {
    body: { ids: [...new Set(ids)].sort((a, b) => a - b) },
    parseAs: 'arrayBuffer',
  }), `${runsFileStem('resmon-bundle', ids)}.zip`, 'The bundle');
}
