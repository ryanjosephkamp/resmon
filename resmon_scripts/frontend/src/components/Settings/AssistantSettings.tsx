import React from 'react';
import { apiClient } from '../../api/client';

/**
 * Settings → AI → Assistant.
 *
 * Deliberately small. The assistant reuses the *same* CLI path the summary lane
 * already discovered — a user who has told resmon where `claude` lives has told
 * it once — so this section chooses a model and an effort level and otherwise
 * reports what resmon found.
 *
 * The status block always renders, including when nothing is available. An
 * assistant that disappeared when its CLI was missing would look like a feature
 * resmon does not have rather than one waiting on a setting; and Codex is listed
 * as unavailable *with its reason*, because a user who has Codex installed and
 * sees no mention of it would reasonably conclude resmon had not noticed.
 */

interface AssistantSettingsShape {
  assistant_runtime: string;
  assistant_model: string;
  assistant_effort: string;
}

interface StatusShape {
  available: boolean;
  reason: string;
  runtime?: { kind: string; path?: string | null; how?: string | null };
  contract_version?: string;
  others?: { kind: string; installed?: boolean; available: boolean; reason: string }[];
}

// `claude` has no models-listing command, so these are its documented aliases
// rather than a fetched list. Offering a dropdown built from a guess would be
// worse than offering the aliases the CLI itself documents.
const MODEL_CHOICES = ['', 'opus', 'sonnet', 'haiku', 'fable'];
const EFFORT_CHOICES = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

const AssistantSettings: React.FC = () => {
  const [settings, setSettings] = React.useState<AssistantSettingsShape>({
    assistant_runtime: '', assistant_model: '', assistant_effort: '',
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

  return (
    <div className="settings-subsection" data-testid="assistant-settings">
      <h3>Assistant</h3>
      <p className="settings-help">
        The panel in the corner of every page. It runs the <code>claude</code>{' '}
        command you already installed and signed into, with resmon as its only
        source of tools, and <strong>anything that changes something waits for
        you to allow it</strong>.
      </p>

      <div className="settings-status" data-testid="assistant-settings-status">
        <strong>{status?.available ? 'Available' : 'Not available'}</strong>
        <span> — {status?.reason || 'Checking…'}</span>
      </div>

      {(status?.others || []).map((other) => (
        <p className="settings-help" key={other.kind}>{other.reason}</p>
      ))}

      <div className="form-row">
        <label htmlFor="assistant-model">Model</label>
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
      </div>

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

      <p className="settings-help">
        The command resmon uses is the one set under <strong>Advanced</strong> in
        the primary lane above — there is only one, so setting it once is enough.
      </p>

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
