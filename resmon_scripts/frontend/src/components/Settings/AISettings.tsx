import React, { useState, useEffect } from 'react';
import { apiClient } from '../../api/client';
import PageHelp from '../Help/PageHelp';
import InfoTooltip from '../Help/InfoTooltip';

const PROVIDERS: { value: string; label: string }[] = [
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

const AISettings: React.FC = () => {
  const [settings, setSettings] = useState<AISettingsState>(DEFAULT_STATE);
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
      setSettings(merged);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshSettings();
    refreshKeyPresence();
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
    if (provider === 'custom') return 'custom_llm_api_key';
    return `${provider}_api_key`;
  };

  // Update 2 — Feature 1: stored-keys management. The list of provider
  // slots displayed in the "Stored API Keys" section, in the same order
  // as the Provider dropdown. ``local`` is excluded because it has no
  // remote API key.
  const STORED_KEY_SLOTS: { provider: string; label: string; credName: string }[] =
    PROVIDERS
      .filter((p) => p.value !== 'local')
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

  const isRemote = settings.ai_provider !== '' && settings.ai_provider !== 'local';
  const providerSelected = settings.ai_provider !== '';
  const isCustom = settings.ai_provider === 'custom';
  const customBaseUrlError = isCustom ? validateCustomBaseUrl(settings.ai_custom_base_url) : null;
  const saveDisabled = saving || customBaseUrlError !== null;

  return (
    <div className="settings-section">
      <h2>AI Configuration</h2>
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
          <select className="form-select" value={settings.ai_provider} onChange={(e) => handleProviderChange(e.target.value)}>
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

        <div className="form-actions">
          <button className="btn btn-primary" onClick={handleSave} disabled={saveDisabled}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
        {status && <div className={status.startsWith('Error') || status.includes('invalid') || status.includes('error') ? 'form-error' : 'form-success'}>{status}</div>}
      </div>
    </div>
  );
};

export default AISettings;
