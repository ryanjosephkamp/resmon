import React from 'react';
import { apiClient } from '../../api/client';

/**
 * Settings → AI → Assistant.
 *
 * Two routes to a model, and the section's job is to make the choice between
 * them legible rather than to configure either one twice.
 *
 * **The CLI is the default and stays the default.** It spends a subscription
 * the user already has rather than a key they pay per token for, and it brings
 * its own agent loop, its own tool-call plumbing and its own spending ceiling.
 * The API-key route (2.0b) exists because a user without a CLI was locked out
 * of the assistant entirely.
 *
 * **Nothing here is asked for twice.** The CLI path reuses the command the
 * summary lane already discovered; the API-key path reuses the provider, the
 * key and the custom base URL from the same place. What this section adds is
 * which route to take, which model, and — on the CLI — an effort level.
 *
 * The status block always renders, including when nothing is available: an
 * assistant that disappeared when its runtime was missing would look like a
 * feature resmon does not have rather than one waiting on a setting. Every
 * route resmon knows about is listed **with its reason**, available or not.
 */

interface AssistantSettingsShape {
  assistant_runtime: string;
  assistant_provider: string;
  assistant_model: string;
  assistant_effort: string;
}

interface StatusShape {
  available: boolean;
  reason: string;
  runtime?: { kind: string; path?: string | null; how?: string | null };
  provider?: string;
  provider_source?: string;
  contract_version?: string;
  tool_calling?: {
    state: string; reason: string; assistant: string; assistant_reason: string;
  };
  others?: { kind: string; installed?: boolean; available: boolean; reason: string }[];
}

// `claude` has no models-listing command, so these are its documented aliases
// rather than a fetched list. Offering a dropdown built from a guess would be
// worse than offering the aliases the CLI itself documents.
const MODEL_CHOICES = ['', 'opus', 'sonnet', 'haiku', 'fable'];
const EFFORT_CHOICES = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The providers resmon's own loop can drive, and the one it deliberately does
 * not. Mirrors `assistant_tool_calling.PROVIDER_TOOL_CALLING`; the *reason* for
 * each comes from the backend at runtime, so this list only decides what to
 * offer and never what to claim about it.
 */
const PROVIDER_CHOICES: { value: string; label: string }[] = [
  { value: '', label: 'The provider the summary lane uses' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'xai', label: 'xAI' },
  { value: 'meta', label: 'Meta (Together)' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'alibaba', label: 'Alibaba' },
  { value: 'custom', label: 'Custom endpoint' },
];

const AssistantSettings: React.FC = () => {
  const [settings, setSettings] = React.useState<AssistantSettingsShape>({
    assistant_runtime: '', assistant_provider: '', assistant_model: '',
    assistant_effort: '',
  });
  const [status, setStatus] = React.useState<StatusShape | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [stored, live] = await Promise.all([
        apiClient.get<AssistantSettingsShape>('/api/settings/assistant'),
        apiClient.get<StatusShape>('/api/assistant/status'),
      ]);
      setSettings({
        assistant_runtime: stored.assistant_runtime || '',
        assistant_provider: stored.assistant_provider || '',
        assistant_model: stored.assistant_model || '',
        assistant_effort: stored.assistant_effort || '',
      });
      setStatus(live);
    } catch {
      setStatus({ available: false, reason: 'resmon is not answering right now.' });
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await apiClient.put('/api/settings/assistant', { settings });
      setSaved(true);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const isApiKey = settings.assistant_runtime === 'api_key';

  return (
    <div className="settings-subsection" data-testid="assistant-settings">
      <h3>Assistant</h3>
      <p className="settings-help">
        The panel in the corner of every page. It is given resmon's own tools and
        nothing else, and <strong>anything that changes something waits for you
        to allow it</strong>.
      </p>

      <div className="settings-status" data-testid="assistant-settings-status">
        <strong>{status?.available ? 'Available' : 'Not available'}</strong>
        <span> — {status?.reason || 'Checking…'}</span>
      </div>

      {(status?.others || []).map((other) => (
        <p className="settings-help" key={other.kind}>{other.reason}</p>
      ))}

      <div className="form-row">
        <label htmlFor="assistant-runtime">Run it with</label>
        <select
          id="assistant-runtime"
          value={settings.assistant_runtime}
          onChange={(e) => setSettings({ ...settings, assistant_runtime: e.target.value })}
        >
          <option value="">The claude command you already signed into</option>
          <option value="api_key">An API key of your own</option>
        </select>
      </div>

      {!isApiKey && (
        <p className="settings-help">
          resmon runs the <code>claude</code> command set under{' '}
          <strong>Advanced</strong> in the primary lane above — there is only
          one, so setting it once is enough. This spends the same Claude usage
          window your own work does, and a turn carries a hard spending ceiling
          the CLI enforces on itself.
        </p>
      )}

      {isApiKey && (
        <>
          <div className="form-row">
            <label htmlFor="assistant-provider">Provider</label>
            <select
              id="assistant-provider"
              value={settings.assistant_provider}
              onChange={(e) => setSettings({
                ...settings, assistant_provider: e.target.value,
              })}
            >
              {PROVIDER_CHOICES.map((choice) => (
                <option key={choice.value || 'inherit'} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>

          {status?.tool_calling && (
            <p className="settings-help" data-testid="assistant-tool-calling">
              {status.tool_calling.reason}
            </p>
          )}

          <p className="settings-help">
            <strong>This spends your own key, per token.</strong> The key and the
            model come from your provider's entry under{' '}
            <strong>Repositories &amp; API Keys</strong> and Settings → AI; resmon
            reads the key from your system keychain for each turn and never puts
            it in a conversation. Because a provider API reports tokens and not
            money, <strong>resmon shows a token count rather than a cost</strong>
            {' '}— it does not know your price list and will not invent one. A turn
            is stopped after eight tool steps or 100,000 tokens, whichever comes
            first.
          </p>

          <p className="settings-help">
            <strong>It remembers what was said, not what the tools returned.</strong>{' '}
            A provider API keeps no session, so resmon replays the conversation
            itself — your messages and its replies. The raw tool output behind an
            earlier answer is not sent again, so a long conversation does not
            re-send a corpus, and text from a paper does not follow you from turn
            to turn.
          </p>
        </>
      )}

      <div className="form-row">
        <label htmlFor="assistant-model">Model</label>
        {isApiKey ? (
          <input
            id="assistant-model"
            type="text"
            value={settings.assistant_model}
            placeholder="e.g. gpt-4o-mini, claude-sonnet-4-5, gemini-2.0-flash"
            onChange={(e) => setSettings({ ...settings, assistant_model: e.target.value })}
          />
        ) : (
          <select
            id="assistant-model"
            value={settings.assistant_model}
            onChange={(e) => setSettings({ ...settings, assistant_model: e.target.value })}
          >
            {MODEL_CHOICES.map((choice) => (
              <option key={choice || 'default'} value={choice}>
                {choice || "The CLI's own default"}
              </option>
            ))}
          </select>
        )}
      </div>

      {!isApiKey && (
        <div className="form-row">
          <label htmlFor="assistant-effort">Effort</label>
          <select
            id="assistant-effort"
            value={settings.assistant_effort}
            onChange={(e) => setSettings({ ...settings, assistant_effort: e.target.value })}
          >
            {EFFORT_CHOICES.map((choice) => (
              <option key={choice || 'default'} value={choice}>
                {choice || "The CLI's own default"}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save assistant settings'}
        </button>
        {saved && <span className="settings-saved">Saved.</span>}
      </div>
    </div>
  );
};

export default AssistantSettings;
