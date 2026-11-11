import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { tipWords, useChartTip, type MarkTip, type TipContent } from '../../charts/ChartTip';
import { joined, useRoving } from '../../charts/roving';
import { count, listWords, number } from '../today/format';
import {
  ANALYTICS_KEY, KEYWORD_SCOPE, collectionFor, daysWords, groupName, groupTotals, keywordTip, lagTip, monthShort, notADayWords, percent,
  searchable, sourceTip, volumeTip, watchRunTip, watchStatusWords, widthOf,
  type KeywordContribution, type Overview, type WatchRow,
} from './analyticsModel';
import { HealthTabs } from './HealthTabs';
import { collectionParam, useCollection, useCollectionWords } from '../../collections/current';
import { instantOf } from './model';

const DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

function dayOf(stamp: string | null | undefined): string {
  const at = instantOf(stamp);
  return at ? DAY.format(at) : 'a date not recorded';
}

/** The sentence a view shows instead of a chart drawn over too little. */
function NotEnough({ reason }: { reason: string | null | undefined }) {
  if (!reason) return null;
  return <p className="not-enough" data-analytics="not-enough">{reason}</p>;
}

/** The key for a two-part bar: what only this one found, and what another also found. */
function OwnAndShared({ own, shared }: { own: string; shared: string }) {
  return (
    <ul className="chart-key" aria-label="Key">
      <li><span className="chart-swatch own" aria-hidden="true" />{own}</li>
      <li><span className="chart-swatch context" aria-hidden="true" />{shared}</li>
    </ul>
  );
}

/** The mark a row's tip is set beside: its bar, or its range, or the row where neither is drawn. */
function markOf(target: HTMLElement): Element | null {
  const row = target.closest('.bar-row');
  return row?.querySelector('.chart-bar, .range') ?? row;
}

/**
 * One row of a bar chart. The pointer anywhere on the row shows its tip, set
 * beside its bar, and a click anywhere on it does what its name's link does;
 * the name is the row's stop for the keyboard, and its accessible name is
 * everything the tip says. A row with nowhere to go (`to` null) shows its tip
 * and opens nothing.
 */
function BarRow({ tip, content, to, name, data, children, keyboard }: {
  tip: MarkTip; content: TipContent; to: string | null; name: ReactNode;
  data: Record<`data-${string}`, string>; children: ReactNode; keyboard: ReturnType<ReturnType<typeof useRoving>['item']>;
}) {
  const navigate = useNavigate();
  const { onPointerEnter, onPointerMove, onPointerLeave, onFocus, onBlur } = tip.mark(content, markOf);
  // The link's own click is the link's; a click on the bar or the figure goes where it goes.
  const onClick = (event: MouseEvent<HTMLLIElement>) => {
    if (!to || (event.target as Element).closest('a')) return;
    navigate(to);
  };
  return (
    <li className="bar-row" data-opens={to ? 'true' : undefined} {...data}
      onPointerEnter={onPointerEnter} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} onClick={onClick}>
      {to
        ? <Link to={to} className="bar-name" aria-label={tipWords(content)} {...joined(keyboard, { onFocus, onBlur })}>{name}</Link>
        : <span className="bar-name" {...joined(keyboard, { onFocus, onBlur })} aria-label={tipWords(content)}>{name}</span>}
      {children}
    </li>
  );
}

/**
 * Analytics: what the collection holds, and which sources, terms and watches
 * earn their place.
 *
 * Every number is the engine's (`/api/analytics/*`). A view with too little to
 * go on shows the engine's sentence saying so instead of a chart, and a share
 * over too little is a dash, not 0. The keyword view reads every paper in the
 * collection once, so it runs only when asked.
 *
 * Every mark has the charts' tip, with the engine's numbers unrounded, and a
 * click on it goes to what it counts: a source's bar or range to the
 * collection narrowed to that source, a keyword's bar to the collection
 * searched for it, a month's column to the papers published that month, a
 * watch's tick to that run, and a source's or a category's total to the
 * collection narrowed to it.
 */
export function Analytics() {
  const { id: collection } = useCollection();
  const shown = useCollectionWords();
  const overview = useQuery({
    queryKey: [...ANALYTICS_KEY, collection],
    queryFn: () => answer(engine().GET('/api/analytics/overview', { params: { query: collectionParam(collection) } })),
  });
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = useMemo(() => new Map((catalog.data ?? []).map((e) => [e.slug, e.name])), [catalog.data]);
  const nameOf = (slug: string) => names.get(slug) ?? slug;
  const data = overview.data;

  return (
    <div className="page health analytics-page" aria-busy={overview.isFetching}>
      <HealthTabs />
      <p className="page-lede">
        What {shown.name} holds, and which sources, terms, and watches earn their place, in the engine’s numbers.
        A view with too little to go on says so instead of drawing a chart.
      </p>
      {overview.isPending && <p className="page-lede">Counting.</p>}
      {overview.isError && <p className="page-lede">The analytics could not be read ({overview.error.message}).</p>}
      {data && (
        <div className="analytics">
          <Corpus summary={data.summary} />
          <Sources view={data.source_contribution} nameOf={nameOf} />
          <Keywords />
          <Lag view={data.discovery_lag} nameOf={nameOf} />
          <Watches view={data.routine_health} />
          <Volume nameOf={nameOf} />
        </div>
      )}
    </div>
  );
}

