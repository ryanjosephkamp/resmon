import { useState, type FormEvent, type KeyboardEvent } from 'react';
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
      <PlaceHelp summary="About Sources and Their Keys">
        <p>
          Each source’s details say the finest date its query can express. Most take exact dates; a few take whole
          months or whole years. A source that takes only whole years cannot be asked for a shorter window, and resmon
          does not widen it to fit: the source is not asked, and the window is recorded as one it could not answer,
          never as an answer with nothing in it. The run and its search record say so.
        </p>
        <p>
          Each source’s details give two rates, and they are different things. resmon’s pace is the rate resmon sets
          for its own requests to that source. The source’s published policy is what the source says about its own
          limits.
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
      <ContactAddress />
      {catalog.isError && <p className="field-error" role="alert">The engine did not list the sources ({catalog.error.message}).</p>}
      {credits.length > 0 && (
        <section className="sources-credits" aria-labelledby="credits-title" data-sources="credits">
          <h3 id="credits-title" className="field-title">Credits These Sources Require</h3>
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
        <span className="source-entry-req">
          {REQUIREMENT[entry.api_key_requirement] ?? entry.api_key_requirement}
          {entry.service_notice && <span className="source-notice" title={entry.service_notice}> · end announced</span>}
        </span>
        {entry.credential_name && <KeyField name={entry.credential_name} source={entry.name} state={state} />}
      </div>
      {open && (
        <dl className="source-details">
          <dt>Description</dt><dd>{entry.description || 'Not stated'}</dd>
          <dt>resmon’s pace</dt><dd>{entry.rate_limit || 'Not stated'}</dd>
          {entry.upstream_policy && <><dt>The source’s published policy</dt><dd>{entry.upstream_policy}</dd></>}
          <dt>Date filtering</dt><dd>{DATES[entry.date_granularity] ?? entry.date_granularity}</dd>
          {entry.keyword_combination && <><dt>How terms combine</dt><dd>{entry.keyword_combination}</dd></>}
          {entry.keyword_combination_notes && <><dt>About combining terms</dt><dd>{entry.keyword_combination_notes}</dd></>}
          <dt>Query method</dt><dd>{entry.query_method || 'Not stated'}</dd>
          <dt>Endpoint</dt><dd><code>{entry.endpoint || 'Not stated'}</code></dd>
          {entry.service_notice && <><dt>Notice</dt><dd data-sources="service-notice">{entry.service_notice}</dd></>}
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
          aria-label={`Remove the Key for ${source}`}>Remove</button>
      )}
      {(store.error || remove.error) && <span className="field-error" role="alert">{refusal((store.error ?? remove.error) as Error)}</span>}
    </span>
  );
}

const CONTACT_KEY = ['source-settings'] as const;

/**
 * The contact address resmon gives Crossref and OpenAlex. Nothing is sent
 * until one is entered here, and it goes to those two sources and no other
 * (`source_contact.py`); Remove takes it back.
 */
function ContactAddress() {
  const client = useQueryClient();
  const stored = useQuery({ queryKey: CONTACT_KEY, queryFn: () => answer(engine().GET('/api/settings/sources')) });
  /** What is typed; null while the field shows what is stored. */
  const [typed, setTyped] = useState<string | null>(null);
  const saved = stored.data?.contact_email ?? null;
  const value = typed ?? saved ?? '';
  const save = useMutation({
    mutationFn: (contact: string | null) => answer(engine().PUT('/api/settings/sources', { body: { contact_email: contact } })),
    onSuccess: (answered) => {
      client.setQueryData(CONTACT_KEY, answered);
      setTyped(null);
    },
  });
  const dirty = typed !== null && typed.trim() !== (saved ?? '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (dirty) save.mutate(typed.trim() || null);
  };
  return (
    <section className="sources-contact" aria-labelledby="contact-title" data-sources="contact" aria-busy={stored.isPending}>
      <h3 id="contact-title" className="field-title">A Contact Address for Crossref and OpenAlex</h3>
      <p className="field-lede">
        Crossref and OpenAlex let a program name a contact address with its requests. Crossref answers requests that
        carry one from its polite pool, and either can write to you about a problem rather than block it. resmon sends
        an address only if you enter one here, and only to those two sources; with none, nothing is sent.
      </p>
      {stored.isError && <p className="field-error" role="alert">The engine did not say what is set ({stored.error.message}).</p>}
      <form className="contact-form" onSubmit={submit} aria-label="A Contact Address for Crossref and OpenAlex">
        <label className="sr-only" htmlFor="contact-email">Your email address</label>
        <input
          id="contact-email" type="email" value={value} autoComplete="email" spellCheck={false}
          placeholder="you@example.org" disabled={!stored.data}
          onChange={(event) => setTyped(event.target.value)}
        />
        <button type="submit" className="btn sm" disabled={!dirty || save.isPending}>Save</button>
        {saved && (
          <button type="button" className="btn quiet sm" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Remove
          </button>
        )}
      </form>
      {save.isSuccess && !dirty && (
        <p className="settings-said" role="status" data-sources="contact-said">
          {save.data.contact_email ? `Saved. Crossref and OpenAlex are sent ${save.data.contact_email}.` : 'Removed. No address is sent.'}
        </p>
      )}
      {save.error && <p className="field-error" role="alert">{refusal(save.error)}</p>}
    </section>
  );
}

