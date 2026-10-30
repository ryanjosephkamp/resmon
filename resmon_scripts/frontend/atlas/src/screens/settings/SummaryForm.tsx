import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { bridge } from '../../bridge';
import { STATUS_KEY } from '../ask/AskProvider';
import { ask } from '../ask/askApi';
import { ModelField, listFor, useModelList, type ModelQuery } from './ModelField';
import { ProviderKey, refusal } from './ProviderKey';
import {
  AI_KEY, CLI_PROVIDERS, DEFAULT_GOALS, DEFAULT_TEMPERATURE, KEY_NAMES, LENGTHS, PROVIDERS, TEMPERATURE_PROVIDERS, TONES,
  baseUrlProblem, effortsFor, entryOf, laneKind, laneName, laneWords, limitProblem, limitsOf, moveFallback, rememberedModels,
  storedSummary, summaryChanged, summaryPayload, switchProvider, temperatureProblem, wordingOf,
  type AiSettings, type ChainEntry, type LaneFields, type SummaryForm as SummaryFields, type Wording,
} from './summaryLanes';

export const CLI_KEY = ['ai-cli-status'] as const;

const same = (a: ChainEntry, b: ChainEntry) => JSON.stringify(a.raw) === JSON.stringify(b.raw);

/** What `/api/ai/models` needs to reach a provider whose address is not fixed. */
function queryOf(lane: LaneFields): ModelQuery {
  const query: ModelQuery = { provider: lane.provider };
  if (lane.provider === 'custom' && lane.base_url?.trim()) query.base_url = lane.base_url.trim();
  if (lane.provider === 'local') query.endpoint = lane.endpoint?.trim() || 'http://localhost:11434';
  if (CLI_PROVIDERS.has(lane.provider) && lane.cli_path?.trim()) query.binary_path = lane.cli_path.trim();
  return query;
}

/**
 * The connection a run summarizes with, the fallbacks after it, and how
 * every summary is written. Where a chain is stored, its first lane is what a
 * run uses, so the form starts from that lane, and Save writes the change
 * into the chain with the fallbacks as they stand here: kept, added,
 * reordered, or removed.
 */