function Corpus({ summary }: { summary: Overview['summary'] }) {
  const tiles: [string, string][] = [
    ['Papers', number(summary.documents)],
    ['Distinct works', number(summary.unique_papers)],
    ['Authors', number(summary.distinct_authors)],
    ['Sources used', number(summary.sources)],
    ['Runs completed', number(summary.completed_executions)],
    ['DOI coverage', percent(summary.doi_coverage)],
  ];
  return (
    <section className="chart-card corpus-card" data-analytics="corpus">
      <h2 className="group-title">Collection Overview</h2>
      <dl className="tiles">
        {tiles.map(([label, value]) => (
          <div key={label} className="tile" data-tile={label}><dt>{label}</dt><dd className="num">{value}</dd></div>
        ))}
      </dl>
      {summary.sufficient
        ? <p className="chart-note">First paper seen {dayOf(summary.first_seen)}; latest {dayOf(summary.last_seen)}. Distinct works counts two records of one paper once.</p>
        : <NotEnough reason="No papers yet, so there is nothing to count." />}
    </section>
  );
}

function Sources({ view, nameOf }: { view: Overview['source_contribution']; nameOf: (slug: string) => string }) {
  const tip = useChartTip();
  const roving = useRoving(view.sources.length);
  const largest = Math.max(0, ...view.sources.map((s) => s.total));
  return (
    <section className="chart-card" data-analytics="sources">
      <h2 className="group-title">Which Sources Earn Their Place</h2>
      <p className="chart-note">Of each source’s papers, how many no other source supplied. A source whose every paper also arrives from elsewhere costs a run and adds nothing.</p>
      {view.sufficient && <OwnAndShared own="Only from this source" shared="Also from another" />}
      <NotEnough reason={view.insufficient_reason} />
      <ol className="bar-rows">
        {view.sources.map((row, i) => (
          <BarRow key={row.source} keyboard={roving.item(i)} tip={tip} content={sourceTip(row, nameOf(row.source), view.sufficient)}
            to={collectionFor({ source: row.source })} name={nameOf(row.source)} data={{ 'data-source': row.source }}>
            {view.sufficient && (
              <span className="chart-bar" aria-hidden="true">
                <span className="bar-own" style={{ width: `${widthOf(row.unique_papers, largest)}%` }} />
                <span className="bar-context" style={{ width: `${widthOf(row.duplicated, largest)}%` }} />
              </span>
            )}
            <span className="bar-figure num" data-value={row.total} aria-hidden="true">
              {count(row.total, 'paper')}{view.sufficient && <>, {percent(row.unique_share)} only here</>}
            </span>
          </BarRow>
        ))}
      </ol>
      {tip.layer}
    </section>
  );
}

