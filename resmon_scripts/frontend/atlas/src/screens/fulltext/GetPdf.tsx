import { sourceAddress } from '../../lib/sourceAddress';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../shell/Icon';
import { bridge } from '../../bridge';
import {
  errorWords, hostWords, licenseWords, pending, refusedCopy, requestWords, useFullText, useGetPdf, useLandedRefresh,
  type FullTextStatus,
} from './fullText';

/**
 * Re-reads the Library's lists once a request this page watched has
 * finished, so its card becomes a PDF card without a reload.
 *
 * A request is seen to finish two ways. One that was read waiting or
 * downloading and is not now; and one whose paper the Library did not hold
 * and now does. The second is a download quicker than a read: Get the PDF
 * answers "waiting", and by the time the statuses are read again the PDF is
 * already in the Library, so it is never read as going.
 */
export function useLanded(statuses: ReadonlyMap<number, FullTextStatus> | undefined) {
  const refresh = useLandedRefresh();
  const going = useRef(new Set<number>());
  const held = useRef(new Map<number, boolean>());
  useEffect(() => {
    if (!statuses) return;
    const landed = new Set<number>();
    for (const status of statuses.values()) {
      const id = status.document_id;
      if (pending(status.download)) going.current.add(id);
      else if (going.current.delete(id)) landed.add(id);
      const holds = !!status.in_library;
      if (holds && held.current.get(id) === false) landed.add(id);
      held.current.set(id, holds);
    }
    if (landed.size) refresh([...landed]);
  }, [statuses, refresh]);
}

/**
 * A paper's full text, on its page: Read the PDF when the Library holds it,
 * Get the PDF when a source states an open license for a copy, and otherwise
 * Open at the source, with the reason there is nothing to get.
 */
export function PaperFullText({ id, sourceUrl, sourceName, title, fullText }: {
  id: number; sourceUrl: string | null; sourceName: string; title?: string; fullText?: FullTextStatus;
}) {
  const statuses = useFullText(fullText ? [] : [id]);
  const get = useGetPdf();
  useLanded(statuses.data);
  const status = fullText ?? statuses.data?.get(id);
  const named = (action: string) => title ? `${action} for “${title}”` : action;
  if (!fullText && statuses.isPending) return <p className="record-cap">Checking for a PDF.</p>;
  if ((!fullText && statuses.isError) || !status) {
    return <p className="field-error" role="alert">{statuses.error
      ? `Whether this paper has an open copy could not be read (${errorWords(statuses.error)}).`
      : 'The engine did not answer about this paper’s PDF.'}</p>;
  }
  const request = status.download;
  const copyInBrowser = refusedCopy(request);
  const going = pending(request);
  const held = status.in_library;
  const best = status.best;
  const sourcePage = sourceAddress(sourceUrl);
  const openAtSource = sourcePage && (
    <a className="btn quiet" href={sourcePage} target="_blank" rel="noreferrer" data-fulltext="open-at-source" aria-label={named(`Open at ${sourceName}`)}>
      <Icon name="open" size={14} />Open at {sourceName}
    </a>
  );
  let line: string | null;
  if (held) line = 'The PDF is in the Library.';
  else if (request && (going || request.state === 'failed' || request.state === 'skipped')) line = requestWords(request);
  else if (best) line = `Open copy at ${hostWords(best.host)}, ${licenseWords(best)}.`;
  else line = status.why_not_words ?? 'No downloadable PDF is recorded for this paper.';
  return (
    <div className="fulltext" data-fulltext={held ? 'held' : going ? request!.state : status.downloadable ? 'downloadable' : 'none'}>
      <div className="fulltext-acts">
        {held ? (
          <Link className="btn" to={`/library/files/${held.file_id}?paper=${id}`} data-fulltext="read" aria-label={named('Read the PDF')}>
            <Icon name="open" size={14} />Read the PDF
          </Link>
        ) : copyInBrowser ? (
          <button type="button" className="btn" data-fulltext="browser" aria-label={named('Open the Copy in Your Browser')} onClick={() => void bridge()?.openPath?.(copyInBrowser)}>
            <Icon name="open" size={14} />Open the Copy in Your Browser
          </button>
        ) : status.downloadable ? (
          <button type="button" className="btn" disabled={going || get.isPending} data-fulltext="get" aria-label={named(going ? 'Getting the PDF' : 'Get the PDF')}
            onClick={() => get.mutate(id)}>
            <Icon name="download" size={14} />{going ? 'Getting the PDF' : 'Get the PDF'}
          </button>
        ) : openAtSource}
        {status.downloadable && !held && openAtSource}
      </div>
      {line && <p className="fulltext-line" role={going ? 'status' : undefined}>{line}</p>}
      {!held && !status.downloadable && !sourceUrl && !copyInBrowser && <p className="fulltext-line">No source address is recorded for this paper.</p>}
      {get.error && <p className="field-error" role="alert">{errorWords(get.error)}</p>}
    </div>
  );
}
