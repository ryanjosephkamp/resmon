import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import PageHelp from '../components/Help/PageHelp';
import { apiClient } from '../api/client';

/**
 * Analytics over the corpus resmon has already swept.
 *
 * Every number here comes from the local database — no external calls. The
 * backend marks each statistic with `sufficient` and `sample_size`; this page
 * honours those rather than drawing a chart from three data points. A new user
 * with two executions should see honest counts and a clear explanation of what
 * is not yet knowable, never a broken axis or a confident "0%".
 */

interface Summary {
  documents: number;
  unique_papers: number;
  distinct_authors: number;
  sources: number;
  completed_executions: number;
  doi_coverage: number | null;
  sample_size: number;
  sufficient: boolean;
}

interface SourceRow {
  source: string;
  total: number;
  unique_papers: number;
  duplicated: number;
  unique_share: number | null;
}

interface LagRow {
  source: string;
  sample_size: number;
  sufficient: boolean;
  median_days: number | null;
  fastest_days: number | null;
  slowest_days: number | null;
}

interface RoutineRow {
  routine_id: number;
  name: string;
  is_active: boolean;
  runs: number;
  runs_since_new: number;
  last_new_result_at: string | null;
  total_new: number;
  status: 'healthy' | 'stale' | 'insufficient_data';
  series: { start_time: string; new_results: number }[];
}

interface VolumeBucket {
  month: string;
  total: number;
  groups: Record<string, number>;
}

interface Section<T> {
  sufficient: boolean;
  sample_size: number;
  insufficient_reason: string | null;
  [key: string]: any;
}

interface Overview {
  summary: Summary;
  source_contribution: Section<SourceRow> & { sources: SourceRow[] };
  discovery_lag: Section<LagRow> & { sources: LagRow[]; minimum_sample: number };
  routine_health: Section<RoutineRow> & {
    routines: RoutineRow[];
    minimum_runs: number;
    stale_after: number;
  };
  publication_volume: Section<VolumeBucket> & {
    series: VolumeBucket[];
    groups: string[];
    group_by: string;
  };
}

const nf = new Intl.NumberFormat();

/** Shown when a statistic exists but cannot yet be trusted. */
const NotEnoughYet: React.FC<{ reason: string | null; sample?: number }> = ({ reason, sample }) => (
  <p className="analytics-thin">
    {reason || 'Not enough data yet.'}
    {typeof sample === 'number' ? ` (${nf.format(sample)} so far)` : null}
  </p>
);

