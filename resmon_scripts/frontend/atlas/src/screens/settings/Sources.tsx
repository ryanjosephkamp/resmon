import { useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { platform } from '../../bridge';
import type { CatalogEntry } from '../runs/model';
import { PlaceHelp } from '../watches/people/People';
import { keychainName } from './model';

/** A stored key is drawn as this, whatever its length: the mask says nothing about the key. */
const MASK = '*'.repeat(12);

const REQUIREMENT: Record<string, string> = {
  none: 'No key', optional: 'Key optional', recommended: 'Key recommended', required: 'Key required',
};

/** The finest date a query to the source can express, as the catalog records it. */
const DATES: Record<string, string> = {
  day: 'Exact dates — resmon can ask for any window',
  month: 'Whole months — a shorter window is widened to the months it touches',
  year: 'Whole years only',
};

function refusal(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

/**
 * Settings › Sources: every source resmon can ask, what each can and cannot
 * do, and the keys some of them want.
 *
 * Everything here is the catalog's own statement about somebody else's
 * service, read as fact by whoever looks: the date precision, the rate,
 * how terms combine, and a credit the license requires, which is drawn for
 * every source that requires one rather than behind its details. A key goes
 * to the keychain and to its source only; what comes back is whether one is
 * stored, drawn as a fixed mask.
 */
export function Sources() {
  const catalog = useQuery({ queryKey: ['catalog'], staleTime: Infinity, queryFn: () => answer(engine().GET('/api/repositories/catalog')) });
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => answer(engine().GET('/api/credentials')) });
  const entries = catalog.data ?? [];
  const credits = entries.filter((e) => e.attribution_requirement === 'required' && e.attribution);
  const where = keychainName(platform());
  return (
    <section className="settings-group sources" aria-labelledby="sources-title" aria-busy={catalog.isPending || credentials.isPending}>
      <h2 id="sources-title" className="group-title">Sources</h2>
      <p className="group-lede">
        Every source resmon can ask, with its limits as each states them, and the keys some of them want. Keys
        for AI providers are in <Link to="/settings/ai">Settings › AI</Link>.
      </p>
      <PlaceHelp summary="About sources and their keys">
        <p>
          Each source’s details say the finest date its query can express. Most take exact dates; a few take whole
          months or whole years. A source that takes only whole years refuses a shorter window rather than widening
          it, so a short window there comes back empty by construction, and the run’s search record says so.
        </p>
        <p>
          A key you store is kept in {where}, never in resmon’s database, and is sent only to its source. A stored
          key is shown as a fixed 12-character mask. A source that requires a key and has none is recorded as not
          asked in a sweep.
        </p>
      </PlaceHelp>
      <p className="field-lede" data-sources="terms">
        A key you store here is your own credential, sent only to that source, and its terms bind you rather than
        resmon. resmon checks a source’s terms before adopting it, and has withdrawn one that could not be used
        without putting the account holder in breach; it cannot accept a license for you. A stored key is shown as
        a fixed 12-character mask.
      </p>
      {credentials.data && credentials.data.keyring_responsive === false && (
        <p className="field-error" role="status">
          {where} is not answering, so stored keys cannot be read right now and show as unreadable rather than as
          missing. They are most likely still there; storing a key again replaces it for this build.
        </p>
      )}
      {catalog.isError && <p className="field-error" role="alert">The engine did not list the sources ({catalog.error.message}).</p>}
      {credits.length > 0 && (
        <section className="sources-credits" aria-labelledby="credits-title" data-sources="credits">
          <h3 id="credits-title" className="field-title">Credits these sources require</h3>
          <ul>{credits.map((e) => <li key={e.slug}><strong>{e.name}</strong>: {e.attribution}</li>)}</ul>
        </section>
      )}
      <ol className="sources-list">
        {entries.map((entry) => (
          <SourceRow key={entry.slug} entry={entry}
            state={entry.credential_name ? credentials.data?.credentials[entry.credential_name]?.status ?? null : null} />
        ))}
      </ol>
    </section>
  );
}

