import React, { useState, useEffect } from 'react';
import TutorialLinkButton from '../AboutResmon/TutorialLinkButton';
import { apiClient } from '../../api/client';
import PageHelp from '../Help/PageHelp';
import InfoTooltip from '../Help/InfoTooltip';
import AssistantSettings from './AssistantSettings';
import EmbeddingSettings from './EmbeddingSettings';
import FallbackChain, {
  FallbackLane, CliStatus, SubscriptionCatalog, SUBSCRIPTION_PROVIDERS,
  DEFAULT_DOC_CAP,
} from './FallbackChain';

const PROVIDERS: { value: string; label: string }[] = [
  // 1.8.5 — the subscription lanes lead, because they are now the recommended
  // route: they run the CLI the user already pays for, and batching measured a
  // paper at 0.33x the cost and 0.23x the input tokens of a per-document call,
  // which is what made it safe to promote them out of the fallback list.
  { value: 'claude_code', label: 'Claude Code — your Claude plan' },
  { value: 'codex',       label: 'Codex — your ChatGPT plan' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai',    label: 'OpenAI' },
  { value: 'google',    label: 'Google' },
  { value: 'xai',       label: 'xAI' },
  { value: 'meta',      label: 'Meta' },
  { value: 'deepseek',  label: 'DeepSeek' },
  { value: 'alibaba',   label: 'Alibaba' },
  { value: 'local',     label: 'Local' },
  { value: 'custom',    label: 'Custom…' },
];

// Per-provider suggested model IDs (placeholder-only; user may override).
// Sourced from resmon_ai_summary_features.md Appendix C.
const MODEL_PLACEHOLDERS: Record<string, string> = {
  openai:    'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  google:    'gemini-2.5-flash',
  xai:       'grok-4',
  meta:      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  deepseek:  'deepseek-chat',
  alibaba:   'qwen-plus',
  local:     'llama3',
  custom:    'your-model-id',
};

// IMPL-AI12 UX guard: reject non-HTTPS Custom base URLs unless the host is
// loopback (localhost / 127.0.0.1 / ::1). Empty input is treated as "not yet
// validated" (no error). The backend applies its own hard check in the
// llm_factory path; this guard only disables Save to warn the user early.
const validateCustomBaseUrl = (raw: string): string | null => {
  const value = (raw || '').trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Base URL must be a valid absolute URL (e.g. https://api.example.com/v1).';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return null;
    return 'HTTP base URLs are only allowed for localhost. Use HTTPS for remote hosts.';
  }
  return 'Base URL must use http(s).';
};

// Heuristic for the IMPL-AI11 one-shot migration: the old UI bound the
// Local-branch model-name input to `ai_tone`. A string that matches the
// allowed model-id charset AND contains `:`, `/`, or a digit is treated
// as a misplaced model id to be moved into `ai_local_model`.
const MODEL_ID_CHARSET = /^[A-Za-z0-9._:/-]+$/;
const looksLikeModelId = (value: string): boolean => {
  if (!value) return false;
  if (!MODEL_ID_CHARSET.test(value)) return false;
  return /[:/]/.test(value) || /\d/.test(value);
};

interface AISettingsState {
  ai_provider: string;
  ai_model: string;
  ai_local_model: string;
  ai_summary_length: string;
  ai_tone: string;
  ai_temperature: string;
  ai_extraction_goals: string;
  ai_custom_base_url: string;
  ai_custom_header_prefix: string;
  // Update 2 — Feature 1 extension: JSON-encoded ``{provider: model_id}``
  // map persisted alongside the rest of the AI settings group. Each Save
  // updates the entry for the currently selected provider so switching
  // providers later restores their last-saved model automatically.
  ai_default_models: string;
  /** 1.8b — the complete ordered chain as JSON. Lane 0 mirrors the form above. */
  ai_chain: string;
  /** 1.8.5, subscription primary only. Persisted inside `ai_chain`; the legacy
   *  keys cannot carry them. */
  ai_cli_path: string;
  ai_effort: string;
  ai_subscription_doc_cap: string;
  ai_batch_size: string;
}

const DEFAULT_STATE: AISettingsState = {
  ai_provider: '',
  ai_model: '',
  ai_local_model: '',
  ai_summary_length: '',
  ai_tone: '',
  ai_temperature: '0.2',
  ai_extraction_goals: '',
  ai_custom_base_url: '',
  ai_custom_header_prefix: 'Bearer',
  ai_default_models: '',
  ai_chain: '',
  ai_cli_path: '',
  ai_effort: '',
  ai_subscription_doc_cap: '',
  ai_batch_size: '',
};

// Parse the JSON-encoded default-model map. Returns an empty object on
// any parse error or non-object payload so a corrupt entry never breaks
// the panel render.
const parseDefaultModels = (raw: string): Record<string, string> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      Object.entries(parsed as Record<string, unknown>).forEach(([k, v]) => {
        if (typeof v === 'string' && v) out[k] = v;
      });
      return out;
    }
  } catch {
    /* fall through */
  }
  return {};
};

/**
 * Read the fallback lanes out of a stored chain — everything after lane 0.
 * Lane 0 is the provider form, so it is not editable here and not shown twice.
 * A malformed chain yields no fallbacks rather than throwing; the backend makes
 * the same choice and falls back to the single-provider settings.
 */
const parseFallbacks = (raw: string): FallbackLane[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(1).map((entry: any): FallbackLane => {
      // Preserve the stored kind rather than collapsing it to api_key. A
      // subscription lane that round-tripped through here as api_key would
      // lose its command path and its document cap, and would then look like
      // a BYOK lane with no key -- silently skipped, with a misleading reason.
      const kind: FallbackLane['kind'] =
        entry?.kind === 'local' || entry?.kind === 'subscription'
          ? entry.kind
          : 'api_key';
      const rawCap = Number(entry?.doc_cap);
      const rawBatch = Number(entry?.batch_size);
      return {
        kind,
        provider: String(entry?.provider || ''),
        model: String(entry?.model || ''),
        endpoint: entry?.endpoint ? String(entry.endpoint) : undefined,
        base_url: entry?.base_url ? String(entry.base_url) : undefined,
        binary_path: entry?.binary_path ? String(entry.binary_path) : undefined,
        doc_cap: Number.isFinite(rawCap) && rawCap > 0 ? rawCap : undefined,
        // 1.8.5 — a lane that round-tripped without these would silently lose
        // the batch size and the effort level the user chose, and would then
        // run at the defaults while the form went on showing their selection.
        batch_size: Number.isFinite(rawBatch) && rawBatch > 0 ? rawBatch : undefined,
        effort: entry?.effort ? String(entry.effort) : undefined,
      };
    }).filter((lane: FallbackLane) => lane.provider);
  } catch {
    return [];
  }
};

