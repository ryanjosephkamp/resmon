/**
 * CloudSyncCard — Dashboard surface for the desktop cursor-sync state
 * (IMPL-36, §12.2). Rendered only when the user is signed in. Shows the
 * last successful sync timestamp, the current cursor, the local cache
 * footprint, an inline error banner, and a manual "Sync now" button.
 */

import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { useCloudSync, formatBytes } from '../../hooks/useCloudSync';

function humanTime(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 5) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleString();
}

const CloudSyncCard: React.FC = () => {
  const { isSignedIn } = useAuth();
  const { status, syncNow } = useCloudSync();
  if (!isSignedIn) return null;
  return (
    <div className="card" data-testid="cloud-sync-card">
      <h2>Cloud Sync</h2>
      <table className="simple-table">
        <tbody>
          <tr>
            <th style={{ textAlign: 'left', width: 160 }}>Last sync</th>
            <td>
              {humanTime(status.lastSyncAt)}
              {status.inFlight && (
                <span className="fw-spinner" style={{ marginLeft: 8 }} aria-hidden="true" />
              )}
            </td>
          </tr>
          <tr>
            <th style={{ textAlign: 'left' }}>Cursor (version)</th>
            <td>{status.lastSyncedVersion}</td>
          </tr>
          <tr>
            <th style={{ textAlign: 'left' }}>Cache size</th>
            <td>{formatBytes(status.cacheBytes)}</td>
          </tr>
        </tbody>
      </table>
      {status.lastError && (
        <p className="badge badge-error" role="alert" style={{ marginTop: 8 }}>
          {status.lastError}
        </p>
      )}
      <div className="action-btns" style={{ marginTop: 8 }}>
        <button
          className="btn btn-sm"
          disabled={status.inFlight}
          onClick={() => {
            syncNow().catch(() => {});
          }}
        >
          {status.inFlight ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
    </div>
  );
};

export default CloudSyncCard;
