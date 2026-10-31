import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { MAP_KEY } from '../Today';
import { count } from '../today/format';
import {
  EMBEDDING_STATUS_KEY, embeddedWords, estimateWords, indexWords, missingCount, missingWords, nothingToEmbedWords,
  orderProviders, outcomeWords, progressWords, providerLabel, providerName, ranking, rebuiltWords,
  type EmbeddingPage, type EmbeddingStatus, type Estimate, type ProbeResult, type Rebuilt,
} from './embeddingWords';
import { ProviderKey, refusal } from './ProviderKey';
import { KEY_NAMES } from './summaryLanes';
import { commandEnter } from '../../shell/shortcuts';

export const EMBEDDING_PAGE_KEY = ['embedding-settings'] as const;

export const readEmbeddingPage = () => answer(engine().GET('/api/settings/embeddings'));
export const readEmbeddingStatus = () => answer(engine().GET('/api/embeddings/status'));

/** How often the status is read while a backfill runs, and only then. */
const WHILE_RUNNING = 1_000;

const ON = new Set(['1', 'true', 'yes']);

type LaneFields = {
  embedding_enabled: 'true' | 'false';
  embedding_provider: string;
  embedding_model: string;
  embedding_endpoint: string;
  embedding_base_url: string;
};

/** The stored lane as the form starts: Ollama is proposed where no provider is stored. */
function startingForm(page: EmbeddingPage): LaneFields {
  const s = page.settings;
  return {
    embedding_enabled: ON.has(String(s.embedding_enabled).trim().toLowerCase()) ? 'true' : 'false',
    embedding_provider: s.embedding_provider.trim().toLowerCase() || 'local',
    embedding_model: s.embedding_model,
    embedding_endpoint: s.embedding_endpoint,
    embedding_base_url: s.embedding_base_url,
  };
}

/**
 * Settings → AI → Embeddings: the model that turns each paper into a vector,
 * so Search can rank the collection by meaning.
 *
 * Three things here each stand against a small lie. **What is embedded is
 * counted**, and so is what is missing, with why where resmon knows it, and
 * whether the similarity index loaded at all. **A provider that cannot embed
 * is listed and refused** where it is chosen, with the reason, rather than
 * omitted or accepted. **The cost is shown before a backfill starts**: the
 * papers, the tokens, the money where resmon has a price, and the disk.
 */
export function Embeddings() {
  const page = useQuery({ queryKey: EMBEDDING_PAGE_KEY, queryFn: readEmbeddingPage });
  const status = useQuery({
    queryKey: EMBEDDING_STATUS_KEY, queryFn: readEmbeddingStatus,
    refetchInterval: (query) => (query.state.data?.run.running ? WHILE_RUNNING : false),
  });
  return (
    <section className="ai-part embeddings" id="embeddings" aria-labelledby="ai-embeddings"
      data-embeddings-lane={page.data ? (page.data.lane ? 'set' : 'none') : undefined}>
      <h3 id="ai-embeddings" className="field-title" tabIndex={-1}>Embeddings</h3>
      <p className="field-lede">
        An embedding model turns each paper’s title and abstract into a vector. That is what lets Search rank your
        collection by closeness in meaning, the map place papers by meaning, and a watch’s audit compare what it finds
        with what you meant. It is separate from summaries: either works without the other. Once a model is saved, each
        run embeds the papers it collects; the papers already in your collection are embedded only when you start that
        below.
      </p>
      {status.isError && <p className="field-error" role="alert">The engine did not say what is embedded ({status.error.message}).</p>}
      {status.data && <Facts status={status.data} />}
      {page.isError && <p className="field-error" role="alert">The engine did not answer ({page.error.message}).</p>}
      {page.data && <LaneForm page={page.data} />}
      {page.data?.lane && status.data && <Backfill status={status.data} />}
    </section>
  );
}

function Facts({ status }: { status: EmbeddingStatus }) {
  const rank = ranking(status);
  return (
    <dl className="facts emb-facts" data-embeddings="facts" data-ranking={rank.available ? 'available' : 'unavailable'}>
      <div data-embeddings="embedded"><dt>Embedded</dt><dd>{embeddedWords(status)}</dd></div>
      <div data-embeddings="missing" data-count={status.coverage.model ? missingCount(status) : status.coverage.total}>
        <dt>Missing</dt><dd>{missingWords(status)}</dd>
      </div>
      <div data-embeddings="index"><dt>Similarity index</dt><dd>{indexWords(status)}</dd></div>
      <div data-embeddings="ranking"><dt>In Search</dt><dd>{rank.sentence}</dd></div>
    </dl>
  );
}

