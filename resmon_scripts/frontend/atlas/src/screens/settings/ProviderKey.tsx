import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine, EngineError } from '../../api/client';
import { platform } from '../../bridge';
import { STATUS_KEY } from '../ask/AskProvider';
import { providerWords } from '../ask/askModel';
import { keychainName } from './model';

/** The engine's own sentence for a refusal, or the route and status where it gave none. */
export function refusal(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

/** What `/api/credentials/validate` answers (it declares no model). */
interface KeyTest {
  valid: boolean;
  outcome: 'accepted' | 'refused' | 'unanswered' | 'unreachable' | 'untestable';
  http_status: number | null;
  detail: string;
}

/**
 * A provider's key: stored by its own button, never shown, and only its
 * presence read back. One key per provider, whichever part of Settings → AI
 * stores it: summaries, Ask and embeddings read the same slot.
 *
 * With `test`, a stored key can be tried against the provider: the engine
 * reads it from the keychain and sends it to the provider's model list, and
 * the answer says whether the provider accepted it, refused it, or could not
 * be asked, which are three different things.
 */
export function ProviderKey({ name, provider, id = 'ai-key', note, test }: {
  name: string;
  provider: string;
  /** The field's id, unique on the page. */
  id?: string;
  /** A sentence after the stored state, where the part using the key has one to add. */
  note?: ReactNode;
  /** Offer to test the stored key; a custom endpoint is tested at this base URL. */
  test?: { baseUrl?: string };
}) {
  const client = useQueryClient();
  const [value, setValue] = useState('');
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => answer(engine().GET('/api/credentials')) });
  const state = credentials.data?.credentials[name]?.status ?? null;
  const done = () => Promise.all([
    client.invalidateQueries({ queryKey: ['credentials'] }),
    client.invalidateQueries({ queryKey: STATUS_KEY }),
  ]);
  // An answer about another provider, or about a key since replaced or removed, is not this key's.
  const tried = useMutation({
    mutationFn: async (at: { provider: string; baseUrl?: string }) => (await answer(engine().POST('/api/credentials/validate', {
      body: { provider: at.provider, ...(at.baseUrl ? { base_url: at.baseUrl } : {}) },
    }))) as unknown as KeyTest,
  });
  const store = useMutation({
    mutationFn: () => answer(engine().PUT('/api/credentials/{key_name}', { params: { path: { key_name: name } }, body: { value } })),
    onSuccess: () => { setValue(''); tried.reset(); return done(); },
  });
  const remove = useMutation({
    mutationFn: () => answer(engine().DELETE('/api/credentials/{key_name}', { params: { path: { key_name: name } } })),
    onSuccess: () => { tried.reset(); return done(); },
  });
  const result = tried.variables?.provider === provider ? tried : null;
  const where = keychainName(platform());
  return (
    <div className="password" data-ai="key" data-state={state ?? 'unknown'}>
      <label className="form-field" htmlFor={id}>
        <span className="form-label">{providerWords(provider)} key</span>
        <span className="password-row">
          <input id={id} type="password" value={value} autoComplete="new-password"
            placeholder={state === 'present' ? 'Stored; type a new one to replace it' : ''}
            onChange={(e) => setValue(e.target.value)} />
          <button type="button" className="btn" disabled={!value || store.isPending} onClick={() => store.mutate()}>
            {state === 'present' ? 'Replace' : 'Store'}
          </button>
          {state === 'present' && test && (
            <button type="button" className="btn" data-ai="test-key" disabled={tried.isPending}
              onClick={() => tried.mutate({ provider, baseUrl: test.baseUrl?.trim() || undefined })}>
              {tried.isPending ? 'Testing' : 'Test the stored key'}
            </button>
          )}
          {state === 'present' && (
            <button type="button" className="btn quiet" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</button>
          )}
        </span>
      </label>
      <p className="form-hint">
        {state === 'present' && `A key is stored in ${where}. resmon reads it to send a request, and never shows it. Whether the provider accepts it shows on first use${test ? ', or when you test it' : ''}.`}
        {state === 'absent' && `No key is stored. One you store goes to ${where}, not to resmon’s database.`}
        {state === 'unreadable' && `A key may be stored in ${where}, but this copy of resmon is not allowed to read it. Store it again to replace it.`}
        {state === null && (credentials.isError ? 'The engine did not say whether a key is stored.' : 'Asking whether a key is stored.')}
        {note && <> {note}</>}
      </p>
      {result?.data && (
        <p className="ai-lane" role="status" data-ai="key-test" data-outcome={result.data.outcome} data-found={result.data.valid}>
          {result.data.detail}
          {result.data.outcome === 'accepted' && ' It answered a request for its list of models; whether it lets this key use a given model shows on the first paper.'}
        </p>
      )}
      {result?.error && <p className="field-error" role="alert" data-ai="key-test">{refusal(result.error)}</p>}
      {(store.error || remove.error) && <p className="field-error" role="alert">{refusal((store.error ?? remove.error) as Error)}</p>}
    </div>
  );
}