/**
 * Compose the stored chain from the primary form plus the fallback lanes.
 *
 * Returns '' when there is nothing a chain can express that the legacy
 * single-provider keys cannot — so a user who never opens the fallback section
 * and runs an API-key or Ollama provider still stores no chain, and nothing
 * changes for them.
 *
 * **A subscription primary always emits the chain, even with no fallbacks**
 * (1.8.5). The legacy keys can carry a provider and a model and nothing else;
 * `binary_path`, `doc_cap`, `batch_size` and `effort` exist only on a lane. A
 * subscription primary written to the legacy keys alone would silently lose
 * the command path the user typed and run at the default cap and batch size
 * while the form went on showing their choices. The legacy keys are still
 * written alongside, for a downgrade to an older build.
 */
/**
 * Read lane 0's subscription-only fields back out of the stored chain.
 *
 * The counterpart to `composeChain`'s subscription branch. Those four fields
 * exist only on a lane, so if they are not read back here the form shows
 * defaults for values the user set, saves those defaults, and quietly reverts
 * their choice — the same class of bug as a writer emitting a field the reader
 * drops.
 */
const primaryFromChain = (raw: string): Partial<AISettingsState> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return {};
    const lane = parsed[0];
    if (!lane || lane.kind !== 'subscription') return {};
    const out: Partial<AISettingsState> = {};
    if (lane.binary_path) out.ai_cli_path = String(lane.binary_path);
    if (lane.effort) out.ai_effort = String(lane.effort);
    if (lane.doc_cap) out.ai_subscription_doc_cap = String(lane.doc_cap);
    if (lane.batch_size) out.ai_batch_size = String(lane.batch_size);
    return out;
  } catch {
    return {};
  }
};

const composeChain = (settings: AISettingsState, fallbacks: FallbackLane[]): string => {
  const isLocal = settings.ai_provider === 'local';
  const isSubscription = SUBSCRIPTION_PROVIDERS.includes(settings.ai_provider);
  if (!fallbacks.length && !isSubscription) return '';
  if (!settings.ai_provider) return '';

  const primary: FallbackLane & Record<string, unknown> = {
    kind: isSubscription ? 'subscription' : (isLocal ? 'local' : 'api_key'),
    provider: settings.ai_provider,
    model: isLocal ? settings.ai_local_model : settings.ai_model,
    ...(settings.ai_custom_base_url ? { base_url: settings.ai_custom_base_url } : {}),
  };
  if (isSubscription) {
    if (settings.ai_cli_path) primary.binary_path = settings.ai_cli_path;
    if (settings.ai_effort) primary.effort = settings.ai_effort;
    const cap = Number(settings.ai_subscription_doc_cap);
    if (Number.isFinite(cap) && cap > 0) primary.doc_cap = cap;
    const batch = Number(settings.ai_batch_size);
    if (Number.isFinite(batch) && batch > 0) primary.batch_size = batch;
  }
  return JSON.stringify([primary, ...fallbacks]);
};

