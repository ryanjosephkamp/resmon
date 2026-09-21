import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client';

/**
 * Where this routine's report is sent — the editable list.
 *
 * Four kinds of destination ship. An **email address**, which may be left
 * blank to mean the one in Settings → Email (which is where it came from
 * before there was a list at all, so every routine the upgrade seeded reads
 * that way). A **folder**: a directory on this machine, which is how a cloud
 * drive becomes a destination — resmon writes the report bundle into it and
 * the drive's own client syncs it, with nothing of ours on the wire. A
 * **webhook**: an https address you own, which receives a signed JSON
 * envelope; its shared secret is typed here and goes straight to the system
 * keychain, and this screen only ever reports whether one is saved. And a
 * **feed**: an Atom file written into a folder, which any feed reader or a
 * static site can point at.
 *
 * Each destination is either **automatic** or **waits for review**. Review
 * means the delivery is recorded and held until you release it from the
 * routine's Deliveries list; nothing promotes it on its own, ever.
 *
 * Saved immediately rather than with the rest of the form: a destination is a
 * row of its own, and a list that saved with the modal would silently lose
 * what was typed when the modal was dismissed.
 */

interface Target {
  id: number;
  channel: string;
  target: string;
  enabled: number | boolean;
  mode: 'automatic' | 'review';
}

/** What each channel is called, and what its target box wants. */
const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email address',
  folder: 'Folder',
  webhook: 'Webhook (https)',
  feed: 'Feed file (Atom)',
};

const CHANNEL_PLACEHOLDERS: Record<string, string> = {
  email: 'name@example.org (blank = Settings → Email)',
  folder: '/Users/you/Dropbox',
  webhook: 'https://example.org/resmon-hook',
  feed: '/Users/you/Sites',
};

/**
 * A webhook destination is stored as a URL, or as `{"url":…,"inline":true}`
 * when the bundle should travel inside the envelope instead of being fetched
 * from a link. One text column carries both forms rather than a schema change
 * for a single boolean; this is the pair of functions that reads and writes it.
 */
const readWebhook = (raw: string): { url: string; inline: boolean } => {
  const text = (raw || '').trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      return { url: String(parsed?.url || ''), inline: Boolean(parsed?.inline) };
    } catch {
      return { url: '', inline: false };
    }
  }
  return { url: text, inline: false };
};

const writeWebhook = (url: string, inline: boolean): string =>
  (inline ? JSON.stringify({ url: url.trim(), inline: true }) : url.trim());

const displayTarget = (t: Target): string => {
  if (t.channel === 'webhook') return readWebhook(t.target).url || '(not set)';
  if (t.channel === 'email') return t.target || 'the address in Settings → Email';
  return t.target || '(not set)';
};