function LaneForm({ page }: { page: EmbeddingPage }) {
  const client = useQueryClient();
  const stored = startingForm(page);
  const [form, setForm] = useState<LaneFields>(stored);
  // A probe answers for the form as it stood when it was asked, and is shown only while the form still says that.
  const [probed, setProbed] = useState<{ form: string; result: ProbeResult } | null>(null);
  const providers = orderProviders(page.providers);
  const chosen = page.providers.find((p) => p.provider === form.embedding_provider);
  const on = form.embedding_enabled === 'true';
  const refused = on && chosen?.state === 'no';
  const dirty = (Object.keys(form) as (keyof LaneFields)[]).some((k) => form[k] !== stored[k]);
  const snapshot = JSON.stringify(form);
  const probe = probed?.form === snapshot ? probed.result : null;
  const keyName = on && !refused && form.embedding_provider !== 'local' ? KEY_NAMES[form.embedding_provider] : undefined;

  const ask = useMutation({
    mutationFn: async (fields: LaneFields) => ({
      form: JSON.stringify(fields),
      result: (await answer(engine().POST('/api/embeddings/probe', { body: { settings: { ...fields } } }))) as ProbeResult,
    }),
    onSuccess: (answered) => {
      setProbed(answered);
      return client.invalidateQueries({ queryKey: EMBEDDING_PAGE_KEY });
    },
  });
  const save = useMutation({
    mutationFn: () => {
      const lane = (['embedding_provider', 'embedding_model', 'embedding_endpoint', 'embedding_base_url'] as const)
        .some((k) => form[k] !== stored[k]);
      // A new model's width is not the old one's: the width a probe of this
      // form found is kept, and an untried one is not carried over.
      const dims = probe?.ok && probe.dims ? { embedding_dims: String(probe.dims) } : lane ? { embedding_dims: '' } : {};
      return answer(engine().PUT('/api/settings/embeddings', { body: { settings: { ...form, ...dims } } }));
    },
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: EMBEDDING_PAGE_KEY }),
      client.invalidateQueries({ queryKey: EMBEDDING_STATUS_KEY }),
      client.invalidateQueries({ queryKey: MAP_KEY }),
    ]),
  });
  const set = (key: keyof LaneFields) => (value: string) => setForm({ ...form, [key]: value });
  const choose = (provider: string) => {
    const answerFor = page.providers.find((p) => p.provider === provider);
    setForm({ ...form, embedding_provider: provider, embedding_model: answerFor?.default_model ?? '' });
  };

  return (
    <form className="settings-form" {...commandEnter()} aria-label="Embedding settings"
      onSubmit={(event) => { event.preventDefault(); if (!refused) save.mutate(); }}>
      <button type="button" className="switch" role="switch" aria-checked={on} data-switch="embedding_enabled"
        onClick={() => setForm({ ...form, embedding_enabled: on ? 'false' : 'true' })}>
        <span className="switch-track"><span className="switch-knob" /></span>
        Embed papers so Search can rank them by meaning
      </button>
      {!on && (
        <p className="form-hint">
          Off: nothing is embedded, and nothing is sent anywhere for it. Vectors already made are kept, and are used again
          if this is turned back on with the same model.
        </p>
      )}
      {on && (
        <>
          <p className="form-hint emb-cannot" data-embeddings="cannot">
            An Anthropic key cannot do this, and neither can Claude Code or Codex: none of them offers an embedding model,
            so the plan or key your summaries use may not cover it. A model on this computer, through Ollama, costs
            nothing and needs no key.
          </p>
          <div className="form-grid">
            <div className="form-field">
              <label className="form-label" htmlFor="embedding-provider">Provider</label>
              <select id="embedding-provider" value={form.embedding_provider} onChange={(e) => choose(e.target.value)}>
                {providers.map((p) => <option key={p.provider} value={p.provider}>{providerLabel(p)}</option>)}
                {!chosen && <option value={form.embedding_provider}>{form.embedding_provider} (saved)</option>}
              </select>
            </div>
            {!refused && (
              <div className="form-field">
                <label className="form-label" htmlFor="embedding-model">Model</label>
                <input id="embedding-model" list="embedding-models" value={form.embedding_model} spellCheck={false}
                  autoComplete="off" placeholder={chosen?.default_model ?? 'The provider’s model name'}
                  onChange={(e) => set('embedding_model')(e.target.value)} />
                <datalist id="embedding-models">
                  {(chosen?.suggested_models ?? []).map((m) => <option key={m} value={m} />)}
                </datalist>
              </div>
            )}
            {!refused && form.embedding_provider === 'local' && (
              <div className="form-field form-wide">
                <label className="form-label" htmlFor="embedding-endpoint">Ollama endpoint</label>
                <input id="embedding-endpoint" value={form.embedding_endpoint} spellCheck={false} autoComplete="off"
                  placeholder="Blank: http://localhost:11434" onChange={(e) => set('embedding_endpoint')(e.target.value)} />
                <span className="form-hint">
                  A server that lists a model can still refuse to embed with it: a chat model is not an embedding model.
                  If the probe says so, run <code className="path">ollama pull nomic-embed-text</code> and choose that.
                </span>
              </div>
            )}
            {!refused && form.embedding_provider === 'custom' && (
              <div className="form-field form-wide">
                <label className="form-label" htmlFor="embedding-base-url">Base URL</label>
                <input id="embedding-base-url" type="url" value={form.embedding_base_url} spellCheck={false}
                  autoComplete="off" placeholder="https://…/v1" onChange={(e) => set('embedding_base_url')(e.target.value)} />
                <span className="form-hint">Called at that address’s /embeddings, in the OpenAI-compatible shape.</span>
              </div>
            )}
          </div>
          {refused && chosen && (
            <div className="emb-refusal">
              <p className="field-error" role="alert" data-embeddings="refusal">{chosen.reason}</p>
              {chosen.evidence && (
                <details className="emb-evidence">
                  <summary>What this rests on</summary>
                  <p className="form-hint">{chosen.evidence}</p>
                </details>
              )}
            </div>
          )}
          {!refused && chosen && chosen.state !== 'yes' && (
            <p className="form-hint" data-embeddings="provider-reason">{chosen.reason}</p>
          )}
          {!refused && (
            <p className="form-hint">
              The model names offered are suggestions, not a list of what your account has. A probe asks the model to embed
              one sentence, and says what answered.
            </p>
          )}
          {keyName && (
            <ProviderKey name={keyName} provider={form.embedding_provider} id="embedding-key"
              note="It is the same key summaries and Ask use for this provider." />
          )}
          {probe && (
            <p className={probe.ok ? 'settings-said' : 'field-error'} role={probe.ok ? 'status' : 'alert'}
              data-embeddings="probe" data-ok={probe.ok}>
              {probe.reason}
            </p>
          )}
        </>
      )}
      <div className="form-actions">
        {on && !refused && (
          <button type="button" className="btn" disabled={ask.isPending} onClick={() => ask.mutate(form)}>
            {ask.isPending ? 'Probing' : 'Probe this model'}
          </button>
        )}
        <button type="submit" className="btn primary" disabled={!dirty || refused || save.isPending}>
          {save.isPending ? 'Saving' : 'Save embedding settings'}
        </button>
        {save.isSuccess && !dirty && (
          <span className="settings-said" role="status" data-embeddings="saved">
            {on ? 'Saved.' : 'Saved. Nothing new is embedded; the vectors already made are kept.'}
          </span>
        )}
      </div>
      {refused && <p className="form-hint">{providerName(form.embedding_provider)} cannot be saved as the embedding provider.</p>}
      {ask.error && <p className="field-error" role="alert">The probe could not run ({refusal(ask.error)}).</p>}
      {save.error && <p className="field-error" role="alert">{refusal(save.error)}</p>}
    </form>
  );
}

