import React, { useState } from 'react';
import ApiKeyField from './ApiKeyField';
import { repositoriesApi, RepoCatalogEntry } from '../../api/repositories';

export type RepoKeyStatusVariant = 'dive' | 'sweep' | 'routine';

interface Props {
  entry: RepoCatalogEntry;
  present: boolean;
  /** Current ephemeral (in-memory only) value for this repo. */
  ephemeralValue?: string;
  /** Called whenever the user edits the ephemeral value. */
  onEphemeralChange?: (value: string) => void;
  /** Called after a key is persisted to the keyring so parent can refresh presence. */
  onPresenceChange?: (present: boolean) => void;
  variant: RepoKeyStatusVariant;
}

/**
 * Color-coded key-availability pill with optional inline ephemeral entry.
 *
 * - `dive` / `sweep`: includes an ephemeral `<ApiKeyField/>` and a
 *   `Save for Future Use` button that persists the typed value via
 *   `PUT /api/credentials/:name`.
 * - `routine`: omits the ephemeral input; only the `Save for Future Use`
 *   control is exposed (routines execute asynchronously and cannot carry
 *   ephemeral credentials into a scheduled run).
 */
const RepoKeyStatus: React.FC<Props> = ({
  entry,
  present,
  ephemeralValue = '',
  onEphemeralChange,
  onPresenceChange,
  variant,
}) => {
  const [persistValue, setPersistValue] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');

  if (entry.api_key_requirement === 'none' || !entry.credential_name) {
    return null;
  }

  const credName = entry.credential_name;

  const handleSave = async (value: string) => {
    if (!value) return;
    setSaveStatus('saving');
    setSaveError('');
    try {
      await repositoriesApi.saveCredential(credName, value);
      setSaveStatus('saved');
      setPersistValue('');
      if (variant !== 'routine' && onEphemeralChange) {
        onEphemeralChange('');
      }
      onPresenceChange?.(true);
      setTimeout(() => setSaveStatus('idle'), 2500);
    } catch (err: any) {
      setSaveStatus('error');
      setSaveError(err?.message || 'Save failed.');
    }
  };

  const pillClass = present ? 'status-pill success' : 'status-pill error';
  const pillText = present
    ? `\u2713 API key found for ${entry.name}`
    : `\u2717 No API key found for ${entry.name}`;

  return (
    <div className="repo-key-status">
      <span className={pillClass}>{pillText}</span>

      {variant !== 'routine' && (
        <div className="repo-key-status-row">
          <ApiKeyField
            present={present}
            value={ephemeralValue}
            onChange={(v) => onEphemeralChange?.(v)}
            placeholder={entry.placeholder || 'Enter API key for this run'}
            ariaLabel={`Ephemeral API key for ${entry.name}`}
          />
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!ephemeralValue.trim() || saveStatus === 'saving'}
            onClick={() => handleSave(ephemeralValue.trim())}
          >
            Save for Future Use
          </button>
        </div>
      )}

      {variant === 'routine' && (
        <div className="repo-key-status-row">
          <ApiKeyField
            present={present}
            value={persistValue}
            onChange={setPersistValue}
            onSave={handleSave}
            placeholder={entry.placeholder || 'Enter API key to save'}
            ariaLabel={`API key for ${entry.name}`}
          />
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!persistValue.trim() || saveStatus === 'saving'}
            onClick={() => handleSave(persistValue.trim())}
          >
            Save for Future Use
          </button>
        </div>
      )}

      {saveStatus === 'saved' && <span className="text-muted">Saved.</span>}
      {saveStatus === 'error' && <span className="form-error">{saveError}</span>}
    </div>
  );
};

export default RepoKeyStatus;
