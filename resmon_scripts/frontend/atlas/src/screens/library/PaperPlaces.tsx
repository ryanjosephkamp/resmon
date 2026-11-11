import { useQuery, type QueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import type { components } from '../../api/schema';
import { errorWords } from '../fulltext/fullText';
import { fullDate, instant } from '../today/format';
import { LIBRARY, libraryProblem } from './libraryApi';
import './paperActions.css';

type Paper = components['schemas']['Paper'];
type PaperLink = components['schemas']['LibraryPaperLink'];

/** A file action changes only the cached papers linked to those files. */
export function invalidatePlacesForFiles(client: QueryClient,
  files: readonly { file_id: string; paper_links?: readonly { document_id: number }[] }[]) {
  const fileIds = new Set(files.map((file) => file.file_id));
  const paperIds = new Set(files.flatMap((file) => file.paper_links?.map((link) => link.document_id) ?? []));
  return client.invalidateQueries({ queryKey: ['paper-places'], predicate: (query) => {
    const places = query.state.data as components['schemas']['LibraryPaperPlaces'] | undefined;
    return paperIds.has(Number(query.queryKey[1])) || !!places?.files?.some((file) => fileIds.has(file.file_id));
  } });
}

export function invalidatePlacesForProject(client: QueryClient, projectId: string) {
  return client.invalidateQueries({ queryKey: ['paper-places'], predicate: (query) => {
    const places = query.state.data as components['schemas']['LibraryPaperPlaces'] | undefined;
    return !!places?.projects?.some((project) => project.project_id === projectId);
  } });
}

/** Every surface shares a small lookup, refreshed on return and after its writes. */
export function usePaperPlaces(id: number, enabled = true) {
  return useQuery<components['schemas']['LibraryPaperPlaces']>({ queryKey: ['paper-places', id], enabled, staleTime: 0, refetchOnMount: true, refetchOnWindowFocus: true,
    // Only a passing state is polled: a Library that is busy or being moved.
    // One that is missing, unconfigured, or needs attention changes when the
    // person acts, and returning to the window reads it again.
    refetchInterval: (query) => {
      const state = query.state.data?.library;
      return state && (state.status === 'busy' || state.changing) ? 1000 : false;
    },
    queryFn: ({ signal }) => answer(engine().GET('/api/library/papers/{document_id}/places', {
      ...LIBRARY, params: { path: { document_id: id } }, signal,
    })),
  });
}

function since(value: string | null): string {
  if (!value) return 'date not recorded';
  const at = instant(value);
  return Number.isNaN(at.getTime()) ? 'date not recorded' : `since ${fullDate(at)}`;
}

/** The queue, linked files, and projects already associated with a collection record. */
export function PaperPlaces({ paper }: { paper: Paper }) {
  const places = usePaperPlaces(paper.id);
  const queue = places.data?.shelf;
  const files = places.data?.files;
  const projects = places.data?.projects;
  const state = places.data?.library;
  const ready = state?.status === 'ready' && !state.changing;
  return <section className="paper-section paper-places" aria-label="Already in Your Library">
    <h2>Already in Your Library</h2>
    <ul>
      {queue && <li>
        <Link to={`/library?show=${queue.status}`}>{queue.status === 'read' ? 'Read' : 'To Read'}</Link>
        {' · '}{since(queue.status === 'read' ? queue.read_at : queue.updated_at)}
      </li>}
      {files?.map((file) => <li key={file.file_id}>
        <Link to={`/library/files/${file.file_id}?paper=${paper.id}`}>{file.media_type === 'application/pdf' ? 'PDF in Your Files' : 'Linked File in Your Files'}: {file.original_name}</Link>
        {file.availability === 'missing' && ' · not in the Library folder'}
        {file.availability === 'unavailable' && ' · this file could not be checked in the Library folder'}
      </li>)}
      {projects?.map((project) => <li key={project.project_id}>
        <Link to={`/library/evidence?project=${encodeURIComponent(project.project_id)}`}>{project.name}</Link>
      </li>)}
    </ul>
    {places.isPending && <p className="record-cap">Reading its shelf, files, and projects.</p>}
    {places.isError && <p className="record-cap" role="status">Some places could not be read: {errorWords(places.error)}</p>}
    {state && !ready && <p className="record-cap" role="status">{libraryProblem(state)}{' '}
      <Link to="/library?show=files">Your Files</Link>
    </p>}
    {places.isSuccess && !queue && <p className="record-cap">Not in To Read or Read.</p>}
    {places.isSuccess && ready && files?.length === 0 && <p className="record-cap">No Library file is linked to this paper.</p>}

  </section>;
}

export function PaperBacklinks({ links }: { links: readonly Pick<PaperLink, 'document_id' | 'title'>[] }) {
  if (!links.length) return null;
  return <ul className="paper-backlinks" aria-label="Linked Papers">
    {links.map((link) => <li key={link.document_id}><Link to={`/papers/${link.document_id}`}>
      {link.title ?? `Paper ${link.document_id}`}
    </Link></li>)}
  </ul>;
}

/** An Evidence file returns to the same collection record as its Library card. */
export function EvidencePaperLinks({ file }: { file: { file_id: string; vault_id: string; version_id: string } }) {
  const detail = useQuery({
    queryKey: ['library-file', file.vault_id, file.file_id],
    queryFn: () => answer(engine().GET('/api/library/files/{file_id}', { ...LIBRARY, params: {
      path: { file_id: file.file_id }, query: { expected_vault_id: file.vault_id },
    } })),
  });
  if (detail.isError) return <p className="record-cap">Linked papers could not be read: {errorWords(detail.error)}</p>;
  const current = detail.data?.file;
  if (!current || current.vault_id !== file.vault_id || current.file_id !== file.file_id || current.version_id !== file.version_id) return null;
  return <PaperBacklinks links={current.paper_links} />;
}
