import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import type { CatalogEntry } from '../runs/model';
import { authorWords, rateShort, ratePerSecond } from './catalog';

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
 */
export function SourceCatalog({ legend, count, sources, chosen, multiple, keyMissing, pending, failed, onChoose, name }: {
  legend: string;
  count: ReactNode;
  sources: readonly CatalogEntry[];
  chosen: readonly string[];
  multiple: boolean;
  keyMissing: (entry: CatalogEntry) => boolean;
  pending: boolean;
  failed: boolean;
  onChoose: (slug: string) => void;
  /** The inputs' shared name, unique to the form. */
  name: string;
}) {
  return (
    <fieldset className="catalog">
      <legend>
        {legend}
        <span>{count}</span>
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
                type={multiple ? 'checkbox' : 'radio'}
                name={name}
                checked={on}
                onChange={() => onChoose(entry.slug)}
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
export function useTerms(initial: readonly string[]) {
  const [terms, setTerms] = useState<string[]>([...initial]);
  const [draft, setDraft] = useState('');
  const add = () => {
    const term = draft.trim();
    if (term && !terms.includes(term)) setTerms([...terms, term]);
    setDraft('');
  };
  const typed = draft.trim();
  const all = typed && !terms.includes(typed) ? [...terms, typed] : terms;
  return { terms, setTerms, draft, setDraft, add, all };
}

export function TermsField({ id, label, state, className }: {
  id: string;
  label: string;
  state: ReturnType<typeof useTerms>;
  className?: string;
}) {
  const { terms, setTerms, draft, setDraft, add } = state;
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
        onBlur={add}
        placeholder={terms.length ? 'Another term' : 'Terms to look for; Enter adds each one'}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}
