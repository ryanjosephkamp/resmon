import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { answer, engine, EngineError } from '../api/client';
import { Icon } from '../shell/Icon';
import { SearchTabs } from './collection/SearchTabs';
import { RunLog } from './runs/RunLog';
import type { CatalogEntry } from './runs/model';

type Mode = 'dive' | 'sweep';

/** The windows offered beside the two date fields, in days; `null` is any time. */
const WINDOWS: readonly { days: number | null; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 365, label: 'A year' },
  { days: null, label: 'Any time' },
];

function isoDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

function windowDates(days: number | null): { from: string; to: string } {
  if (days === null) return { from: '', to: '' };
  const to = new Date();
  return { from: isoDay(new Date(to.getTime() - days * 86_400_000)), to: isoDay(to) };
}

/** Requests per second, from the catalog's stated limit ("0.33 req/s (1 per 3 s)"). */
function ratePerSecond(rate: string): number | null {
  const match = rate.match(/^\s*([\d.]+)\s*req\/s/);
  return match ? Number(match[1]) : null;
}

/** The stated limit, short, for the catalog: "10 a second", "1 every 3 s", "1 a minute". */
function rateShort(perSecond: number | null, stated: string): string {
  if (perSecond === null || perSecond <= 0) return stated;
  if (perSecond >= 1) return `${Number(perSecond.toFixed(1))} a second`;
  const every = 1 / perSecond;
  return every >= 59 ? `1 every ${Math.round(every / 60)} min` : `1 every ${Math.round(every)} s`;
}

/** The same limit as a phrase: "one request every 3 seconds". */
function rateLong(perSecond: number): string {
  if (perSecond >= 1) return `${Number(perSecond.toFixed(1))} requests a second`;
  const every = 1 / perSecond;
  return every >= 59
    ? `one request every ${Math.round(every / 60) === 1 ? 'minute' : `${Math.round(every / 60)} minutes`}`
    : `one request every ${Math.round(every)} seconds`;
}

/** Whole days between two ISO dates; `null` when the window is open at either end. */
function windowLength(from: string, to: string): number | null {
  if (!from || !to) return null;
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  return Number.isFinite(days) ? days : null;
}

/**
 * Search: ask the sources. One source in depth (a Deep Dive) or several at
 * once (a Deep Sweep), from a catalog that states each source's limits before
 * anything is asked, beside the log of every run so far.
 *
 * The limits are the catalog's own statements about each upstream, and the
 * two sentences under the button are derived from them for this selection:
 * which source sets the pace, and which cannot date papers as finely as the
 * window asks. Nothing here estimates how many papers a search will find.
 */