function Keywords() {
  const [asked, setAsked] = useState(false);
  const { id: collection } = useCollection();
  const shown = useCollectionWords();
  const yieldQuery = useQuery({
    queryKey: ['keyword-contribution', collection],
    enabled: asked,
    queryFn: () => answer(engine().GET('/api/analytics/keyword-contribution', { params: { query: collectionParam(collection) } })),
  });
  const data: KeywordContribution | undefined = yieldQuery.data;
  const tip = useChartTip();
  const roving = useRoving(data?.keywords.length ?? 0);
  const largest = Math.max(0, ...(data?.keywords ?? []).map((k) => k.matched));
  return (
    <section className="chart-card" data-analytics="keywords" aria-busy={yieldQuery.isFetching}>
      <h2 className="group-title">Which Keywords Earn Their Place</h2>
      <p className="chart-note">
        Of the papers each term matched, how many no other term did. This view reads every paper in {shown.name} once,
        so it does not run automatically.
      </p>
      {!data && (
        <button type="button" className="btn" data-analytics="measure" disabled={yieldQuery.isFetching} onClick={() => setAsked(true)}>
          {yieldQuery.isFetching ? 'Reading Every Paper' : 'Measure Keyword Yield'}
        </button>
      )}
      {yieldQuery.isError && <p className="field-error" role="alert">{yieldQuery.error.message}</p>}
      {data && (
        <>
          <NotEnough reason={data.insufficient_reason} />
          {data.keywords.length > 0 && <OwnAndShared own="Only this term" shared="Another term too" />}
          <ol className="bar-rows" data-analytics="keyword-rows">
            {data.keywords.map((row, i) => (
              <BarRow key={row.keyword} keyboard={roving.item(i)} tip={tip} content={keywordTip(row, data.minimum_sample_for_share)}
                to={searchable(row) ? collectionFor({ words: row.keyword }) : null} data={{ 'data-keyword': row.keyword }}
                name={<>{row.keyword}{row.contains_operators && <span className="bar-aside"> has search operators</span>}</>}>
                <span className="chart-bar" aria-hidden="true">
                  <span className="bar-own" style={{ width: `${widthOf(row.unique, largest)}%` }} />
                  <span className="bar-context" style={{ width: `${widthOf(row.shared, largest)}%` }} />
                </span>
                <span className="bar-figure num" data-value={row.matched} aria-hidden={searchable(row) ? 'true' : undefined}>
                  {count(row.matched, 'paper')}, {row.unique_share === null ? `share needs ${data.minimum_sample_for_share} matches` : `${percent(row.unique_share)} only here`}
                </span>
              </BarRow>
            ))}
          </ol>
          <p className="chart-note">{KEYWORD_SCOPE}</p>
          {tip.layer}
          {data.sample_size > 0 && (
            <p className="chart-note">
              {number(data.documents_matched)} of {count(data.documents_considered, 'paper')} matched one of these terms in
              their {listWords(data.fields_checked)}. A paper no term accounts for is expected from a source that ranks by
              relevance.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Lag({ view, nameOf }: { view: Overview['discovery_lag']; nameOf: (slug: string) => string }) {
  const tip = useChartTip();
  const roving = useRoving(view.sources.length);
  const reported = view.sources.filter((s) => s.sufficient);
  const lo = Math.min(0, ...reported.map((s) => s.fastest_days ?? 0));
  const hi = Math.max(1, ...reported.map((s) => s.slowest_days ?? 0));
  const at = (days: number) => `${(100 * (days - lo)) / (hi - lo)}%`;
  return (
    <section className="chart-card" data-analytics="lag">
      <h2 className="group-title">How Quickly Each Source Surfaces a Paper</h2>
      <p className="chart-note">
        Days from a paper’s stated publication date to resmon first seeing it: the median, between the fastest and the
        slowest.{view.not_a_day > 0 && <> {notADayWords(view.not_a_day)}</>}
      </p>
      <NotEnough reason={view.insufficient_reason} />
      <ol className="bar-rows lag-rows">
        {view.sources.map((row, i) => (
          <BarRow key={row.source} keyboard={roving.item(i)} tip={tip} content={lagTip(row, nameOf(row.source), view.minimum_sample)}
            to={collectionFor({ source: row.source })} name={nameOf(row.source)} data={{ 'data-source': row.source }}>
            {row.sufficient && row.median_days !== null ? (
              <span className="range" aria-hidden="true">
                <span className="range-span" style={{ left: at(row.fastest_days ?? 0), width: `calc(${at(row.slowest_days ?? 0)} - ${at(row.fastest_days ?? 0)})` }} />
                <span className="range-median" style={{ left: at(row.median_days) }} />
              </span>
            ) : <span className="range-none" aria-hidden="true">{count(row.sample_size, 'paper')} dated to the day; needs {view.minimum_sample}</span>}
            <span className="bar-figure num" aria-hidden="true">{row.sufficient ? `median ${daysWords(row.median_days)}` : '—'}</span>
          </BarRow>
        ))}
      </ol>
      {tip.layer}
    </section>
  );
}

function Watches({ view }: { view: Overview['routine_health'] }) {
  const tip = useChartTip();
  return (
    <section className="chart-card" data-analytics="watches">
      <h2 className="group-title">Watch Health</h2>
      <p className="chart-note">Each watch’s completed runs, by how many new papers each found, oldest on the left.</p>
      <NotEnough reason={view.insufficient_reason} />
      <ol className="watch-health">
        {view.routines.map((row) => (
          <li key={row.routine_id} data-routine={row.routine_id} data-status={row.status}>
            <div className="wh-head">
              <Link to={`/watches/${row.routine_id}`} className="bar-name">{row.name}</Link>
              {!row.is_active && <span className="bar-aside">paused</span>}
            </div>
            <RunStrip row={row} tip={tip} />
            <span className="wh-status">
              {watchStatusWords(row, view.stale_after, view.minimum_runs)}
              {row.missed_fires > 0 && <span className="bar-aside">, {count(row.missed_fires, 'fire')} that did not run</span>}
            </span>
          </li>
        ))}
      </ol>
      {tip.layer}
    </section>
  );
}

/** A watch's last 24 completed runs, a tick each: one stop for the keyboard, the arrow keys between runs, Enter opens one. */
function RunStrip({ row, tip }: { row: WatchRow; tip: MarkTip }) {
  const runs = row.series.slice(-24);
  const largest = Math.max(1, ...runs.map((r) => r.new_results ?? 0));
  const roving = useRoving(runs.length, runs.length - 1);
  if (!runs.length) return <span className="run-strip" aria-label="No completed runs" />;
  return (
    <span className="run-strip" role="group" aria-label={`${row.name}: new papers in each of its last ${count(runs.length, 'completed run')}, oldest first`}>
      {runs.map((run, i) => {
        const content = watchRunTip(run, row.name);
        return (
          <Link key={run.execution_id} to={`/runs/${run.execution_id}`} className="run-tick" data-run={run.execution_id}
            data-zero={run.new_results === 0 ? 'true' : undefined}
            data-unrecorded={run.new_results === null ? 'true' : undefined} aria-label={tipWords(content)}
            {...joined(roving.item(i), tip.mark(content))}>
            {/* A run that did not record its count is a hollow mark of its own, never a bar of none. */}
            <span className="run-tick-bar"
              style={run.new_results === null ? undefined : { height: `${Math.max(8, (100 * run.new_results) / largest)}%` }} />
          </Link>
        );
      })}
    </span>
  );
}

function Volume({ nameOf }: { nameOf: (slug: string) => string }) {
  const [by, setBy] = useState<'source' | 'category'>('source');
  const { id: collection } = useCollection();
  const volume = useQuery({
    queryKey: ['publication-volume', by, collection],
    queryFn: () => answer(engine().GET('/api/analytics/publication-volume', {
      params: { query: { group_by: by, months: 12, ...collectionParam(collection) } },
    })),
    placeholderData: keepPreviousData,
  });
  const data = volume.data;
  const groups = data ? groupTotals(data.series) : [];
  const linkable = (group: string) => group !== 'other' && group !== '(uncategorised)';
  return (
    <section className="chart-card volume-card" data-analytics="volume" aria-busy={volume.isFetching}>
      <div className="chart-head">
        <h2 className="group-title">Papers by Publication Month</h2>
        <div className="seg" role="group" aria-label="Grouped by">
          <button type="button" aria-pressed={by === 'source'} onClick={() => setBy('source')}>Source</button>
          <button type="button" aria-pressed={by === 'category'} onClick={() => setBy('category')}>Category</button>
        </div>
      </div>
      <p className="chart-note" data-analytics="volume-note">
        By the date each source gives a paper, for the latest twelve months that have any. A column holds exactly the
        papers it opens.{data && data.not_a_day > 0 && <> {notADayWords(data.not_a_day)}</>}
      </p>
      {data && <NotEnough reason={data.insufficient_reason} />}
      {data && data.series.length > 0 && (
        <>
          <VolumeColumns series={data.series} by={data.group_by === 'category' ? 'category' : 'source'} nameOf={nameOf} />
          <ul className="group-totals" aria-label={by === 'source' ? 'Sources over these months' : 'Categories over these months'}>
            {groups.map(({ group, total }) => (
              <li key={group}>
                {linkable(group)
                  ? <Link to={collectionFor(by === 'source' ? { source: group } : { category: group })}>{groupName(group, by, nameOf)}</Link>
                  : <span>{groupName(group, by, nameOf)}</span>}
                <span className="num">{number(total)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** A month's mark: its bar and the figure set on top of it, which the tip keeps clear of together. */
function columnMark(column: HTMLElement): Element[] {
  return [...column.querySelectorAll('.column-figure, .column-bar')];
}

/**
 * The months as columns, each one a way into the collection: the papers
 * published that month. One stop for the keyboard; the arrow keys move
 * between months, and Enter opens one.
 */
function VolumeColumns({ series, by, nameOf }: {
  series: Overview['publication_volume']['series']; by: 'source' | 'category'; nameOf: (slug: string) => string;
}) {
  const tip = useChartTip();
  const roving = useRoving(series.length, series.length - 1);
  const largest = Math.max(1, ...series.map((m) => m.total));
  return (
    <div className="columns" role="group" aria-label="Papers by Publication Month">
      {series.map((m, i) => {
        const content = volumeTip(m, by, nameOf);
        return (
          <Link key={m.month} to={collectionFor({ month: m.month })} className="column" data-month={m.month}
            aria-label={tipWords(content)} {...joined(roving.item(i), tip.mark(content, columnMark))}>
            <span className="column-figure num" aria-hidden="true">{number(m.total)}</span>
            <span className="column-bar" style={{ height: `${Math.max(2, (100 * m.total) / largest)}%` }} />
            <span className="column-label" aria-hidden="true">{monthShort(m.month)}</span>
          </Link>
        );
      })}
      {tip.layer}
    </div>
  );
}
