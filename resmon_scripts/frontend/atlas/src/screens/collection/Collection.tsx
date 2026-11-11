import { WordBreaks } from '../../lib/WordBreaks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { answer, engine, type EngineError } from '../../api/client';
import type { components } from '../../api/schema';
import { isMac } from '../../bridge';
import { afterPause } from '../../shell/history';
import { Icon } from '../../shell/Icon';
import { useScrollerPlace } from '../../shell/stageScroll';
import { ariaKeys, keysText, shortcut } from '../../shell/shortcuts';
import { ASK_PATH, KINDS, type AskState } from '../searchStart';
import { useFocusOnArrival } from '../arrival';
import { MapPaper } from '../sky/MapPaper';
import { basisWords, leftOffWords, PaperSky, type PaperSkyHandle, type SkyChoice } from '../sky/PaperSky';
import { count, number } from '../today/format';
import { EMBEDDING_STATUS_KEY, EMBEDDINGS_PATH, ranking as rankingWords } from '../settings/embeddingWords';
import { stoppedWords } from './countCap';
import { exportCollection } from './collectionExport';
import { FacetMenus, type Menu } from './FacetMenus';
import {
  chips, countSentence, engineFilters, exportedWords, exportWords, filterCount, narrowingWords, readFilters,
  toggled, withDate, withoutFilters, type EngineFilters, type Facets, type Ranking,
} from './filters';
import { foldedAway } from './fold';
import { jumpWords, monthEnd, readJump, withJump } from './jump';
import { readOrder, withOrder } from './order';
import { ResultList, type Marks, type Picking } from './ResultList';
import { SearchTabs } from './SearchTabs';
import { FORMATS, type ReferenceFormat } from '../runs/references';
import { collectionParam, useCollection, useCollectionWords } from '../../collections/current';
import { MoveCopy, useChangeNotice } from '../../collections/MoveCopy';
import { SaveButton, SaveLimit, useSaveToRead } from '../library/SaveMany';
import { SelectBar } from '../selection/SelectBar';
import { has, isEmpty, pickedIn, selectedWords, sizeOf, usePicks } from '../selection/picks';

type ExplorerPaper = components['schemas']['ExplorerPaper'];
/** No paper marked on the map: the same list each time, so the map is not drawn again for a new empty one. */
const NONE_MARKED: readonly number[] = [];
/** What each search page carries for its papers (`include`). */
const MARKS = ['links', 'matches', 'lifecycle'] as const;

/** How long typing pauses before the collection is searched again. */
const SETTLE_MS = 350;

/**
 * Search › Collection: every paper resmon holds, searched by its words
 * or, where an embedding model is set, ranked by meaning; each match marked
 * where it sits on the collection map.
 *
 * Ranking by meaning orders the matches without filtering them, and the note
 * says against what, with which model, and how many had no vector yet (those
 * are listed last, never dropped). Where it cannot rank, the control is not
 * offered and a sentence stands in its place saying why (no model, papers
 * without vectors, counted, or the extension missing) with a link to
 * Settings → AI → Embeddings, where that is put right. Every match is
 * counted; a count that ran out of time says so beside the number it reached.
 *
 * Two records of the same work are labeled with the reason the engine linked
 * them; folding them hides rows in this view only, and the count does not
 * change.
 *
 * The list is drawn as a window over every row read (`ResultList`), reading
 * the next page as the view nears the end, so a long one scrolls as a short
 * one does. In the newest order, Jump to starts it at a month: the matches
 * published after it are said and still counted, and Back to the newest
 * returns. The month is kept in the address (`at`) with the words and filters.
 *
 * Filters narrow it by source, category, author, and publication date, each
 * value with the engine's count of the papers it would hold (`filters.ts` says
 * what a count counts). They live in the address, so a chart on Analytics
 * opens exactly the papers it drew with `?source=` or `?category=`, and that
 * filter is named on the screen and taken off like any other.
 *
 * Export writes every paper the search matches, not the rows drawn so far,
 * however many: the engine renders the file as it reads the papers and the
 * system's save dialog asks where it goes.
 *
 * Select turns the export's row into a selection bar, and gives each row a
 * box: pick rows by click, Shift-click, or the keyboard, or Select all, which
 * is every match the search counted, read or not. Save to Read saves the rows
 * picked by their ids, or every match by the search itself, so a save of
 * 12,000 lists none of them; past 200 it asks first. The bar holds its actions
 * in one row, so another can join Save to Read there.
 */