export function SummaryForm({ stored }: { stored: AiSettings }) {
  const client = useQueryClient();
  const start = storedSummary(stored);
  const remembered = rememberedModels(stored);
  const [form, setForm] = useState<SummaryFields>(start.form);
  const [wording, setWording] = useState<Wording>(() => wordingOf(stored));
  const [fallbacks, setFallbacks] = useState<ChainEntry[]>(start.fallbacks);
  const [adding, setAdding] = useState(false);
  const models = useModelList();
  const dirty = summaryChanged(stored, form, fallbacks, wording);
  const cli = CLI_PROVIDERS.has(form.ai_provider);
  const keyName = KEY_NAMES[form.ai_provider];
  const limits = limitsOf(form);
  const claude = useQuery({ queryKey: STATUS_KEY, queryFn: ask.status }).data?.composer_choices.claude_efforts ?? [];
  const efforts = effortsFor(listFor(models, form.ai_provider), form.ai_model, form.ai_provider === 'claude_code' ? claude : []);
  const urlProblem = form.ai_provider === 'custom' ? baseUrlProblem(form.ai_custom_base_url) : null;
  const tempProblem = temperatureProblem(wording.ai_temperature);
  const capProblem = cli ? limitProblem(form.doc_cap) : null;
  const batchProblem = cli ? limitProblem(form.batch_size) : null;
  const blocked = !!(urlProblem || tempProblem || capProblem || batchProblem);
  const save = useMutation({
    mutationFn: () => answer(engine().PUT('/api/settings/ai', { body: { settings: summaryPayload(stored, form, fallbacks, wording) } })),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: AI_KEY }),
      client.invalidateQueries({ queryKey: CLI_KEY }),
      client.invalidateQueries({ queryKey: STATUS_KEY }),
    ]),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); if (!blocked) save.mutate(); };
  const set = (key: keyof SummaryFields) => (value: string) => setForm({ ...form, [key]: value });
  const word = (key: keyof Wording) => (value: string) => setWording({ ...wording, [key]: value });
  const removed = start.fallbacks.filter((f) => !fallbacks.some((g) => same(f, g))).length;
  const added = fallbacks.filter((f) => !start.fallbacks.some((g) => same(f, g))).length;
  const moved = !removed && !added && fallbacks.some((f, i) => !same(f, start.fallbacks[i]!));

  return (
    <form className="settings-form" onSubmit={submit} aria-label="Summary settings">
      <div className="form-grid">
        <div className="form-field">
          <label className="form-label" htmlFor="ai-provider">Provider</label>
          <select id="ai-provider" value={form.ai_provider}
            onChange={(e) => setForm(switchProvider(form, e.target.value, start.form, remembered))}>
            <option value="">None chosen</option>
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            {form.ai_provider && !PROVIDERS.some((p) => p.value === form.ai_provider) && (
              <option value={form.ai_provider}>{form.ai_provider} (saved)</option>
            )}
          </select>
        </div>
        <ModelField id="ai-model" provider={form.ai_provider} value={form.ai_model} onChange={set('ai_model')}
          list={models} query={queryOf({ provider: form.ai_provider, model: form.ai_model, base_url: form.ai_custom_base_url,
            endpoint: form.ai_local_endpoint, cli_path: form.ai_cli_path })} />
        {cli && (
          <div className="form-field form-wide">
            <label className="form-label" htmlFor="ai-cli-path">Command</label>
            <span className="password-row">
              <input id="ai-cli-path" value={form.ai_cli_path} spellCheck={false} autoComplete="off"
                placeholder="Blank: look where the installer puts it, then on PATH"
                onChange={(e) => set('ai_cli_path')(e.target.value)} />
              {/* The installers put both commands where a plain open panel does not go; the app's chooser shows hidden files and app bundles. */}
              {bridge()?.chooseFile && (
                <button type="button" className="btn sm" data-ai="choose-command" onClick={() => {
                  void bridge()?.chooseFile?.(form.ai_cli_path || undefined).then((picked) => {
                    if (picked) setForm((now) => ({ ...now, ai_cli_path: picked }));
                  });
                }}>Choose…</button>
              )}
            </span>
            <span className="form-hint">The full path to the command, if resmon does not find it.</span>
          </div>
        )}
        {cli && (
          <label className="form-field" htmlFor="ai-effort">
            <span className="form-label">Effort</span>
            <select id="ai-effort" value={form.ai_effort} onChange={(e) => set('ai_effort')(e.target.value)}>
              <option value="">The command’s default</option>
              {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              {form.ai_effort && !efforts.includes(form.ai_effort) && <option value={form.ai_effort}>{form.ai_effort} (saved)</option>}
            </select>
            {!efforts.length && <span className="form-hint">Load models to see the levels each of the command’s models takes.</span>}
          </label>
        )}
        {cli && (
          <label className="form-field" htmlFor="ai-batch-size">
            <span className="form-label">Papers per call</span>
            <input id="ai-batch-size" inputMode="numeric" value={form.batch_size} autoComplete="off"
              placeholder={`Blank: ${limitsOf({ doc_cap: '', batch_size: '' }).batch}`} onChange={(e) => set('batch_size')(e.target.value)} />
            {batchProblem && <span className="field-error" role="alert">{batchProblem}</span>}
          </label>
        )}
        {cli && (
          <label className="form-field" htmlFor="ai-doc-cap">
            <span className="form-label">Most papers per run</span>
            <input id="ai-doc-cap" inputMode="numeric" value={form.doc_cap} autoComplete="off"
              placeholder={`Blank: ${limitsOf({ doc_cap: '', batch_size: '' }).cap}`} onChange={(e) => set('doc_cap')(e.target.value)} />
            {capProblem
              ? <span className="field-error" role="alert">{capProblem}</span>
              : <span className="form-hint">Papers past this go to the next fallback, and the run records why.</span>}
          </label>
        )}
        {form.ai_provider === 'custom' && (
          <label className="form-field form-wide" htmlFor="ai-base-url">
            <span className="form-label">Endpoint</span>
            <input id="ai-base-url" type="url" value={form.ai_custom_base_url} spellCheck={false} autoComplete="off"
              placeholder="https://…/v1" onChange={(e) => set('ai_custom_base_url')(e.target.value)} />
            {urlProblem
              ? <span className="field-error" role="alert">{urlProblem}</span>
              : <span className="form-hint">An OpenAI-compatible base URL. The key below is sent only there.</span>}
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
      {keyName && (
        <ProviderKey name={keyName} provider={form.ai_provider}
          test={{ baseUrl: form.ai_provider === 'custom' ? form.ai_custom_base_url : undefined }} />
      )}

      <WordingFields wording={wording} onWord={word} provider={form.ai_provider} problem={tempProblem} />

      <div className="ai-fallbacks" data-ai="fallbacks">
        <p className="form-label">Fallbacks</p>
        <p className="form-hint">
          {fallbacks.length > 0
            ? 'When the connection above cannot summarize a paper, resmon tries these next, in order. One that is refused for the whole run, such as a rejected key, is set aside for the rest of that run.'
            : 'None: a summary the connection above cannot write is left out.'}
        </p>
        {fallbacks.length > 0 && <FallbackList fallbacks={fallbacks} onChange={setFallbacks} />}
        {adding
          ? <FallbackDraft stored={stored} claude={claude} onCancel={() => setAdding(false)}
              onAdd={(entry) => { setFallbacks([...fallbacks, entry]); setAdding(false); }} />
          : (
            <p><button type="button" className="btn sm" data-ai="add-fallback" onClick={() => setAdding(true)}>Add a fallback</button></p>
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
        {added > 0 && (
          <p className="form-hint" data-ai="fallbacks-added">
            {added === 1 ? 'One fallback is' : `${added} fallbacks are`} added here; Save to start using {added === 1 ? 'it' : 'them'}.
          </p>
        )}
        {moved && <p className="form-hint" data-ai="fallbacks-moved">Their order is changed here; Save to use the new order.</p>}
      </div>
      {start.unreadable && (
        <p className="form-hint" data-ai="chain-unreadable">
          A stored list of fallback connections could not be read, so a run uses only the connection above. Saving
          replaces that list.
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={!dirty || blocked || save.isPending}>
          {save.isPending ? 'Saving' : 'Save summary settings'}
        </button>
        {save.isSuccess && !dirty && <span className="settings-said" role="status">Saved.</span>}
      </div>
      {save.error && <p className="field-error" role="alert">{refusal(save.error)}</p>}
    </form>
  );
}

/** Length, tone, temperature, and what to draw out: how every summary is written, whichever lane writes it. */
function WordingFields({ wording, onWord, provider, problem }: {
  wording: Wording;
  onWord: (key: keyof Wording) => (value: string) => void;
  provider: string;
  problem: string | null;
}) {
  const sent = !provider || TEMPERATURE_PROVIDERS.has(provider);
  return (
    <fieldset className="ai-wording" data-ai="wording">
      <legend className="form-label">How each summary is written</legend>
      <div className="form-grid">
        <label className="form-field" htmlFor="ai-length">
          <span className="form-label">Length</span>
          <select id="ai-length" value={wording.ai_summary_length} onChange={(e) => onWord('ai_summary_length')(e.target.value)}>
            {LENGTHS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            {!LENGTHS.some((l) => l.value === wording.ai_summary_length) && (
              <option value={wording.ai_summary_length}>{wording.ai_summary_length} (saved)</option>
            )}
          </select>
        </label>
        <label className="form-field" htmlFor="ai-tone">
          <span className="form-label">Tone</span>
          <select id="ai-tone" value={wording.ai_tone} onChange={(e) => onWord('ai_tone')(e.target.value)}>
            {TONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            {!TONES.some((t) => t.value === wording.ai_tone) && <option value={wording.ai_tone}>{wording.ai_tone} (saved)</option>}
          </select>
        </label>
        <label className="form-field" htmlFor="ai-temperature">
          <span className="form-label">Temperature</span>
          <input id="ai-temperature" inputMode="decimal" value={wording.ai_temperature} autoComplete="off"
            placeholder={`Blank: ${DEFAULT_TEMPERATURE}`} onChange={(e) => onWord('ai_temperature')(e.target.value)} />
          {problem
            ? <span className="field-error" role="alert">{problem}</span>
            : (
              <span className="form-hint" data-ai="temperature-reach">
                {!sent && `Not sent to ${laneName(provider)}. `}
                Sent to OpenAI, Google, xAI, Meta, DeepSeek, Alibaba, and a custom endpoint; Anthropic, Ollama, and the two
                commands use their own.
              </span>
            )}
        </label>
        <label className="form-field" htmlFor="ai-goals">
          <span className="form-label">What to draw out</span>
          <input id="ai-goals" value={wording.ai_extraction_goals} autoComplete="off" placeholder={`Blank: ${DEFAULT_GOALS}`}
            onChange={(e) => onWord('ai_extraction_goals')(e.target.value)} />
          <span className="form-hint">Asked of each abstract, in your words, separated by commas.</span>
        </label>
      </div>
    </fieldset>
  );
}

/** The stored fallbacks, in the order a run tries them, each movable and removable. */
function FallbackList({ fallbacks, onChange }: { fallbacks: ChainEntry[]; onChange: (next: ChainEntry[]) => void }) {
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => answer(engine().GET('/api/credentials')) });
  return (
    <ol className="ai-fallback-list">
      {fallbacks.map((entry, index) => {
        const words = laneWords(entry.lane);
        const slot = entry.lane.kind === 'api_key' ? KEY_NAMES[entry.lane.provider] : undefined;
        const keyState = slot ? credentials.data?.credentials[slot]?.status : undefined;
        return (
          <li key={`${index}:${JSON.stringify(entry.raw)}`} data-lane={entry.lane.provider}>
            <div className="ai-fallback-row">
              <span className="ai-fallback-words">
                {words}
                {keyState === 'absent' && (
                  <span className="form-hint" data-ai="fallback-no-key"> No {laneName(entry.lane.provider)} key is stored, so a run skips it.</span>
                )}
              </span>
              <span className="ai-fallback-actions">
                <button type="button" className="btn quiet sm" aria-label={`Move the fallback ${words} up`} disabled={index === 0}
                  onClick={() => onChange(moveFallback(fallbacks, index, -1))}>Up</button>
                <button type="button" className="btn quiet sm" aria-label={`Move the fallback ${words} down`}
                  disabled={index === fallbacks.length - 1} onClick={() => onChange(moveFallback(fallbacks, index, 1))}>Down</button>
                <button type="button" className="btn quiet sm" aria-label={`Remove the fallback ${words}`}
                  onClick={() => onChange(fallbacks.filter((_, i) => i !== index))}>Remove</button>
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const BLANK_LANE: LaneFields = { provider: '', model: '', cli_path: '', effort: '', base_url: '', endpoint: '', doc_cap: '', batch_size: '' };

/** A new fallback, typed in place and added to the list; nothing is stored until Save. */
function FallbackDraft({ stored, claude, onAdd, onCancel }: {
  stored: AiSettings;
  claude: readonly string[];
  onAdd: (entry: ChainEntry) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<LaneFields>(BLANK_LANE);
  const models = useModelList();
  const remembered = rememberedModels(stored);
  const kind = draft.provider ? laneKind(draft.provider) : null;
  const set = (key: keyof LaneFields) => (value: string) => setDraft({ ...draft, [key]: value });
  const entry = entryOf(draft);
  const problem = draft.provider === 'custom' && !draft.base_url?.trim() ? 'A custom endpoint needs its address.'
    : draft.provider === 'custom' && baseUrlProblem(draft.base_url ?? '') ? baseUrlProblem(draft.base_url ?? '')
      : kind && kind !== 'subscription' && !draft.model.trim() ? 'Choose or type a model: without one, a run skips this fallback.'
        : kind === 'subscription' ? limitProblem(draft.doc_cap ?? '') : null;
  const efforts = effortsFor(listFor(models, draft.provider), draft.model, draft.provider === 'claude_code' ? claude : []);
  return (
    <div className="ai-fallback-add" role="group" aria-label="A new fallback" data-ai="fallback-draft">
      <div className="form-grid">
        <div className="form-field">
          <label className="form-label" htmlFor="ai-fallback-provider">Provider</label>
          <select id="ai-fallback-provider" value={draft.provider}
            onChange={(e) => setDraft({
              ...BLANK_LANE, provider: e.target.value, model: remembered[e.target.value] ?? '',
              base_url: e.target.value === 'custom' ? stored.ai_custom_base_url : '',
            })}>
            <option value="">Choose a provider</option>
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <ModelField id="ai-fallback-model" provider={draft.provider} value={draft.model} onChange={set('model')}
          list={models} query={queryOf(draft)} />
        {kind === 'subscription' && (
          <>
            <label className="form-field form-wide" htmlFor="ai-fallback-cli-path">
              <span className="form-label">Command</span>
              <input id="ai-fallback-cli-path" value={draft.cli_path} spellCheck={false} autoComplete="off"
                placeholder="Blank: look where the installer puts it, then on PATH" onChange={(e) => set('cli_path')(e.target.value)} />
            </label>
            <label className="form-field" htmlFor="ai-fallback-effort">
              <span className="form-label">Effort</span>
              <select id="ai-fallback-effort" value={draft.effort} onChange={(e) => set('effort')(e.target.value)}>
                <option value="">The command’s default</option>
                {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
            <label className="form-field" htmlFor="ai-fallback-doc-cap">
              <span className="form-label">Most papers per run</span>
              <input id="ai-fallback-doc-cap" inputMode="numeric" value={draft.doc_cap} autoComplete="off"
                placeholder={`Blank: ${limitsOf({ doc_cap: '', batch_size: '' }).cap}`} onChange={(e) => set('doc_cap')(e.target.value)} />
            </label>
          </>
        )}
        {draft.provider === 'custom' && (
          <label className="form-field form-wide" htmlFor="ai-fallback-base-url">
            <span className="form-label">Endpoint</span>
            <input id="ai-fallback-base-url" type="url" value={draft.base_url} spellCheck={false} autoComplete="off"
              placeholder="https://…/v1" onChange={(e) => set('base_url')(e.target.value)} />
          </label>
        )}
        {draft.provider === 'local' && (
          <label className="form-field form-wide" htmlFor="ai-fallback-endpoint">
            <span className="form-label">Ollama endpoint</span>
            <input id="ai-fallback-endpoint" value={draft.endpoint} spellCheck={false} autoComplete="off"
              placeholder="Blank: http://localhost:11434" onChange={(e) => set('endpoint')(e.target.value)} />
          </label>
        )}
      </div>
      {entry && !problem && <p className="form-hint" data-ai="fallback-preview">Adds {laneWords(entry.lane)}, after the others.</p>}
      {draft.provider && problem && <p className="field-error" role="alert">{problem}</p>}
      {kind === 'api_key' && (
        <p className="form-hint">It uses the {laneName(draft.provider)} key stored for that provider; choose it above to store or test one.</p>
      )}
      <div className="form-actions">
        <button type="button" className="btn" data-ai="add-this-fallback" disabled={!entry || !!problem}
          onClick={() => { if (entry) onAdd(entry); }}>Add this fallback</button>
        <button type="button" className="btn quiet" onClick={onCancel}>Cancel</button>
      </div>
    </div>
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