const DeliveryTargets: React.FC<{ routineId: number }> = ({ routineId }) => {
  const [targets, setTargets] = useState<Target[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [draftChannel, setDraftChannel] = useState('email');
  const [draftTarget, setDraftTarget] = useState('');
  const [draftMode, setDraftMode] = useState<'automatic' | 'review'>('automatic');
  const [draftInline, setDraftInline] = useState(false);
  // Which destinations have a signing secret in the keychain. Presence only:
  // the value is never read back, by this screen or by anything else.
  const [secrets, setSecrets] = useState<Record<number, boolean>>({});
  const [secretDraft, setSecretDraft] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const data = await apiClient.get<{ targets: Target[]; shipped_channels: string[] }>(
        `/api/routines/${routineId}/delivery-targets`,
      );
      setTargets(data.targets);
      const presence: Record<number, boolean> = {};
      await Promise.all(data.targets
        .filter((t) => t.channel === 'webhook')
        .map(async (t) => {
          try {
            const probe = await apiClient.get<{ credentials: Record<string, { present: boolean }> }>(
              '/api/credentials',
            );
            presence[t.id] = Boolean(probe.credentials?.[`webhook_secret_${t.id}`]?.present);
          } catch {
            presence[t.id] = false;
          }
        }));
      setSecrets(presence);
      // The channels the backend can actually act on, asked of the backend:
      // the schema's vocabulary is wider than what has an adapter behind it.
      setChannels(data.shipped_channels);
    } catch (err: any) {
      setError(err?.message || 'Could not read this routine’s destinations.');
    }
  }, [routineId]);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setError('');
    try {
      const target = draftChannel === 'webhook'
        ? writeWebhook(draftTarget, draftInline)
        : draftTarget.trim();
      await apiClient.post(`/api/routines/${routineId}/delivery-targets`, {
        channel: draftChannel, target, mode: draftMode,
      });
      setDraftTarget('');
      setDraftInline(false);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not add that destination.');
    }
  };

  const update = async (t: Target, patch: Partial<Target>) => {
    setError('');
    try {
      await apiClient.put(`/api/routines/${routineId}/delivery-targets/${t.id}`, patch);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not change that destination.');
    }
  };

  /**
   * Send one destination's signing secret to the keychain.
   *
   * Through `PUT /api/credentials/webhook_secret_<id>`, the same route the
   * SMTP password takes: no delivery secret is ever written to a table, a
   * setting or this component's state after it has been sent (B12).
   */
  const saveSecret = async (t: Target) => {
    const value = (secretDraft[t.id] || '').trim();
    if (!value) return;
    setError('');
    try {
      await apiClient.put(`/api/credentials/webhook_secret_${t.id}`, { value });
      setSecretDraft((d) => ({ ...d, [t.id]: '' }));
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not save that secret.');
    }
  };

  const remove = async (t: Target) => {
    setError('');
    try {
      await apiClient.delete(`/api/routines/${routineId}/delivery-targets/${t.id}`);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not remove that destination.');
    }
  };

  return (
    <div className="form-field delivery-targets" data-testid="delivery-targets">
      <label className="form-label">Delivery</label>
      <p className="text-muted">
        Where this routine&rsquo;s report goes when a run finishes. Every attempt
        is recorded — including the ones that fail — under <em>Where did this
        go?</em> on the Routines page.
      </p>

      {targets.length === 0 && (
        <p className="text-muted" data-testid="delivery-targets-empty">
          No destinations yet. The report is still saved in resmon either way.
        </p>
      )}

      {targets.length > 0 && (
        <ul className="delivery-target-list">
          {targets.map((t) => (
            <li key={t.id} data-testid={`delivery-target-${t.id}`}>
              <span className="delivery-channel">{t.channel}</span>
              <span className="delivery-target-value">{displayTarget(t)}</span>
              {t.channel === 'webhook' && (
                <span className="delivery-webhook-secret">
                  <span className="text-muted" data-testid={`delivery-secret-state-${t.id}`}>
                    {secrets[t.id] ? 'secret saved' : 'no secret yet'}
                  </span>
                  <input
                    type="password"
                    className="form-input"
                    aria-label="Shared secret for this webhook"
                    placeholder="set secret"
                    value={secretDraft[t.id] || ''}
                    onChange={(e) => setSecretDraft(
                      (d) => ({ ...d, [t.id]: e.target.value }))}
                  />
                  <button type="button" className="btn btn-sm"
                          data-testid={`delivery-secret-save-${t.id}`}
                          onClick={() => saveSecret(t)}>Save secret</button>
                </span>
              )}
              <select
                className="form-input"
                value={t.mode}
                aria-label="When to deliver"
                onChange={(e) => update(t, { mode: e.target.value as Target['mode'] })}
              >
                <option value="automatic">automatically</option>
                <option value="review">wait for my review</option>
              </select>
              <button
                type="button"
                className={`toggle-btn ${t.enabled ? 'toggle-on' : 'toggle-off'}`}
                onClick={() => update(t, { enabled: !t.enabled })}
                title="Whether this destination is used at all"
              >{t.enabled ? 'ON' : 'OFF'}</button>
              <button type="button" className="btn btn-sm btn-danger"
                      onClick={() => remove(t)}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      <div className="delivery-target-add">
        <select
          className="form-input"
          value={draftChannel}
          aria-label="Destination type"
          onChange={(e) => setDraftChannel(e.target.value)}
        >
          {channels.map((c) => (
            <option key={c} value={c}>{CHANNEL_LABELS[c] || c}</option>
          ))}
        </select>
        <input
          type="text"
          className="form-input"
          value={draftTarget}
          aria-label="Address or folder"
          placeholder={CHANNEL_PLACEHOLDERS[draftChannel] || ''}
          onChange={(e) => setDraftTarget(e.target.value)}
        />
        {draftChannel === 'webhook' && (
          <label className="delivery-inline-choice">
            <input
              type="checkbox"
              checked={draftInline}
              onChange={(e) => setDraftInline(e.target.checked)}
            />
            {' '}Send the bundle inside the envelope
          </label>
        )}
        <select
          className="form-input"
          value={draftMode}
          aria-label="When to deliver this destination"
          onChange={(e) => setDraftMode(e.target.value as 'automatic' | 'review')}
        >
          <option value="automatic">automatically</option>
          <option value="review">wait for my review</option>
        </select>
        <button type="button" className="btn btn-sm" onClick={add}
                data-testid="delivery-target-add">Add destination</button>
      </div>

      {channels.includes('webhook') && (
        <p className="text-muted">
          A webhook needs a shared secret before resmon will send to it: add the
          destination, then type the secret on its row. resmon signs every
          envelope with it and will not send an unsigned one.
        </p>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
};

export default DeliveryTargets;
