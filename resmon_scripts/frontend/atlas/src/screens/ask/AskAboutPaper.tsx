import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { STATUS_KEY } from './AskProvider';
import { ask } from './askApi';
import { choiceProblem, firstChoice } from './askModel';
import { usePaperPlaces } from '../library/PaperPlaces';
import { LIBRARY } from '../library/libraryApi';
import type { FileRecord } from '../library/evidenceApi';
import type { PaperSubject } from './paperQuestion';

function AskLink({ subject, pending = false }: { subject: PaperSubject; pending?: boolean }) {
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: ask.status, refetchOnMount: 'always' });
  const choices = status.data?.composer_choices;
  if (status.isPending || pending) return <span className="form-hint">Checking the paper and Ask connection.</span>;
  if (status.isError) return <span className="form-hint">The Ask connection could not be checked ({status.error.message}).{' '}
    <Link to="/settings/ai">Open Settings › AI</Link>
  </span>;
  if (!choices || choiceProblem(choices, firstChoice(choices))) return <span className="form-hint">
    Ask About This Paper needs an available connection in Settings › AI.{' '}
    <Link to="/settings/ai" className="record-link">Set Up AI to Ask About This Paper</Link>
  </span>;
  return <Link className="btn sm" to="/ask" state={{ paper: subject }}>Ask About This Paper</Link>;
}

export function AskAboutPaper({ id, title }: { id: number; title: string }) {
  const places = usePaperPlaces(id);
  const file = paperFile(places.data?.files ?? []);
  return <AskLink pending={places.isPending} subject={{ title, paperId: id, ...(file ? { file: {
    id: file.file_id, name: file.original_name, ...(file.version_id ? { version: file.version_id } : {}) } } : {}) }} />;
}

/**
 * The file a paper question attaches: the paper's PDF where one is in the Library folder, else
 * its first file there, else its first file. A note kept beside a paper is not its full text.
 */
export function paperFile<T extends { media_type: string; availability?: string }>(files: readonly T[]): T | undefined {
  const present = files.filter(f => f.availability !== 'missing' && f.availability !== 'unavailable');
  return present.find(f => f.media_type === 'application/pdf') ?? present[0] ?? files[0];
}

/** The same exact-version lookup as the reader's paper backlinks. */
export function AskAboutFile({ file }: { file: FileRecord }) {
  const detail = useQuery({
    queryKey: ['library-file', file.vault_id, file.file_id],
    queryFn: () => answer(engine().GET('/api/library/files/{file_id}', { ...LIBRARY, params: {
      path: { file_id: file.file_id }, query: { expected_vault_id: file.vault_id },
    } })),
  });
  const current = detail.data?.file;
  const linked = current?.vault_id === file.vault_id && current.file_id === file.file_id && current.version_id === file.version_id
    && current.paper_links?.length === 1 ? current.paper_links[0] : null;
  return <AskLink pending={detail.isPending} subject={{ title: linked?.title ?? file.original_name,
    ...(linked ? { paperId: linked.document_id } : {}),
    file: { id: file.file_id, name: file.original_name, version: file.version_id } }} />;
}