const AnalyticsPage: React.FC = () => {
  const [data, setData] = useState<Overview | null>(null);
  const [volumeBy, setVolumeBy] = useState<'source' | 'category'>('source');
  const [volume, setVolume] = useState<Overview['publication_volume'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const overview = await apiClient.get<Overview>('/api/analytics/overview');
      setData(overview);
      setVolume(overview.publication_volume);
    } catch (err: any) {
      setError(err?.message || 'Failed to load analytics.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const changeGrouping = useCallback(async (next: 'source' | 'category') => {
    setVolumeBy(next);
    try {
      const v = await apiClient.get<Overview['publication_volume']>(
        `/api/analytics/publication-volume?group_by=${next}`,
      );
      setVolume(v);
    } catch (err: any) {
      setError(err?.message || 'Failed to load publication volume.');
    }
  }, []);

  const help = (
    <PageHelp
      storageKey="analytics"
      title="Analytics"
      summary="What your swept corpus can tell you about itself — and about your routines."
      sections={[
        {
          heading: 'Where these numbers come from',
          body: (
            <p>
              Everything on this page is computed from papers resmon has already collected
              on this machine. Nothing here queries a repository, so opening it costs no API
              quota and works offline.
            </p>
          ),
        },
        {
          heading: 'Source contribution',
          body: (
            <p>
              Papers that arrived from more than one repository are counted as unique to
              none of them. A source whose every paper also came from somewhere else is
              costing you time on every sweep without adding anything — consider
              deselecting it. Papers are matched by DOI, or by title when no DOI exists.
            </p>
          ),
        },
        {
          heading: 'Discovery lag',
          body: (
            <p>
              The gap between a paper&rsquo;s publication date and the moment resmon first
              saw it. This is a property of the source, not of your settings: a repository
              with a two-week median will not surface anything sooner just because a
              routine runs hourly. Use it to choose a sensible schedule.
            </p>
          ),
        },
        {
          heading: 'Routine health',
          body: (
            <p>
              How many <em>new</em> papers each routine has been finding. A routine marked
              <strong> quiet</strong> has returned nothing new for several runs in a row,
              which usually means its keywords are too narrow, or its field has gone still.
              Neither is a fault — but it is worth knowing.
            </p>
          ),
        },
        {
          heading: 'Why some figures say “not enough data yet”',
          body: (
            <p>
              Counts are always shown. Averages and percentages are held back until there
              is enough data for them to mean something — a median of three numbers is not
              a finding, and one quiet run does not tell you a routine is finished. The
              sample size is always displayed so you can see how close you are.
            </p>
          ),
        },
      ]}
    />
  );

  if (loading) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Analytics</h1>
          <TutorialLinkButton anchor="#tutorial-analytics" />
        </div>
        {help}
        <p className="text-muted">Loading analytics…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Analytics</h1>
          <TutorialLinkButton anchor="#tutorial-analytics" />
        </div>
        {help}
        <div className="alert alert-error" role="alert">{error}</div>
        <button className="btn" onClick={() => void load()}>Try again</button>
      </div>
    );
  }

  const summary = data?.summary;
  const hasCorpus = !!summary && summary.documents > 0;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Analytics</h1>
        <TutorialLinkButton anchor="#tutorial-analytics" />
      </div>

      {help}

      {!hasCorpus ? (
        // The state every new install starts in. An explanation and a way
        // forward, not four empty charts.
        <section className="card analytics-empty">
          <h2>Nothing to analyse yet</h2>
          <p>
            This page describes the papers resmon has collected. Once you have run a
            search, it will show which repositories are actually earning their place, how
            quickly each one surfaces new work, and whether your routines are still
            finding anything.
          </p>
          <p>
            Start with a <Link to="/dive">Deep Dive</Link> against a single repository, or
            a <Link to="/sweep">Deep Sweep</Link> across several at once.
          </p>
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Your corpus</h2>
            <div className="analytics-tiles">
              <div className="analytics-tile">
                <span className="analytics-tile-key">Papers</span>
                <span className="analytics-tile-value">{nf.format(summary!.documents)}</span>
                <span className="analytics-tile-detail">
                  {nf.format(summary!.unique_papers)} distinct after de-duplication
                </span>
              </div>
              <div className="analytics-tile">
                <span className="analytics-tile-key">Authors</span>
                <span className="analytics-tile-value">{nf.format(summary!.distinct_authors)}</span>
                <span className="analytics-tile-detail">across all sources</span>
              </div>
              <div className="analytics-tile">
                <span className="analytics-tile-key">Sources used</span>
                <span className="analytics-tile-value">{nf.format(summary!.sources)}</span>
                <span className="analytics-tile-detail">
                  {nf.format(summary!.completed_executions)} completed runs
                </span>
              </div>
              <div className="analytics-tile">
                <span className="analytics-tile-key">DOI coverage</span>
                <span className="analytics-tile-value">
                  {summary!.doi_coverage === null
                    ? '—'
                    : `${Math.round(summary!.doi_coverage * 100)}%`}
                </span>
                <span className="analytics-tile-detail">papers with a resolvable DOI</span>
              </div>
            </div>
          </section>

          <section className="card">
            <h2>Which sources earn their place</h2>
            <p className="text-muted">
              Papers nothing else found, against papers that also arrived from another
              repository.
            </p>
            {!data!.source_contribution.sufficient ? (
              <NotEnoughYet
                reason={data!.source_contribution.insufficient_reason}
                sample={data!.source_contribution.sample_size}
              />
            ) : (
              <>
                <div className="analytics-bars">
                  {data!.source_contribution.sources.map((s) => {
                    const max = Math.max(
                      ...data!.source_contribution.sources.map((x) => x.total), 1,
                    );
                    return (
                      <div className="analytics-bar-row" key={s.source}>
                        <span className="analytics-bar-label" title={s.source}>{s.source}</span>
                        <span className="analytics-bar-track">
                          <span
                            className="analytics-bar-fill"
                            style={{ width: `${(s.unique_papers / max) * 100}%` }}
                          />
                          <span
                            className="analytics-bar-fill analytics-bar-fill-dup"
                            style={{ width: `${(s.duplicated / max) * 100}%` }}
                          />
                        </span>
                        <span className="analytics-bar-num">
                          {nf.format(s.unique_papers)} / {nf.format(s.total)}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="analytics-legend">
                  <span><i className="analytics-swatch" /> unique to this source</span>
                  <span><i className="analytics-swatch analytics-swatch-dup" /> also found elsewhere</span>
                </p>
              </>
            )}
          </section>

          <section className="card">
            <h2>How quickly each source surfaces a paper</h2>
            <p className="text-muted">
              Median days between publication and resmon first seeing it.
            </p>
            {!data!.discovery_lag.sufficient ? (
              <NotEnoughYet
                reason={data!.discovery_lag.insufficient_reason}
                sample={data!.discovery_lag.sample_size}
              />
            ) : (
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Source</th><th>Median</th><th>Fastest</th><th>Slowest</th><th>Papers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.discovery_lag.sources.map((s) => (
                      <tr key={s.source}>
                        <td>{s.source}</td>
                        <td className="num">
                          {s.sufficient ? `${s.median_days} d` : <span className="text-muted">—</span>}
                        </td>
                        <td className="num">{s.sufficient ? `${s.fastest_days} d` : ''}</td>
                        <td className="num">{s.sufficient ? `${s.slowest_days} d` : ''}</td>
                        <td className="num">
                          {nf.format(s.sample_size)}
                          {!s.sufficient && (
                            <span className="text-muted">
                              {' '}(needs {data!.discovery_lag.minimum_sample})
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <h2>Routine health</h2>
            <p className="text-muted">
              Whether each routine is still finding papers you have not already seen.
            </p>
            {!data!.routine_health.sufficient ? (
              <NotEnoughYet reason={data!.routine_health.insufficient_reason} />
            ) : (
              <div className="analytics-routines">
                {data!.routine_health.routines.map((r) => (
                  <div className={`analytics-routine analytics-routine-${r.status}`} key={r.routine_id}>
                    <div className="analytics-routine-head">
                      <strong>{r.name}</strong>
                      <span className={`badge badge-${r.status}`}>
                        {r.status === 'healthy' && 'Finding new work'}
                        {r.status === 'stale' && 'Quiet'}
                        {r.status === 'insufficient_data' && 'Too early to tell'}
                      </span>
                    </div>
                    <p className="text-muted">
                      {r.runs} {r.runs === 1 ? 'run' : 'runs'}, {nf.format(r.total_new)} new papers.
                      {r.status === 'stale' && ` Nothing new in the last ${r.runs_since_new} runs.`}
                      {r.status === 'insufficient_data' &&
                        ` Needs ${data!.routine_health.minimum_runs} runs before this means anything.`}
                      {r.last_new_result_at && ` Last new paper: ${r.last_new_result_at.slice(0, 10)}.`}
                    </p>
                    {r.series.length > 1 && (
                      <div className="analytics-spark" aria-hidden="true">
                        {r.series.slice(-24).map((run, i) => {
                          const peak = Math.max(...r.series.map((x) => x.new_results), 1);
                          return (
                            <span
                              key={i}
                              className="analytics-spark-bar"
                              style={{ height: `${Math.max((run.new_results / peak) * 100, 3)}%` }}
                              title={`${run.start_time.slice(0, 10)}: ${run.new_results} new`}
                            />
                          );
                        })}
                      </div>
                    )}
                    <Link className="link" to="/routines">Open routine</Link>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <h2>Publication volume over time</h2>
            <div className="analytics-toggle" role="group" aria-label="Group publication volume by">
              <button
                className={`btn btn-sm ${volumeBy === 'source' ? 'btn-active' : ''}`}
                onClick={() => void changeGrouping('source')}
                aria-pressed={volumeBy === 'source'}
              >By source</button>
              <button
                className={`btn btn-sm ${volumeBy === 'category' ? 'btn-active' : ''}`}
                onClick={() => void changeGrouping('category')}
                aria-pressed={volumeBy === 'category'}
              >By category</button>
            </div>
            {!volume || !volume.sufficient ? (
              <NotEnoughYet
                reason={volume?.insufficient_reason || null}
                sample={volume?.sample_size}
              />
            ) : (
              <div className="analytics-volume">
                {volume.series.map((bucket) => {
                  const peak = Math.max(...volume.series.map((b) => b.total), 1);
                  return (
                    <div className="analytics-volume-col" key={bucket.month}>
                      <span
                        className="analytics-volume-bar"
                        style={{ height: `${Math.max((bucket.total / peak) * 100, 2)}%` }}
                        title={`${bucket.month}: ${bucket.total} papers`}
                      />
                      <span className="analytics-volume-label">{bucket.month.slice(2)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default AnalyticsPage;