export function Search() {
  const navigate = useNavigate();
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const runnable = useQuery({
    queryKey: ['runnable-sources'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/search/repositories')),
  });
  const credentials = useQuery({
    queryKey: ['credentials'],
    queryFn: () => answer(engine().GET('/api/credentials')),
  });

  const [mode, setMode] = useState<Mode>('dive');
  const [terms, setTerms] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  /** The preset the dates came from; `undefined` once they are edited by hand. */
  const [windowDays, setWindowDays] = useState<number | null | undefined>(30);
  const [dates, setDates] = useState(() => windowDates(30));
  const [cap, setCap] = useState(100);

  const sources = useMemo(() => {
    const allowed = new Set(runnable.data ?? []);
    return (catalog.data ?? []).filter((entry) => allowed.has(entry.slug));
  }, [catalog.data, runnable.data]);

  const keyMissing = (entry: CatalogEntry) => entry.api_key_requirement === 'required'
    && !!entry.credential_name
    && credentials.data?.credentials[entry.credential_name]?.present !== true;

  const choose = (slug: string) => {
    setChosen((current) => {
      if (mode === 'dive') return [slug];
      return current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug];
    });
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    if (next === 'dive') setChosen((current) => current.slice(0, 1));
  };

  const addTerm = () => {
    const term = draft.trim();
    if (term && !terms.includes(term)) setTerms([...terms, term]);
    setDraft('');
  };
  const onTermKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addTerm();
    } else if (event.key === 'Backspace' && !draft && terms.length) {
      setTerms(terms.slice(0, -1));
    }
  };

  const allTerms = draft.trim() && !terms.includes(draft.trim()) ? [...terms, draft.trim()] : terms;
  const picked = sources.filter((entry) => chosen.includes(entry.slug));

  const start = useMutation({
    mutationFn: async () => {
      const base = {
        query: allTerms.join(' '),
        keywords: allTerms,
        date_from: dates.from || null,
        date_to: dates.to || null,
        max_results: cap,
        // A summary per paper is a model's work and goes with Ask (slice 6).
        ai_enabled: false,
        request_id: crypto.randomUUID(),
      };
      return mode === 'dive'
        ? answer(engine().POST('/api/search/dive', { body: { ...base, repository: chosen[0] ?? '' } }))
        : answer(engine().POST('/api/search/sweep', { body: { ...base, repositories: chosen } }));
    },
    onSuccess: (started) => navigate(`/runs/${started.execution_id}`),
  });

  const ready = allTerms.length > 0 && chosen.length > 0 && !start.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim()) addTerm();
    if (ready) start.mutate();
  };

  // The two facts derived from the catalog for this selection.
  const pace = useMemo(() => {
    const rated = picked.map((entry) => ({ entry, rate: ratePerSecond(entry.rate_limit) }))
      .filter((r): r is { entry: CatalogEntry; rate: number } => r.rate !== null && r.rate > 0)
      .sort((a, b) => a.rate - b.rate);
    return picked.length > 1 && rated[0] ? rated[0] : null;
  }, [picked]);
  const coarse = useMemo(() => {
    const days = windowLength(dates.from, dates.to);
    if (days === null || days >= 365) return [];
    return picked.filter((entry) => entry.date_granularity === 'year'
      || (entry.date_granularity === 'month' && days < 31));
  }, [picked, dates]);

  const refusal = start.error instanceof EngineError && start.error.status === 429
    ? 'resmon is already running as many searches as it allows at once. Try again in a few seconds.'
    : start.error ? `The search could not start: ${start.error.message}.` : null;

  return (
    <div className="search">
      <form className="ask" onSubmit={submit} aria-label="Ask the sources">
        <SearchTabs />
        <div className="ask-head">
          <h1 className="page-title">Ask the sources</h1>
          <div className="seg" role="group" aria-label="Kind of search">
            <button type="button" aria-pressed={mode === 'dive'} onClick={() => switchMode('dive')}>Deep Dive</button>
            <button type="button" aria-pressed={mode === 'sweep'} onClick={() => switchMode('sweep')}>Deep Sweep</button>
          </div>
        </div>
        <p className="page-lede">
          {mode === 'dive'
            ? 'One source, asked in depth.'
            : 'Several sources at once, each asked the same question.'}
          {' '}Each source&rsquo;s own limits are listed before you ask.
        </p>

        <label className="terms" htmlFor="ask-terms">
          <Icon name="search" />
          {terms.map((term) => (
            <span key={term} className="term">
              {term}
              <button type="button" aria-label={`Remove ${term}`} onClick={() => setTerms(terms.filter((t) => t !== term))}>
                <Icon name="close" />
              </button>
            </span>
          ))}
          <input
            id="ask-terms"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onTermKey}
            onBlur={addTerm}
            placeholder={terms.length ? 'Another term' : 'Terms to look for; Enter adds each one'}
            aria-label="Search terms"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <fieldset className="catalog">
          <legend>
            {mode === 'dive' ? 'Source' : 'Sources'}
            <span>{mode === 'dive' ? 'choose one' : `${chosen.length} of ${sources.length} chosen`}</span>
          </legend>
          <div className="catalog-head" aria-hidden="true">
            <span />
            <span>Source</span>
            <span>Terms combine</span>
            <span>Requests allowed</span>
            <span>Dates papers</span>
          </div>
          <div className="catalog-rows">
            {sources.map((entry) => {
              const rate = ratePerSecond(entry.rate_limit);
              const missing = keyMissing(entry);
              const on = chosen.includes(entry.slug);
              return (
                <label key={entry.slug} className={on ? 'source on' : 'source'} data-source={entry.slug}>
                  <input
                    type={mode === 'dive' ? 'radio' : 'checkbox'}
                    name="ask-source"
                    checked={on}
                    onChange={() => choose(entry.slug)}
                  />
                  <span className="source-name">
                    {entry.name}
                    {missing && <span className="source-key">needs an API key</span>}
                    <span className="source-key" data-author-query={entry.entity_search.author_query}>
                      {authorWords(entry.entity_search.author_query)}
                    </span>
                  </span>
                  <span className="source-fact">{entry.keyword_combination}</span>
                  <span className="source-fact num" title={entry.rate_limit}>{rateShort(rate, entry.rate_limit)}</span>
                  <span className="source-fact">to the {entry.date_granularity}</span>
                </label>
              );
            })}
            {(catalog.isPending || runnable.isPending) && <p className="index-cap">Reading the catalog.</p>}
            {(catalog.isError || runnable.isError) && <p className="index-cap">The catalog could not be read.</p>}
          </div>
        </fieldset>

        <div className="ask-window">
          <fieldset className="window">
            <legend>Published</legend>
            <div className="seg" role="group" aria-label="Window">
              {WINDOWS.map((w) => (
                <button
                  key={w.label}
                  type="button"
                  aria-pressed={windowDays === w.days}
                  onClick={() => { setWindowDays(w.days); setDates(windowDates(w.days)); }}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <label className="date">
              <span>From</span>
              <input type="date" value={dates.from} onChange={(e) => { setWindowDays(undefined); setDates({ ...dates, from: e.target.value }); }} />
            </label>
            <label className="date">
              <span>To</span>
              <input type="date" value={dates.to} onChange={(e) => { setWindowDays(undefined); setDates({ ...dates, to: e.target.value }); }} />
            </label>
          </fieldset>
          <label className="cap">
            <span>Up to</span>
            <input
              type="number"
              min={1}
              max={1000}
              value={cap}
              onChange={(event) => setCap(Math.max(1, Math.min(1000, Number(event.target.value) || 1)))}
              aria-label="Most papers per source"
            />
            <span>papers per source</span>
          </label>
        </div>

        <div className="ask-go">
          <button type="submit" className="btn primary go" disabled={!ready}>
            {start.isPending ? 'Starting'
              : picked.length === 1 ? `Ask ${picked[0]?.name}`
                : picked.length > 1 ? `Ask ${picked.length} sources` : 'Ask'}
          </button>
          <div className="ask-facts" aria-live="polite">
            {!allTerms.length && <p>Add at least one term.</p>}
            {allTerms.length > 0 && !chosen.length && <p>Choose {mode === 'dive' ? 'a source' : 'one or more sources'}.</p>}
            {pace && (
              <p>
                {pace.entry.name} allows {rateLong(pace.rate)}, the slowest of these; it sets how long the sweep takes.
              </p>
            )}
            {coarse.length > 0 && (
              <p>
                {coarse.map((entry) => entry.name).join(', ')} {coarse.length === 1 ? 'dates' : 'date'} papers only to the {coarse.length === 1 ? coarse[0]?.date_granularity : 'month or year'}; a window this short may come back as one {coarse.length === 1 ? 'it' : 'they'} could not answer.
              </p>
            )}
            {picked.filter(keyMissing).map((entry) => (
              <p key={entry.slug}>{entry.name} has no API key here, so it will be recorded as not queried.</p>
            ))}
            {refusal && <p className="ask-refusal" role="alert">{refusal}</p>}
          </div>
        </div>
      </form>
      <RunLog />
    </div>
  );
}

/**
 * Whether a source can be asked about a person, as the catalog states it. A
 * watch on a person through a source that cannot be asked finds nothing, and
 * the run says so on that source's own row; this says it before asking.
 */
function authorWords(query: string): string {
  if (query === 'none') return 'cannot be asked about an author';
  if (query === 'unknown') return 'not known whether it can be asked about an author';
  return 'can be asked about an author';
}
