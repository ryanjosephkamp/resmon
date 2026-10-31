import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { answer, engine, type EngineError } from '../../api/client';
import type { components } from '../../api/schema';
import { isMac } from '../../bridge';
import { Icon } from '../../shell/Icon';
import { ariaKeys, keysText, shortcut } from '../../shell/shortcuts';
import { ASK_PATH, KINDS, type AskState } from '../searchStart';
import { useFocusOnArrival } from '../arrival';
import { MapPaper } from '../sky/MapPaper';
import { basisWords, PaperSky, type PaperSkyHandle, type SkyChoice } from '../sky/PaperSky';
import { authors, count, number } from '../today/format';
import { EMBEDDING_STATUS_KEY, EMBEDDINGS_PATH, ranking as rankingWords } from '../settings/embeddingWords';
import { capWords } from './countCap';
import { exportCollection } from './collectionExport';
import { FacetMenus, type Menu } from './FacetMenus';
import {
  chips, countSentence, engineFilters, exportedWords, exportWords, filterCount, narrowingWords, readFilters,
  toggled, withDate, withoutFilters, type EngineFilters, type Facets,
} from './filters';
import { foldedAway, standingInFor } from './fold';
import { SearchTabs } from './SearchTabs';
import { FORMATS, type ReferenceFormat } from '../runs/references';
import { BASIS_MEANING, basisWords as matchBasis } from '../watches/people/model';
import { LifecycleMarks, LifecycleUnread, useLifecycleFor } from '../lifecycle/LifecycleMarks';

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
 * are listed last, never dropped). Where it cannot rank, the control is not
 * offered and a sentence stands in its place saying why (no model, papers
 * without vectors, counted, or the extension missing) with a link to
 * Settings → AI → Embeddings, where that is put right. A count the engine
 * stopped at its cap says so beside the number.
 *
 * Two records of the same work are labeled with the reason the engine linked
 * them; folding them hides rows in this view only, and the count does not
 * change.
 *
 * Filters narrow it by source, category, author, and publication date, each
 * value with the engine's count of the papers it would hold (`filters.ts` says
 * what a count counts). They live in the address, so a chart on Analytics
 * opens exactly the papers it drew with `?source=` or `?category=`, and that
 * filter is named on the screen and taken off like any other.
 *
 * Export writes every paper the count above the list counts, not the rows
 * drawn so far: the engine renders the file and the system's save dialog asks
 * where it goes. Where the engine caps an export, that is said before saving.
 */
