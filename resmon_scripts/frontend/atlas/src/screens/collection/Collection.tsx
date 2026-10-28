import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import type { components } from '../../api/schema';
import { Icon } from '../../shell/Icon';
import { basisWords, PaperSky } from '../sky/PaperSky';
import { authors, count, number } from '../today/format';
import { foldedAway, standingInFor } from './fold';
import { SearchTabs } from './SearchTabs';
import { BASIS_MEANING, basisWords as matchBasis } from '../watches/people/model';

type ExplorerPaper = components['schemas']['ExplorerPaper'];
type Sort = 'newest' | 'similarity';

/** How long typing pauses before the collection is searched again. */
const SETTLE_MS = 350;

/**
 * Search › Your collection: every paper resmon holds, searched by its words
 * or, where an embedding model is set, ranked by meaning; each match marked
 * where it sits on the collection map.
 *
 * Ranking by meaning orders the matches without filtering them, and the note
 * says against what, with which model, and how many had no vector yet (those
 * are listed last, never dropped). Two records of the same work are labeled
 * with the reason the engine linked them; folding them hides rows in this view
 * only, and the count does not change.
 */
export function Collection() {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [fold, setFold] = useState(false);
  useEffect(() => {
    const settle = setTimeout(() => setQuery(draft.trim()), SETTLE_MS);
    return () => clearTimeout(settle);
  }, [draft]);

  const status = useQuery({ queryKey: ['embedding-status'], queryFn: () => answer(engine().GET('/api/embeddings/status')) });
  const canRank = status.data?.capability.available === true;
  const ranking: Sort = canRank && query && sort === 'similarity' ? 'similarity' : 'newest';
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = useMemo(() => new Map((catalog.data ?? []).map((e) => [e.slug, e.name])), [catalog.data]);

  const pages = useInfiniteQuery({
    queryKey: ['explorer', query, ranking],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => answer(engine().POST('/api/explorer/search', {
      body: { query, sort: ranking, limit: 50, cursor: pageParam, sources: [], authors: [], categories: [] },
    })),
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? String(last.next_cursor) : undefined),
  });
  const first = pages.data?.pages[0];
  const rows: ExplorerPaper[] = useMemo(() => pages.data?.pages.flatMap((p) => p.results) ?? [], [pages.data]);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);

  const links = useQuery({
    queryKey: ['links', ids],
    enabled: ids.length > 0,
    queryFn: () => answer(engine().POST('/api/links/for-documents', { body: { document_ids: ids } })),
  });
  const anyLinks = !!links.data && Object.keys(links.data.links).length > 0;
  // The people a paper matched, and on what basis: a name on a paper is not a
  // person, and each row says which claim its match makes.
  const people = useQuery({
    queryKey: ['profile-matches-for', ids],
    enabled: ids.length > 0,
    queryFn: () => answer(engine().POST('/api/profiles/matches/for-documents', { body: { document_ids: ids } })),
  });
  const folded = useQuery({
    queryKey: ['fold', ids],
    enabled: fold && anyLinks,
    queryFn: () => answer(engine().POST('/api/links/collapse-preview', { body: { document_ids: ids } })),
  });
  const hidden = useMemo(
    () => (fold && folded.data ? foldedAway(folded.data.folded) : new Set<number>()),
    [fold, folded.data],
  );
  const visible = rows.filter((row) => !hidden.has(row.id));

  const total = first?.total ?? 0;
  const busy = pages.isFetching || links.isFetching || people.isFetching || (fold && folded.isFetching);
  const countSentence = first
    ? `${number(total)}${first.total_is_capped ? '+' : ''} ${total === 1 ? 'paper' : 'papers'} ${query ? 'match' : 'in your collection'}`
    : '';

  return (
    <div className="collection">
      <PaperSky
        marked={query ? ids : []}
        shape="tall"
        label="Where the matches sit in the collection"
        caption={({ placed, ready, basis }) => {
          if (!ready) return 'The collection map is not ready yet; matches are marked once it is.';
          if (!query) return `Every paper in your collection, ${basisWords(basis)}. Matches are marked as you search.`;
          if (!ids.length) return 'Nothing matches, so nothing is marked.';
          const listed = ids.length < total
            ? `the first ${number(ids.length)} of ${number(total)} matches`
            : count(ids.length, 'match', 'matches');
          if (placed === ids.length) return `Marked: ${listed}, ${basisWords(basis)}.`;
          return `Marked: ${number(placed ?? 0)} of ${listed}; the map has not placed the rest yet.`;
        }}
      />
      <section className="index results" aria-label="Your collection" aria-busy={busy}
        data-capability={status.isSuccess ? (canRank ? 'available' : 'unavailable') : 'unknown'}>
        <div className="results-head">
          <SearchTabs />
          <h1 className="page-title">Your collection</h1>
          <label className="terms compact" htmlFor="collection-query">
            <Icon name="search" />
            <input
              id="collection-query"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') setQuery(draft.trim()); }}
              placeholder="Words in a title, an abstract or an author's name"
              aria-label="Search your collection"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="results-controls">
            {canRank && (
              <div className="seg" role="group" aria-label="Order">
                <button type="button" aria-pressed={ranking === 'newest'} onClick={() => setSort('newest')}>Newest</button>
                <button type="button" aria-pressed={ranking === 'similarity'} disabled={!query}
                  title={query ? undefined : 'Type a phrase to rank by'} onClick={() => setSort('similarity')}>
                  Closest in meaning
                </button>
              </div>
            )}
            {anyLinks && (
              <label className="fold-toggle">
                <input type="checkbox" checked={fold} onChange={(event) => setFold(event.target.checked)} />
                Fold the same work into one row
              </label>
            )}
          </div>
          <p className="count-sentence">{countSentence}</p>
          {ranking === 'similarity' && first && first.sort === 'similarity' && (
            <p className="rank-note">
              Closest to: <strong>{query}</strong>{first.model && <> — using <strong>{first.model}</strong></>}
              {(first.unranked_count ?? 0) > 0
                && <> · {first.ranked_count} ranked, {first.unranked_count} not embedded yet and listed last</>}
            </p>
          )}
          {first?.similarity_unavailable && <p className="rank-note">{first.similarity_unavailable}</p>}
          {fold && folded.data && rows.length > visible.length && (
            <p className="collapse-note">
              {count(rows.length - visible.length, 'row')} folded into another that looks like the same work.{' '}
              <strong>Nothing was removed</strong>: the count above is unchanged, and turning this off shows every row.
            </p>
          )}
        </div>
        <div className="index-scroll">
          {pages.isPending && <p className="index-cap">Searching.</p>}
          {pages.isError && <p className="index-cap">The collection could not be searched ({pages.error.message}).</p>}
          {first && !rows.length && <p className="index-empty">{query ? `Nothing in your collection matches "${query}".` : 'Your collection is empty.'}</p>}
          <ol className="result-list">
            {visible.map((paper) => {
              const also = links.data?.links[String(paper.id)] ?? [];
              const standing = folded.data ? standingInFor(folded.data.folded, paper.id) : 0;
              return (
                <li key={paper.id} className="result" data-document={paper.id}>
                  <Link to={`/papers/${paper.id}`} className="result-title">{paper.title}</Link>
                  <div className="meta">
                    <span className="who">{authors(paper.authors)}</span>
                    <span className="sep" />
                    <span>{names.get(paper.source_repository) ?? paper.source_repository}</span>
                    {paper.publication_date && (<><span className="sep" /><span>{paper.publication_date}</span></>)}
                    {ranking === 'similarity' && (
                      <span className="result-distance num" title="Distance from the phrase; smaller is closer">
                        {paper.distance === null || paper.distance === undefined ? 'not ranked' : paper.distance.toFixed(3)}
                      </span>
                    )}
                  </div>
                  {also.length > 0 && (
                    <ul className="result-links">{also.map((link) => <li key={link.id}>{link.label}</li>)}</ul>
                  )}
                  {(people.data?.matches[String(paper.id)] ?? []).length > 0 && (
                    <ul className="result-people">
                      {(people.data?.matches[String(paper.id)] ?? []).map((match) => (
                        <li key={`${match.profile_id}:${match.basis}`} data-basis={match.basis}>
                          <span className="basis-chip" title={BASIS_MEANING[match.basis]}>{matchBasis(match.basis)}</span>
                          <Link to={`/watches/people/${match.profile_id}`}>{match.display_name}</Link>
                          <span className="match-author">as {match.matched_author}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {fold && standing > 0 && (
                    <p className="result-folded">Standing in for {count(standing, 'other record')} of the same work.</p>
                  )}
                </li>
              );
            })}
          </ol>
          {pages.hasNextPage && (
            <button type="button" className="btn more" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              {pages.isFetchingNextPage ? 'Reading more' : 'Show more'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
