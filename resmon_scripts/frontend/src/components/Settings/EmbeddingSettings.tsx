import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client';

/**
 * Settings → AI → Embeddings: the model that makes semantic search possible.
 *
 * Three things this panel is careful about, each because the alternative would
 * be a small lie.
 *
 * **Providers that cannot embed are listed, not hidden.** Anthropic has no
 * embeddings API and neither agent CLI has an embedding command; omitting them
 * would leave a user who pays for Claude wondering where it went. They appear,
 * disabled, with the reason. A gap explains nothing; a stated limitation does.
 *
 * **Local first.** An embedding model on your own machine costs nothing, sends
 * nothing anywhere, and is good enough that paying for this is a choice rather
 * than a requirement. BYOK sits beside it with a cost estimate *before* any
 * backfill starts, computed from the documents that will actually be sent.
 *
 * **The probe is the authority, not the table.** `PROVIDER_EMBEDDING` says what
 * a vendor serves; only a probe says whether this endpoint, this key and this
 * model answer. For a local server the difference is the whole feature — Ollama
 * lists its models happily and then refuses to embed with a chat model loaded,
 * and that refusal has to read as "that is not an embedding model" rather than
 * as an empty corpus.
 */

interface ProviderAnswer {
  provider: string;
  state: 'yes' | 'no' | 'unknown';
  reason: string;
  evidence: string;
  offered: boolean;
  default_model: string | null;
  suggested_models: string[];
}

interface Capability {
  available: boolean;
  extension: string | null;
  reason: string | null;
  model: string | null;
  indexed: number;
}

interface RunState {
  running: boolean;
  model: string | null;
  processed: number;
  total: number;
  skipped_no_text: number;
  cancelled: boolean;
  reason: string | null;
}

interface StatusPayload {
  run: RunState;
  coverage: { embedded: number; total: number; model: string | null };
  extension: { extension: string | null; reason: string | null };
  index: { model: string | null; dims: number | null; rows: number };
  capability?: Capability;
}

interface SettingsPayload {
  settings: Record<string, string>;
  providers: ProviderAnswer[];
  lane: { model: string; kind: string } | null;
  capability: Capability;
  status: StatusPayload;
}

interface ProbeResult {
  ok: boolean;
  dims: number | null;
  model: string | null;
  reason: string;
}

interface Estimate {
  documents: number;
  estimated_tokens: number;
  cost_usd: number | null;
  /** Null until the lane has been probed and reported its width. */
  disk_bytes: number | null;
  disk_note: string;
  note: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  meta: 'Meta (Together)',
  deepseek: 'DeepSeek',
  alibaba: 'Alibaba',
  anthropic: 'Anthropic',
  custom: 'Custom endpoint',
  local: 'Ollama (on this machine)',
  claude_code: 'Claude Code CLI',
  codex: 'Codex CLI',
};

const nf = new Intl.NumberFormat();

/** Poll while a backfill is running; a corpus of 15,000 takes minutes. */
const POLL_MS = 1500;

