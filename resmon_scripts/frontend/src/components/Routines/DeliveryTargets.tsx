import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client';

/**
 * Where this routine's report is sent — the editable list.
 *
 * Two kinds of destination ship. An **email address**, which may be left blank
 * to mean the one in Settings → Email (which is where it came from before
 * there was a list at all, so every routine the upgrade seeded reads that way).
 * And a **folder**: a directory on this machine, which is how a cloud drive
 * becomes a destination — resmon writes the report bundle into it and the
 * drive's own client syncs it, with nothing of ours on the wire.
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

const DeliveryTargets: React.FC<{ routineId: number }> = ({ routineId }) => {
  const [targets, setTargets] = useState<Target[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [draftChannel, setDraftChannel] = useState('email');
  const [draftTarget, setDraftTarget] = useState('');
  const [draftMode, setDraftMode] = useState<'automatic' | 'review'>('automatic');

  const load = useCallback(async () => {
    try {
      const data = await apiClient.get<{ targets: Target[]; shipped_channels: string[] }>(
        `/api/routines/${routineId}/delivery-targets`,
      );
      setTargets(data.targets);
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
      await apiClient.post(`/api/routines/${routineId}/delivery-targets`, {
        channel: draftChannel, target: draftTarget.trim(), mode: draftMode,
      });
      setDraftTarget('');
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
              <span className="delivery-target-value">
                {t.target || (t.channel === 'email'
                  ? 'the address in Settings → Email'
                  : '(not set)')}
              </span>
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
            <option key={c} value={c}>{c === 'email' ? 'Email address' : 'Folder'}</option>
          ))}
        </select>
        <input
          type="text"
          className="form-input"
          value={draftTarget}
          aria-label="Address or folder"
          placeholder={draftChannel === 'email'
            ? 'name@example.org (blank = Settings → Email)'
            : '/Users/you/Dropbox'}
          onChange={(e) => setDraftTarget(e.target.value)}
        />
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

      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
};

export default DeliveryTargets;
