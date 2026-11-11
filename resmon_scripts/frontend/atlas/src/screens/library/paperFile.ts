import { answer, engine } from '../../api/client';
import { errorWords, pending, readFullText, refusedCopy, requestWords, type FullTextStatus } from '../fulltext/fullText';
import { LIBRARY } from './libraryApi';

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const canceled = () => { clearTimeout(timer); reject(new Error('Adding to the project was canceled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', canceled); resolve(); }, 1000);
    signal.addEventListener('abort', canceled, { once: true });
    if (signal.aborted) canceled();
  });
}

/** The reason a project cannot get this paper's PDF, using the downloader's own account. */
export function cannotPrepare(status: FullTextStatus): string | null {
  if (status.in_library || pending(status.download)) return null;
  if (refusedCopy(status.download)) return requestWords(status.download!);
  if (status.downloadable) return null;
  return status.why_not_words ?? 'No downloadable PDF is recorded for this paper.';
}

/**
 * Get a permitted copy before adding it, and pin the exact version the Library
 * now holds. Closing the picker cancels this wait, not the download. The caller
 * checks cancellation before sending a project write; a write already sent may
 * still finish. No project is made until its file is ready.
 */
export async function preparePaperFile(id: number, vault: string, signal: AbortSignal, onRequested?: () => void) {
  let status = (await readFullText([id], signal)).get(id);
  if (!status) throw new Error('The engine did not answer about this paper’s PDF.');
  const why = cannotPrepare(status);
  if (why) throw new Error(why);
  if (!status.in_library && !pending(status.download)) {
    await answer(engine().POST('/api/documents/{doc_id}/full-text', { params: { path: { doc_id: id } }, signal }));
    onRequested?.();
    status = (await readFullText([id], signal)).get(id);
  }
  while (status && !status.in_library && pending(status.download)) {
    await pause(signal);
    status = (await readFullText([id], signal)).get(id);
  }
  if (!status?.in_library) {
    throw new Error(status?.download ? requestWords(status.download) : status?.why_not_words ?? 'The PDF is not in the Library.');
  }
  const held = status.in_library;
  if (held.vault_id !== vault) throw new Error('The Library changed. Close this menu and open it again.');
  const detail = await answer(engine().GET('/api/library/files/{file_id}', {
    ...LIBRARY, params: { path: { file_id: held.file_id }, query: { expected_vault_id: vault } }, signal,
  })).catch((error: unknown) => { throw new Error(errorWords(error)); });
  if (detail.file.version_id !== held.version_id || detail.vault_id !== vault || detail.file.vault_id !== vault || detail.file.file_id !== held.file_id
    || detail.file.media_type !== 'application/pdf') {
    throw new Error('The Library no longer holds that exact PDF. Close this menu and open it again.');
  }
  return [detail.file];
}
