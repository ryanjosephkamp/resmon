import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine, EngineError } from '../../api/client';
import { platform } from '../../bridge';
import { STATUS_KEY } from '../ask/AskProvider';
import { ask } from '../ask/askApi';
import { providerWords } from '../ask/askModel';
import { keychainName } from './model';

const AI_KEY = ['ai-settings'] as const;
const ASSISTANT_KEY = ['assistant-settings'] as const;
const CLI_KEY = ['ai-cli-status'] as const;

const readAi = () => answer(engine().GET('/api/settings/ai'));
const readAssistant = () => answer(engine().GET('/api/settings/assistant'));
type AiSettings = Awaited<ReturnType<typeof readAi>>;
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
const CLI_PROVIDERS = new Set(['claude_code', 'codex']);
/** The credential each provider's key is stored under (`llm_remote._ALIAS_FOR`). */
const KEY_NAMES: Record<string, string> = {
  openai: 'openai_api_key', anthropic: 'anthropic_api_key', google: 'google_api_key', xai: 'xai_api_key',
  meta: 'meta_api_key', deepseek: 'deepseek_api_key', alibaba: 'alibaba_api_key', custom: 'custom_llm_api_key',
};

/** The papers a plan's run sends at most: the stored cap where it is a positive whole number, else the engine's 50. */
function docCap(stored: string): number {
  const parsed = Number.parseInt(stored, 10);
  return parsed > 0 ? parsed : 50;
}

function refusal(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

/**
 * Settings → AI: the two things in resmon that use a model.
 *
 * **Summaries** are written for the papers a run finds, when a run asks for
 * them. **Ask** is the assistant. They can use different connections, and
 * each says what resmon has checked about it: finding a command is not
 * knowing that anyone is signed into it, and a stored key is not one a
 * provider has accepted.
 */
export function Ai() {
  // The same reads the two parts make, asked here only to say when the group has arrived.
  const busy = [
    useQuery({ queryKey: AI_KEY, queryFn: readAi }),
    useQuery({ queryKey: ASSISTANT_KEY, queryFn: readAssistant }),
    useQuery({ queryKey: STATUS_KEY, queryFn: ask.status }),
  ].some((q) => q.isPending);
  return (
    <section className="settings-group ai" aria-labelledby="ai-title" aria-busy={busy}>
      <h2 id="ai-title" className="group-title">AI</h2>
      <p className="group-lede">
        Two things in resmon use a model: a summary of each paper a run finds, when you ask for one, and Ask.
        Neither runs unless you start it.
      </p>
      <Summaries />
      <Assistant />
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


function SummaryForm({ stored }: { stored: AiSettings }) {
  const client = useQueryClient();
  const [form, setForm] = useState({
    ai_provider: stored.ai_provider, ai_model: stored.ai_model, ai_cli_path: stored.ai_cli_path,
    ai_effort: stored.ai_effort, ai_custom_base_url: stored.ai_custom_base_url,
  });
  const dirty = (Object.keys(form) as (keyof typeof form)[]).some((k) => form[k] !== stored[k]);
  const cli = CLI_PROVIDERS.has(form.ai_provider);
  const keyName = KEY_NAMES[form.ai_provider];
  const efforts = useQuery({ queryKey: STATUS_KEY, queryFn: ask.status }).data?.composer_choices.claude_efforts ?? [];
  const save = useMutation({
    mutationFn: () => answer(engine().PUT('/api/settings/ai', { body: { settings: { ...form } } })),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: AI_KEY }),
      client.invalidateQueries({ queryKey: CLI_KEY }),
      client.invalidateQueries({ queryKey: STATUS_KEY }),
    ]),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

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
      </div>
      {cli && !dirty && <LaneStatus provider={form.ai_provider} />}
      {cli && dirty && <p className="form-hint">Save to see whether resmon finds this command.</p>}
      {cli && (
        <p className="form-hint">
          This spends your own plan: resmon runs the command you installed and signed into, and never sees or keeps
          your sign-in. Papers are sent five at a time, and a run sends at most {docCap(stored.ai_subscription_doc_cap)} to it.
        </p>
      )}
      {keyName && <ProviderKey name={keyName} provider={form.ai_provider} />}
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

/** A provider's key: stored by its own button, never shown, and only its presence read back. */
function ProviderKey({ name, provider }: { name: string; provider: string }) {
  const client = useQueryClient();
  const [value, setValue] = useState('');
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => answer(engine().GET('/api/credentials')) });
  const state = credentials.data?.credentials[name]?.status ?? null;
  const done = () => Promise.all([
    client.invalidateQueries({ queryKey: ['credentials'] }),
    client.invalidateQueries({ queryKey: STATUS_KEY }),
  ]);
  const store = useMutation({
    mutationFn: () => answer(engine().PUT('/api/credentials/{key_name}', { params: { path: { key_name: name } }, body: { value } })),
    onSuccess: () => { setValue(''); return done(); },
  });
  const remove = useMutation({
    mutationFn: () => answer(engine().DELETE('/api/credentials/{key_name}', { params: { path: { key_name: name } } })),
    onSuccess: done,
  });
  const where = keychainName(platform());
  return (
    <div className="password" data-ai="key" data-state={state ?? 'unknown'}>
      <label className="form-field" htmlFor="ai-key">
        <span className="form-label">{providerWords(provider)} key</span>
        <span className="password-row">
          <input id="ai-key" type="password" value={value} autoComplete="new-password"
            placeholder={state === 'present' ? 'Stored; type a new one to replace it' : ''}
            onChange={(e) => setValue(e.target.value)} />
          <button type="button" className="btn" disabled={!value || store.isPending} onClick={() => store.mutate()}>
            {state === 'present' ? 'Replace' : 'Store'}
          </button>
          {state === 'present' && (
            <button type="button" className="btn quiet" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</button>
          )}
        </span>
      </label>
      <p className="form-hint">
        {state === 'present' && `A key is stored in ${where}. resmon reads it to send a request, and never shows it. Whether the provider accepts it shows on first use.`}
        {state === 'absent' && `No key is stored. One you store goes to ${where}, not to resmon’s database.`}
        {state === 'unreadable' && `A key may be stored in ${where}, but this copy of resmon is not allowed to read it. Store it again to replace it.`}
        {state === null && (credentials.isError ? 'The engine did not say whether a key is stored.' : 'Asking whether a key is stored.')}
      </p>
      {(store.error || remove.error) && <p className="field-error" role="alert">{refusal((store.error ?? remove.error) as Error)}</p>}
    </div>
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
        <ul className="ai-routes" aria-label="Ways the assistant can run">
          <li data-available={status.data.available}>
            <strong>{status.data.runtime.kind === 'api_key' ? 'An API key' : 'Claude Code'}</strong>{' '}
            {status.data.available ? 'can run. ' : 'cannot run. '}{status.data.reason}
          </li>
          {status.data.others.map((other) => (
            <li key={other.kind} data-available={other.available}>
              <strong>{other.kind === 'api_key' ? 'An API key' : other.kind === 'codex_cli' ? 'Codex' : 'Claude Code'}</strong>{' '}
              {other.reason}
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
