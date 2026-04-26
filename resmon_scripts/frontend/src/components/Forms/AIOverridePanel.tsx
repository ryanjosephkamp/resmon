import React, { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../../api/client';

/**
 * Update 2 — Feature 2.
 *
 * Shared per-execution AI-override panel used by Deep Dive, Deep Sweep,
 * and Routines. Mirrors the Settings → AI control set (Provider, Model,
 * Length, Tone, Temperature, Extraction Goals) with a "Use app default"
 * blank option for every field.
 *
 * The component is intentionally controlled and stateless: callers hold
 * the ``AIOverrideValue`` dict, render whatever framing they like (an
 * inline ``<details>``, a modal section, etc.), and pass empty strings
 * through to the request body. The backend's ``_normalize_ai_override``
 * helper drops empty / blank values before merging, so a half-filled
 * override block surgically replaces only the populated fields.
 *
 * Update 2 follow-up: the panel now also lets the user enter and save
 * a missing API key for the selected provider (so "Load models" works
 * without leaving the page) and to save the currently-selected model
 * as the per-provider default that powers the Settings → AI table.
 */
export interface AIOverrideValue {
  provider: string;
  model: string;
  length: string;
  tone: string;
  temperature: string;
  extraction_goals: string;
}

export const EMPTY_AI_OVERRIDE: AIOverrideValue = {
  provider: '',
  model: '',
  length: '',
  tone: '',
  temperature: '',
  extraction_goals: '',
};

const PROVIDERS: { value: string; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai',    label: 'OpenAI' },
  { value: 'google',    label: 'Google' },
  { value: 'xai',       label: 'xAI' },
  { value: 'meta',      label: 'Meta' },
  { value: 'deepseek',  label: 'DeepSeek' },
  { value: 'alibaba',   label: 'Alibaba' },
  { value: 'local',     label: 'Local' },
  { value: 'custom',    label: 'Custom' },
];

interface Props {
  value: AIOverrideValue;
  onChange: (next: AIOverrideValue) => void;
}

/**
 * Strip empty / blank string fields from an override dict so they aren't
 * sent to the backend. Used by every consumer of ``AIOverridePanel``
 * before posting to ``/api/search/dive``, ``/api/search/sweep``, or
 * ``/api/routines``.
 */
export const buildAIOverridePayload = (
  v: AIOverrideValue,
): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v.provider) out.provider = v.provider;
  if (v.model.trim()) out.model = v.model.trim();
  if (v.length) out.length = v.length;
  if (v.tone) out.tone = v.tone;
  if (v.temperature.trim()) out.temperature = v.temperature.trim();
  if (v.extraction_goals.trim()) out.extraction_goals = v.extraction_goals.trim();
  return out;
};

// Derive the OS-keychain credential name for a remote provider. Mirrors
// the mapping in Settings → AI so both surfaces address the same slot.
const credentialNameForProvider = (provider: string): string | null => {
  if (!provider || provider === 'local') return null;
  if (provider === 'custom') return 'custom_llm_api_key';
  return `${provider}_api_key`;
};

