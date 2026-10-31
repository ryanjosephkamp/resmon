import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { STATUS_KEY } from '../ask/AskProvider';
import { ask } from '../ask/askApi';
import { providerWords } from '../ask/askModel';
import { CliSignIn } from './CliSignIn';
import { EMBEDDING_STATUS_KEY } from './embeddingWords';
import { LAST_ANSWERED_KEY, lastFor, modelOptionWords, readLastAnswered } from './modelWords';
import { EMBEDDING_PAGE_KEY, Embeddings, readEmbeddingPage, readEmbeddingStatus } from './Embeddings';
import { refusal } from './ProviderKey';
import { SummaryForm } from './SummaryForm';
import { AI_KEY, routeSentence } from './summaryLanes';

const ASSISTANT_KEY = ['assistant-settings'] as const;

const readAi = () => answer(engine().GET('/api/settings/ai'));
const readAssistant = () => answer(engine().GET('/api/settings/assistant'));
type AssistantSettings = Awaited<ReturnType<typeof readAssistant>>;
type Status = Awaited<ReturnType<typeof ask.status>>;

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
      {settings.data && (settings.data.assistant_runtime || 'claude_cli') === 'claude_cli' && (
        <CliSignIn provider="claude_code" purpose="ask" checkOnOpen />
      )}
      {status.data && (
        <ul className="ai-routes" aria-label="Ways the assistant can run" data-ai="routes">
          <li data-available={status.data.available} data-kind={status.data.runtime.kind}>
            <strong>{routeName(status.data.runtime.kind)}</strong>{' '}
            {routeSentence(status.data.runtime.kind, status.data.available, status.data.reason, true)}
          </li>
          {status.data.others.map((other) => (
            <li key={other.kind} data-available={other.available} data-kind={other.kind}>
              <strong>{routeName(other.kind)}</strong>{' '}
              {routeSentence(other.kind, other.available, other.reason, false)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


/** One way the assistant can run, as a person names it. */
const routeName = (kind: string): string => (kind === 'api_key' ? 'An API key' : kind === 'codex_cli' ? 'Codex' : 'Claude Code');

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
  const last = useQuery({ queryKey: LAST_ANSWERED_KEY, queryFn: readLastAnswered, enabled: !api, refetchOnMount: 'always' });
  const words = (model: string) => modelOptionWords('claude_code', model, lastFor(last.data, 'claude_code', model), choices.claude_aliases);
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
                <option value="">{words('')}</option>
                {aliases.map((alias) => <option key={alias} value={alias}>{words(alias)}</option>)}
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
