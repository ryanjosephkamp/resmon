import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import PageHelp from '../components/Help/PageHelp';
import { apiClient, getBaseUrl } from '../api/client';

/**
 * Corpus-wide explorer: every paper resmon has collected, in one place.
 *
 * Deep-linkable. `?source=arxiv` or `?category=cs.LG` opens with that filter
 * already applied, which is how the Analytics page hands off — seeing that one
 * source dominates a category is only useful if you can go and read those
 * papers.
 *
 * Paging is a cursor, not a page number, because the backend seeks by sort key
 * rather than counting rows. That makes "load more" the natural control and
 * "jump to page 40" impossible; at this scale nobody wants the latter.
 */

interface Doc {
  id: number;
  title: string;
  authors: string | null;
  abstract: string | null;
  publication_date: string | null;
  doi: string | null;
  url: string | null;
  source_repository: string;
  categories: string | null;
}

interface SearchResponse {
  results: Doc[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
  total_is_capped: boolean;
  used_full_text_index: boolean;
}

interface FacetValue { value: string; count: number; }
interface FacetResponse {
  sources: FacetValue[];
  authors: FacetValue[];
  categories: FacetValue[];
  max_values: number;
}

const nf = new Intl.NumberFormat();
const PAGE = 50;

const ExplorerPage: React.FC = () => {
  const [params, setParams] = useSearchParams();

  // The URL is the single source of truth for committed filters, rather than a
  // copy kept in state and pushed outward. Duplicating it meant an incoming
  // link was read only on mount: arriving from Analytics worked because that
  // remounts the page, but navigating Explorer -> Explorer, or pressing Back,
  // left the filters stale and the sync effect then overwrote the new URL with
  // the old state. Deriving them removes the possibility.
  const sources = params.getAll('source');
  const categories = params.getAll('category');
  const authors = params.getAll('author');
  const dateFrom = params.get('from') || '';
  const dateTo = params.get('to') || '';
  const urlQuery = params.get('q') || '';

  // The text box is the one exception: it needs local state so typing is
  // responsive, and is debounced into the URL below.
  const [query, setQuery] = useState(urlQuery);

  const [docs, setDocs] = useState<Doc[]>([]);
  const [meta, setMeta] = useState<Omit<SearchResponse, 'results'> | null>(null);
  const [facets, setFacets] = useState<FacetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  // Debounce the free-text box so a query is not issued per keystroke.
  const debounceRef = useRef<number | undefined>(undefined);

  /** Write one parameter back to the URL, which re-runs the search. */
  const setParam = useCallback((key: string, values: string[]) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(key);
      values.filter(Boolean).forEach((v) => next.append(key, v));
      return next;
    }, { replace: true });
  }, [setParams]);

  // Debounce typing into the URL rather than issuing a query per keystroke.
  useEffect(() => {
    if (query === urlQuery) return;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setParam('q', query ? [query] : []), 250);
    return () => window.clearTimeout(debounceRef.current);
  }, [query, urlQuery, setParam]);

  // Follow the URL when it changes from outside — a link from Analytics, or
  // the Back button.
  useEffect(() => { setQuery(urlQuery); }, [urlQuery]);

  const filterKey = params.toString();
  const filters = useMemo(() => ({
    query: urlQuery || null,
    sources, categories, authors,
    date_from: dateFrom || null,
    date_to: dateTo || null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [filterKey]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [page, f] = await Promise.all([
        apiClient.post<SearchResponse>('/api/explorer/search', { ...filters, limit: PAGE }),
        apiClient.post<FacetResponse>('/api/explorer/facets', filters),
      ]);
      const { results, ...rest } = page;
      setDocs(results);
      setMeta(rest);
      setFacets(f);
    } catch (err: any) {
      setError(err?.message || 'Search failed.');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { void load(); }, [load]);

  const loadMore = useCallback(async () => {
    if (!meta?.next_cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await apiClient.post<SearchResponse>('/api/explorer/search', {
        ...filters, cursor: meta.next_cursor, limit: PAGE,
      });
      const { results, ...rest } = page;
      setDocs((prev) => [...prev, ...results]);
      setMeta(rest);
    } catch (err: any) {
      setError(err?.message || 'Failed to load more.');
    } finally {
      setLoadingMore(false);
    }
  }, [filters, meta, loadingMore]);

  const toggle = (key: string, list: string[], value: string) =>
    setParam(key, list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const clearAll = () => {
    setQuery('');
    setParams(new URLSearchParams(), { replace: true });
  };

  const activeCount =
    sources.length + categories.length + authors.length +
    (urlQuery ? 1 : 0) + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);

  /** Export everything matching the filters, not just the rows on screen. */
  const exportFiltered = async (fmt: 'bibtex' | 'ris' | 'csv') => {
    setExporting(true);
    setError('');
    try {
      const resp = await fetch(`${getBaseUrl()}/api/explorer/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ ...filters, format: fmt }),
      });
      if (!resp.ok) throw new Error(`Export failed (HTTP ${resp.status})`);
      const text = await resp.text();
      const ext = fmt === 'bibtex' ? 'bib' : fmt;
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `resmon-explorer.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err?.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  const FacetGroup: React.FC<{
    title: string; values: FacetValue[]; selected: string[];
    onToggle: (v: string) => void;
  }> = ({ title, values, selected, onToggle }) => (
    <div className="explorer-facet">
      <h3>{title}</h3>
      {values.length === 0 ? (
        <p className="text-muted">None yet.</p>
      ) : (
        <ul className="explorer-facet-list">
          {values.map((v) => (
            <li key={v.value}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(v.value)}
                  onChange={() => onToggle(v.value)}
                />
                <span className="explorer-facet-value" title={v.value}>{v.value}</span>
                <span className="explorer-facet-count">{nf.format(v.count)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Explorer</h1>
        <TutorialLinkButton anchor="explorer" />
        <div className="form-actions">
          <button className="btn btn-secondary" disabled={exporting || !docs.length}
                  onClick={() => void exportFiltered('bibtex')}>BibTeX</button>
          <button className="btn btn-secondary" disabled={exporting || !docs.length}
                  onClick={() => void exportFiltered('ris')}>RIS</button>
          <button className="btn btn-secondary" disabled={exporting || !docs.length}
                  onClick={() => void exportFiltered('csv')}>CSV</button>
        </div>
      </div>

      <PageHelp
        storageKey="explorer"
        title="Explorer"
        summary="Search everything resmon has ever collected, not one execution at a time."
        sections={[
          {
            heading: 'What this searches',
            body: (
              <p>
                Every paper in your local corpus, across all executions and routines.
                Nothing here queries a repository — it reads what resmon has already
                stored, so it works offline and costs no API quota.
              </p>
            ),
          },
          {
            heading: 'Filters combine',
            body: (
              <p>
                A paper has to satisfy <em>every</em> filter you set, not any of them.
                Ticking two sources widens the search across both; ticking a source
                <em> and</em> a category narrows it to papers that are in both. The
                number beside each value is how many papers would match.
              </p>
            ),
          },
          {
            heading: 'Free text',
            body: (
              <p>
                Searches titles and abstracts together, using a full-text index rather
                than a plain substring scan, so it stays fast on a large corpus. The
                last word you type is treated as a prefix, so results narrow as you go.
              </p>
            ),
          },
          {
            heading: 'Exporting what you filtered',
            body: (
              <p>
                <strong>BibTeX</strong>, <strong>RIS</strong> and <strong>CSV</strong>{' '}
                export <em>everything matching your filters</em>, not just the papers
                currently on screen. That is usually what you want: filter down to a
                topic, then send the whole set to your reference manager.
              </p>
            ),
          },
          {
            heading: 'Coming from Analytics',
            body: (
              <p>
                Clicking a source or a category on the Analytics page opens this page
                already filtered to it. The address bar always reflects your filters, so
                a filtered view can be bookmarked or reloaded.
              </p>
            ),
          },
        ]}
      />

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="explorer-layout">
        <aside className="explorer-filters">
          <div className="explorer-filter-head">
            <h2>Filters</h2>
            {activeCount > 0 && (
              <button className="btn btn-sm btn-link" onClick={clearAll}>
                Clear {activeCount}
              </button>
            )}
          </div>

          <label className="explorer-field">
            <span>Search titles and abstracts</span>
            <input
              type="search"
              value={query}
              placeholder="e.g. diffusion models"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          <div className="explorer-dates">
            <label className="explorer-field">
              <span>Published from</span>
              <input type="date" value={dateFrom} onChange={(e) => setParam('from', [e.target.value])} />
            </label>
            <label className="explorer-field">
              <span>to</span>
              <input type="date" value={dateTo} onChange={(e) => setParam('to', [e.target.value])} />
            </label>
          </div>

          {facets && (
            <>
              <FacetGroup title="Source" values={facets.sources} selected={sources}
                          onToggle={(v) => toggle('source', sources, v)} />
              <FacetGroup title="Category" values={facets.categories} selected={categories}
                          onToggle={(v) => toggle('category', categories, v)} />
              <FacetGroup title="Author" values={facets.authors} selected={authors}
                          onToggle={(v) => toggle('author', authors, v)} />
            </>
          )}
        </aside>

        <section className="explorer-results">
          <div className="explorer-results-head">
            {loading ? (
              <p className="text-muted">Searching…</p>
            ) : (
              <p className="text-muted">
                {meta?.total === 0
                  ? 'No papers match these filters.'
                  : `${nf.format(meta?.total || 0)}${meta?.total_is_capped ? '+' : ''} ${
                      meta?.total === 1 ? 'paper' : 'papers'
                    }${activeCount ? ' matching your filters' : ' in your corpus'}`}
              </p>
            )}
          </div>

          {!loading && meta?.total === 0 && activeCount > 0 && (
            <div className="card">
              <p>Nothing matches every filter you have set. Try removing one.</p>
              <button className="btn btn-sm" onClick={clearAll}>Clear all filters</button>
            </div>
          )}

          {!loading && meta?.total === 0 && activeCount === 0 && (
            <div className="card">
              <h2>Nothing collected yet</h2>
              <p>
                Once you have run a Deep Dive or Deep Sweep, every paper resmon finds
                becomes searchable here.
              </p>
            </div>
          )}

          <ul className="explorer-list">
            {docs.map((d) => (
              <li className="explorer-item" key={d.id}>
                <h3>
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noreferrer noopener">{d.title}</a>
                  ) : d.title}
                </h3>
                <p className="explorer-meta">
                  <span className="explorer-source">{d.source_repository}</span>
                  {d.publication_date && <span>{d.publication_date}</span>}
                  {d.doi && <span className="explorer-doi">{d.doi}</span>}
                </p>
                {d.authors && <p className="explorer-authors">{d.authors}</p>}
                {d.abstract && <p className="explorer-abstract">{d.abstract}</p>}
                {d.categories && (
                  <p className="explorer-cats">
                    {d.categories.split(',').map((c) => c.trim()).filter(Boolean).map((c) => (
                      <button key={c} className="explorer-chip"
                              onClick={() => toggle('category', categories, c)}>
                        {c}
                      </button>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>

          {meta?.has_more && (
            <button className="btn" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : `Load ${PAGE} more`}
            </button>
          )}
        </section>
      </div>
    </div>
  );
};

export default ExplorerPage;