const EmbeddingSettings: React.FC = () => {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadAll = useCallback(async () => {
    try {
      const data = await apiClient.get<SettingsPayload>('/api/settings/embeddings');
      setPayload(data);
      setForm({
        embedding_enabled: data.settings.embedding_enabled || 'false',
        embedding_provider: data.settings.embedding_provider || 'local',
        embedding_model: data.settings.embedding_model || '',
        embedding_endpoint: data.settings.embedding_endpoint || '',
        embedding_base_url: data.settings.embedding_base_url || '',
      });
      setStatus(data.status);
    } catch (err: any) {
      setError(err?.message || 'Could not read the embedding settings.');
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  // Only while something is actually running. A settings tab that polled
  // forever would keep a backend connection warm for nothing.
  useEffect(() => {
    if (!status?.run.running) return undefined;
    const timer = window.setInterval(async () => {
      try {
        setStatus(await apiClient.get<StatusPayload>('/api/embeddings/status'));
      } catch { /* a poll that fails is retried by the next tick */ }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [status?.run.running]);

  const providers = payload?.providers || [];
  const selected = providers.find((p) => p.provider === form.embedding_provider);
  const enabled = form.embedding_enabled === 'true';

  const save = async () => {
    setBusy('save'); setError(''); setMessage('');
    try {
      await apiClient.put('/api/settings/embeddings', { settings: form });
      setMessage('Saved.');
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'Could not save.');
    } finally { setBusy(''); }
  };

  const runProbe = async () => {
    setBusy('probe'); setError(''); setMessage(''); setProbe(null);
    try {
      setProbe(await apiClient.post<ProbeResult>('/api/embeddings/probe', { settings: form }));
    } catch (err: any) {
      setError(err?.message || 'The probe could not run.');
    } finally { setBusy(''); }
  };

  const loadEstimate = async () => {
    setBusy('estimate'); setError(''); setEstimate(null);
    try {
      setEstimate(await apiClient.get<Estimate>('/api/embeddings/estimate'));
    } catch (err: any) {
      setError(err?.message || 'Could not estimate.');
    } finally { setBusy(''); }
  };

  const startBackfill = async () => {
    setBusy('backfill'); setError(''); setMessage('');
    try {
      await apiClient.post('/api/embeddings/backfill', {});
      setStatus(await apiClient.get<StatusPayload>('/api/embeddings/status'));
    } catch (err: any) {
      setError(err?.message || 'Could not start the backfill.');
    } finally { setBusy(''); }
  };

  const cancelBackfill = async () => {
    try {
      await apiClient.post('/api/embeddings/backfill/cancel', {});
      setStatus(await apiClient.get<StatusPayload>('/api/embeddings/status'));
    } catch (err: any) {
      setError(err?.message || 'Could not cancel.');
    }
  };

  const coverage = status?.coverage;
  const run = status?.run;

  return (
    <div className="card" data-testid="embedding-settings">
      <h2>Embeddings</h2>
      <p className="form-hint">
        An embedding model turns each paper&rsquo;s title and abstract into a vector, which
        is what lets the Explorer sort by <em>closest to what you meant</em> rather than by
        date, and what powers <strong>Papers like this one</strong>. It is separate from AI
        summaries: you can have either without the other.
      </p>

      {/*
        Stated plainly and near the top, because it is the first thing a user
        with a Claude subscription will wonder. These are the two facts that
        surprise people, and burying them would waste their time.
      */}
      <p className="form-hint" data-testid="embedding-cannot-note">
        <strong>An Anthropic key cannot do this</strong> — Anthropic does not offer an
        embeddings API — and <strong>neither agent CLI can either</strong>: the Claude Code
        and Codex commands have no embedding command, so the subscription that covers your
        summaries does not cover semantic search. A local model is free and needs no key.
      </p>

      <label className="form-checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setForm({ ...form, embedding_enabled: e.target.checked ? 'true' : 'false' })}
        />
        <span>Embed papers so they can be searched by meaning</span>
      </label>

      {enabled && (
        <>
          <div className="form-group">
            <label className="form-label">Provider</label>
            <select
              className="form-input"
              aria-label="Embedding provider"
              value={form.embedding_provider}
              onChange={(e) => {
                const next = providers.find((p) => p.provider === e.target.value);
                setForm({
                  ...form,
                  embedding_provider: e.target.value,
                  embedding_model: next?.default_model || '',
                });
                setProbe(null);
              }}
            >
              {providers.map((p) => (
                <option key={p.provider} value={p.provider} disabled={!p.offered}>
                  {PROVIDER_LABEL[p.provider] || p.provider}
                  {p.state === 'no' ? ' — cannot embed' : ''}
                  {p.state === 'unknown' ? ' — unverified' : ''}
                </option>
              ))}
            </select>
            {/*
              The reason for every state, not only the refusals. "unverified"
              needs an explanation as much as "cannot": a user should know that
              resmon is declining to guess rather than that it has checked.
            */}
            {selected && selected.state !== 'yes' && (
              <p className="form-hint" data-testid="provider-reason">{selected.reason}</p>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">Model</label>
            <input
              className="form-input"
              list="embedding-model-suggestions"
              value={form.embedding_model}
              placeholder={selected?.default_model || 'model name'}
              onChange={(e) => setForm({ ...form, embedding_model: e.target.value })}
            />
            <datalist id="embedding-model-suggestions">
              {(selected?.suggested_models || []).map((m) => <option key={m} value={m} />)}
            </datalist>
            <p className="form-hint">
              These are suggestions, not a list of what your provider has. resmon does not
              claim to know your account&rsquo;s catalogue — probe below to find out what
              actually answers.
            </p>
          </div>

          {form.embedding_provider === 'local' && (
            <div className="form-group">
              <label className="form-label">Ollama endpoint</label>
              <input
                className="form-input"
                value={form.embedding_endpoint}
                placeholder="http://localhost:11434"
                onChange={(e) => setForm({ ...form, embedding_endpoint: e.target.value })}
              />
              <p className="form-hint">
                A server that lists models can still refuse to embed: an ordinary chat model
                is not an embedding model. If the probe says so, run{' '}
                <code>ollama pull nomic-embed-text</code> and select that.
              </p>
            </div>
          )}

          {form.embedding_provider === 'custom' && (
            <div className="form-group">
              <label className="form-label">Base URL</label>
              <input
                className="form-input"
                value={form.embedding_base_url}
                placeholder="https://your-endpoint/v1"
                onChange={(e) => setForm({ ...form, embedding_base_url: e.target.value })}
              />
              <p className="form-hint">
                Called at <code>{'{base URL}'}/embeddings</code> in the OpenAI-compatible
                shape, with the key stored under <em>custom</em> in Settings &rarr; AI.
              </p>
            </div>
          )}

          <div className="form-actions">
            <button className="btn btn-secondary" onClick={() => void runProbe()}
                    disabled={Boolean(busy)} data-testid="probe-button">
              {busy === 'probe' ? 'Probing…' : 'Probe this model'}
            </button>
            <button className="btn btn-primary" onClick={() => void save()}
                    disabled={Boolean(busy)}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </div>

          {probe && (
            <p className={probe.ok ? 'form-success' : 'form-error'} data-testid="probe-result">
              {probe.reason}
            </p>
          )}
        </>
      )}

      {message && <p className="form-success">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      {/* ------------------------------------------------------------------ */}

      <h3>Coverage</h3>
      {coverage && (
        <p data-testid="embedding-coverage">
          {coverage.model
            ? <>{nf.format(coverage.embedded)} of {nf.format(coverage.total)} papers embedded
                with <strong>{coverage.model}</strong>.</>
            : <>Nothing is embedded yet.</>}
        </p>
      )}

      {/*
        The extension state is reported separately from the coverage, because
        they fail independently and the remedies differ: vectors with no
        extension means "this build cannot rank"; an extension with no vectors
        means "run the backfill".
      */}
      {status?.extension && (
        <p className="form-hint" data-testid="embedding-extension">
          {status.extension.extension
            ? <>Vector extension <strong>{status.extension.extension}</strong> is loaded
                {status.index?.rows ? <> and holds {nf.format(status.index.rows)} vectors.</> : '.'}</>
            : <>This build cannot rank by meaning: {status.extension.reason} Papers are still
                embedded and stored, and become rankable if this is resolved.</>}
        </p>
      )}

      {run?.running ? (
        <>
          <p data-testid="backfill-progress">
            Embedding… {nf.format(run.processed)} of {nf.format(run.total)}
            {run.model && <> with {run.model}</>}.
          </p>
          <button className="btn btn-secondary" onClick={() => void cancelBackfill()}>
            Stop after this batch
          </button>
        </>
      ) : (
        <div className="form-actions">
          <button className="btn btn-secondary" onClick={() => void loadEstimate()}
                  disabled={Boolean(busy) || !payload?.lane}>
            {busy === 'estimate' ? 'Estimating…' : 'Estimate first'}
          </button>
          <button className="btn" onClick={() => void startBackfill()}
                  disabled={Boolean(busy) || !payload?.lane} data-testid="backfill-button">
            {busy === 'backfill' ? 'Starting…' : 'Embed everything not yet done'}
          </button>
        </div>
      )}

      {estimate && (
        <>
          <p className="form-hint" data-testid="embedding-estimate">
            {nf.format(estimate.documents)} papers, about{' '}
            {nf.format(estimate.estimated_tokens)} tokens
            {estimate.cost_usd !== null
              ? <> — roughly <strong>${estimate.cost_usd.toFixed(2)}</strong>.</>
              : <> — resmon cannot price this.</>}
            {' '}{estimate.note}
          </p>
          {/*
            Beside the money, not below it. A local model is free to call and
            still fills the disk: the real corpus grew 140 MB for 15,707 papers,
            which extrapolates to most of a gigabyte at 100,000. A user deserves
            that number before they press the button rather than after.
          */}
          <p className="form-hint" data-testid="embedding-disk-estimate">
            {estimate.disk_bytes !== null && (
              <>
                <strong>
                  ~{(estimate.disk_bytes / 1_048_576).toFixed(0)} MiB
                </strong>{' '}
                of database growth.{' '}
              </>
            )}
            {estimate.disk_note}
          </p>
        </>
      )}

      {/* A finished run reports what happened, including why it stopped. */}
      {run && !run.running && (run.reason || run.skipped_no_text > 0) && (
        <p className="form-hint" data-testid="backfill-outcome">
          {run.reason}
          {run.skipped_no_text > 0 && (
            <> {nf.format(run.skipped_no_text)} paper(s) had no title or abstract to embed
              and were skipped.</>
          )}
        </p>
      )}

      <p className="form-hint">
        The backfill can be stopped and restarted at any time. It always resumes from what
        is missing rather than from where it left off, so nothing is embedded twice and
        nothing is skipped — including papers added while it was not running.
      </p>
    </div>
  );
};

export default EmbeddingSettings;
