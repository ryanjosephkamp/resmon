import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine, EngineError } from '../../api/client';
import { keychainName } from '../settings/model';
import { platform } from '../../bridge';
import { CHANNEL_WORDS, WATCHES_KEY, destinationWords, webhookUrl, type DeliveryTarget } from './model';
import { commandEnter } from '../../shell/shortcuts';

type Mode = 'automatic' | 'review';

/** What the target field wants, for each channel. */
const ASKS: Record<string, { placeholder: string; hint: string }> = {
  email: {
    placeholder: 'name@example.org, or blank for the address in Settings',
    hint: 'Sent through the account under Settings, Email, while this watch’s Email the report switch is on.',
  },
  folder: {
    placeholder: 'A folder on this computer',
    hint: 'resmon writes each report’s files into this folder. A folder your cloud drive syncs carries them on, with nothing of resmon’s on the wire.',
  },
  webhook: {
    placeholder: 'https://example.org/resmon-hook',
    hint: 'An https address you own. It receives a signed JSON envelope with a link to the report’s files, good for 24 hours, or the files themselves inside it. It needs a shared secret before resmon will send to it.',
  },
  feed: {
    placeholder: 'The folder the feed file is written into',
    hint: 'An Atom file in this folder, keeping the newest 50 reports, which a feed reader or a static site can read.',
  },
};

/** A webhook stored as a URL, or as `{"url":…,"inline":true}` when the files travel inside the envelope. */
export function webhookTarget(url: string, inline: boolean): string {
  return inline ? JSON.stringify({ url: url.trim(), inline: true }) : url.trim();
}

function webhookInline(raw: string): boolean {
  if (!raw.trim().startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return !!parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).inline === true;
  } catch {
    return false;
  }
}

function errorWords(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

/**
 * Where a watch's reports go: each destination, changed in place, and a new
 * one added. Each saves as it is changed: a destination is a row of its own.
 *
 * A webhook's shared secret goes straight to the system's credential store,
 * and the screen shows only whether one is stored, as the engine reports it.
 * Removing the last email destination turns the watch's email switch off,
 * in the engine, so the watch is read again after any change.
 */
export function Destinations({ routineId, emailOn }: { routineId: number; emailOn: boolean }) {
  const client = useQueryClient();
  const targets = useQuery({
    queryKey: ['delivery-targets', routineId],
    queryFn: () => answer(engine().GET('/api/routines/{routine_id}/delivery-targets', {
      params: { path: { routine_id: routineId } },
    })),
  });
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => answer(engine().GET('/api/credentials')) });
  const changed = () => {
    void client.invalidateQueries({ queryKey: ['delivery-targets', routineId] });
    void client.invalidateQueries({ queryKey: ['routine', routineId] });
    void client.invalidateQueries({ queryKey: WATCHES_KEY });
    // A webhook added is a secret name the engine now reports on.
    void client.invalidateQueries({ queryKey: ['credentials'] });
  };
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { mode?: Mode; enabled?: boolean } }) => answer(engine().PUT(
      '/api/routines/{routine_id}/delivery-targets/{target_id}',
      { params: { path: { routine_id: routineId, target_id: id } }, body: patch },
    )),
    onSettled: changed,
  });
  const remove = useMutation({
    mutationFn: (id: number) => answer(engine().DELETE('/api/routines/{routine_id}/delivery-targets/{target_id}', {
      params: { path: { routine_id: routineId, target_id: id } },
    })),
    onSettled: changed,
  });
  const secret = useMutation({
    mutationFn: ({ id, value }: { id: number; value: string }) => answer(engine().PUT('/api/credentials/{key_name}', {
      params: { path: { key_name: `webhook_secret_${id}` } }, body: { value },
    })),
    onSettled: () => client.invalidateQueries({ queryKey: ['credentials'] }),
  });

  const list = targets.data?.targets ?? [];
  const error = update.error ?? remove.error ?? secret.error;
  const keychain = keychainName(platform());

  return (
    <div className="destinations-edit">
      {targets.isPending && <p className="record-cap">Reading the destinations.</p>}
      {targets.isError && <p className="record-cap">The destinations could not be read ({targets.error.message}).</p>}
      {targets.data && !list.length && (
        <p className="record-cap">
          None. Each run&rsquo;s report stays in resmon; a destination sends it on, to an address, a folder your cloud
          drive syncs, a feed, or a webhook.
        </p>
      )}
      <ul className="destinations">
        {list.map((target) => (
          <DestinationRow key={target.id} target={target} emailOn={emailOn} busy={update.isPending || remove.isPending}
            secretStatus={credentials.data
              ? credentials.data.credentials[`webhook_secret_${target.id}`]?.status ?? 'unreported'
              : 'reading'}
            keychain={keychain}
            savingSecret={secret.isPending}
            onSecret={(value) => secret.mutate({ id: target.id, value })}
            onChange={(patch) => update.mutate({ id: target.id, patch })}
            onRemove={() => {
              if (window.confirm(`Stop sending this watch’s reports to ${where(target)}? What was already sent there stays in the record below.`)) {
                remove.mutate(target.id);
              }
            }} />
        ))}
      </ul>
      {error && <p className="field-error" role="alert">{errorWords(error)}</p>}
      {targets.data && (
        <AddDestination routineId={routineId} channels={targets.data.shipped_channels} onAdded={changed} />
      )}
    </div>
  );
}

