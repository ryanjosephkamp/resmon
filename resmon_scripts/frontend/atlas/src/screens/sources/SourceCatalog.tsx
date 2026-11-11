import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import type { CatalogEntry } from '../runs/model';
import { authorWords, rateShort, ratePerSecond } from './catalog';
import { collectionParam, useCollection } from '../../collections/current';
import { MATCHES, type Match } from './terms';
import './relatedTerms.css';

/**
 * The sources this copy of resmon can ask, with the catalog's statement about
 * each, and whether a source that needs a key has one here.
 */
export function useSources() {
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
  const sources = useMemo(() => {
    const allowed = new Set(runnable.data ?? []);
    return (catalog.data ?? []).filter((entry) => allowed.has(entry.slug));
  }, [catalog.data, runnable.data]);
  const keyMissing = (entry: CatalogEntry) => entry.api_key_requirement === 'required'
    && !!entry.credential_name
    && credentials.data?.credentials[entry.credential_name]?.present !== true;
  return {
    sources,
    keyMissing,
    pending: catalog.isPending || runnable.isPending,
    failed: catalog.isError || runnable.isError,
  };
}

/**
 * The catalog as a choice: one source (radios) or several (checkboxes), each
 * row stating how the source combines terms, how fast it may be asked, how
 * finely it dates papers, and whether it can be asked about an author.
 *
 * The rows take their full height, so a wheel over them scrolls the page and
 * whatever the form holds below them comes into view; the column heads, a
 * filter, and the names already chosen stay at the top while it scrolls. The
 * rows keep the catalog's order, so a row never moves under the pointer when
 * it is chosen.
 */
