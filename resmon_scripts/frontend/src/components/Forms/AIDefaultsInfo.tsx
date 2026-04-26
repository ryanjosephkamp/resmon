import React, { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../../api/client';

/**
 * Update 2 follow-up.
 *
 * Inline info box that surfaces the current app-default AI provider and
 * its default model. Mounted on Deep Dive / Deep Sweep / Routines under
 * the "Enable AI Summarization" checkbox so the user knows exactly
 * which provider+model the run will use when the override panel below
 * is left at "Use app default".
 *
 * Re-fetches whenever the global ``ai-settings-changed`` event fires
 * (dispatched by ``AIOverridePanel`` after "Save as default model" and
 * by ``AISettings`` after Save / row-click), so the box always reflects
 * the latest ``Settings → AI`` state without a page reload.
 */
interface AISettingsShape {
  ai_provider?: string;
  ai_model?: string;
  ai_local_model?: string;
  ai_default_models?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  meta: 'Meta',
  deepseek: 'DeepSeek',
  alibaba: 'Alibaba',
  local: 'Local',
  custom: 'Custom',
};

const parseDefaultModels = (raw: string | undefined): Record<string, string> => {
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
    /* ignore */
  }
  return {};
};

const AIDefaultsInfo: React.FC = () => {
  const [provider, setProvider] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await apiClient.get<AISettingsShape>('/api/settings/ai');
      const prov = (data?.ai_provider || '').trim();
      const map = parseDefaultModels(data?.ai_default_models);
      let mdl = '';
      if (prov) {
        if (map[prov]) {
          mdl = map[prov];
        } else if (prov === 'local') {
          mdl = (data?.ai_local_model || '').trim();
        } else {
          mdl = (data?.ai_model || '').trim();
        }
      }
      setProvider(prov);
      setModel(mdl);
    } catch {
      setProvider('');
      setModel('');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => { refresh(); };
    window.addEventListener('ai-settings-changed', handler);
    return () => window.removeEventListener('ai-settings-changed', handler);
  }, [refresh]);

  if (!loaded) return null;

  const providerLabel = provider ? (PROVIDER_LABELS[provider] || provider) : '';

  return (
    <div
      className="form-field"
      style={{
        background: 'var(--surface-2, rgba(0, 0, 0, 0.04))',
        border: '1px solid var(--border, rgba(0, 0, 0, 0.12))',
        borderRadius: 6,
        padding: '8px 12px',
        fontSize: '0.9em',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 2 }}>
        App default AI configuration
      </div>
      {provider ? (
        <div className="text-muted">
          Provider: <strong>{providerLabel}</strong>
          {'  ·  '}
          Default model:{' '}
          {model ? (
            <strong>{model}</strong>
          ) : (
            <em>not set — Load and save one in Settings → AI or via the override panel below</em>
          )}
        </div>
      ) : (
        <div className="text-muted">
          No app-default provider is selected. Choose one in{' '}
          <strong>Settings → AI</strong> or override below for this run only.
        </div>
      )}
    </div>
  );
};

export default AIDefaultsInfo;
