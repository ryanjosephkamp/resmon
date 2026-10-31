import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { MAP_KEY } from '../Today';
import { PaperLifecycle } from '../lifecycle/LifecycleMarks';
import { basisWords, PaperSky } from '../sky/PaperSky';
import { authors, publishedWords } from '../today/format';
import { pairLine, pairLink, pairParam } from './wordingModel';

/** How many of the paper's nearest neighbors on the map are listed. */
const NEIGHBORS = 8;

/** The words for a reading-queue status. */
export function queueWords(status: string | null | undefined): string | null {
  if (status === 'to_read') return 'To read';
  if (status === 'read') return 'Read';
  return null;
}

/**
 * One paper: the record as resmon holds it, any retraction or update recorded
 * against it since, why it is in the collection, the other records of the
 * same work, and where it sits on the map among its nearest neighbors there.
 *
 * Everything here is what was collected or what resmon measured. The abstract
 * is the source's, labeled as such; the "why" is the engine's account, with
 * what it cannot see stated beside it; the neighbors are nearest on the map,
 * and the map says whether it placed papers by meaning or by shared wording.
 */
export function Paper() {
  const { id: raw } = useParams();
  const id = Number(raw);
  const client = useQueryClient();
  const valid = Number.isInteger(id) && id > 0;

  const paper = useQuery({
    queryKey: ['paper', id], enabled: valid,
    queryFn: () => answer(engine().GET('/api/documents/{doc_id}', { params: { path: { doc_id: id } } })),
  });
  const why = useQuery({
    queryKey: ['paper-why', id], enabled: valid,
    queryFn: () => answer(engine().GET('/api/documents/{doc_id}/why', { params: { path: { doc_id: id } } })),
  });
  const links = useQuery({
    queryKey: ['links', [id]], enabled: valid,
    queryFn: () => answer(engine().POST('/api/links/for-documents', { body: { document_ids: [id] } })),
  });
  const wording = useQuery({
    queryKey: ['shared-wording-paper', id], enabled: valid,
    queryFn: () => answer(engine().GET('/api/shared-wording/papers/{document_id}', { params: { path: { document_id: id } } })),
  });
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const map = useQuery({ queryKey: MAP_KEY, queryFn: () => answer(engine().GET('/api/map')) });

  // Nearest on the map: by distance between map positions, which is what the
  // sky beside them shows, and no more than that.
  const nearest = useMemo(() => {
    const points = map.data?.points;
    if (!points) return [];
    const at = points.id.indexOf(id);
    if (at < 0) return [];
    const x0 = points.x[at] ?? 0; const y0 = points.y[at] ?? 0;
    const others: { id: number; d: number }[] = [];
    for (let i = 0; i < points.id.length; i += 1) {
      if (i === at) continue;
      const dx = (points.x[i] ?? 0) - x0; const dy = (points.y[i] ?? 0) - y0;
      others.push({ id: points.id[i] ?? -1, d: dx * dx + dy * dy });
    }
    return others.sort((a, b) => a.d - b.d).slice(0, NEIGHBORS).map((o) => o.id);
  }, [map.data, id]);
  const briefs = useQuery({
    queryKey: ['briefs', nearest], enabled: nearest.length > 0,
    queryFn: () => answer(engine().POST('/api/documents/briefs', { body: { ids: nearest } })),
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['paper', id] });
    void client.invalidateQueries({ queryKey: ['reading-queue'] });
  };
  const save = useMutation({
    mutationFn: () => answer(engine().POST('/api/reading-queue', { body: { document_id: id } })),
    onSuccess: refresh,
  });
  const mark = useMutation({
    mutationFn: (status: 'read' | 'to_read') => answer(engine().PUT('/api/reading-queue/{document_id}', {
      params: { path: { document_id: id } }, body: { status },
    })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => answer(engine().DELETE('/api/reading-queue/{document_id}', { params: { path: { document_id: id } } })),
    onSuccess: refresh,
  });

  if (!valid || paper.isError) {
    return (
      <div className="page">
        <h1 className="page-title">Paper {raw} could not be read</h1>
        <p className="page-lede">{paper.error?.message ?? 'There is no such paper in your collection.'}</p>
        <p><Link to="/search" className="btn">Back to Search</Link></p>
      </div>
    );
  }
  if (paper.isPending) return <div className="page"><p className="page-lede">Reading paper {raw}.</p></div>;

  const data = paper.data;
  const source = catalog.data?.find((entry) => entry.slug === data.source_repository)?.name ?? data.source_repository;
  const status = data.queue_status ?? null;
  const pending = save.isPending || mark.isPending || remove.isPending;
  const also = links.data?.links[String(id)] ?? [];
  const shares = wording.data?.pairs ?? [];

  return (
    <div className="paper" data-paper={data.id}>
      <div className="paper-main">
        <Link to="/search" className="back"><Icon name="back" size={14} />Your collection</Link>
        <h1 className="paper-name">{data.title}</h1>
        <div className="meta paper-meta">
          <span className="who">{authors(data.authors)}</span>
          <span className="sep" />
          <span>{source}</span>
          {data.publication_date && (<><span className="sep" /><span>Published {publishedWords(data.publication_date)}</span></>)}
          {data.doi && (<><span className="sep" /><a href={`https://doi.org/${data.doi}`} target="_blank" rel="noreferrer">doi:{data.doi}</a></>)}
          {data.url && (<><span className="sep" /><a href={data.url} target="_blank" rel="noreferrer">open at the source</a></>)}
          {/* The number this collection knows it by: what a file in the Library is linked with. */}
          <span className="sep" />
          <span className="paper-number num" title="Its number in this collection only">Paper {data.id}</span>
        </div>
        <div className="paper-actions" data-queue={status ?? 'none'}>
          {status === null && (
            <button type="button" className="btn primary" disabled={pending} onClick={() => save.mutate()}>
              <Icon name="bookmark" size={14} />Save to read
            </button>
          )}
          {status !== null && (
            <>
              <span className="queue-state">In the reading queue · {queueWords(status)}</span>
              <button type="button" className="btn" disabled={pending}
                onClick={() => mark.mutate(status === 'read' ? 'to_read' : 'read')}>
                {status === 'read' ? 'Mark unread' : 'Mark read'}
              </button>
              <button type="button" className="btn quiet" disabled={pending} onClick={() => remove.mutate()}>Remove</button>
            </>
          )}
          {(save.error || mark.error || remove.error) && (
            <p className="field-error" role="alert">{(save.error ?? mark.error ?? remove.error)?.message}</p>
          )}
        </div>

        {/* Above the abstract: a retraction is read before the paper is. */}
        <PaperLifecycle id={data.id} />

        {data.abstract && (
          <section className="paper-section" aria-label="Abstract">
            <h2>Abstract <span>as {source} gave it</span></h2>
            <p className="paper-abstract">{data.abstract}</p>
          </section>
        )}

        <section className="paper-section why" aria-label="Why this paper is here">
          <h2>Why it is here</h2>
          {why.isPending && <p className="record-cap">Reading resmon&rsquo;s account.</p>}
          {why.isError && <p className="record-cap">The account could not be read ({why.error.message}).</p>}
          {why.data && (
            <>
              <p className="why-headline">{why.data.headline}</p>
              {why.data.keywords.length > 0 && (
                <ul className="why-keywords">
                  {why.data.keywords.map((k) => (
                    <li key={k.keyword} data-matched={k.matched}>
                      <span className="why-keyword">{k.keyword}</span>
                      <span className="why-where">{k.matched ? `found in ${k.where}` : k.where}</span>
                    </li>
                  ))}
                </ul>
              )}
              {why.data.runs.length > 0 && (
                <p className="why-runs">
                  Collected by {why.data.runs.map((run, i) => (
                    <span key={run.execution_id}>
                      {i > 0 && ', '}
                      <Link to={`/runs/${run.execution_id}`}>{run.routine_name ?? `run ${run.execution_id}`}</Link>
                    </span>
                  ))}.
                </p>
              )}
              <h3 className="why-limits-label">What resmon cannot see</h3>
              <ul className="why-limits">{why.data.what_resmon_cannot_see.map((line) => <li key={line}>{line}</li>)}</ul>
            </>
          )}
        </section>

        {shares.length > 0 && (
          <section className="paper-section" aria-label="Shared wording" data-wording="paper-note">
            <h2>Shared wording <span>with other abstracts in your collection, from the last scan</span></h2>
            <ul className="paper-links">
              {shares.map((pair) => {
                const other = pair.left.id === data.id ? pair.right : pair.left;
                return (
                  <li key={pairParam(pair.a, pair.b)}>
                    <Link to={pairLink(pair.a, pair.b)}>{other.title}</Link>
                    <span>{pairLine(pair, wording.data?.phrase_words ?? 8)}{pair.reason_words ? ` · Set aside: ${pair.reason_words}` : ''}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {also.length > 0 && (
          <section className="paper-section" aria-label="The same work elsewhere">
            <h2>The same work elsewhere</h2>
            <ul className="paper-links">
              {also.map((link) => (
                <li key={link.id}><Link to={`/papers/${link.id}`}>{link.title}</Link><span>{link.label}</span></li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className="paper-side" aria-label="Its neighborhood">
        <PaperSky
          marked={nearest}
          focus={id}
          label="Where this paper sits, among its nearest neighbors on the map"
          caption={({ ready, basis }) => {
            if (!ready) return 'The collection map is not ready yet.';
            if (!nearest.length) return 'The map has not placed this paper yet: it arrived after the last fit, or has too little text to place.';
            return `This paper, and the ${nearest.length} nearest to it on the map, ${basisWords(basis)}.`;
          }}
        />
        {briefs.data && briefs.data.length > 0 && (
          <ol className="neighbors" aria-label="Nearest on the map">
            {briefs.data.map((brief) => (
              <li key={brief.id}><Link to={`/papers/${brief.id}`}>{brief.title}</Link></li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}
