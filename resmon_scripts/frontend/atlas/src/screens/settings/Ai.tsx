import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { STATUS_KEY } from '../ask/AskProvider';
import { ask } from '../ask/askApi';
import { providerWords } from '../ask/askModel';
import { EMBEDDING_STATUS_KEY } from './embeddingWords';
import { EMBEDDING_PAGE_KEY, Embeddings, readEmbeddingPage, readEmbeddingStatus } from './Embeddings';
import { ProviderKey, refusal } from './ProviderKey';
import {
  CLI_PROVIDERS, KEY_NAMES, laneWords, planLimits, routeSentence, storedSummary, summaryChanged, summaryPayload,
  type AiSettings, type ChainEntry, type SummaryForm as SummaryFields,
} from './summaryLanes';

const AI_KEY = ['ai-settings'] as const;
const ASSISTANT_KEY = ['assistant-settings'] as const;
const CLI_KEY = ['ai-cli-status'] as const;

const readAi = () => answer(engine().GET('/api/settings/ai'));
const readAssistant = () => answer(engine().GET('/api/settings/assistant'));
type AssistantSettings = Awaited<ReturnType<typeof readAssistant>>;
type Status = Awaited<ReturnType<typeof ask.status>>;

/** The providers a summary can come from, in classic's order: the plans you already pay for first. */
const PROVIDERS: readonly { value: string; label: string }[] = [
  { value: 'claude_code', label: 'Claude Code, on your Claude plan' },
  { value: 'codex', label: 'Codex, on your ChatGPT plan' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'xai', label: 'xAI' },
  { value: 'meta', label: 'Meta' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'alibaba', label: 'Alibaba' },
  { value: 'local', label: 'Local (Ollama)' },
  { value: 'custom', label: 'A custom endpoint' },
];
/**
 * Settings → AI: the three things in resmon that use a model.
 *
 * **Summaries** are written for the papers a run finds, when a run asks for
 * them. **Ask** is the assistant. **Embeddings** turn papers into vectors, so
 * the collection can be ranked by meaning. Each says what resmon has checked
 * about its connection: finding a command is not knowing that anyone is
 * signed into it, and a stored key is not one a provider has accepted.
 *
 * `?focus=embeddings` opens the group at Embeddings, where Search › Your
 * collection sends a person whose papers have no vectors, and where a watch's
 * audit tells them to go.
 */
export function Ai() {
  // The same reads the parts make, asked here only to say when the group has arrived.
  const busy = [
    useQuery({ queryKey: AI_KEY, queryFn: readAi }),
    useQuery({ queryKey: ASSISTANT_KEY, queryFn: readAssistant }),
    useQuery({ queryKey: STATUS_KEY, queryFn: ask.status }),
    useQuery({ queryKey: EMBEDDING_PAGE_KEY, queryFn: readEmbeddingPage }),
    useQuery({ queryKey: EMBEDDING_STATUS_KEY, queryFn: readEmbeddingStatus }),
  ].some((q) => q.isPending);
  const [params, setParams] = useSearchParams();

  // Once every part has drawn, so that the parts above Embeddings no longer move it.
  useEffect(() => {
    if (busy || params.get('focus') !== 'embeddings') return;
    document.getElementById('embeddings')?.scrollIntoView({ block: 'start' });
    document.getElementById('ai-embeddings')?.focus({ preventScroll: true });
    setParams({}, { replace: true });
  }, [busy, params, setParams]);

  return (
    <section className="settings-group ai" aria-labelledby="ai-title" aria-busy={busy}>
      <h2 id="ai-title" className="group-title">AI</h2>
      <p className="group-lede">
        Three things in resmon use a model: a summary of each paper a run finds, when you ask for one; Ask; and
        embeddings, which let Search rank your collection by meaning. None of them runs until you set it up.
      </p>
      <Summaries />
      <Assistant />
      <Embeddings />
    </section>
  );
}

function Summaries() {
  const settings = useQuery({ queryKey: AI_KEY, queryFn: readAi });
  return (
    <section className="ai-part" aria-labelledby="ai-summaries">
      <h3 id="ai-summaries" className="field-title">Summaries</h3>
      <p className="field-lede">
        Used when a search or a watch is set to summarize each paper. The papers are found and kept either way;
        a summary that cannot be written is left out, and the run’s log says why.
      </p>
      {settings.isError && <p className="field-error" role="alert">The engine did not answer ({settings.error.message}).</p>}
      {settings.data && <SummaryForm stored={settings.data} />}
    </section>
  );
}