export function Collection() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const filtered = filterCount(filters) > 0;
  const [menu, setMenu] = useState<Menu | null>(null);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [fold, setFold] = useState(false);
  // A paper chosen on the map opens in the results' place; the results, and the search box, wait behind it.
  const [opened, setOpened] = useState<SkyChoice | null>(null);
  const sky = useRef<PaperSkyHandle>(null);
  useFocusOnArrival('collection-query');
  useEffect(() => {
    const settle = setTimeout(() => setQuery(draft.trim()), SETTLE_MS);
    return () => clearTimeout(settle);
  }, [draft]);

  const status = useQuery({ queryKey: EMBEDDING_STATUS_KEY, queryFn: () => answer(engine().GET('/api/embeddings/status')) });
  const canRank = status.data?.capability.available === true;
  const rank = status.data ? rankingWords(status.data) : null;
  const ranking: Sort = canRank && query && sort === 'similarity' ? 'similarity' : 'newest';
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = useMemo(() => new Map((catalog.data ?? []).map((e) => [e.slug, e.name])), [catalog.data]);
  const nameOf = (slug: string) => names.get(slug) ?? slug;

  const pages = useInfiniteQuery({
    queryKey: ['explorer', query, ranking, filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => answer(engine().POST('/api/explorer/search', {
      body: { ...engineFilters(filters, query), sort: ranking, limit: 50, cursor: pageParam },
    })),
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? String(last.next_cursor) : undefined),
  });
  const first = pages.data?.pages[0];
  const rows: ExplorerPaper[] = useMemo(() => pages.data?.pages.flatMap((p) => p.results) ?? [], [pages.data]);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);

  // What the list holds, which the counts beside the filters and the export
  // hold too: the words narrow it unless the engine ranked by meaning, where
  // they only order it. Where it could not rank, the engine says so and
  // filters by the words instead, so this follows what it served, and what
  // was asked for until it answers.
  const served = first ? (first.sort === 'similarity' ? 'similarity' : 'newest') : ranking;
  const scope: EngineFilters = useMemo(() => engineFilters(filters, narrowingWords(query, served)), [filters, query, served]);
  const facets = useQuery({
    queryKey: ['explorer-facets', scope],
    enabled: menu !== null && menu !== 'published',
    placeholderData: keepPreviousData,
    queryFn: () => answer(engine().POST('/api/explorer/facets', { body: scope })) as Promise<Facets>,
  });
  const exporting = useMutation({
    mutationFn: (asked: { format: ReferenceFormat; scope: EngineFilters }) => exportCollection(asked.scope, asked.format),
  });
  // An export's outcome is said only while the filters are the ones it was made under.
  const exportedHere = !!exporting.variables && JSON.stringify(exporting.variables.scope) === JSON.stringify(scope);

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
  const lifecycle = useLifecycleFor(ids);
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
  const said = first ? countSentence(first, filtered, query) : '';
  // The whole collection's own count is the status's, read from every record; it answers only the unfiltered view.
  const cap = first ? capWords(first, !query && !filtered ? status.data?.coverage.total ?? null : null) : null;
  const offer = first ? exportWords(first, served) : null;

  return (
    <div className="collection">
      <PaperSky
        ref={sky}
        marked={query || filtered ? ids : []}
        shape="tall"
        wheel="zoom"
        chosen={opened?.id ?? null}
        onChoose={setOpened}
        sourceName={nameOf}
        label="Where the matches sit in the collection"
        caption={({ placed, ready, basis }) => {
          if (!ready) return 'The collection map is not ready yet; matches are marked once it is.';
          if (!query && !filtered) return `Every paper in your collection, ${basisWords(basis)}. Matches are marked as you search.`;
          if (!ids.length) return 'Nothing matches, so nothing is marked.';
          const listed = ids.length < total
            ? `the first ${number(ids.length)} of ${number(total)} matches`
            : count(ids.length, 'match', 'matches');
          if (placed === ids.length) return `Marked: ${listed}, ${basisWords(basis)}.`;
          return `Marked: ${number(placed ?? 0)} of ${listed}; the map has not placed the rest yet.`;
        }}
      />
      {opened && (
        <MapPaper
          key={opened.id}
          id={opened.id}
          cell={opened.cell}
          region={opened.region}
          sourceName={nameOf}
          backLabel="Back to the results"
          onBack={() => { setOpened(null); sky.current?.focus(); }}
          onShow={() => sky.current?.show(opened.id)}
        />
      )}
      <section className="index results" aria-label="Your collection" aria-busy={busy} hidden={opened !== null}
        data-capability={status.isSuccess ? (canRank ? 'available' : 'unavailable') : 'unknown'}>
        <div className="results-head">
          <SearchTabs />
          <div className="collection-head">
            <h1 className="page-title">Your collection</h1>
            <AskForMore />
          </div>
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
            <FacetMenus
              filters={filters}
              facets={{ data: facets.data, error: facets.error, busy: facets.isFetching, stale: facets.isPlaceholderData }}
              words={!!scope.query}
              nameOf={nameOf}
              onMenu={(which, open) => setMenu((now) => (open ? which : now === which ? null : now))}
              onToggle={(key, value) => setParams(toggled(params, key, value))}
              onDate={(key, value) => setParams(withDate(params, key, value))}
            />
            {canRank && (
              <div className="seg" role="group" aria-label="Order">
                <button type="button" aria-pressed={ranking === 'newest'} onClick={() => setSort('newest')}>Newest</button>
                <button type="button" aria-pressed={ranking === 'similarity'} disabled={!query}
                  title={query ? undefined : 'Type a phrase to rank by'} onClick={() => setSort('similarity')}>
                  Closest in meaning
                </button>
              </div>
            )}
            {rank && !canRank && (
              <p className="rank-off" data-collection="ranking">
                {rank.sentence}
                {rank.action && <>{' '}<Link to={EMBEDDINGS_PATH}>{rank.action}</Link>.</>}
              </p>
            )}
            {status.isError && (
              <p className="rank-off" data-collection="ranking">
                The engine did not say whether the collection can be ranked by meaning ({status.error.message}).
              </p>
            )}
            {anyLinks && (
              <label className="fold-toggle">
                <input type="checkbox" checked={fold} onChange={(event) => setFold(event.target.checked)} />
                Fold the same work into one row
              </label>
            )}
          </div>
          {filtered && (
            <div className="filter-chips" data-collection="filters" aria-label="Filters">
              {chips(filters, nameOf).map((chip) => (
                <span key={`${chip.key}:${chip.value}`} className="term" data-filter={chip.key} data-value={chip.value}>
                  {chip.text}
                  <button type="button" aria-label={chip.remove} onClick={() => setParams(chip.key === 'from' || chip.key === 'to'
                    ? withDate(params, chip.key, '') : toggled(params, chip.key, chip.value))}>
                    <Icon name="close" />
                  </button>
                </span>
              ))}
              {filterCount(filters) > 1 && (
                <button type="button" className="btn quiet sm" onClick={() => setParams(withoutFilters(params))}>Clear all</button>
              )}
            </div>
          )}
          <p className="count-sentence">
            {said}
            {cap && <span className="count-cap" data-collection="count-cap"> · {cap}</span>}
          </p>
          {offer && (
            <div className="collection-export" data-collection="export" role="group" aria-label="Export the papers counted above">
              <Icon name="download" size={14} />
              <span>{offer.lead}</span>
              {FORMATS.map((format) => (
                <button key={format.id} type="button" className="btn sm" disabled={exporting.isPending}
                  onClick={() => exporting.mutate({ format: format.id, scope })}>{format.label}</button>
              ))}
            </div>
          )}
          {offer?.note && <p className="export-note" data-collection="export-note">{offer.note}</p>}
          {exportedHere && exporting.data && (
            <p className="export-note" role="status" data-collection="exported">
              {exportedWords(exporting.data.records, exporting.data.filename)}
            </p>
          )}
          {exportedHere && exporting.error && (
            <p className="field-error" role="alert" data-collection="export-refused">
              {(exporting.error as EngineError).detail ?? exporting.error.message}
            </p>
          )}
          {ranking === 'similarity' && first && first.sort === 'similarity' && (
            <p className="rank-note">
              Closest to: <strong>{query}</strong>{first.model && <> — using <strong>{first.model}</strong></>}
              {(first.unranked_count ?? 0) > 0
                && <> · {first.ranked_count} ranked, {first.unranked_count} not embedded yet and listed last</>}
            </p>
          )}
          {first?.similarity_unavailable && <p className="rank-note">{first.similarity_unavailable}</p>}
          <LifecycleUnread error={lifecycle.error} />
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
          {first && !rows.length && (
            <p className="index-empty">
              {query ? `Nothing in your collection matches "${query}"${filtered ? ' within these filters' : ''}.`
                : filtered ? 'Nothing in your collection matches these filters.' : 'Your collection is empty.'}
            </p>
          )}
          <ol className="result-list">
            {visible.map((paper) => {
              const also = links.data?.links[String(paper.id)] ?? [];
              const standing = folded.data ? standingInFor(folded.data.folded, paper.id) : 0;
              return (
                <li key={paper.id} className="result" data-document={paper.id}>
                  <Link to={`/papers/${paper.id}`} className="result-title">{paper.title}</Link>
                  <LifecycleMarks events={lifecycle.data?.events[String(paper.id)]} />
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

/**
 * A new Deep Dive or Deep Sweep from the top of Search, where a person looks
 * for one first: each opens Ask the sources with that kind chosen and the
 * caret in its terms, as its shortcut does from anywhere.
 */
function AskForMore() {
  const mac = isMac();
  return (
    <div className="collection-new" role="group" aria-label="Ask the sources for more papers">
      {KINDS.map((kind) => {
        const { chord } = shortcut(kind.shortcut);
        return (
          <Link key={kind.kind} to={ASK_PATH} state={{ start: kind.kind } satisfies AskState} className="btn"
            data-new-search={kind.kind} aria-keyshortcuts={ariaKeys(chord, mac)} title={`${kind.says} ${keysText(chord, mac)}`}>
            <Icon name="plus" size={14} />{kind.name}
          </Link>
        );
      })}
    </div>
  );
}