export function SourceCatalog({ legend, count, sources, chosen, multiple, keyMissing, pending, failed, onChoose, onChooseMany, canAsk, name }: {
  legend: string;
  count: ReactNode;
  sources: readonly CatalogEntry[];
  chosen: readonly string[];
  multiple: boolean;
  keyMissing: (entry: CatalogEntry) => boolean;
  pending: boolean;
  failed: boolean;
  onChoose: (slug: string) => void;
  onChooseMany?: (slugs: string[]) => void;
  canAsk?: (entry: CatalogEntry) => boolean;
  /** The inputs' shared name, unique to the form. */
  name: string;
}) {
  const [filter, setFilter] = useState('');
  const wanted = filter.trim().toLowerCase();
  const shown = wanted
    ? sources.filter((entry) => entry.name.toLowerCase().includes(wanted) || entry.slug.includes(wanted))
    : sources;
  const picked = sources.filter((entry) => chosen.includes(entry.slug));
  return (
    <fieldset className="catalog">
      <legend>
        {legend}
        <span>{count}</span>
      </legend>
      <div className="catalog-top">
        <div className="catalog-tools">
          {multiple && onChooseMany && (
            <div className="catalog-bulk">
              <button type="button" className="btn quiet sm" disabled={pending || failed}
                onClick={() => onChooseMany(sources.filter(entry => !keyMissing(entry) && (!canAsk || canAsk(entry))).map(entry => entry.slug))}>Select All</button>
              <button type="button" className="btn quiet sm" disabled={pending || failed || chosen.length === 0}
                onClick={() => onChooseMany([])}>Deselect All</button>
            </div>
          )}
          <label className="catalog-filter">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                // Enter here filters; it must not reach the form and start a run.
                if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) event.preventDefault();
                if (event.key === 'Escape' && filter) { event.preventDefault(); setFilter(''); }
              }}
              placeholder="Filter sources"
              aria-label="Filter the sources by name"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {picked.length > 0 && (
            <p className="catalog-chosen" data-catalog="chosen">
              <span>Chosen:</span>
              {picked.map((entry) => (multiple ? (
                <span key={entry.slug} className="chosen-source">
                  {entry.name}
                  <button type="button" aria-label={`Remove ${entry.name}`} onClick={() => onChoose(entry.slug)}>
                    <Icon name="close" />
                  </button>
                </span>
              ) : <span key={entry.slug} className="chosen-source">{entry.name}</span>))}
            </p>
          )}
        </div>
        <div className="catalog-head" aria-hidden="true">
          <span />
          <span>Source</span>
          <span>Terms Combine</span>
          <span>Requests Allowed</span>
          <span>Dates Papers</span>
        </div>
      </div>
      <div className="catalog-rows">
        {wanted && shown.length === 0 && (
          <p className="index-cap" data-catalog="no-match">No source’s name matches “{filter.trim()}”.</p>
        )}
        {shown.map((entry) => {
          const rate = ratePerSecond(entry.rate_limit);
          const missing = keyMissing(entry);
          const on = chosen.includes(entry.slug);
          return (
            <label key={entry.slug} className={on ? 'source on' : 'source'} data-source={entry.slug}>
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={name}
                checked={on}
                onChange={() => onChoose(entry.slug)}
              />
              <span className="source-name">
                {entry.name}
                {missing && <span className="source-key">needs an API key</span>}
                {entry.service_notice && (
                  <span className="source-key source-notice" data-notice="service" title={entry.service_notice}>end announced</span>
                )}
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
        {pending && <p className="index-cap">Reading the catalog.</p>}
        {failed && <p className="index-cap">The catalog could not be read.</p>}
      </div>
    </fieldset>
  );
}

/**
 * Terms, one at a time: Enter adds the one typed, Backspace in an empty field
 * takes the last one back, and leaving the field keeps what was typed.
 * `draft` is lifted so a form can count a term that is typed and not yet added.
 */
export function useTerms(initial: readonly string[], initialDraft = '') {
  const [terms, setTerms] = useState<string[]>([...initial]);
  const [draft, setDraft] = useState(initialDraft);
  const add = () => {
    const term = draft.trim();
    if (term) setTerms(current => current.includes(term) ? current : [...current, term]);
    setDraft('');
  };
  const typed = draft.trim();
  const all = typed && !terms.includes(typed) ? [...terms, typed] : terms;
  return { terms, setTerms, draft, setDraft, add, all };
}

export function TermsField({ id, label, state, className, related = false, match }: {
  id: string;
  label: string;
  state: ReturnType<typeof useTerms>;
  className?: string;
  related?: boolean;
  /** Whether a paper must match any term or all of them, shown under the box. */
  match?: { value: Match; onChange: (match: Match) => void };
}) {
  const { terms, setTerms, draft, setDraft, add } = state;
  const { id: collection } = useCollection();
  // The first time the field gets the keyboard, the engine prepares this collection's word counts,
  // so the first related-terms lookup a person waits on reuses them. Its answer is not read.
  const prepared = useRef<number | null>(null);
  const prepare = () => {
    if (!related || collection === null || prepared.current === collection) return;
    prepared.current = collection;
    void engine().GET('/api/collection/related-terms', { params: { query: { ...collectionParam(collection) } } }).catch(() => undefined);
  };
  // A press outside the field takes the keyboard before it becomes a click, and leaving the field adds
  // what was typed. That term's offer, drawn under the field, would move what was pressed out from under
  // the pointer, so it waits until the press ends.
  const held = useRef(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  useEffect(() => {
    if (!related) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const press = () => { held.current = true; };
    const release = () => {
      held.current = false;
      clearTimeout(timer);
      timer = setTimeout(() => setWaiting(null), 0);
    };
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
  }, [related]);
  const leave = () => {
    const term = draft.trim();
    if (related && term && held.current && !terms.includes(term)) setWaiting(term);
    add();
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    // Plain Enter adds the term; ⌘Enter (Ctrl+Enter) is left to the form around the field (`commandEnter`).
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      add();
    } else if (event.key === 'Backspace' && !draft && terms.length) {
      setTerms(terms.slice(0, -1));
    }
  };
  return (
    <>
    <label className={className ? `terms ${className}` : 'terms'} htmlFor={id}>
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
        id={id}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKey}
        onFocus={prepare}
        onBlur={leave}
        placeholder={terms.length ? 'Another term' : 'Terms to look for; Enter adds each one'}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
    {match && <MatchField id={`${id}-match`} value={match.value} onChange={match.onChange} count={state.all.length} />}
    {related && terms.filter(term => term !== waiting).map(term => <RelatedTerms key={term} term={term} state={state} />)}
    </>
  );
}

/**
 * Match: Any Term or All Terms. Each term is one term to every source, a
 * phrase where it has several words; Any keeps a paper with any one of them,
 * All only a paper with every one. With one term the two ask the same.
 */
export function MatchField({ id, value, onChange, count }: {
  id: string;
  value: Match;
  onChange: (match: Match) => void;
  count: number;
}) {
  const says = MATCHES.find((m) => m.match === value)?.says ?? '';
  return (
    <div className="match-field" data-terms="match">
      <span className="match-label" id={id}>Match</span>
      <div className="seg" role="group" aria-labelledby={id}>
        {MATCHES.map((m) => (
          <button key={m.match} type="button" aria-pressed={value === m.match} data-match={m.match} onClick={() => onChange(m.match)}>
            {m.label}
          </button>
        ))}
      </div>
      <span className="match-says" aria-live="polite">
        {count > 1 ? says : 'With one term, Any and All ask the same.'}
      </span>
    </div>
  );
}

/** Each term owns its read, so adding another cannot discard this one's offer. */
function RelatedTerms({ term, state }: { term: string; state: ReturnType<typeof useTerms> }) {
  const { id: collection, error: collectionError } = useCollection();
  const related = useQuery({
    enabled: collection !== null,
    queryKey: ['related-terms', collection, term], refetchOnWindowFocus: false,
    queryFn: () => answer(engine().GET('/api/collection/related-terms', {
      params: { query: { term, ...collectionParam(collection) } },
    })),
  });
  const chosen = new Set(state.terms.map(t => t.toLowerCase()));
  const offered = (related.isError ? [] : related.data?.suggestions ?? []).filter((t, i, all) => all.findIndex(other => other.toLowerCase() === t.toLowerCase()) === i)
    .filter(t => !chosen.has(t.toLowerCase())).slice(0, 6);
  // Only the read's outcome is live. Adding a suggestion changes the buttons,
  // without announcing the whole offer a second time.
  const said = collection === null && collectionError ? `The collection could not be read (${collectionError.message}).`
    : related.isError ? `Related terms could not be read (${related.error.message}).`
    : !related.data ? ''
      : related.data.matched_papers === 0 ? `No papers in this collection use “${term}” yet, so there’s nothing to suggest.`
        : `Related terms for “${term}” are drawn from ${related.data.matched_papers} ${related.data.matched_papers === 1 ? 'paper' : 'papers'} in this collection.`;
  return <div className="related-terms" role="group" aria-label={`Related to “${term}”`}>
    <p className="form-hint" role="status" aria-live="polite" aria-atomic="true">{said}</p>
    {related.isPending && !collectionError && <p className="form-hint">{collection === null ? 'Waiting for this window’s collection.' : `Looking in this collection for “${term}”.`}</p>}
    {offered.length > 0 && <div className="lib-actions">
      {offered.map(t => <button key={t} type="button" className="btn quiet sm" aria-label={`Add “${t}”`}
        onClick={() => state.setTerms(current => current.some(added => added.toLowerCase() === t.toLowerCase()) ? current : [...current, t])}>{t}</button>)}
    </div>}
    {related.isError && <button type="button" className="btn quiet sm" onClick={() => void related.refetch()}>Try Again</button>}
  </div>;
}
