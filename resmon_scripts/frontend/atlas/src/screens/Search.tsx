import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { answer, engine, EngineError } from '../api/client';
import { SearchTabs } from './collection/SearchTabs';
import { SAVED_KEY, savedAsks, savedParameters, type SavedConfiguration } from './collection/savedSearches';
import { providerWords } from './ask/askModel';
import { RunLog } from './runs/RunLog';
import { PlaceHelp } from './watches/people/People';
import { coarseFor, coarseSentence, paceOf, rateLong } from './sources/catalog';
import { SourceCatalog, TermsField, useSources, useTerms } from './sources/SourceCatalog';

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

/** Which lane would write a run's summaries, and what happens where it cannot. */
function laneSentence(provider: string, model: string): string {
  if (!provider) return 'No provider is chosen for summaries, so none can be written. The papers are kept either way.';
  return `Written with ${providerWords(provider)}${model ? ` (${model})` : ''}. A paper it cannot summarize is kept`
    + ' without one, and the run’s log says why.';
}

function windowDates(days: number | null): { from: string; to: string } {
  if (days === null) return { from: '', to: '' };
  const to = new Date();
  return { from: isoDay(new Date(to.getTime() - days * 86_400_000)), to: isoDay(to) };
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
  const client = useQueryClient();
  // A saved search opened from Saved fills the form, and the run it starts
  // records which saved search it came from.
  const opened = (useLocation().state as { saved?: SavedConfiguration } | null)?.saved ?? null;
  const from = opened ? savedAsks(opened) : null;
  const { sources, keyMissing, pending, failed } = useSources();

  const [mode, setMode] = useState<Mode>(opened?.config_type === 'manual_dive' ? 'dive' : opened ? 'sweep' : 'dive');
  const terms = useTerms(from?.keywords ?? []);
  const [chosen, setChosen] = useState<string[]>(from?.sources ?? []);
  /** The preset the dates came from; `undefined` once they are edited by hand. */
  const [windowDays, setWindowDays] = useState<number | null | undefined>(from ? undefined : 30);
  const [dates, setDates] = useState(() => (from ? { from: from.dateFrom, to: from.dateTo } : windowDates(30)));
  const [cap, setCap] = useState(from?.cap ?? 100);
  const [summarize, setSummarize] = useState(from?.summarize ?? false);
  const lane = useQuery({ queryKey: ['ai-settings'], queryFn: () => answer(engine().GET('/api/settings/ai')), enabled: summarize });
  /** The name being typed for Save this search; `null` while the field is closed. */
  const [naming, setNaming] = useState<string | null>(null);

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

  const allTerms = terms.all;
  // In the order they were chosen, which is the order the run asks and records them.
  const picked = chosen.flatMap((slug) => sources.filter((entry) => entry.slug === slug));
  // A saved search can name a source this copy of resmon cannot ask (one
  // retired since, or from a newer build). It is said and left out, rather
  // than counted as chosen and asked of nothing.
  const unknown = sources.length ? chosen.filter((slug) => !sources.some((entry) => entry.slug === slug)) : [];

  const start = useMutation({
    mutationFn: async () => {
      const base = {
        query: allTerms.join(' '),
        keywords: allTerms,
        date_from: dates.from || null,
        date_to: dates.to || null,
        max_results: cap,
        ai_enabled: summarize,
        request_id: crypto.randomUUID(),
        saved_configuration_id: opened?.id ?? null,
      };
      return mode === 'dive'
        ? answer(engine().POST('/api/search/dive', { body: { ...base, repository: picked[0]?.slug ?? '' } }))
        : answer(engine().POST('/api/search/sweep', { body: { ...base, repositories: picked.map((e) => e.slug) } }));
    },
    onSuccess: (started) => navigate(`/runs/${started.execution_id}`),
  });

  const ready = allTerms.length > 0 && picked.length > 0 && !start.isPending;

  const keep = useMutation({
    mutationFn: (name: string) => {
      const { config_type, parameters } = savedParameters({
        mode, sources: picked.map((e) => e.slug), keywords: allTerms, dateFrom: dates.from, dateTo: dates.to, cap, summarize,
      });
      return answer(engine().POST('/api/configurations', { body: { name, config_type, parameters } }));
    },
    onSuccess: () => {
      setNaming(null);
      void client.invalidateQueries({ queryKey: SAVED_KEY });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (terms.draft.trim()) terms.add();
    if (ready) start.mutate();
  };

  // The two facts derived from the catalog for this selection.
  const pace = useMemo(() => paceOf(picked), [picked]);
  const coarse = useMemo(() => coarseFor(picked, dates.from, dates.to), [picked, dates]);

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

        <PlaceHelp summary="About sources, their limits and their keys">
          <p>
            Each source is listed with its own limits before you ask: how it combines your terms, how many requests it
            allows, and how finely it can date a paper. A source that dates papers only to the year cannot answer a
            shorter window, and says so in the run’s search record.
          </p>
          <p>
            A source that requires an API key and has none here is recorded as not asked. Keys are stored in
            {' '}<Link to="/settings/sources">Settings › Sources</Link>, in this computer’s keychain, and sent only to
            their source.
          </p>
        </PlaceHelp>

        <TermsField id="ask-terms" label="Search terms" state={terms} />

        <SourceCatalog
          name="ask-source"
          legend={mode === 'dive' ? 'Source' : 'Sources'}
          count={mode === 'dive' ? 'choose one' : `${picked.length} of ${sources.length} chosen`}
          sources={sources}
          chosen={chosen}
          multiple={mode === 'sweep'}
          keyMissing={keyMissing}
          pending={pending}
          failed={failed}
          onChoose={choose}
        />

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

        <div className="ask-summarize">
          <label>
            <input type="checkbox" checked={summarize} onChange={(e) => setSummarize(e.target.checked)} />
            <span>Summarize each paper</span>
          </label>
          {summarize && (
            <p className="ask-lane" data-ask="summary-lane">
              {lane.data ? laneSentence(lane.data.ai_provider, lane.data.ai_model)
                : lane.isError ? `The engine did not say which lane would write them (${lane.error.message}).`
                  : 'Reading which lane would write them.'}
              {' '}<Link to="/settings/ai">Settings → AI</Link>
            </p>
          )}
        </div>

        <div className="ask-go">
          <button type="submit" className="btn primary go" disabled={!ready}>
            {start.isPending ? 'Starting'
              : picked.length === 1 ? `Ask ${picked[0]?.name}`
                : picked.length > 1 ? `Ask ${picked.length} sources` : 'Ask'}
          </button>
          <div className="ask-facts" aria-live="polite">
            {!allTerms.length && <p>Add at least one term.</p>}
            {allTerms.length > 0 && !picked.length && <p>Choose {mode === 'dive' ? 'a source' : 'one or more sources'}.</p>}
            {pace && (
              <p>
                {pace.entry.name} allows {rateLong(pace.rate)}, the slowest of these; it sets how long the sweep takes.
              </p>
            )}
            {coarse.length > 0 && <p>{coarseSentence(coarse)}</p>}
            {picked.filter(keyMissing).map((entry) => (
              <p key={entry.slug}>{entry.name} has no API key here, so it will be recorded as not queried.</p>
            ))}
            {unknown.length > 0 && (
              <p data-saved="unknown-sources">
                {unknown.join(', ')} {unknown.length === 1 ? 'is' : 'are'} in this saved search but {unknown.length === 1 ? 'is not a source' : 'are not sources'}
                {' '}this copy of resmon can ask, so {unknown.length === 1 ? 'it is' : 'they are'} left out.
              </p>
            )}
            {refusal && <p className="ask-refusal" role="alert">{refusal}</p>}
          </div>
        </div>

        <div className="ask-keep">
          {opened && <p className="keep-from">Opened from the saved search “{opened.name}”; a run started here records it.</p>}
          {naming === null ? (
            <span className="keep-row">
              <button
                type="button"
                className="btn quiet"
                data-saved="keep"
                disabled={!allTerms.length || !picked.length}
                onClick={() => { keep.reset(); setNaming(''); }}
              >
                Save this search
              </button>
              {/* Not the dates: a window fixed today would be asked again on every run. */}
              <button
                type="button"
                className="btn quiet"
                data-editor="watch-this"
                disabled={!allTerms.length || !picked.length}
                onClick={() => navigate('/watches/new', {
                  state: { seed: { sources: picked.map((e) => e.slug), keywords: allTerms, cap } },
                })}
              >
                Watch this search
              </button>
            </span>
          ) : (
            <span className="keep-row">
              <label className="sr-only" htmlFor="keep-name">A name for this saved search</label>
              <input
                id="keep-name"
                value={naming}
                placeholder="A name for this search"
                autoFocus
                onChange={(event) => setNaming(event.target.value)}
                onKeyDown={(event) => {
                  // Enter here saves; it must not reach the form and start a run.
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (naming.trim()) keep.mutate(naming.trim());
                  } else if (event.key === 'Escape') {
                    setNaming(null);
                  }
                }}
              />
              <button type="button" className="btn" disabled={!naming.trim() || keep.isPending} onClick={() => keep.mutate(naming.trim())}>
                {keep.isPending ? 'Saving' : 'Save'}
              </button>
              <button type="button" className="btn quiet" onClick={() => setNaming(null)}>Cancel</button>
            </span>
          )}
          {keep.isSuccess && naming === null && (
            <p className="settings-said" role="status" data-saved="kept">
              Saved as “{keep.variables}”, under <Link to="/search/saved">Saved</Link>.
            </p>
          )}
          {keep.error && (
            <p className="field-error" role="alert">
              {keep.error instanceof EngineError && keep.error.detail ? keep.error.detail : keep.error.message}
            </p>
          )}
        </div>
      </form>
      <RunLog />
    </div>
  );
}