export function Collection() {
  const [params, setParams] = useSearchParams();
  // The collection this window shows: every read below names it.
  const { id: collection, name: collectionName, pending: collectionsPending } = useCollection();
  // How a sentence names it: "your collection" while it is the only one, its name where there are several.
  const words = useCollectionWords();
  const within = useMemo(() => (collection === null ? {} : { collection }), [collection]);
  const filters = useMemo(() => readFilters(params), [params]);
  const filtered = filterCount(filters) > 0;
  const [menu, setMenu] = useState<Menu | null>(null);
  // The words searched for are kept in the address beside the filters (`q`),
  // replacing the entry rather than adding one, so Back to this page finds
  // them as they were left. Words that arrive in the address, by Back or a
  // link, are taken up as if typed.
  const asked = params.get('q') ?? '';
  const [draft, setDraft] = useState(asked);
  const [query, setQuery] = useState(asked.trim());
  const [arrived, setArrived] = useState(asked);
  if (asked !== arrived) {
    setArrived(asked);
    if (asked.trim() !== query) { setDraft(asked); setQuery(asked.trim()); }
  }
  useEffect(() => {
    if (asked === query) return;
    setParams((now) => {
      const next = new URLSearchParams(now);
      if (query) next.set('q', query); else next.delete('q');
      return next;
    }, { replace: true });
  }, [asked, query, setParams]);
  // The order asked for is in the address, so Back returns to it.
  const sort = readOrder(params);
  const setSort = (order: Ranking) => setParams((now) => withOrder(now, order), { replace: true });
  const scroller = useRef<HTMLDivElement>(null);
  // The results' box, once it is in the page, for the list drawn in it.
  const [resultsBox, setResultsBox] = useState<HTMLDivElement | null>(null);
  const results = useCallback((node: HTMLDivElement | null) => {
    scroller.current = node;
    setResultsBox(node);
  }, []);
  const [fold, setFold] = useState(false);
  // A paper chosen on the map opens in the results' place; the results, and the search box, wait behind it.
  const [opened, setOpened] = useState<SkyChoice | null>(null);
  const sky = useRef<PaperSkyHandle>(null);
  useFocusOnArrival('collection-query');
  // The words typed become the search once typing pauses. Nothing is set when
  // they already are the search: on arrival that timer re-rendered the page,
  // and redrew its map, a third of a second after it had settled.
  useEffect(() => {
    if (draft.trim() === query) return undefined;
    // Not once the window has gone to another page (a paper opened): the search's address would take it back here.
    return afterPause(SETTLE_MS, () => setQuery(draft.trim()));
  }, [draft, query]);

  // The vectors of the papers in this collection, counted for it (`collection_coverage`).
  const status = useQuery({
    queryKey: [...EMBEDDING_STATUS_KEY, collection],
    queryFn: () => answer(engine().GET('/api/embeddings/status', { params: { query: collectionParam(collection) } })),
  });
  const canRank = status.data?.capability.available === true;
  const rank = status.data ? rankingWords(status.data, words) : null;
  const ranking: Ranking = canRank && query && sort === 'similarity' ? 'similarity' : 'newest';
  // A month jumped to, in the newest order only: a ranking by meaning is not in date order.
  const at = readJump(params);
  const jump = ranking === 'newest' && at ? monthEnd(at) : null;
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = useMemo(() => new Map((catalog.data ?? []).map((e) => [e.slug, e.name])), [catalog.data]);
  const nameOf = (slug: string) => names.get(slug) ?? slug;

  const pages = useInfiniteQuery({
    queryKey: ['explorer', collection, query, ranking, filters, jump],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => answer(engine().POST('/api/explorer/search', {
      body: {
        ...engineFilters(filters, query), ...within, sort: ranking, limit: 50, cursor: pageParam, include: [...MARKS],
        // The jump says where the first page starts; every page after it follows its cursor.
        ...(pageParam === null && jump ? { start_date: jump } : {}),
      },
    })),
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? String(last.next_cursor) : undefined),
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  const readMore = useCallback(() => { if (hasNextPage && !isFetchingNextPage) void fetchNextPage(); }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  // Back and Forward put the list where it was left, by the paper at its top, for the same search; a new
  // search, a new order, a jump, or another collection starts at its top.
  useScrollerPlace(scroller, { name: 'results', under: JSON.stringify([collection, query, ranking, filters, jump]), fresh: true });
  const first = pages.data?.pages[0];
  const rows: ExplorerPaper[] = useMemo(() => pages.data?.pages.flatMap((p) => p.results) ?? [], [pages.data]);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);

  // What the list holds, which the counts beside the filters and the export
  // hold too: the words narrow it unless the engine ranked by meaning, where
  // they only order it. Where it could not rank, the engine says so and
  // filters by the words instead, so this follows what it served, and what
  // was asked for until it answers.
  const served = first ? (first.sort === 'similarity' ? 'similarity' : 'newest') : ranking;
  const scope: EngineFilters = useMemo(
    () => ({ ...engineFilters(filters, narrowingWords(query, served)), ...within }), [filters, query, served, within]);
  // The notice a move or a copy of the selected papers leaves is held here, so
  // Done or Esc right after it keeps its Undo.
  const changed = useChangeNotice();
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

  // Each page carries its papers' marks, so they are drawn with the rows rather
  // than after a second round of requests: the papers that look like the same
  // work, the people a paper matched and on what basis (a name on a paper is
  // not a person, and each row says which claim its match makes), and what
  // has been recorded against it since.
  const marks = useMemo(() => {
    const out: Marks = { links: {}, matches: {}, events: {} };
    for (const page of pages.data?.pages ?? []) {
      Object.assign(out.links, page.links?.links);
      Object.assign(out.matches, page.matches?.matches);
      Object.assign(out.events, page.lifecycle?.events);
    }
    return out;
  }, [pages.data]);
  const anyLinks = Object.keys(marks.links).length > 0;
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
  const busy = pages.isFetching || (fold && folded.isFetching);
  const said = first && !collectionsPending ? countSentence(first, filtered, query, words) : '';
  const stopped = first ? stoppedWords(first) : null;
  const offer = first ? exportWords(first, served) : null;

  // Select mode. What is picked belongs to this search: a new search, filter, or order lets go of it.
  const [selecting, setSelecting] = useState(false);
  const visibleIds = useMemo(() => visible.map((row) => row.id), [visible]);
  const picks = usePicks<number>(visibleIds, JSON.stringify(scope));
  const counted = first?.total_is_exact ? total : null;
  const picked = sizeOf(picks.picks, counted);
  const allPicked = picks.picks.all && picks.picks.except.size === 0;
  const saving = useSaveToRead(() => picks.release('all'));
  const { pick, selectAll, clear } = picks;
  const picking = useMemo<Picking | null>(() => (selecting ? {
    has: (id) => has(picks.picks, id),
    onPick: (index, range) => { const id = visibleIds[index]; if (id !== undefined) pick(id, range); },
    onRange: (to, from) => { const id = visibleIds[to]; if (id !== undefined) pick(id, true, visibleIds[from]); },
    onAll: () => { if (counted !== null) selectAll(); },
  } : null), [selecting, picks.picks, visibleIds, pick, selectAll, counted]);
  const { cancel } = saving;
  const endSelecting = useCallback(() => { setSelecting(false); clear(); cancel(); }, [clear, cancel]);
  const savePicked = () => {
    if (picked === null || picked === 0) return;
    if (picks.picks.all) {
      saving.save({
        target: { kind: 'search', search: scope, except: [...picks.picks.except], atMost: picked }, n: picked, all: allPicked,
        what: allPicked ? `all ${count(picked, 'match', 'matches')}` : `these ${count(picked, 'paper')}`,
      });
    } else {
      const ids = pickedIn(picks.picks, visibleIds);
      saving.save({ target: { kind: 'listed', ids }, n: ids.length, all: false, what: `these ${count(ids.length, 'paper')}` });
    }
  };
  const jumped = first?.start_date ? jumpWords(first, at ?? first.start_date) : null;

  return (
    <div className="collection">
      <PaperSky
        ref={sky}
        marked={query || filtered ? ids : NONE_MARKED}
        shape="tall"
        wheel="zoom"
        chosen={opened?.id ?? null}
        onChoose={setOpened}
        sourceName={nameOf}
        label="Where the matches sit in the collection"
        caption={({ placed, ready, basis, unplaced }) => {
          if (!ready) return 'The collection map is not ready yet; matches are marked once it is.';
          if (!query && !filtered) return `Every paper in ${words.name}, ${basisWords(basis)}. Matches are marked as you search.`;
          if (!ids.length) return 'Nothing matches, so nothing is marked.';
          const listed = ids.length < total || first?.total_is_exact === false
            ? `the first ${number(ids.length)} of ${first?.total_is_exact === false ? 'at least ' : ''}${number(total)} matches`
            : count(ids.length, 'match', 'matches');
          if (placed === ids.length) return `Marked: ${listed}, ${basisWords(basis)}.`;
          return `Marked: ${number(placed ?? 0)} of ${listed}. ${leftOffWords(ids.length - (placed ?? 0), { basis, unplaced })}`;
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
      <section className="index results" aria-label="Collection" aria-busy={busy} hidden={opened !== null}
        data-capability={status.isSuccess ? (canRank ? 'available' : 'unavailable') : 'unknown'}>
        <div className="results-head">
          <SearchTabs />
          <div className="collection-head">
            <h1 className="page-title" aria-label={collectionName ?? 'Collection'}><WordBreaks text={collectionName ?? 'Collection'} /></h1>
            <AskForMore />
          </div>
          <label className="terms compact" htmlFor="collection-query">
            <Icon name="search" />
            <input
              id="collection-query"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') setQuery(draft.trim()); }}
              placeholder="Words in a title, an abstract, or an author's name"
              aria-label={`Search ${words.name}`}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="results-controls">
            <FacetMenus
              filters={filters}
              facets={{ data: facets.data, error: facets.error, busy: facets.isFetching, stale: facets.isPlaceholderData }}
              words={!!scope.query}
              matches={first?.total_is_exact ? first.total : null}
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
                  Closest in Meaning
                </button>
              </div>
            )}
            {ranking === 'newest' && (
              <label className="date jump-to" data-collection="jump">
                Jump to
                <input type="month" value={at ?? ''} max="9999-12" aria-label="Jump to a month of publication"
                  onChange={(event) => setParams(withJump(params, event.target.value), { replace: true })} />
              </label>
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
                <button type="button" className="btn quiet sm" onClick={() => setParams(withoutFilters(params))}>Clear All</button>
              )}
            </div>
          )}
          <p className="count-sentence">
            <WordBreaks text={said} />
            {stopped && <span className="count-cap" data-collection="count-stopped"> · {stopped}</span>}
          </p>
          {selecting && rows.length > 0 && (
            <SelectBar label="The selected matches" className="collection-select" said={selectedWords(picked, counted)}
              tick={isEmpty(picks.picks, counted) ? 'none' : allPicked ? 'on' : 'part'}
              allLabel={allPicked || counted === null ? null : `Select All ${count(counted, 'Match', 'Matches')}`}
              onAll={selectAll} onDone={endSelecting}
              below={<><SaveLimit n={picked} />{saving.question}{saving.refused}</>}>
              <SaveButton n={picked} all={allPicked} busy={saving.pending || saving.asking} saving={saving.pending} onSave={savePicked} />
              {/* Every match but the unticked, read by the engine and refused if the search now holds more; or the rows picked. */}
              <MoveCopy which={picks.picks.all
                ? { matching: scope, except: [...picks.picks.except], atMost: picked ?? 0 }
                : { ids: pickedIn(picks.picks, visibleIds) }}
                from={collection} count={picked ?? 0} onDone={() => picks.release('all')} onNotice={changed.show} />
            </SelectBar>
          )}
          {offer && !(selecting && rows.length > 0) && (
            <div className="collection-export" data-collection="export" role="group" aria-label="Export the papers counted above">
              <Icon name="download" size={14} />
              <span>{offer.lead}</span>
              {FORMATS.map((format) => (
                <button key={format.id} type="button" className="btn sm" disabled={exporting.isPending}
                  onClick={() => exporting.mutate({ format: format.id, scope })}>{format.label}</button>
              ))}
              {rows.length > 0 && (
                <button type="button" className="btn sm collection-select-start" data-collection="select"
                  onClick={() => setSelecting(true)}>Select</button>
              )}
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
          {fold && folded.data && rows.length > visible.length && (
            <p className="collapse-note">
              {count(rows.length - visible.length, 'row')} folded into another that looks like the same work.{' '}
              <strong>Nothing was removed</strong>: the count above is unchanged, and turning this off shows every row.
            </p>
          )}
        </div>
        <div className="results-status">
          {pages.isPending && <p className="index-cap">Searching.</p>}
          {pages.isError && <p className="index-cap">The collection could not be searched ({pages.error.message}).</p>}
          {jumped && (
            <p className="jump-note" role="status" data-collection="jumped">
              {jumped}{' '}
              <button type="button" className="btn quiet sm" onClick={() => setParams(withJump(params, ''), { replace: true })}>
                Back to the Newest
              </button>
            </p>
          )}
          {first && !collectionsPending && !rows.length && (
            <p className="index-empty">
              <WordBreaks text={jumped ? 'Nothing that matches was published on or before then.'
                : query ? `Nothing in ${words.name} matches "${query}"${filtered ? ' within these filters' : ''}.`
                : filtered ? `Nothing in ${words.name} matches these filters.`
                : words.named ? `${words.Name} holds no papers yet.` : 'This collection is empty.'} />
            </p>
          )}
        </div>
        <div className="index-scroll" ref={results}>
          <ResultList
            rows={visible}
            total={first?.total_is_exact ? total : null}
            marks={marks}
            folded={folded.data?.folded ?? null}
            showFolded={fold}
            ranking={ranking}
            sourceName={nameOf}
            scroller={resultsBox}
            more={{ has: !!hasNextPage, reading: isFetchingNextPage, read: readMore }}
            picking={picking}
          />
        </div>
      </section>
      {saving.notice}
      {changed.notice}
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