/**
 * The connection a run summarizes with, and the fallbacks after it. Where a
 * chain is stored, its first lane is what a run uses, so the form starts from
 * that lane, and Save writes the change into the chain with the fallbacks
 * kept, unless one is removed here.
 */
function SummaryForm({ stored }: { stored: AiSettings }) {
  const client = useQueryClient();
  const start = storedSummary(stored);
  const [form, setForm] = useState<SummaryFields>(start.form);
  const [fallbacks, setFallbacks] = useState<ChainEntry[]>(start.fallbacks);
  const dirty = summaryChanged(stored, form, fallbacks);
  const cli = CLI_PROVIDERS.has(form.ai_provider);
  const keyName = KEY_NAMES[form.ai_provider];
  const limits = planLimits(stored);
  const efforts = useQuery({ queryKey: STATUS_KEY, queryFn: ask.status }).data?.composer_choices.claude_efforts ?? [];
  const save = useMutation({
    mutationFn: () => answer(engine().PUT('/api/settings/ai', { body: { settings: summaryPayload(stored, form, fallbacks) } })),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: AI_KEY }),
      client.invalidateQueries({ queryKey: CLI_KEY }),
      client.invalidateQueries({ queryKey: STATUS_KEY }),
    ]),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };
  const set = (key: keyof SummaryFields) => (value: string) => setForm({ ...form, [key]: value });
  const removed = start.fallbacks.length - fallbacks.length;

  return (
    <form className="settings-form" onSubmit={submit} aria-label="Summary settings">
      <div className="form-grid">
        <label className="form-field" htmlFor="ai-provider">
          <span className="form-label">Provider</span>
          <select id="ai-provider" value={form.ai_provider} onChange={(e) => set('ai_provider')(e.target.value)}>
            <option value="">None chosen</option>
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            {form.ai_provider && !PROVIDERS.some((p) => p.value === form.ai_provider) && (
              <option value={form.ai_provider}>{form.ai_provider} (saved)</option>
            )}
          </select>
        </label>
        <label className="form-field" htmlFor="ai-model">
          <span className="form-label">Model</span>
          <input id="ai-model" value={form.ai_model} spellCheck={false} autoComplete="off"
            placeholder={cli ? 'Blank: the command’s default' : 'The provider’s model ID'}
            onChange={(e) => set('ai_model')(e.target.value)} />
        </label>
        {cli && (
          <label className="form-field form-wide" htmlFor="ai-cli-path">
            <span className="form-label">Command</span>
            <input id="ai-cli-path" value={form.ai_cli_path} spellCheck={false} autoComplete="off"
              placeholder="Blank: look where the installer puts it, then on PATH"
              onChange={(e) => set('ai_cli_path')(e.target.value)} />
            <span className="form-hint">The full path to the command, if resmon does not find it.</span>
          </label>
        )}
        {form.ai_provider === 'claude_code' && (
          <label className="form-field" htmlFor="ai-effort">
            <span className="form-label">Effort</span>
            <select id="ai-effort" value={form.ai_effort} onChange={(e) => set('ai_effort')(e.target.value)}>
              <option value="">The command’s default</option>
              {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              {form.ai_effort && !efforts.includes(form.ai_effort) && <option value={form.ai_effort}>{form.ai_effort} (saved)</option>}
            </select>
          </label>
        )}
        {form.ai_provider === 'custom' && (
          <label className="form-field form-wide" htmlFor="ai-base-url">
            <span className="form-label">Endpoint</span>
            <input id="ai-base-url" type="url" value={form.ai_custom_base_url} spellCheck={false} autoComplete="off"
              placeholder="https://…/v1" onChange={(e) => set('ai_custom_base_url')(e.target.value)} />
            <span className="form-hint">An OpenAI-compatible base URL. The key below is sent only there.</span>
          </label>
        )}
        {form.ai_provider === 'local' && (
          <label className="form-field form-wide" htmlFor="ai-local-endpoint">
            <span className="form-label">Ollama endpoint</span>
            <input id="ai-local-endpoint" value={form.ai_local_endpoint} spellCheck={false} autoComplete="off"
              placeholder="Blank: http://localhost:11434" onChange={(e) => set('ai_local_endpoint')(e.target.value)} />
          </label>
        )}
      </div>
      {cli && !dirty && <LaneStatus provider={form.ai_provider} />}
      {cli && dirty && <p className="form-hint">Save to see whether resmon finds this command.</p>}
      {cli && (
        <p className="form-hint">
          This spends your own plan: resmon runs the command you installed and signed into, and never sees or keeps
          your sign-in. Papers are sent {limits.batch} at a time, and a run sends at most {limits.cap} to it.
        </p>
      )}
      {keyName && <ProviderKey name={keyName} provider={form.ai_provider} />}
      {(fallbacks.length > 0 || removed > 0) && (
        <div className="ai-fallbacks" data-ai="fallbacks">
          <p className="form-label">Fallbacks</p>
          {fallbacks.length > 0 ? (
            <>
              <p className="form-hint">
                When the connection above cannot summarize a paper, resmon tries these next, in order. One that is refused
                for the whole run, such as a rejected key, is set aside for the rest of that run.
              </p>
              <ol className="ai-fallback-list">
                {fallbacks.map((entry, index) => (
                  <li key={`${index}:${entry.lane.kind}:${entry.lane.provider}`} data-lane={entry.lane.provider}>
                    <span>{laneWords(entry.lane)}</span>
                    <button type="button" className="btn quiet sm" aria-label={`Remove the fallback ${laneWords(entry.lane)}`}
                      onClick={() => setFallbacks(fallbacks.filter((_, i) => i !== index))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="form-hint">None: a summary the connection above cannot write is left out.</p>
          )}
          {!form.ai_provider && fallbacks.length > 0 && (
            <p className="form-hint" data-ai="fallbacks-dropped">
              With no provider chosen, summaries are off, and saving does not keep these fallbacks.
            </p>
          )}
          {removed > 0 && (
            <p className="form-hint" data-ai="fallbacks-removed">
              {removed === 1 ? 'One fallback is' : `${removed} fallbacks are`} removed here; Save to stop using{' '}
              {removed === 1 ? 'it' : 'them'}.
            </p>
          )}
        </div>
      )}
      {start.unreadable && (
        <p className="form-hint" data-ai="chain-unreadable">
          A stored list of fallback connections could not be read, so a run uses only the connection above. Saving
          replaces that list.
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving' : 'Save summary settings'}
        </button>
        {save.isSuccess && !dirty && <span className="settings-said" role="status">Saved.</span>}
      </div>
      {save.error && <p className="field-error" role="alert">{refusal(save.error)}</p>}
    </form>
  );
}

/** Where resmon found the command, and the one thing finding it does not establish. */
function LaneStatus({ provider }: { provider: string }) {
  const status = useQuery({ queryKey: CLI_KEY, queryFn: () => answer(engine().GET('/api/settings/ai/cli-status')) });
  const probe = status.data?.providers.find((p) => p.provider === provider);
  if (status.isError) return <p className="field-error" role="alert">The engine did not say where the command is ({status.error.message}).</p>;
  if (!probe) return null;
  return (
    <p className="ai-lane" data-ai="lane-status" data-found={probe.found}>
      {/[.!?]$/.test(probe.detail) ? probe.detail : `${probe.detail}.`}
      {!probe.found && ` Looked in: ${probe.tried.join(', ')}.`}
      {' '}resmon has not checked whether you are signed in: that shows on the first paper, and is recorded on the run.
    </p>
  );
}

function Assistant() {
  const settings = useQuery({ queryKey: ASSISTANT_KEY, queryFn: readAssistant });
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: ask.status });
  return (
    <section className="ai-part" aria-labelledby="ai-assistant">
      <h3 id="ai-assistant" className="field-title">Ask</h3>
      <p className="field-lede">
        What a new conversation starts with. A conversation keeps the connection, model and effort it began with,
        so changing these changes no conversation already started.
      </p>
      {settings.isError && <p className="field-error" role="alert">The engine did not answer ({settings.error.message}).</p>}
      {settings.data && status.data && <AssistantForm stored={settings.data} status={status.data} />}
      {status.data && (
        <ul className="ai-routes" aria-label="Ways the assistant can run" data-ai="routes">
          <li data-available={status.data.available} data-kind={status.data.runtime.kind}>
            <strong>{status.data.runtime.kind === 'api_key' ? 'An API key' : 'Claude Code'}</strong>{' '}
            {routeSentence(status.data.runtime.kind, status.data.available, status.data.reason, true)}
          </li>
          {status.data.others.map((other) => (
            <li key={other.kind} data-available={other.available} data-kind={other.kind}>
              <strong>{other.kind === 'api_key' ? 'An API key' : other.kind === 'codex_cli' ? 'Codex' : 'Claude Code'}</strong>{' '}
              {routeSentence(other.kind, other.available, other.reason, false)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


function AssistantForm({ stored, status }: { stored: AssistantSettings; status: Status }) {
  const client = useQueryClient();
  const [form, setForm] = useState<AssistantSettings>(stored);
  const dirty = (Object.keys(form) as (keyof AssistantSettings)[]).some((k) => form[k] !== stored[k]);
  const api = form.assistant_runtime === 'api_key';
  const choices = status.composer_choices;
  const offered = choices.connections.filter((c) => c.runtime === 'api_key');
  const save = useMutation({
    mutationFn: () => answer(engine().PUT('/api/settings/assistant', { body: { settings: { ...form } } })),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: ASSISTANT_KEY }),
      client.invalidateQueries({ queryKey: STATUS_KEY }),
    ]),
  });
  const set = (key: keyof AssistantSettings) => (value: string) => setForm({ ...form, [key]: value });
  const aliases = choices.claude_aliases.includes(form.assistant_model) || !form.assistant_model
    ? choices.claude_aliases : [...choices.claude_aliases, form.assistant_model];
  return (
    <form className="settings-form" aria-label="Assistant settings"
      onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <div className="form-grid">
        <label className="form-field" htmlFor="assistant-runtime">
          <span className="form-label">Connection</span>
          <select id="assistant-runtime" value={form.assistant_runtime || 'claude_cli'}
            onChange={(e) => setForm({ ...form, assistant_runtime: e.target.value, assistant_effort: e.target.value === 'api_key' ? '' : form.assistant_effort })}>
            <option value="claude_cli">Claude Code, the claude command</option>
            <option value="api_key">An API key</option>
          </select>
        </label>
        {api && (
          <label className="form-field" htmlFor="assistant-provider">
            <span className="form-label">Provider</span>
            <select id="assistant-provider" value={form.assistant_provider} onChange={(e) => set('assistant_provider')(e.target.value)}>
              <option value="">The one summaries use</option>
              {offered.map((c) => <option key={c.provider} value={c.provider}>{providerWords(c.provider)}</option>)}
            </select>
          </label>
        )}
        <label className="form-field" htmlFor="assistant-model">
          <span className="form-label">Model</span>
          {api
            ? <input id="assistant-model" value={form.assistant_model} spellCheck={false} autoComplete="off"
                placeholder="The provider’s model ID (required)" onChange={(e) => set('assistant_model')(e.target.value)} />
            : (
              <select id="assistant-model" value={form.assistant_model} onChange={(e) => set('assistant_model')(e.target.value)}>
                <option value="">The command’s default</option>
                {aliases.map((alias) => <option key={alias} value={alias}>{alias}</option>)}
              </select>
            )}
        </label>
        {!api && (
          <label className="form-field" htmlFor="assistant-effort">
            <span className="form-label">Effort</span>
            <select id="assistant-effort" value={form.assistant_effort} onChange={(e) => set('assistant_effort')(e.target.value)}>
              <option value="">The command’s default</option>
              {choices.claude_efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </label>
        )}
      </div>
      {!api && (
        <p className="form-hint">
          The Claude names are aliases the command accepts, not a list of what your account can use. The command
          checks the model and effort when it runs.
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving' : 'Save assistant settings'}
        </button>
        {save.isSuccess && !dirty && (
          <span className="settings-said" role="status">Saved. New conversations start from these.</span>
        )}
      </div>
      {save.error && <p className="field-error" role="alert">{refusal(save.error)}</p>}
    </form>
  );
}
