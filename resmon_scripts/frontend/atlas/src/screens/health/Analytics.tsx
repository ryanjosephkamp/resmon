import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { count, number } from '../today/format';
import {
  ANALYTICS_KEY, collectionFor, daysWords, groupTotals, monthShort, monthWords, percent, watchStatusWords, widthOf,
  type KeywordContribution, type Overview,
} from './analyticsModel';
import { HealthTabs } from './HealthTabs';
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

/**
 * Analytics: what the collection holds, and which sources, terms and watches
 * earn their place.
 *
 * Every number is the engine's (`/api/analytics/*`). A view with too little to
 * go on shows the engine's sentence saying so instead of a chart, and a share
 * over too little is a dash, not 0. The keyword view reads every paper in the
 * collection once, so it runs only when asked. A source's row, and a source's
 * or a category's month total, opens the collection narrowed to it.
 */
export function Analytics() {
  const overview = useQuery({ queryKey: ANALYTICS_KEY, queryFn: () => answer(engine().GET('/api/analytics/overview')) });
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
        What your collection holds, and which sources, terms and watches earn their place, in the engine’s numbers.
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
      <h2 className="group-title">Your corpus</h2>
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
  const largest = Math.max(0, ...view.sources.map((s) => s.total));
  return (
    <section className="chart-card" data-analytics="sources">
      <h2 className="group-title">Which sources earn their place</h2>
      <p className="chart-note">Of each source’s papers, how many no other source supplied. A source whose every paper also arrives from elsewhere costs a run and adds nothing.</p>
      {view.sufficient && <OwnAndShared own="Only from this source" shared="Also from another" />}
      <NotEnough reason={view.insufficient_reason} />
      <ol className="bar-rows">
        {view.sources.map((row) => (
          <li key={row.source} className="bar-row" data-source={row.source}>
            <Link to={collectionFor({ source: row.source })} className="bar-name" title={`Show ${nameOf(row.source)}’s papers in your collection`}>
              {nameOf(row.source)}
            </Link>
            {view.sufficient && (
              <span className="chart-bar" title={`${number(row.unique_papers)} only from ${nameOf(row.source)}, ${number(row.duplicated)} also from another source`}>
                <span className="bar-own" style={{ width: `${widthOf(row.unique_papers, largest)}%` }} />
                <span className="bar-context" style={{ width: `${widthOf(row.duplicated, largest)}%` }} />
              </span>
            )}
            <span className="bar-figure num" data-value={row.total}>
              {count(row.total, 'paper')}{view.sufficient && <>, {percent(row.unique_share)} only here</>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Keywords() {
  const [asked, setAsked] = useState(false);
  const yieldQuery = useQuery({
    queryKey: ['keyword-contribution'],
    enabled: asked,
    queryFn: () => answer(engine().GET('/api/analytics/keyword-contribution')),
  });
  const data: KeywordContribution | undefined = yieldQuery.data;
  const largest = Math.max(0, ...(data?.keywords ?? []).map((k) => k.matched));
  return (
    <section className="chart-card" data-analytics="keywords" aria-busy={yieldQuery.isFetching}>
      <h2 className="group-title">Which keywords earn their place</h2>
      <p className="chart-note">
        Of the papers each term matched, how many no other term did. This view reads every paper in your collection
        once, so it does not run automatically.
      </p>
      {!data && (
        <button type="button" className="btn" data-analytics="measure" disabled={yieldQuery.isFetching} onClick={() => setAsked(true)}>
          {yieldQuery.isFetching ? 'Reading every paper' : 'Measure keyword yield'}
        </button>
      )}
      {yieldQuery.isError && <p className="field-error" role="alert">{yieldQuery.error.message}</p>}
      {data && (
        <>
          <NotEnough reason={data.insufficient_reason} />
          {data.keywords.length > 0 && <OwnAndShared own="Only this term" shared="Another term too" />}
          <ol className="bar-rows" data-analytics="keyword-rows">
            {data.keywords.map((row) => (
              <li key={row.keyword} className="bar-row" data-keyword={row.keyword}>
                <span className="bar-name">{row.keyword}{row.contains_operators && <span className="bar-aside"> has search operators</span>}</span>
                <span className="chart-bar" title={`${number(row.unique)} only this term, ${number(row.shared)} another term too`}>
                  <span className="bar-own" style={{ width: `${widthOf(row.unique, largest)}%` }} />
                  <span className="bar-context" style={{ width: `${widthOf(row.shared, largest)}%` }} />
                </span>
                <span className="bar-figure num" data-value={row.matched}>
                  {count(row.matched, 'paper')}, {row.unique_share === null ? `share needs ${data.minimum_sample_for_share} matches` : `${percent(row.unique_share)} only here`}
                </span>
              </li>
            ))}
          </ol>
          {data.sample_size > 0 && (
            <p className="chart-note">
              {number(data.documents_matched)} of {count(data.documents_considered, 'paper')} matched one of these terms in
              their {data.fields_checked.join(', ')}. A paper no term accounts for is expected from a source that ranks by
              relevance.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Lag({ view, nameOf }: { view: Overview['discovery_lag']; nameOf: (slug: string) => string }) {
  const reported = view.sources.filter((s) => s.sufficient);
  const lo = Math.min(0, ...reported.map((s) => s.fastest_days ?? 0));
  const hi = Math.max(1, ...reported.map((s) => s.slowest_days ?? 0));
  const at = (days: number) => `${(100 * (days - lo)) / (hi - lo)}%`;
  return (
    <section className="chart-card" data-analytics="lag">
      <h2 className="group-title">How quickly each source surfaces a paper</h2>
      <p className="chart-note">Days from a paper’s stated publication date to resmon first seeing it: the median, between the fastest and the slowest.</p>
      <NotEnough reason={view.insufficient_reason} />
      <ol className="bar-rows lag-rows">
        {view.sources.map((row) => (
          <li key={row.source} className="bar-row" data-source={row.source}>
            <span className="bar-name">{nameOf(row.source)}</span>
            {row.sufficient && row.median_days !== null ? (
              <span className="range" title={`fastest ${daysWords(row.fastest_days)}, median ${daysWords(row.median_days)}, slowest ${daysWords(row.slowest_days)}`}>
                <span className="range-span" style={{ left: at(row.fastest_days ?? 0), width: `calc(${at(row.slowest_days ?? 0)} - ${at(row.fastest_days ?? 0)})` }} />
                <span className="range-median" style={{ left: at(row.median_days) }} />
              </span>
            ) : <span className="range-none">{count(row.sample_size, 'dated paper')}; needs {view.minimum_sample}</span>}
            <span className="bar-figure num">{row.sufficient ? `median ${daysWords(row.median_days)}` : '—'}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Watches({ view }: { view: Overview['routine_health'] }) {
  return (
    <section className="chart-card" data-analytics="watches">
      <h2 className="group-title">Watch health</h2>
      <p className="chart-note">Each watch’s completed runs, by how many new papers each found, oldest on the left.</p>
      <NotEnough reason={view.insufficient_reason} />
      <ol className="watch-health">
        {view.routines.map((row) => {
          const runs = row.series.slice(-24);
          const largest = Math.max(1, ...runs.map((r) => r.new_results));
          return (
            <li key={row.routine_id} data-routine={row.routine_id} data-status={row.status}>
              <div className="wh-head">
                <Link to={`/watches/${row.routine_id}`} className="bar-name">{row.name}</Link>
                {!row.is_active && <span className="bar-aside">paused</span>}
              </div>
              <span className="run-strip" aria-label={`New papers per run: ${runs.map((r) => r.new_results).join(', ') || 'no completed runs'}`}>
                {runs.map((run, i) => (
                  <span key={`${run.start_time ?? ''}-${i}`} className="run-tick" data-zero={run.new_results === 0 ? 'true' : undefined}
                    style={{ height: `${Math.max(8, (100 * run.new_results) / largest)}%` }}
                    title={`${dayOf(run.start_time)}: ${count(run.new_results, 'new paper')} of ${number(run.total_results)}`} />
                ))}
              </span>
              <span className="wh-status">
                {watchStatusWords(row, view.stale_after, view.minimum_runs)}
                {row.missed_fires > 0 && <span className="bar-aside">, {count(row.missed_fires, 'fire')} that did not run</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Volume({ nameOf }: { nameOf: (slug: string) => string }) {
  const [by, setBy] = useState<'source' | 'category'>('source');
  const volume = useQuery({
    queryKey: ['publication-volume', by],
    queryFn: () => answer(engine().GET('/api/analytics/publication-volume', { params: { query: { group_by: by, months: 12 } } })),
    placeholderData: keepPreviousData,
  });
  const data = volume.data;
  const largest = Math.max(1, ...(data?.series ?? []).map((m) => m.total));
  const groups = data ? groupTotals(data.series) : [];
  const linkable = (group: string) => group !== 'other' && group !== '(uncategorised)';
  return (
    <section className="chart-card volume-card" data-analytics="volume" aria-busy={volume.isFetching}>
      <div className="chart-head">
        <h2 className="group-title">Papers by publication month</h2>
        <div className="seg" role="group" aria-label="Grouped by">
          <button type="button" aria-pressed={by === 'source'} onClick={() => setBy('source')}>Source</button>
          <button type="button" aria-pressed={by === 'category'} onClick={() => setBy('category')}>Category</button>
        </div>
      </div>
      <p className="chart-note">By the date each source gives a paper, for the latest twelve months that have any.</p>
      {data && <NotEnough reason={data.insufficient_reason} />}
      {data && data.series.length > 0 && (
        <>
          <div className="columns" role="img" aria-label={data.series.map((m) => `${monthWords(m.month)}: ${m.total}`).join('; ')}>
            {data.series.map((m) => (
              <div key={m.month} className="column" title={`${monthWords(m.month)}: ${count(m.total, 'paper')}`}>
                <span className="column-figure num">{number(m.total)}</span>
                <span className="column-bar" style={{ height: `${Math.max(2, (100 * m.total) / largest)}%` }} />
                <span className="column-label">{monthShort(m.month)}</span>
              </div>
            ))}
          </div>
          <ul className="group-totals" aria-label={by === 'source' ? 'Sources over these months' : 'Categories over these months'}>
            {groups.map(({ group, total }) => (
              <li key={group}>
                {linkable(group)
                  ? <Link to={collectionFor(by === 'source' ? { source: group } : { category: group })}>{by === 'source' ? nameOf(group) : group}</Link>
                  : <span>{group === 'other' ? 'Everything else' : 'No category given'}</span>}
                <span className="num">{number(total)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