const AIOverridePanel: React.FC<Props> = ({ value, onChange }) => {
  const set = <K extends keyof AIOverrideValue>(key: K, v: AIOverrideValue[K]) =>
    onChange({ ...value, [key]: v });

  // Load-models state mirrors the Settings → AI panel: the dropdown is
  // empty until the user clicks "Load models", which calls
  // ``/api/ai/models`` with the selected provider. The backend falls
  // back to the stored credential for that provider, so no API-key
  // entry is required when one is already saved.
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');

  // Per-provider stored-key presence (refreshed on mount + whenever the
  // user saves/clears a key). Keyed by credential name.
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyMasked, setKeyMasked] = useState(true);
  const [savingKey, setSavingKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState('');

  // "Save as default model" state.
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultStatus, setDefaultStatus] = useState('');

  const refreshKeyPresence = useCallback(async () => {
    try {
      const resp = await apiClient.get<Record<string, { present: boolean }>>('/api/credentials');
      const next: Record<string, boolean> = {};
      Object.entries(resp || {}).forEach(([name, info]) => {
        next[name] = !!(info && info.present);
      });
      setKeyPresence(next);
    } catch {
      /* empty presence on error */
    }
  }, []);

  useEffect(() => {
    refreshKeyPresence();
  }, [refreshKeyPresence]);

  // Reset the fetched model list, key-input buffer, and inline statuses
  // whenever the provider override changes so stale entries from
  // another provider can't be selected by mistake. The parent's
  // ``value.model`` is cleared inline by the Provider ``<select>``
  // onChange handler below so it stays in lock-step with this reset.
  useEffect(() => {
    setModels([]);
    setModelsError('');
    setApiKeyInput('');
    setKeyStatus('');
    setDefaultStatus('');
  }, [value.provider]);

  const credName = credentialNameForProvider(value.provider);
  const keyStored = credName ? !!keyPresence[credName] : false;
  // ``local`` needs an Ollama endpoint, not an API key — and Custom
  // requires a base URL we don't capture here. The inline key-entry UI
  // is therefore limited to the standard remote providers.
  const showKeyEntry =
    !!value.provider && value.provider !== 'local' && value.provider !== 'custom' && !keyStored;

  const handleSaveKey = async () => {
    if (!credName || !apiKeyInput.trim()) return;
    setSavingKey(true);
    setKeyStatus('');
    try {
      await apiClient.put(`/api/credentials/${credName}`, { value: apiKeyInput.trim() });
      setApiKeyInput('');
      setKeyStatus('API key saved.');
      await refreshKeyPresence();
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    } catch (err: any) {
      setKeyStatus(`Error: ${err?.message || 'Failed to save key.'}`);
    } finally {
      setSavingKey(false);
      setTimeout(() => setKeyStatus(''), 3000);
    }
  };

  const handleLoadModels = async () => {
    if (!value.provider) {
      setModelsError('Select a provider override first.');
      return;
    }
    setModelsError('');
    setModelsLoading(true);
    try {
      const payload: { provider: string; key?: string } = { provider: value.provider };
      // Allow loading models with a freshly-typed (un-saved) key, the
      // same way Settings → AI does.
      if (apiKeyInput.trim()) payload.key = apiKeyInput.trim();
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

  // Persist the currently-selected provider+model as the app default.
  // Writes three settings in a single PUT:
  //   - ``ai_provider``           → value.provider (promote to app default)
  //   - ``ai_model`` OR
  //     ``ai_local_model``        → value.model.trim() (matching branch)
  //   - ``ai_default_models``     → updated ``{provider: model}`` map
  // Backend ``_set_settings_group`` only writes keys present in the
  // payload, so other AI fields (length, tone, temperature, extraction
  // goals, custom base URL, etc.) are left untouched. The Settings → AI
  // tab and the AIDefaultsInfo box on this page both listen for the
  // ``ai-settings-changed`` event and refetch immediately.
  const handleSaveDefaultModel = async () => {
    if (!value.provider || !value.model.trim()) return;
    setSavingDefault(true);
    setDefaultStatus('');
    try {
      const current = await apiClient.get<Record<string, string>>('/api/settings/ai');
      let map: Record<string, string> = {};
      const raw = current?.ai_default_models;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.entries(parsed as Record<string, unknown>).forEach(([k, v]) => {
              if (typeof v === 'string' && v) map[k] = v;
            });
          }
        } catch {
          map = {};
        }
      }
      const trimmedModel = value.model.trim();
      map[value.provider] = trimmedModel;
      const payload: Record<string, string> = {
        ai_provider: value.provider,
        ai_default_models: JSON.stringify(map),
      };
      if (value.provider === 'local') {
        payload.ai_local_model = trimmedModel;
      } else {
        payload.ai_model = trimmedModel;
      }
      await apiClient.put('/api/settings/ai', { settings: payload });
      const providerLabel =
        PROVIDERS.find((p) => p.value === value.provider)?.label || value.provider;
      setDefaultStatus(`Saved. ${providerLabel} is now the app default.`);
      // Notify any other mounted AI-settings-aware components (the
      // Settings → AI table, AIDefaultsInfo on the Dive/Sweep/Routines
      // pages) that the persisted defaults have changed so they re-fetch
      // and re-render without a page reload.
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    } catch (err: any) {
      setDefaultStatus(`Error: ${err?.message || 'Failed to save default model.'}`);
    } finally {
      setSavingDefault(false);
      setTimeout(() => setDefaultStatus(''), 4000);
    }
  };

  return (
    <>
      <div className="form-field">
        <label className="form-label">Provider</label>
        <select
          className="form-select"
          value={value.provider}
          onChange={(e) =>
            // Clear ``model`` in lock-step with the provider switch so a
            // value loaded for the previous provider can't be saved as
            // the default for the new one. The Model dropdown then
            // shows "Load models to populate this list" until the user
            // explicitly fetches and picks a model for this provider.
            onChange({ ...value, provider: e.target.value, model: '' })
          }
        >
          <option value="">Use app default</option>
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      {showKeyEntry && (
        <div className="form-field">
          <label className="form-label">API Key</label>
          <div className="text-muted" style={{ fontSize: '0.85em', marginBottom: 6 }}>
            No API key is saved for this provider yet. Enter one to load
            models and run summaries; it will be stored in the OS
            keychain under the same slot used by Settings → AI.
          </div>
          <div className="key-input-row">
            <input
              className="form-input"
              type={keyMasked ? 'password' : 'text'}
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="Enter API key"
              autoComplete="off"
            />
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => setKeyMasked(!keyMasked)}
            >
              {keyMasked ? 'Show' : 'Hide'}
            </button>
            <button
              className="btn btn-sm"
              type="button"
              onClick={handleSaveKey}
              disabled={savingKey || !apiKeyInput.trim()}
            >
              {savingKey ? 'Saving…' : 'Save key'}
            </button>
          </div>
          {keyStatus && (
            <div
              className={keyStatus.startsWith('Error') ? 'form-error' : 'text-muted'}
              style={{ fontSize: '0.85em', marginTop: 4 }}
            >
              {keyStatus}
            </div>
          )}
        </div>
      )}

      <div className="form-field">
        <label className="form-label">Model</label>
        <div className="key-input-row">
          <select
            className="form-select"
            value={value.model}
            onChange={(e) => set('model', e.target.value)}
          >
            <option value="">
              {models.length
                ? 'Use app default'
                : 'Load models to populate this list'}
            </option>
            {/* Preserve a previously-saved value even if it isn't in the
                fetched list (e.g. when editing a routine before clicking
                Load Models). */}
            {value.model && !models.includes(value.model) && (
              <option value={value.model}>{value.model} (saved)</option>
            )}
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button
            className="btn btn-sm"
            type="button"
            onClick={handleLoadModels}
            disabled={modelsLoading || !value.provider}
            title={
              value.provider
                ? 'Fetch models available to the selected provider'
                : 'Select a provider override first'
            }
          >
            {modelsLoading ? 'Loading…' : 'Load models'}
          </button>
          <button
            className="btn btn-sm"
            type="button"
            onClick={handleSaveDefaultModel}
            disabled={savingDefault || !value.provider || !value.model.trim()}
            title={
              value.provider && value.model.trim()
                ? 'Save the selected model as the default model for this provider (also updates the Settings → AI tab)'
                : 'Select a provider and model first'
            }
          >
            {savingDefault ? 'Saving…' : 'Save as default model'}
          </button>
        </div>
        {modelsError && <div className="form-error">{modelsError}</div>}
        {defaultStatus && (
          <div
            className={defaultStatus.startsWith('Error') ? 'form-error' : 'text-muted'}
            style={{ fontSize: '0.85em', marginTop: 4 }}
          >
            {defaultStatus}
          </div>
        )}
      </div>

      <div className="form-field">
        <label className="form-label">Length</label>
        <select
          className="form-select"
          value={value.length}
          onChange={(e) => set('length', e.target.value)}
        >
          <option value="">Use app default</option>
          <option value="brief">Brief</option>
          <option value="standard">Standard</option>
          <option value="detailed">Detailed</option>
        </select>
      </div>

      <div className="form-field">
        <label className="form-label">Tone</label>
        <select
          className="form-select"
          value={value.tone}
          onChange={(e) => set('tone', e.target.value)}
        >
          <option value="">Use app default</option>
          <option value="technical">Technical</option>
          <option value="neutral">Neutral</option>
          <option value="accessible">Accessible</option>
        </select>
      </div>

      <div className="form-field">
        <label className="form-label">Temperature</label>
        <input
          className="form-input"
          type="number"
          min={0}
          max={1}
          step={0.1}
          value={value.temperature}
          onChange={(e) => set('temperature', e.target.value)}
          placeholder="Use app default"
        />
      </div>

      <div className="form-field">
        <label className="form-label">Extraction Goals</label>
        <input
          className="form-input"
          value={value.extraction_goals}
          onChange={(e) => set('extraction_goals', e.target.value)}
          placeholder="Use app default"
        />
      </div>
    </>
  );
};

export default AIOverridePanel;
