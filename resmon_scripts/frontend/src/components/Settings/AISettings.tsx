import React, { useState, useEffect } from 'react';
import { apiClient } from '../../api/client';
import PageHelp from '../Help/PageHelp';

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

  useEffect(() => {
    apiClient.get<Partial<AISettingsState>>('/api/settings/ai')
      .then((data) => {
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
      })
      .finally(() => setLoading(false));
  }, []);

  const credentialNameForProvider = (provider: string): string | null => {
    if (provider === 'local' || provider === '') return null;
    if (provider === 'custom') return 'custom_llm_api_key';
    return `${provider}_api_key`;
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus('');
    try {
      await apiClient.put('/api/settings/ai', { settings });
      if (apiKey) {
        const keyName = credentialNameForProvider(settings.ai_provider);
        if (keyName) {
          await apiClient.put(`/api/credentials/${keyName}`, { value: apiKey });
        }
        setApiKey('');
      }
      setStatus('AI settings saved.');
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
  // entries from another provider cannot be selected by mistake.
  const handleProviderChange = (next: string) => {
    setSettings({ ...settings, ai_provider: next });
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
              <label className="form-label">Summary Length</label>
              <select className="form-select" value={settings.ai_summary_length} onChange={(e) => setSettings({ ...settings, ai_summary_length: e.target.value })}>
                <option value="">Default</option>
                <option value="brief">Brief</option>
                <option value="standard">Standard</option>
                <option value="detailed">Detailed</option>
              </select>
            </div>

            <div className="form-field">
              <label className="form-label">Tone</label>
              <select className="form-select" value={settings.ai_tone} onChange={(e) => setSettings({ ...settings, ai_tone: e.target.value })}>
                <option value="">Default</option>
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
                value={settings.ai_temperature}
                onChange={(e) => setSettings({ ...settings, ai_temperature: e.target.value })}
              />
            </div>

            <div className="form-field">
              <label className="form-label">Extraction Goals</label>
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
