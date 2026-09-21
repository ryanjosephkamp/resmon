import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client';
import { useRoutinesVersion } from '../../lib/routinesBus';

/**
 * "Did this routine's report actually go anywhere?" — the delivery record.
 *
 * Before schema 21 the only answer resmon had was silence: the completion
 * email was sent from the execution worker and nothing was written down, so a
 * user whose mail server had started refusing connections had no way to find
 * that out from the app. This panel is the record, and every column in it is a
 * fact the backend stored rather than a state this component inferred: which
 * destination, what state, how many attempts, and the reason it has not
 * arrived, in the backend's own words.
 *
 * Three buttons, because three decisions are deliberately the user's and never
 * the drain's: **Deliver** releases a delivery that is waiting for review,
 * **Skip** decides not to send one, and **Retry** starts the attempt sequence
 * again after the backoff has given up. There is no automatic promotion
 * anywhere behind them.
 *
 * Fetched on demand, like the coverage audit beside it: a page of eight
 * routines must not make eight requests on mount.
 */

interface Delivery {
  id: number;
  execution_id: number;
  channel: string;
  target_snapshot: string;
  state: 'queued' | 'awaiting_review' | 'delivering' | 'delivered' | 'failed' | 'skipped';
  attempts: number;
  next_attempt_at_utc: string | null;
  last_error: string | null;
  delivered_at_utc: string | null;
}

interface Summary {
  targets: Record<string, number>;
  enabled_target_count: number;
  awaiting_review: number;
}

interface Payload {
  routine_id: number;
  deliveries: Delivery[];
  summary: Summary;
}

const stateBadgeClass = (state: Delivery['state']): string => {
  if (state === 'delivered') return 'badge-success';
  if (state === 'failed') return 'badge-error';
  if (state === 'skipped') return 'badge-cancelled';
  return 'badge-info'; // queued, awaiting_review, delivering
};

/** The state, in the words a person would use for it. */
const stateLabel = (row: Delivery): string => {
  switch (row.state) {
    case 'awaiting_review': return 'waiting for you';
    case 'delivering': return 'sending';
    case 'delivered': return 'delivered';
    case 'skipped': return 'skipped';
    case 'failed': return row.next_attempt_at_utc ? 'failed, retrying' : 'failed';
    default: return 'queued';
  }
};

/** Where it was sent, without inventing one when the target is the default. */
const describeTarget = (row: Delivery): string => {
  if (row.target_snapshot) return row.target_snapshot;
  if (row.channel === 'email') return 'the address in Settings → Email';
  return '—';
};

const DeliveryPanel: React.FC<{ routineId: number }> = ({ routineId }) => {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiClient.get<Payload>(`/api/routines/${routineId}/deliveries`));
    } catch (err: any) {
      setError(err?.message || 'Could not read this routine’s deliveries.');
    } finally {
      setLoading(false);
    }
  }, [routineId]);

  useEffect(() => {
    if (open && !data && !loading && !error) void load();
  }, [open, data, loading, error, load]);

  // A routine mutation may have added or removed a destination.
  const routinesVersion = useRoutinesVersion();
  useEffect(() => { setData(null); setError(null); }, [routinesVersion]);

  const act = async (id: number, action: 'deliver' | 'skip' | 'retry') => {
    try {
      await apiClient.post(`/api/deliveries/${id}/${action}`);
      await load();
    } catch (err: any) {
      setError(err?.message || 'That did not work.');
    }
  };

  return (
    <div className="delivery-panel">
      <button
        type="button"
        className="why-toggle"
        aria-expanded={open}
        data-testid="delivery-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide deliveries' : 'Where did this go?'}
      </button>

      {open && (
        <div className="delivery-body" data-testid="delivery-body">
          {loading && <p className="text-muted">Reading the record…</p>}
          {error && <p className="why-error">{error}</p>}

          {data && data.deliveries.length === 0 && (
            <p className="text-muted" data-testid="delivery-empty">
              {data.summary.enabled_target_count > 0
                ? 'No deliveries yet. The next run of this routine will send one to each destination.'
                : 'This routine has no delivery destinations. Add one in its editor — an email address, or a folder your cloud drive syncs.'}
            </p>
          )}

          {data && data.deliveries.length > 0 && (
            <table className="simple-table delivery-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Destination</th>
                  <th>State</th>
                  <th>Attempts</th>
                  <th>Detail</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((row) => (
                  <tr key={row.id} data-testid={`delivery-row-${row.id}`}>
                    <td>{row.execution_id}</td>
                    <td>
                      <span className="delivery-channel">{row.channel}</span>{' '}
                      <span className="text-muted">{describeTarget(row)}</span>
                    </td>
                    <td>
                      <span className={`badge ${stateBadgeClass(row.state)}`}>
                        {stateLabel(row)}
                      </span>
                    </td>
                    <td>{row.attempts}</td>
                    <td className="delivery-detail">
                      {row.last_error ||
                        (row.delivered_at_utc ? row.delivered_at_utc : '—')}
                      {row.state === 'failed' && row.next_attempt_at_utc && (
                        <div className="text-muted">
                          next attempt {row.next_attempt_at_utc}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="action-btns">
                        {row.state === 'awaiting_review' && (
                          <>
                            <button className="btn btn-sm btn-primary"
                                    onClick={() => act(row.id, 'deliver')}>
                              Deliver
                            </button>
                            <button className="btn btn-sm"
                                    onClick={() => act(row.id, 'skip')}>
                              Skip
                            </button>
                          </>
                        )}
                        {(row.state === 'failed' || row.state === 'skipped') && (
                          <button className="btn btn-sm"
                                  onClick={() => act(row.id, 'retry')}>
                            Retry
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data && (
            <p className="text-muted delivery-caveat">
              resmon records what it did: that it handed the report to your mail
              server, or wrote it into the folder. Whether the message reached an
              inbox, or the folder finished syncing, is not something it can see.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default DeliveryPanel;