/**
 * Embedding the papers already in the collection: the estimate, then the run,
 * its progress and a stop between batches, and rebuilding the index from the
 * stored vectors.
 */
function Backfill({ status }: { status: EmbeddingStatus }) {
  const client = useQueryClient();
  const run = status.run;
  const missing = missingCount(status);
  // An estimate holds for the coverage it was made against; once that moves, it is asked for again.
  const [estimated, setEstimated] = useState<{ at: number; estimate: Estimate } | null>(null);
  const estimate = estimated && estimated.at === status.coverage.embedded && !run.running ? estimated.estimate : null;
  const [rebuilt, setRebuilt] = useState<Rebuilt | null>(null);
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: EMBEDDING_STATUS_KEY }),
    client.invalidateQueries({ queryKey: EMBEDDING_PAGE_KEY }),
  ]);

  const estimating = useMutation({
    mutationFn: async () => (await answer(engine().GET('/api/embeddings/estimate'))) as Estimate,
    onSuccess: (result) => setEstimated({ at: status.coverage.embedded, estimate: result }),
  });
  const start = useMutation({
    mutationFn: async () => (await answer(engine().POST('/api/embeddings/backfill'))) as { run: EmbeddingStatus['run'] },
    onSuccess: (started) => {
      setRebuilt(null);
      client.setQueryData<EmbeddingStatus>(EMBEDDING_STATUS_KEY, (before) => (before ? { ...before, run: started.run } : before));
      return refresh();
    },
  });
  const stop = useMutation({
    mutationFn: () => answer(engine().POST('/api/embeddings/backfill/cancel')),
    onSuccess: refresh,
  });
  const rebuild = useMutation({
    mutationFn: async () => (await answer(engine().POST('/api/embeddings/rebuild'))) as Rebuilt,
    onSuccess: (result) => { setRebuilt(result); return refresh(); },
  });
  const outcome = outcomeWords(run);
  const leftOver = estimate ? nothingToEmbedWords(missing, estimate.documents) : null;

  return (
    <div className="emb-run" data-embeddings="backfill" data-running={run.running}>
      <h4 className="form-label">The papers already in your collection</h4>
      {outcome && <p className="settings-said" data-embeddings="outcome">{outcome}</p>}
      {run.running ? (
        <>
          <p className="emb-progress" role="status" data-embeddings="progress">{progressWords(run)}</p>
          {run.total > 0 && (
            <div className="emb-meter" aria-hidden="true">
              <span style={{ width: `${Math.min(100, (run.processed / run.total) * 100)}%` }} />
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="btn" disabled={stop.isPending} onClick={() => stop.mutate()}>
              {stop.isPending ? 'Stopping' : 'Stop after this batch'}
            </button>
          </div>
          <p className="form-hint">A batch already sent is finished and kept, so stopping can take a moment.</p>
        </>
      ) : (
        <>
          {missing === 0 && (
            <p className="form-hint">Every paper has a vector from {status.coverage.model}; there is nothing to embed.</p>
          )}
          {missing > 0 && !estimate && (
            <p className="form-hint">
              {count(missing, 'paper')} {missing === 1 ? 'has' : 'have'} no vector yet. Before anything is sent, resmon
              estimates the work: the papers, the tokens, the money where it has a price on record, and the disk.
            </p>
          )}
          {estimate && (
            <div className="emb-estimate" data-embeddings="estimate" data-documents={estimate.documents}>
              <p>{estimateWords(estimate)}</p>
              <p className="form-hint">{estimate.disk_note}</p>
              {leftOver && <p className="form-hint">{leftOver}</p>}
            </div>
          )}
          <div className="form-actions">
            {missing > 0 && !estimate && (
              <button type="button" className="btn primary" disabled={estimating.isPending} onClick={() => estimating.mutate()}>
                {estimating.isPending ? 'Estimating' : 'Estimate the work'}
              </button>
            )}
            {estimate && estimate.documents > 0 && (
              <button type="button" className="btn primary" disabled={start.isPending} onClick={() => start.mutate()}>
                {start.isPending ? 'Starting' : `Embed ${count(estimate.documents, 'paper')}`}
              </button>
            )}
            <button type="button" className="btn" disabled={rebuild.isPending} onClick={() => rebuild.mutate()}>
              {rebuild.isPending ? 'Rebuilding' : 'Rebuild the index'}
            </button>
          </div>
          {rebuilt && <p className="settings-said" role="status" data-embeddings="rebuilt">{rebuiltWords(rebuilt)}</p>}
          <p className="form-hint">
            Embedding resumes from whatever is missing, not from where it stopped, so nothing is embedded twice and a
            paper collected meanwhile is not skipped. The index is made from the stored vectors; rebuild it when the
            counts above disagree, as they do for a database copied from a computer that could not load the extension.
          </p>
        </>
      )}
      {estimating.error && <p className="field-error" role="alert">{refusal(estimating.error)}</p>}
      {start.error && <p className="field-error" role="alert">{refusal(start.error)}</p>}
      {stop.error && <p className="field-error" role="alert">{refusal(stop.error)}</p>}
      {rebuild.error && <p className="field-error" role="alert">{refusal(rebuild.error)}</p>}
    </div>
  );
}