const AISettings: React.FC = () => {
  const [settings, setSettings] = useState<AISettingsState>(DEFAULT_STATE);
  // 1.8b — the lanes *after* the primary. The stored ai_chain holds the whole
  // chain including lane 0; lane 0 is the provider form above, so it is
  // dropped on load and re-composed on save. That keeps one writer for it.
  const [fallbacks, setFallbacks] = useState<FallbackLane[]>([]);
  // 1.8c — where each agent CLI was found, or that it was not. Detection only;
  // it says nothing about whether the user is signed in.
  const [cliStatus, setCliStatus] = useState<CliStatus[]>([]);
  // 1.8.5 — per-provider model/effort catalogs for subscription lanes. Loaded
  // on demand rather than on mount: `codex debug models` starts a process, and
  // opening Settings should not.
  const [catalogs, setCatalogs] = useState<Record<string, SubscriptionCatalog>>({});
  // Shown only when the picker is unavailable — a button that silently does
  // nothing is worse than one that says why.
  const [cliPathNotice, setCliPathNotice] = useState('');

  // The primary form's Advanced disclosure. Undefined until the user touches
  // it, so the default can follow detection: open when the command was not
  // found, which is the only time the question is the next thing to answer.
  const [advancedTouched, setAdvancedTouched] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [keyMasked, setKeyMasked] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  // Update 2 — Feature 1: per-provider stored-key presence map. Keyed
  // by credential name (e.g. ``openai_api_key``). Refreshed after every
  // save / clear so the panel always reflects the current keyring state.
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});

  const loadSubscriptionCatalog = React.useCallback(
    async (provider: string, binaryPath?: string) => {
      try {
        const resp = await apiClient.post<SubscriptionCatalog>('/api/ai/models', {
          provider,
          ...(binaryPath ? { binary_path: binaryPath } : {}),
        });
        setCatalogs((prev) => ({
          ...prev,
          [provider]: {
            models: Array.isArray(resp?.models) ? resp.models : [],
            provenance: resp?.provenance || '',
            efforts: resp?.efforts || {},
            default_efforts: resp?.default_efforts || {},
            error: '',
          },
        }));
      } catch (err: any) {
        // The catalog is a convenience. Losing it costs the dropdown, never
        // the lane: free text still reaches the CLI, and the CLI's own
        // rejection is what the user sees if a model name is wrong.
        setCatalogs((prev) => ({
          ...prev,
          [provider]: {
            models: [], provenance: '', efforts: {}, default_efforts: {},
            error: err?.message || 'Could not load models for this command.',
          },
        }));
      }
    },
    [],
  );

  const refreshKeyPresence = React.useCallback(async () => {
    try {
      const resp = await apiClient.get<Record<string, { present: boolean }>>('/api/credentials');
      const next: Record<string, boolean> = {};
      Object.entries(resp || {}).forEach(([name, info]) => {
        next[name] = !!(info && info.present);
      });
      setKeyPresence(next);
    } catch {
      /* presence panel renders empty on error */
    }
  }, []);

  const refreshSettings = React.useCallback(async () => {
    try {
      const data = await apiClient.get<Partial<AISettingsState>>('/api/settings/ai');
      const merged: AISettingsState = { ...DEFAULT_STATE, ...(data || {}) };
      // IMPL-AI11 one-shot migration: if `ai_local_model` is empty and
      // `ai_tone` looks like an ollama model id on the local branch,
      // move it over and reset `ai_tone` to the documented default.
      if (
        merged.ai_provider === 'local'
        && !merged.ai_local_model
        && looksLikeModelId(merged.ai_tone)
      ) {
        merged.ai_local_model = merged.ai_tone;
        merged.ai_tone = 'technical';
      }
      if (!merged.ai_temperature) merged.ai_temperature = '0.2';
      if (!merged.ai_custom_header_prefix) merged.ai_custom_header_prefix = 'Bearer';
      // Lane 0's subscription-only fields live in the chain, not in the
      // legacy keys, so they have to be read back out of it or the form would
      // show defaults for values the user set.
      setSettings({ ...merged, ...primaryFromChain(merged.ai_chain) });
      setFallbacks(parseFallbacks(merged.ai_chain));
    } finally {
      setLoading(false);
    }
  }, []);

  // Detection is cheap (a few stat calls, no process is started) and only
  // matters when the panel is open, so it runs once on mount alongside the
  // rest. A failure leaves the list empty and the chain builder simply omits
  // the status line rather than claiming anything.
  const refreshCliStatus = React.useCallback(async () => {
    try {
      const data = await apiClient.get<{ providers: CliStatus[] }>(
        '/api/settings/ai/cli-status',
      );
      setCliStatus(Array.isArray(data?.providers) ? data.providers : []);
    } catch {
      setCliStatus([]);
    }
  }, []);

  // Fresh install: if nothing is configured and a CLI is sitting there, propose
  // it. **Proposing is selecting a provider in this form, and nothing else** —
  // it never sets ai_enabled, never saves, and never claims the lane works.
  // resmon cannot know whether the user is signed in until the first paper, and
  // a "ready" here would be a promise nobody checked. It also does not fire
  // once a provider is chosen, so it can never overwrite a choice.
  const proposedRef = React.useRef(false);
  useEffect(() => {
    if (proposedRef.current || loading) return;
    if (settings.ai_provider) return;
    if (settings.ai_chain) return;
    const found = cliStatus.find((c) => c.found);
    if (!found) return;
    proposedRef.current = true;
    setSettings((prev) => (prev.ai_provider ? prev : {
      ...prev, ai_provider: found.provider,
    }));
  }, [loading, cliStatus, settings.ai_provider, settings.ai_chain]);

  useEffect(() => {
    refreshSettings();
    refreshKeyPresence();
    refreshCliStatus();
    // Re-fetch whenever any other surface (the AIOverridePanel "Save as
    // default model" / "Save key" buttons, the table-row click below)
    // dispatches ``ai-settings-changed``. Keeps the table column 3 and
    // the "Default" row highlight in sync without a page reload.
    const handler = () => {
      refreshSettings();
      refreshKeyPresence();
    };
    window.addEventListener('ai-settings-changed', handler);
    return () => window.removeEventListener('ai-settings-changed', handler);
  }, [refreshSettings, refreshKeyPresence]);

  const credentialNameForProvider = (provider: string): string | null => {
    if (provider === 'local' || provider === '') return null;
    // A subscription lane authenticates through the CLI the user already
    // signed into. resmon never sees that credential and has no slot for it.
    if (SUBSCRIPTION_PROVIDERS.includes(provider)) return null;
    if (provider === 'custom') return 'custom_llm_api_key';
    return `${provider}_api_key`;
  };

  // Update 2 — Feature 1: stored-keys management. The list of provider
  // slots displayed in the "Stored API Keys" section, in the same order
  // as the Provider dropdown. ``local`` is excluded because it has no
  // remote API key.
  const STORED_KEY_SLOTS: { provider: string; label: string; credName: string }[] =
    PROVIDERS
      .filter((p) => p.value !== 'local' && !SUBSCRIPTION_PROVIDERS.includes(p.value))
      .map((p) => ({
        provider: p.value,
        label: p.label,
        credName: p.value === 'custom' ? 'custom_llm_api_key' : `${p.value}_api_key`,
      }));

  const handleClearStoredKey = async (credName: string, label: string) => {
    if (!window.confirm(`Clear the stored ${label} API key from the OS keychain?`)) return;
    try {
      await apiClient.delete(`/api/credentials/${credName}`);
      setStatus(`${label} key cleared.`);
      await refreshKeyPresence();
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    } catch (err: any) {
      setStatus(`Error: ${err?.message || 'Failed to clear key.'}`);
    }
    setTimeout(() => setStatus(''), 3000);
  };

  // Remove the saved default-model entry for ``provider`` from the
  // per-provider ``ai_default_models`` map. Sources the map from a
  // fresh GET so a stale React state cannot reintroduce other
  // providers' entries on the merged write. If ``provider`` is the
  // current app-default provider, also clears the live ``ai_model`` /
  // ``ai_local_model`` field so the table's fallback path doesn't keep
  // displaying the now-cleared value.
  const handleClearDefaultModel = async (provider: string, label: string) => {
    if (!window.confirm(`Clear the saved default model for ${label}?`)) return;
    try {
      const fresh = await apiClient.get<Partial<AISettingsState>>('/api/settings/ai');
      const freshMap = parseDefaultModels((fresh && fresh.ai_default_models) || '');
      const hadEntry = provider in freshMap;
      if (hadEntry) delete freshMap[provider];
      const payload: Record<string, string> = {
        ai_default_models: JSON.stringify(freshMap),
      };
      const isActive = (fresh && fresh.ai_provider) === provider;
      if (isActive) {
        if (provider === 'local') payload.ai_local_model = '';
        else payload.ai_model = '';
      }
      await apiClient.put('/api/settings/ai', { settings: payload });
      setSettings((prev) => ({
        ...prev,
        ai_default_models: payload.ai_default_models,
        ...(payload.ai_model !== undefined ? { ai_model: '' } : {}),
        ...(payload.ai_local_model !== undefined ? { ai_local_model: '' } : {}),
      }));
      setStatus(
        hadEntry
          ? `${label} default model cleared.`
          : `${label} had no saved default model.`,
      );
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    } catch (err: any) {
      setStatus(`Error: ${err?.message || 'Failed to clear default model.'}`);
    }
    setTimeout(() => setStatus(''), 3000);
  };

  // Update 2 follow-up: clicking a provider row makes it the app
  // default provider. The previously-saved default model for that
  // provider (if any) is auto-applied to the matching model field so
  // the rest of the panel updates consistently. Persists immediately
  // and dispatches ``ai-settings-changed`` so AIDefaultsInfo on the
  // Dive/Sweep/Routines pages refreshes too.
  const handleSetDefaultProvider = async (provider: string) => {
    setModels([]);
    setModelsError('');
    try {
      // Re-fetch the live settings group immediately before writing so
      // the per-provider ``ai_default_models`` map is sourced from the
      // backend (the source of truth) instead of from possibly-stale
      // React state. This prevents a save on this surface from
      // overwriting an entry that was just added by another writer
      // (e.g. ``AIOverridePanel.handleSaveDefaultModel``).
      const fresh = await apiClient.get<Partial<AISettingsState>>('/api/settings/ai');
      const freshMap = parseDefaultModels((fresh && fresh.ai_default_models) || '');
      const savedModel = freshMap[provider] || '';
      // Send a NARROW payload — no ``ai_default_models`` key at all.
      // The backend's ``_set_settings_group`` only writes keys present
      // in the payload, so the existing map is left untouched.
      const payload: Record<string, string> = {
        ai_provider: provider,
        ai_model: provider === 'local' ? (fresh?.ai_model || '') : savedModel,
        ai_local_model: provider === 'local' ? savedModel : (fresh?.ai_local_model || ''),
      };
      await apiClient.put('/api/settings/ai', { settings: payload });
      // Reflect the just-written values plus the freshly-fetched map
      // back into local state so the table re-renders consistently.
      setSettings({
        ...DEFAULT_STATE,
        ...(fresh || {}),
        ai_provider: payload.ai_provider,
        ai_model: payload.ai_model,
        ai_local_model: payload.ai_local_model,
      });
      setStatus(`${PROVIDERS.find((p) => p.value === provider)?.label || provider} set as default provider.`);
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    } catch (err: any) {
      setStatus(`Error: ${err?.message || 'Failed to set default provider.'}`);
    }
    setTimeout(() => setStatus(''), 3000);
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus('');
    try {
      // Update 2 — Feature 1 extension: persist the chosen Model as the
      // "default model" for the currently selected provider so future
      // provider switches can auto-fill the Model dropdown.
      //
      // Source the per-provider map from the BACKEND (source of truth)
      // immediately before the write, not from React state, so a stale
      // local copy can't clobber an entry that another writer (e.g. the
      // ``AIOverridePanel`` Save-as-default-model button) just added.
      const provider = settings.ai_provider;
      const chosenModel =
        provider === 'local' ? settings.ai_local_model : settings.ai_model;
      // Build the payload from the user's current form state but EXCLUDE
      // ``ai_default_models`` by default — backend preserves keys not in
      // the payload. Only include it when this Save needs to update the
      // map for the currently chosen provider.
      const payload: Record<string, string> = {
        ai_provider: settings.ai_provider,
        ai_model: settings.ai_model,
        ai_local_model: settings.ai_local_model,
        ai_summary_length: settings.ai_summary_length,
        ai_tone: settings.ai_tone,
        ai_temperature: settings.ai_temperature,
        ai_extraction_goals: settings.ai_extraction_goals,
        ai_custom_base_url: settings.ai_custom_base_url,
        ai_custom_header_prefix: settings.ai_custom_header_prefix,
        // 1.8b — written by this Save and nothing else, so lane 0 always
        // matches the provider selected above.
        ai_chain: composeChain(settings, fallbacks),
        // Written alongside the chain so an older build, which reads only the
        // legacy keys, still finds the command path and the cap.
        ai_cli_path: settings.ai_cli_path,
        ai_effort: settings.ai_effort,
        ai_subscription_doc_cap: settings.ai_subscription_doc_cap,
      };
      let mergedMap: Record<string, string> | null = null;
      if (provider && provider !== '' && chosenModel) {
        const fresh = await apiClient.get<Partial<AISettingsState>>('/api/settings/ai');
        const freshMap = parseDefaultModels((fresh && fresh.ai_default_models) || '');
        if (freshMap[provider] !== chosenModel) {
          freshMap[provider] = chosenModel;
          payload.ai_default_models = JSON.stringify(freshMap);
          mergedMap = freshMap;
        }
      }
      await apiClient.put('/api/settings/ai', { settings: payload });
      if (mergedMap) {
        setSettings({ ...settings, ai_default_models: JSON.stringify(mergedMap) });
      }
      if (apiKey) {
        const keyName = credentialNameForProvider(settings.ai_provider);
        if (keyName) {
          await apiClient.put(`/api/credentials/${keyName}`, { value: apiKey });
        }
        setApiKey('');
        await refreshKeyPresence();
      }
      setStatus('AI settings saved.');
      // Notify other surfaces (AIDefaultsInfo on Dive/Sweep/Routines)
      // that the persisted defaults have changed.
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setStatus(''), 3000);
    }
  };

  const handleTestKey = async () => {
    if (!apiKey) { setStatus('Enter an API key to test.'); return; }
    setStatus('Validating…');
    try {
      const payload: { provider: string; key: string; base_url?: string } = {
        provider: settings.ai_provider,
        key: apiKey,
      };
      if (settings.ai_provider === 'custom') {
        payload.base_url = settings.ai_custom_base_url.trim();
      }
      const resp = await apiClient.post<{ valid: boolean }>('/api/credentials/validate', payload);
      setStatus(resp.valid ? 'API key is valid.' : 'API key is invalid.');
    } catch (err: any) {
      setStatus(`Validation error: ${err.message}`);
    }
    setTimeout(() => setStatus(''), 5000);
  };

  // Fetch the list of models available to the user for the currently
  // selected provider. Uses the freshly-typed API key when present and
  // otherwise relies on the backend to fall back to the stored credential.
  const handleLoadModels = async () => {
    setModelsError('');
    setModelsLoading(true);
    try {
      const payload: {
        provider: string;
        key?: string;
        base_url?: string;
        header_prefix?: string;
        endpoint?: string;
      } = { provider: settings.ai_provider };
      if (apiKey) payload.key = apiKey;
      if (settings.ai_provider === 'custom') {
        payload.base_url = settings.ai_custom_base_url.trim();
        payload.header_prefix = settings.ai_custom_header_prefix.trim() || 'Bearer';
      }
      if (settings.ai_provider === 'local') {
        payload.endpoint = (settings.ai_model || 'http://localhost:11434').trim();
      }
      const resp = await apiClient.post<{ models: string[] }>('/api/ai/models', payload);
      const list = Array.isArray(resp.models) ? resp.models : [];
      setModels(list);
      if (list.length === 0) {
        setModelsError('Provider returned no models.');
      }
    } catch (err: any) {
      setModels([]);
      setModelsError(err?.message || 'Failed to load models.');
    } finally {
      setModelsLoading(false);
    }
  };

  // Reset the fetched model list whenever the provider changes so stale
  // entries from another provider cannot be selected by mistake. Update
  // 2 — Feature 1 extension: also auto-fill the Model dropdown with the
  // previously saved default model for ``next`` (if any), or clear it
  // otherwise so the dropdown returns to its "Select a model" state.
  const handleProviderChange = (next: string) => {
    const map = parseDefaultModels(settings.ai_default_models);
    const savedModel = map[next] || '';
    setSettings({
      ...settings,
      ai_provider: next,
      // For remote providers the saved default lives in ``ai_model``; for
      // ``local`` it lives in ``ai_local_model`` (the Ollama-endpoint
      // input occupies ``ai_model`` on that branch). Clearing the
      // sibling field prevents a stale value from another provider from
      // leaking onto the new branch.
      ai_model: next === 'local' ? settings.ai_model : savedModel,
      ai_local_model: next === 'local' ? savedModel : settings.ai_local_model,
    });
    setModels([]);
    setModelsError('');
  };

  if (loading) return <p className="text-muted">Loading…</p>;

  // A subscription lane is neither "remote" nor "local": it has no API key to
  // store, no endpoint, and no credential slot. Folding it into isRemote would
  // put an API Key field and a keyring row in front of a lane that has neither.
  const isSubscription = SUBSCRIPTION_PROVIDERS.includes(settings.ai_provider);
  const isRemote = settings.ai_provider !== ''
    && settings.ai_provider !== 'local'
    && !isSubscription;
  const providerSelected = settings.ai_provider !== '';
  const isCustom = settings.ai_provider === 'custom';
  const primaryCliStatus = cliStatus.find((c) => c.provider === settings.ai_provider);
  const primaryCatalog = catalogs[settings.ai_provider];
  const primaryAdvancedOpen = advancedTouched !== null
    ? advancedTouched
    : (primaryCliStatus ? !primaryCliStatus.found : false);
  const setPrimaryAdvancedOpen = (open: boolean) => setAdvancedTouched(open);
  // Effort levels for the chosen model, falling back to the union of what any
  // listed model supports. The CLI rejects a level its model does not take and
  // resmon passes that message through rather than pre-judging it.
  const primaryEffortLevels: string[] = (() => {
    if (!primaryCatalog) return [];
    if (settings.ai_model && primaryCatalog.efforts[settings.ai_model]) {
      return primaryCatalog.efforts[settings.ai_model];
    }
    const union = new Set<string>();
    Object.values(primaryCatalog.efforts).forEach((ls) => ls.forEach((l) => union.add(l)));
    return Array.from(union);
  })();
  const customBaseUrlError = isCustom ? validateCustomBaseUrl(settings.ai_custom_base_url) : null;
  const saveDisabled = saving || customBaseUrlError !== null;

  return (
    <div className="settings-section">
      <div className="settings-panel-header">
        <h2>AI Configuration</h2>
        <TutorialLinkButton anchor="settings-ai" />
      </div>
      <PageHelp
        storageKey="settings-ai"
        title="AI Configuration"
        summary="Configure the LLM provider, model, and default prompt parameters."
        sections={[
          {
            heading: 'What this tab does',
            body: (
              <p>
                Selects the LLM provider (OpenAI, Anthropic, Google, xAI,
                Meta, DeepSeek, Alibaba, a local model, or a custom
                OpenAI-compatible endpoint) and stores its API key in the
                OS keychain. These values are only used when an execution
                has <strong>AI summarization</strong> enabled.
              </p>
            ),
          },
          {
            heading: 'Key fields',
            body: (
              <ul>
                <li><strong>Provider / Model</strong> — the backend and the specific model ID.</li>
                <li><strong>Length</strong> — target summary length band (brief / standard / detailed).</li>
                <li><strong>Tone</strong> — writing style (technical / neutral / accessible).</li>
                <li><strong>Custom Base URL</strong> — only for the <em>Custom</em> provider; must be HTTPS (or a loopback HTTP address).</li>
                <li><strong>API Key</strong> — stored in the OS keychain, never echoed back.</li>
              </ul>
            ),
          },
          {
            heading: 'Using a plan you already pay for',
            body: (
              <>
                <p>
                  A <strong>subscription lane</strong> runs the Claude Code or
                  Codex command you already installed and signed into, so the
                  work is billed to your existing plan rather than a metered
                  key. Add one under <em>If that fails, try…</em>. resmon never
                  embeds provider sign-in and never sees your credential; if the
                  CLI is not signed in, the lane reports that and stands down.
                </p>
                <p>
                  <strong>It is the recommended route as of 1.8.5</strong>,
                  because batching made it affordable. Papers go{' '}
                  <strong>five at a time in one call</strong> rather than one
                  session each, and measured against the same abstracts one at a
                  time a paper costs <strong>0.33× as much</strong> and{' '}
                  <strong>0.23× the input-side tokens</strong> — the constitution
                  and the prompt scaffold are about 5,600 tokens paid once per
                  call instead of once per paper. It still spends your own
                  window, so a lane is capped at{' '}
                  <strong>50 papers per run</strong> by default. Reaching the cap
                  is not an error — the remaining papers go to the next lane and
                  the execution records the cap as the reason.
                </p>
                <p>
                  A batched call asks for one numbered summary per paper. A
                  paper the batch did not answer for is re-sent on its own; if
                  the numbering comes back inconsistent, the whole batch is
                  re-sent one paper at a time, because a summary attached to the
                  wrong paper is a quieter failure than no summary at all.
                </p>
                <p>
                  <strong>Model and effort are per lane.</strong> Codex reports
                  a real model catalog and the reasoning levels each model
                  supports, so only those are offered. Claude Code has no
                  models command, so the list is the aliases its help documents
                  — names the command accepts, not models resmon has confirmed
                  your account can reach. Leaving either unset means the
                  command&rsquo;s own default.
                </p>
                <p>
                  There is <strong>no effort control for API-key providers</strong>,
                  because none of the eight has one. Where a provider does have
                  a thinking control it will be offered per provider once it has
                  been verified; offering one knob that silently did nothing for
                  most of them would claim more than resmon delivers.
                </p>
                <p>
                  resmon looks for the command at the path you set, then where
                  the installers put it, then on <code>PATH</code> last. That
                  order matters: an app launched from the Finder inherits a
                  <code>PATH</code> containing neither CLI, while a terminal
                  finds both. The lane shows which route found your command, and
                  lists the paths it searched when it found nothing.
                </p>
              </>
            ),
          },
          {
            heading: 'The assistant — the ✦ Ask panel in the corner',
            body: (
              <>
                <p>
                  The <strong>Assistant</strong> section configures the panel
                  behind the <strong>✦ Ask</strong> button on every page. It runs
                  the same <code>claude</code> command as the primary lane above,
                  so setting the path once is enough, and adds a model and an
                  effort level.
                </p>
                <p>
                  It is given resmon's own tools and nothing else — no built-in
                  tools, none of your own MCP servers or skills, an empty working
                  directory. Everything it tells you came from a tool call it
                  made in that conversation; it has no other source.
                </p>
                <p>
                  <strong>Anything that changes something waits for you.</strong>{' '}
                  A write appears as a card with the exact call on it and does
                  not run until you press Allow. That is enforced outside the
                  model: only the read tools are pre-approved, and every other
                  call goes through a permission tool resmon serves and the
                  assistant cannot invoke. Deleting, erasing, resetting, writing
                  a credential, installing the background service and linking
                  cloud storage are not in its tools at all.
                </p>
                <p>
<<<<<<< HEAD
                  <strong>No CLI? Use a key instead.</strong> <em>Run it with</em>{' '}
                  chooses between the <code>claude</code> command and an API key of
                  your own. The API-key route is the same panel, the same tools and
                  the same card; resmon runs the loop itself. Three things differ:
                  it reports <strong>tokens rather than money</strong>, because a
                  provider API reports tokens and resmon maintains no price list; a
                  turn stops after eight tool steps or 100,000 tokens; and it
                  remembers what was <em>said</em> rather than what the tools
                  returned, so a long conversation does not re-send a corpus.
                </p>
                <p>
=======
>>>>>>> upstream/main
                  <strong>Conversations live in two places, and they can drift
                  apart.</strong> resmon keeps the transcript; the{' '}
                  <code>claude</code> command keeps the conversation the model
                  can actually see. If that one goes — you cleared the CLI's
                  history, or restored resmon's database onto a different
                  machine — the next thing you send is answered in a fresh
                  session, and the panel says so in place. Your earlier messages
                  stay on screen; the assistant can no longer see them.
                </p>
                <p>
                  <strong>Codex is not offered here.</strong> resmon can give a
                  Codex session its own tools but cannot take away Codex's shell,
                  and <code>codex exec</code> has no way for you to approve a
                  command before it runs. Codex is still a summarisation lane,
                  where it is given no tools at all.
                </p>
              </>
            ),
          },
          {
            heading: 'Embeddings — a separate model, for search rather than summaries',
            body: (
              <>
                <p>
                  The <strong>Embeddings</strong> section at the bottom of this tab
                  configures a different kind of model: one that turns each paper&rsquo;s
                  title and abstract into a vector. That is what lets the Explorer sort by{' '}
                  <em>closest to what you meant</em> and show{' '}
                  <strong>Papers like this one</strong>. It has nothing to do with
                  summaries and can be used with or without them.
                </p>
                <p>
                  <strong>An Anthropic key cannot do this</strong> — Anthropic does not
                  offer an embeddings API — and <strong>neither agent CLI can either</strong>:
                  the Claude Code and Codex commands have no embedding command, so a
                  subscription that covers your summaries does not cover semantic search.
                  Both are still listed in the provider menu, disabled, with the reason, so
                  you can see why rather than wonder where they went.
                </p>
                <p>
                  A local model is the recommended start: <code>ollama pull
                  nomic-embed-text</code>, select <em>Ollama</em>, and probe. It costs
                  nothing and nothing leaves your machine. Note that a server which lists
                  models can still refuse to embed — an ordinary chat model is not an
                  embedding model — and the probe reports that in as many words.
                </p>
                <p>
                  Embedding happens automatically after each sweep for the papers it found.
                  Everything already in your corpus needs the one-off{' '}
                  <strong>backfill</strong>, which can be stopped and restarted freely: it
                  always resumes from what is missing rather than from where it stopped, so
                  nothing is embedded twice and nothing is skipped.
                </p>
              </>
            ),
          },
          {
            heading: 'Per-execution override',
            body: (
              <p>
                The Deep Dive / Sweep pages expose an <em>Override AI
                settings for this run</em> disclosure that lets you change
                length, tone, or model for a single execution without
                touching the app-wide defaults here.
              </p>
            ),
          },
        ]}
      />
      {/*
        The Stored API Keys table is intentionally rendered OUTSIDE the
        ``.settings-form`` block below: that block has ``max-width:
        480px`` (see ``global.css``) which is appropriate for the
        single-column form fields but too narrow for a four-column
        provider table. Giving the table its own wider container keeps
        the rest of the panel's form fields at their original width.
      */}
      <div
        className="form-field"
        style={{ width: 'min(960px, 100%)', marginBottom: 14 }}
      >
        <label className="form-label">Stored API Keys</label>
        <div className="text-muted" style={{ fontSize: '0.85em', marginBottom: 6 }}>
          Each provider has its own permanent key slot in the OS
          keychain. Switching providers below adds or replaces the
          key for that provider only — keys for other providers are
          preserved. <strong>Click the provider name</strong> in the
          first column to make that provider the app default.
        </div>
        <table
          className="data-table"
          style={{
            marginBottom: 4,
            width: '100%',
            borderCollapse: 'separate',
            borderSpacing: '12px 6px',
          }}
        >
          <thead>
            <tr>
              <th style={{ width: '15%' }}>Provider</th>
              <th style={{ width: '20%' }}>Status</th>
              <th style={{ width: '25%' }}>Default Model</th>
              <th style={{ width: '40%' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {STORED_KEY_SLOTS.map((slot) => {
              const present = !!keyPresence[slot.credName];
              const defaultModelMap = parseDefaultModels(settings.ai_default_models);
              // Resolve the displayed default model with the same
              // precedence used by ``AIDefaultsInfo`` on Dive/Sweep/
              // Routines so the two surfaces never disagree:
              //   1. per-provider entry in ``ai_default_models``
              //   2. for the current app-default provider only,
              //      fall back to the live ``ai_model`` /
              //      ``ai_local_model`` field (this catches the case
              //      where the user saved via Settings → AI's main
              //      Save button before the per-provider map existed).
              const isDefault = settings.ai_provider === slot.provider;
              let defaultModel = defaultModelMap[slot.provider] || '';
              if (!defaultModel && isDefault) {
                defaultModel =
                  slot.provider === 'local'
                    ? (settings.ai_local_model || '').trim()
                    : (settings.ai_model || '').trim();
              }
              const hasMapEntry = !!defaultModelMap[slot.provider];
              const canClearDefaultModel = hasMapEntry || (isDefault && !!defaultModel);
              return (
                <tr
                  key={slot.credName}
                  style={{
                    background: isDefault ? 'var(--surface-2, rgba(0, 100, 200, 0.08))' : undefined,
                    fontWeight: isDefault ? 600 : undefined,
                  }}
                >
                  <td>
                    <span
                      onClick={() => handleSetDefaultProvider(slot.provider)}
                      style={{
                        cursor: 'pointer',
                        textDecoration: isDefault ? 'none' : 'underline',
                      }}
                      title={
                        isDefault
                          ? 'This provider is the current app default.'
                          : `Click to set ${slot.label} as the app default provider.`
                      }
                    >
                      {slot.label}
                    </span>
                  </td>
                  <td>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      {present ? (
                        <span className="badge badge-success">Stored</span>
                      ) : (
                        <span className="text-muted">Not set</span>
                      )}
                      {isDefault && (
                        <span className="badge badge-success">Default</span>
                      )}
                    </div>
                  </td>
                  <td>
                    {defaultModel ? (
                      <span className="badge badge-default-model">{defaultModel}</span>
                    ) : (
                      <span className="text-muted">Not set</span>
                    )}
                  </td>
                  <td>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'nowrap',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={!canClearDefaultModel}
                        onClick={() => handleClearDefaultModel(slot.provider, slot.label)}
                        style={{ whiteSpace: 'nowrap' }}
                        title={
                          canClearDefaultModel
                            ? `Clear the saved default model for ${slot.label}.`
                            : `${slot.label} has no saved default model.`
                        }
                      >
                        Clear default model
                      </button>
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={!present}
                        onClick={() => handleClearStoredKey(slot.credName, slot.label)}
                        style={{ whiteSpace: 'nowrap' }}
                        title={
                          present
                            ? `Clear the stored ${slot.label} API key.`
                            : `${slot.label} has no stored API key.`
                        }
                      >
                        Clear API key
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="settings-form">
        <div className="form-field">
          <label className="form-label">Provider</label>
          <select
            className="form-select"
            aria-label="Provider"
            value={settings.ai_provider}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            <option value="">Select provider</option>
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>

        {isCustom && (
          <>
            <div className="form-field">
              <label className="form-label">Base URL</label>
              <input
                className="form-input"
                value={settings.ai_custom_base_url}
                onChange={(e) => setSettings({ ...settings, ai_custom_base_url: e.target.value })}
                placeholder="https://api.together.xyz/v1"
              />
              {customBaseUrlError && <div className="form-error">{customBaseUrlError}</div>}
            </div>
            <div className="form-field">
              <label className="form-label">Auth Header Prefix</label>
              <input
                className="form-input"
                value={settings.ai_custom_header_prefix}
                onChange={(e) => setSettings({ ...settings, ai_custom_header_prefix: e.target.value })}
                placeholder="Bearer"
              />
            </div>
          </>
        )}

        {isRemote && (
          <>
            <div className="form-field">
              <label className="form-label">API Key</label>
              <div className="key-input-row">
                <input
                  className="form-input"
                  type={keyMasked ? 'password' : 'text'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter API key"
                  autoComplete="off"
                />
                <button className="btn btn-sm" type="button" onClick={() => setKeyMasked(!keyMasked)}>
                  {keyMasked ? 'Show' : 'Hide'}
                </button>
                <button className="btn btn-sm" type="button" onClick={handleTestKey}>Test</button>
              </div>
            </div>
            <div className="form-field">
              <label className="form-label">Model</label>
              <div className="key-input-row">
                <select
                  className="form-select"
                  value={settings.ai_model}
                  onChange={(e) => setSettings({ ...settings, ai_model: e.target.value })}
                >
                  <option value="">
                    {models.length ? 'Select a model' : 'Load models to populate this list'}
                  </option>
                  {/* Preserve the saved value even if it is not in the fetched list. */}
                  {settings.ai_model && !models.includes(settings.ai_model) && (
                    <option value={settings.ai_model}>{settings.ai_model} (saved)</option>
                  )}
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={handleLoadModels}
                  disabled={modelsLoading}
                >
                  {modelsLoading ? 'Loading…' : 'Load models'}
                </button>
              </div>
              {modelsError && <div className="form-error">{modelsError}</div>}
              <div className="text-muted" style={{ fontSize: '0.85em', marginTop: 4 }}>
                Suggested: {MODEL_PLACEHOLDERS[settings.ai_provider] ?? 'see provider docs'}
              </div>
            </div>
          </>
        )}

        {isSubscription && (
          <>
            {proposedRef.current && (
              <div className="form-field">
                <p className="text-muted" style={{ margin: 0 }}>
                  resmon found this command on your machine and selected it.
                  Nothing is switched on yet — AI summarization stays off until
                  you turn it on for a run, and resmon cannot tell whether you
                  are signed in until the first paper.
                </p>
              </div>
            )}

            <div className="form-field">
              <p className="text-muted" style={{ margin: 0 }}>
                <strong>This spends your own plan.</strong> resmon runs the{' '}
                {settings.ai_provider === 'codex' ? 'Codex' : 'Claude Code'}{' '}
                command you already installed and signed into, so summaries draw
                on the same{' '}
                {settings.ai_provider === 'codex' ? 'ChatGPT' : 'Claude'} usage
                window you use for your own work. resmon never sees or stores
                your sign-in. Papers are sent five at a time in one call, and a
                run sends at most{' '}
                <strong>
                  {settings.ai_subscription_doc_cap || DEFAULT_DOC_CAP} papers
                </strong>{' '}
                to this lane.
              </p>
              {primaryCliStatus && (
                <p
                  className="text-muted"
                  style={{ margin: '0.3rem 0 0' }}
                  data-testid={`primary-cli-status-${settings.ai_provider}`}
                >
                  {primaryCliStatus.found ? '✓ ' : '⚠ '}
                  {primaryCliStatus.detail}
                  {!primaryCliStatus.found && (
                    <> Looked in: {primaryCliStatus.tried.join(', ')}.</>
                  )}{' '}
                  resmon has not checked whether you are signed in — that shows
                  up on the first paper, and is recorded on the run.
                </p>
              )}
            </div>

            <div className="form-field">
              <label className="form-label">Model</label>
              <div className="key-input-row">
                <select
                  className="form-select"
                  aria-label="Primary model"
                  value={settings.ai_model}
                  onChange={(e) => setSettings({ ...settings, ai_model: e.target.value })}
                >
                  <option value="">CLI default</option>
                  {settings.ai_model
                    && !(primaryCatalog?.models || []).includes(settings.ai_model) && (
                    <option value={settings.ai_model}>{settings.ai_model} (saved)</option>
                  )}
                  {(primaryCatalog?.models || []).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <button
                  className="btn btn-sm"
                  type="button"
                  aria-label={`Load ${settings.ai_provider} models`}
                  onClick={() => loadSubscriptionCatalog(
                    settings.ai_provider, settings.ai_cli_path || undefined,
                  )}
                >
                  Load models
                </button>
              </div>
              {primaryCatalog?.provenance && (
                <div className="text-muted" style={{ fontSize: '0.85em', marginTop: 4 }}>
                  {primaryCatalog.provenance}
                </div>
              )}
              {primaryCatalog?.error && (
                <div className="form-error">{primaryCatalog.error}</div>
              )}
            </div>

            <div className="form-field">
              <label className="form-label">Effort</label>
              <select
                className="form-select"
                aria-label="Primary effort"
                value={settings.ai_effort}
                onChange={(e) => setSettings({ ...settings, ai_effort: e.target.value })}
              >
                <option value="">CLI default</option>
                {primaryEffortLevels.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
              <div className="text-muted" style={{ fontSize: '0.85em', marginTop: 4 }}>
                How hard the command thinks about each summary. Only the agent
                CLIs have this — none of the API-key providers does, so no
                effort control is offered for them.
              </div>
            </div>

            <div className="form-field">
              <label className="form-label">Papers per run</label>
              <input
                className="form-input"
                type="number"
                min={1}
                style={{ width: '7rem' }}
                aria-label="Primary document limit"
                value={settings.ai_subscription_doc_cap || DEFAULT_DOC_CAP}
                onChange={(e) => setSettings({
                  ...settings, ai_subscription_doc_cap: e.target.value,
                })}
              />
              <div className="text-muted" style={{ fontSize: '0.85em', marginTop: 4 }}>
                Anything past this goes to the next lane, and the run records
                the limit as the reason. It is not an error.
              </div>
            </div>

            <details
              open={primaryAdvancedOpen}
              onToggle={(e) => setPrimaryAdvancedOpen((e.target as HTMLDetailsElement).open)}
              className="form-field"
            >
              <summary className="text-muted" style={{ cursor: 'pointer' }}>
                Advanced
              </summary>
              <label className="form-label" style={{ marginTop: '0.3rem' }}>
                Where is the{' '}
                <code>{settings.ai_provider === 'codex' ? 'codex' : 'claude'}</code>{' '}
                command?
              </label>
              <div className="key-input-row">
                <input
                  className="form-input"
                  aria-label="Primary command path"
                  placeholder={
                    settings.ai_provider === 'codex'
                      ? '/Applications/ChatGPT.app/Contents/Resources/codex'
                      : '/Users/you/.local/bin/claude'
                  }
                  value={settings.ai_cli_path}
                  onChange={(e) => setSettings({ ...settings, ai_cli_path: e.target.value })}
                />
                {/*
                  Typing the path is the fallback, not the route. Both CLIs live
                  where a plain open panel will not take you — `claude` under a
                  hidden `~/.local`, `codex` inside `ChatGPT.app` — so the
                  picker asks for hidden files and for permission to descend
                  into an app bundle. See `resmon:choose-file` in main.ts.
                */}
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label="Browse for the command"
                  onClick={async () => {
                    const picker = window.resmonAPI?.chooseFile;
                    if (!picker) {
                      // The browser build has no main process to ask. Say so
                      // rather than doing nothing: the field still accepts a
                      // typed path.
                      setCliPathNotice(
                        'The file picker is only available inside the resmon desktop app — '
                        + 'type the path instead.',
                      );
                      return;
                    }
                    const picked = await picker(settings.ai_cli_path || undefined);
                    if (picked) {
                      setCliPathNotice('');
                      setSettings((prev) => ({ ...prev, ai_cli_path: picked }));
                    }
                  }}
                >
                  Browse…
                </button>
              </div>
              {cliPathNotice && (
                <div className="form-error" data-testid="cli-path-notice">{cliPathNotice}</div>
              )}
              <p className="text-muted" style={{ margin: '0.2rem 0 0' }}>
                Only needed when resmon could not find the command on its own.
                Leave it empty and resmon looks where the installers put it,
                then on <code>PATH</code>.
              </p>
            </details>
          </>
        )}

        {settings.ai_provider === 'local' && (
          <>
            <div className="form-field">
              <label className="form-label">Ollama Endpoint</label>
              <input className="form-input" value={settings.ai_model} onChange={(e) => setSettings({ ...settings, ai_model: e.target.value })} placeholder="http://localhost:11434" />
            </div>
            <div className="form-field">
              <label className="form-label">Model</label>
              <div className="key-input-row">
                <select
                  className="form-select"
                  value={settings.ai_local_model}
                  onChange={(e) => setSettings({ ...settings, ai_local_model: e.target.value })}
                >
                  <option value="">
                    {models.length ? 'Select a model' : 'Load models to populate this list'}
                  </option>
                  {settings.ai_local_model && !models.includes(settings.ai_local_model) && (
                    <option value={settings.ai_local_model}>{settings.ai_local_model} (saved)</option>
                  )}
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={handleLoadModels}
                  disabled={modelsLoading}
                >
                  {modelsLoading ? 'Loading…' : 'Load models'}
                </button>
              </div>
              {modelsError && <div className="form-error">{modelsError}</div>}
            </div>
          </>
        )}

        {providerSelected && (
          <>
            <div className="form-field">
              <label className="form-label">
                Summary Length
                <InfoTooltip text="Target length band for each AI summary. 'Brief' aims for a tight one-paragraph synopsis, 'Standard' a typical multi-paragraph summary, and 'Detailed' a longer summary that retains more methodological and quantitative detail." />
              </label>
              <select className="form-select" value={settings.ai_summary_length} onChange={(e) => setSettings({ ...settings, ai_summary_length: e.target.value })}>
                <option value="">Default</option>
                <option value="brief">Brief</option>
                <option value="standard">Standard</option>
                <option value="detailed">Detailed</option>
              </select>
            </div>

            <div className="form-field">
              <label className="form-label">
                Tone
                <InfoTooltip text="Writing style for each AI summary. 'Technical' preserves domain-specific terminology and is the safest default for research literature; 'Neutral' aims for plain, even prose; 'Accessible' rephrases jargon for a general audience." />
              </label>
              <select className="form-select" value={settings.ai_tone} onChange={(e) => setSettings({ ...settings, ai_tone: e.target.value })}>
                <option value="">Default</option>
                <option value="technical">Technical</option>
                <option value="neutral">Neutral</option>
                <option value="accessible">Accessible</option>
              </select>
            </div>

            <div className="form-field">
              <label className="form-label">
                Temperature
                <InfoTooltip text="Sampling temperature passed to the LLM (0–1). Lower values produce more deterministic, conservative summaries; higher values let the model take more creative liberties with phrasing. The default is 0.2, which is appropriate for factual scientific summarization." />
              </label>
              <input
                className="form-input"
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={settings.ai_temperature}
                onChange={(e) => setSettings({ ...settings, ai_temperature: e.target.value })}
              />
            </div>

            <div className="form-field">
              <label className="form-label">
                Extraction Goals
                <InfoTooltip text="Optional, comma-separated list of facets the summary should explicitly try to extract from each abstract — e.g. 'key findings, methodology, contributions, limitations'. Leave blank for the model's default summarization behavior." />
              </label>
              <input
                className="form-input"
                value={settings.ai_extraction_goals}
                onChange={(e) => setSettings({ ...settings, ai_extraction_goals: e.target.value })}
                placeholder="key findings, methodology, contributions"
              />
            </div>
          </>
        )}

        <FallbackChain
          cliStatus={cliStatus}
          catalogs={catalogs}
          onLoadCatalog={loadSubscriptionCatalog}
          lanes={fallbacks}
          onChange={setFallbacks}
          primaryLabel={
            settings.ai_provider
              ? `${settings.ai_provider}${
                  (settings.ai_provider === 'local' ? settings.ai_local_model : settings.ai_model)
                    ? ` · ${settings.ai_provider === 'local' ? settings.ai_local_model : settings.ai_model}`
                    : ''
                }`
              : ''
          }
          disabled={saving}
        />

        <div className="form-actions">
          <button className="btn btn-primary" onClick={handleSave} disabled={saveDisabled}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
        {status && <div className={status.startsWith('Error') || status.includes('invalid') || status.includes('error') ? 'form-error' : 'form-success'}>{status}</div>}
      </div>

      {/*
        A separate card with its own save, because embeddings are a separate
        feature with a separate lane. A user who wants semantic search and no AI
        summaries -- or the reverse -- should not have to configure both, and
        folding them into one form would imply they are one setting.
      */}
      <AssistantSettings />
      <EmbeddingSettings />
    </div>
  );
};

export default AISettings;

// Exported for tests. These two are the whole of lane 0's round trip — the
// chain is written by one place and read by one place, and a field the writer
// emits but the reader drops is a setting that silently reverts to its
// default while the form goes on showing the user's choice.
export { composeChain, parseFallbacks, primaryFromChain };
