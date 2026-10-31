import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { CLAUDE_ALIASES, LAST_ANSWERED_KEY, lastFor, modelOptionWords, readLastAnswered } from './modelWords';
import { refusal } from './ProviderKey';
import { CLI_PROVIDERS, laneName, type ModelCatalog } from './summaryLanes';

/** What `/api/ai/models` is asked: the provider, and where it is reached when that is not fixed. */
export interface ModelQuery {
  provider: string;
  base_url?: string;
  endpoint?: string;
  binary_path?: string;
  /** `ask`: the command Ask's connection runs, where no path is given. */
  purpose?: 'ask' | 'summaries';
}

/**
 * Asks a provider which models it offers, with the key stored for it (the
 * engine reads the keychain; the screen never holds the key), and asks a
 * command what it accepts. One per field, so two fields never share a list.
 */
export function useModelList() {
  return useMutation({
    mutationFn: async (query: ModelQuery) => (await answer(engine().POST('/api/ai/models', { body: query }))) as unknown as ModelCatalog,
  });
}

export type ModelList = ReturnType<typeof useModelList>;

/** The list a field holds for this provider, or null; an answer about another provider is not this one's. */
export function listFor(list: ModelList, provider: string): ModelCatalog | null {
  return list.data && list.variables?.provider === provider ? list.data : null;
}

/**
 * A model, typed or chosen from what the provider listed. The list is a
 * convenience: a model it leaves out can still be typed, and the provider is
 * what accepts or refuses it on the first paper.
 */
export function ModelField({ id, provider, value, onChange, list, query, label = 'Model' }: {
  id: string;
  provider: string;
  value: string;
  onChange: (model: string) => void;
  list: ModelList;
  query: ModelQuery;
  label?: string;
}) {
  const [typing, setTyping] = useState(false);
  const catalog = listFor(list, provider);
  const cli = CLI_PROVIDERS.has(provider);
  const choosing = !!catalog && catalog.models.length > 0 && !typing;
  const failed = list.error && list.variables?.provider === provider ? list.error : null;
  const name = laneName(provider);
  // A command's alias resolves to its newest model when it runs; what it was
  // when it last answered is known only from answers already kept.
  const last = useQuery({ queryKey: LAST_ANSWERED_KEY, queryFn: readLastAnswered, enabled: cli, refetchOnMount: 'always' });
  const words = (model: string) => modelOptionWords(provider, model, lastFor(last.data, provider, model));
  const typed = value.trim();
  // Said under a typed model only where it adds something: an alias, or a
  // model an answer has already resolved.
  const said = cli && (lastFor(last.data, provider, typed) || (provider === 'claude_code' && CLAUDE_ALIASES.includes(typed)))
    ? words(typed) : '';
  return (
    <div className="form-field ai-model" data-ai="model">
      <label className="form-label" htmlFor={id}>{label}</label>
      <span className="password-row">
        {choosing ? (
          <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">{cli ? words('') : 'Choose a model'}</option>
            {value && !catalog.models.includes(value) && <option value={value}>{value} (not in the list)</option>}
            {catalog.models.map((model) => <option key={model} value={model}>{cli ? words(model) : model}</option>)}
          </select>
        ) : (
          <input id={id} value={value} spellCheck={false} autoComplete="off"
            placeholder={cli ? 'Blank: the command’s default' : 'The provider’s model ID'}
            onChange={(e) => onChange(e.target.value)} />
        )}
        <button type="button" className="btn sm" data-ai="load-models" disabled={!provider || list.isPending}
          onClick={() => { setTyping(false); list.mutate(query); }}>
          {list.isPending ? 'Loading' : catalog ? 'Load again' : 'Load models'}
        </button>
      </span>
      {catalog && (
        <p className="form-hint" data-ai="model-list" data-count={catalog.models.length}>
          {catalog.models.length === 0
            ? `${name} listed no models. Type the model’s ID instead.`
            : catalog.provenance || `${catalog.models.length} ${catalog.models.length === 1 ? 'model' : 'models'} listed by ${name}.`}
          {choosing && (
            <>{' '}<button type="button" className="ai-link" onClick={() => setTyping(true)}>Type a model ID instead</button></>
          )}
        </p>
      )}
      {failed && <p className="field-error" role="alert" data-ai="model-list-error">{refusal(failed)}</p>}
      {cli && !choosing && said && (
        <p className="form-hint ai-model-hint" data-ai="model-words">{said}.</p>
      )}
    </div>
  );
}
