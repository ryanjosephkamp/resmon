import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { when } from '../today/format';
import { CHANNEL_WORDS, deliveryWords, destinationWords, instant, type Delivery } from './model';

type Decision = 'deliver' | 'skip' | 'retry';

/** States the drain is still working on: the record is read again until they settle. */
const MOVING = new Set(['queued', 'delivering']);

/**
 * "Where did this go?": a watch's destinations, and the record of every
 * report's journey to each.
 *
 * Every column is a fact the engine stored, not a state inferred here:
 * "delivered" is never read off the absence of an error. Three decisions are
 * the person's and never the drain's: **Deliver** releases one waiting for
 * review, **Skip** decides not to send it, and **Retry** starts the attempts
 * again after the backoff gave up.
 */
export function DeliveryTab({ routineId }: { routineId: number }) {
  const client = useQueryClient();
  const [now] = useState(() => new Date());
  const targets = useQuery({
    queryKey: ['delivery-targets', routineId],
    queryFn: () => answer(engine().GET('/api/routines/{routine_id}/delivery-targets', {
      params: { path: { routine_id: routineId } },
    })),
  });
  const record = useQuery({
    queryKey: ['deliveries', routineId],
    queryFn: () => answer(engine().GET('/api/routines/{routine_id}/deliveries', {
      params: { path: { routine_id: routineId } },
    })),
    refetchInterval: (query) => ((query.state.data?.deliveries ?? []).some((d) => MOVING.has(d.state)) ? 1_500 : false),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: Decision }) => {
      const path = { params: { path: { delivery_id: id } } };
      if (decision === 'deliver') return answer(engine().POST('/api/deliveries/{delivery_id}/deliver', path));
      if (decision === 'skip') return answer(engine().POST('/api/deliveries/{delivery_id}/skip', path));
      return answer(engine().POST('/api/deliveries/{delivery_id}/retry', path));
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['deliveries', routineId] }),
  });
  const enabled = useMemo(() => (targets.data?.targets ?? []).filter((t) => t.enabled), [targets.data]);
  const deliveries = record.data?.deliveries ?? [];

  return (
    <div className="delivery" aria-busy={record.isFetching}>
      <h3 className="record-sub">Destinations</h3>
      {targets.isPending && <p className="record-cap">Reading the destinations.</p>}
      {targets.data && !targets.data.targets.length && (
        <p className="record-cap">
          None. Each run&rsquo;s report stays in resmon; a destination sends it on, to an address, a folder your
          cloud drive syncs, a feed, or a webhook.
        </p>
      )}
      <ul className="destinations">
        {(targets.data?.targets ?? []).map((target) => (
          <li key={target.id} data-channel={target.channel} data-enabled={target.enabled ? 'true' : 'false'}>
            <span className="delivery-channel">{CHANNEL_WORDS[target.channel] ?? target.channel}</span>
            <span className="delivery-where">{destinationWords(target.channel, target.target)}</span>
            <span className="record-cap">
              {target.mode === 'review' ? 'each report waits for you' : 'sent when the run finishes'}
              {target.enabled ? '' : ' · turned off'}
            </span>
          </li>
        ))}
      </ul>

      <h3 className="record-sub">Deliveries</h3>
      {record.isPending && <p className="record-cap">Reading the record.</p>}
      {record.isError && <p className="record-cap">The record could not be read ({record.error.message}).</p>}
      {record.data && !deliveries.length && (
        <p className="record-cap">
          {enabled.length
            ? 'None yet. The next run of this watch sends one to each destination.'
            : 'None: this watch has no destination to send to.'}
        </p>
      )}
      <ol className="delivery-list">
        {deliveries.map((row) => (
          <DeliveryRow key={row.id} row={row} now={now} busy={decide.isPending}
            onDecide={(decision) => decide.mutate({ id: row.id, decision })} />
        ))}
      </ol>
      {decide.error && (
        <p className="field-error" role="alert">
          {decide.error instanceof EngineError && decide.error.detail ? decide.error.detail : decide.error.message}
        </p>
      )}
    </div>
  );
}

function DeliveryRow({ row, now, busy, onDecide }: {
  row: Delivery; now: Date; busy: boolean; onDecide: (decision: Decision) => void;
}) {
  const delivered = instant(row.delivered_at_utc);
  const next = instant(row.next_attempt_at_utc);
  const detail = row.last_error
    ?? (delivered ? `delivered ${when(delivered.toISOString(), now)}` : '');
  return (
    <li className="delivery-row" data-delivery={row.id} data-channel={row.channel} data-state={row.state}>
      <Link to={`/runs/${row.execution_id}`} className="delivery-run">run {row.execution_id}</Link>
      <span className="delivery-channel">{CHANNEL_WORDS[row.channel] ?? row.channel}</span>
      <span className="delivery-where">{destinationWords(row.channel, row.target_snapshot)}</span>
      <span className="delivery-state" data-state={row.state}>{deliveryWords(row)}</span>
      <span className="delivery-detail">
        {detail || (row.attempts ? `${row.attempts} attempts` : '')}
        {row.state === 'failed' && next && ` · next attempt ${when(next.toISOString(), now)}`}
      </span>
      <span className="delivery-acts">
        {row.state === 'awaiting_review' && (
          <>
            <button type="button" className="btn sm primary" disabled={busy} onClick={() => onDecide('deliver')}>Deliver</button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => onDecide('skip')}>Skip</button>
          </>
        )}
        {(row.state === 'failed' || row.state === 'skipped') && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => onDecide('retry')}>Retry</button>
        )}
      </span>
    </li>
  );
}