function where(target: DeliveryTarget): string {
  return target.channel === 'webhook' ? webhookUrl(target.target) : destinationWords(target.channel, target.target);
}

function DestinationRow({ target, emailOn, busy, secretStatus, keychain, savingSecret, onSecret, onChange, onRemove }: {
  target: DeliveryTarget;
  emailOn: boolean;
  busy: boolean;
  /** The engine's `present`, `absent` or `unreadable`; `reading` until it answers, `unreported` if it did not say. */
  secretStatus: string;
  keychain: string;
  savingSecret: boolean;
  onSecret: (value: string) => void;
  onChange: (patch: { mode?: Mode; enabled?: boolean }) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState('');
  const on = !!target.enabled;
  const held = target.channel === 'email' && !emailOn;
  return (
    <li data-target={target.id} data-channel={target.channel} data-enabled={on ? 'true' : 'false'}>
      <span className="delivery-channel">{CHANNEL_WORDS[target.channel] ?? target.channel}</span>
      <span className="destination-body">
        <span className="delivery-where" title={where(target)}>{where(target)}</span>
        <span className="record-cap">
          {target.channel === 'webhook' && (webhookInline(target.target) ? 'the report’s files inside the envelope' : 'a link to the report’s files')}
          {held && <span data-destination="held">Not sent while this watch’s Email the report switch is off.</span>}
        </span>
        {target.channel === 'webhook' && (
          <span className="destination-secret" data-secret={secretStatus}>
            <span className="record-cap">
              {secretStatus === 'present' ? `Shared secret stored in ${keychain}.`
                : secretStatus === 'absent' ? 'No shared secret yet, so nothing is sent to it.'
                  : secretStatus === 'unreadable' ? `${keychain} would not say whether a secret is stored.`
                    : secretStatus === 'reading' ? 'Reading whether a secret is stored.'
                      : 'resmon did not say whether a secret is stored.'}
            </span>
            <input type="password" value={draft} autoComplete="off" aria-label={`Shared secret for ${where(target)}`}
              placeholder={secretStatus === 'present' ? 'A new secret' : 'The shared secret'}
              onChange={(e) => setDraft(e.target.value)} />
            <button type="button" className="btn sm" disabled={!draft.trim() || savingSecret}
              onClick={() => { onSecret(draft.trim()); setDraft(''); }}>
              {secretStatus === 'present' ? 'Replace' : 'Store'}
            </button>
          </span>
        )}
      </span>
      <span className="destination-acts">
        <select aria-label={`When reports go to ${where(target)}`} value={target.mode} disabled={busy}
          onChange={(e) => onChange({ mode: e.target.value as Mode })}>
          <option value="automatic">Sent when a run finishes</option>
          <option value="review">Waits for you to release it</option>
        </select>
        <button type="button" role="switch" aria-checked={on} className="switch" data-switch="destination" disabled={busy}
          onClick={() => onChange({ enabled: !on })}>
          <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
          {on ? 'On' : 'Off'}
        </button>
        <button type="button" className="btn sm quiet" disabled={busy} onClick={onRemove}>Remove</button>
      </span>
    </li>
  );
}

function AddDestination({ routineId, channels, onAdded }: { routineId: number; channels: readonly string[]; onAdded: () => void }) {
  const [channel, setChannel] = useState(channels[0] ?? 'email');
  const [target, setTarget] = useState('');
  const [mode, setMode] = useState<Mode>('automatic');
  const [inline, setInline] = useState(false);
  const add = useMutation({
    mutationFn: () => answer(engine().POST('/api/routines/{routine_id}/delivery-targets', {
      params: { path: { routine_id: routineId } },
      body: { channel, target: channel === 'webhook' ? webhookTarget(target, inline) : target.trim(), mode, enabled: true },
    })),
    onSuccess: () => {
      setTarget('');
      setInline(false);
      onAdded();
    },
  });
  const asks = ASKS[channel];
  const needsTarget = channel !== 'email';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!needsTarget || target.trim()) add.mutate();
  };
  return (
    <form className="destination-add" {...commandEnter()} onSubmit={submit} aria-label="Add a destination">
      <p className="field-title">Add a destination</p>
      <div className="destination-add-row">
        <select aria-label="Kind of destination" value={channel} onChange={(e) => { setChannel(e.target.value); add.reset(); }}>
          {channels.map((c) => <option key={c} value={c}>{CHANNEL_WORDS[c] ?? c}</option>)}
        </select>
        <input value={target} aria-label="Where it goes" placeholder={asks?.placeholder ?? ''} autoComplete="off" spellCheck={false}
          onChange={(e) => setTarget(e.target.value)} />
        <select aria-label="When reports go there" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="automatic">Sent when a run finishes</option>
          <option value="review">Waits for you to release it</option>
        </select>
        <button type="submit" className="btn" disabled={add.isPending || (needsTarget && !target.trim())}>
          {add.isPending ? 'Adding' : 'Add'}
        </button>
      </div>
      {channel === 'webhook' && (
        <label className="choice destination-inline">
          <input type="checkbox" checked={inline} onChange={(e) => setInline(e.target.checked)} />
          <span>Put the report’s files inside the envelope rather than a link to them</span>
        </label>
      )}
      {asks && <p className="form-hint">{asks.hint}</p>}
      {add.error && <p className="field-error" role="alert">{errorWords(add.error)}</p>}
    </form>
  );
}