function SourceRow({ entry, state }: { entry: CatalogEntry; state: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="source-entry" data-source={entry.slug}>
      <div className="source-entry-head">
        <button type="button" className="source-entry-name" aria-expanded={open} onClick={() => setOpen(!open)}>
          {entry.name}
        </button>
        <span className="source-entry-req">{REQUIREMENT[entry.api_key_requirement] ?? entry.api_key_requirement}</span>
        {entry.credential_name && <KeyField name={entry.credential_name} source={entry.name} state={state} />}
      </div>
      {open && (
        <dl className="source-details">
          <dt>Description</dt><dd>{entry.description || 'Not stated'}</dd>
          <dt>Rate limit</dt><dd>{entry.rate_limit || 'Not stated'}</dd>
          {entry.upstream_policy && <><dt>Upstream policy</dt><dd>{entry.upstream_policy}</dd></>}
          <dt>Date filtering</dt><dd>{DATES[entry.date_granularity] ?? entry.date_granularity}</dd>
          {entry.keyword_combination && <><dt>How terms combine</dt><dd>{entry.keyword_combination}</dd></>}
          {entry.keyword_combination_notes && <><dt>About combining terms</dt><dd>{entry.keyword_combination_notes}</dd></>}
          <dt>Query method</dt><dd>{entry.query_method || 'Not stated'}</dd>
          <dt>Endpoint</dt><dd><code>{entry.endpoint || 'Not stated'}</code></dd>
          {entry.notes && <><dt>Notes</dt><dd>{entry.notes}</dd></>}
          {entry.website && <><dt>Website</dt><dd><a href={entry.website} target="_blank" rel="noreferrer noopener">{entry.website}</a></dd></>}
          {entry.registration_url && (
            <><dt>Get a key</dt><dd><a href={entry.registration_url} target="_blank" rel="noreferrer noopener">{entry.registration_url}</a></dd></>
          )}
          {entry.attribution && (
            <>
              <dt>{entry.attribution_requirement === 'required' ? 'Credit (required)' : 'Credit (requested)'}</dt>
              <dd>
                {entry.attribution}{' '}
                {entry.attribution_requirement === 'required'
                  ? 'A condition of the source’s license, shown above for every source that requires one.'
                  : 'The source asks for this credit; it is not a condition of reuse.'}
              </dd>
            </>
          )}
        </dl>
      )}
    </li>
  );
}

/**
 * A source's key. The field is never filled from the engine, which never
 * returns a key: a stored one is drawn as the mask, and Enter stores what
 * was typed.
 */
function KeyField({ name, source, state }: { name: string; source: string; state: string | null }) {
  const client = useQueryClient();
  const [value, setValue] = useState('');
  const done = () => client.invalidateQueries({ queryKey: ['credentials'] });
  const store = useMutation({
    mutationFn: () => answer(engine().PUT('/api/credentials/{key_name}', { params: { path: { key_name: name } }, body: { value } })),
    onSuccess: () => { setValue(''); return done(); },
  });
  const remove = useMutation({
    mutationFn: () => answer(engine().DELETE('/api/credentials/{key_name}', { params: { path: { key_name: name } } })),
    onSuccess: done,
  });
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && value.trim()) { event.preventDefault(); store.mutate(); }
  };
  return (
    <span className="source-key" data-state={state ?? 'unknown'}>
      <input
        type="password" value={value} autoComplete="new-password" spellCheck={false}
        aria-label={`API key for ${source}`}
        placeholder={state === 'present' ? MASK : state === 'unreadable' ? 'Unreadable; type to replace' : 'Enter a key'}
        onChange={(e) => setValue(e.target.value)} onKeyDown={onKey}
      />
      <button type="button" className="btn sm" disabled={!value.trim() || store.isPending} onClick={() => store.mutate()}>
        {state === 'present' ? 'Replace' : 'Store'}
      </button>
      {state === 'present' && (
        <button type="button" className="btn quiet sm" disabled={remove.isPending} onClick={() => remove.mutate()}
          aria-label={`Remove the key for ${source}`}>Remove</button>
      )}
      {(store.error || remove.error) && <span className="field-error" role="alert">{refusal((store.error ?? remove.error) as Error)}</span>}
    </span>
  );
}
