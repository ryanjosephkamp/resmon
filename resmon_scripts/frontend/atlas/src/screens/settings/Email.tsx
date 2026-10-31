import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { platform } from '../../bridge';
import { WATCHES_KEY } from '../watches/model';
import { keychainName, type EmailSettings } from './model';
import { commandEnter } from '../../shell/shortcuts';

const PASSWORD = 'smtp_password';

type EmailField = 'smtp_server' | 'smtp_port' | 'smtp_username' | 'smtp_from' | 'smtp_to';

const FIELDS: readonly { key: EmailField; id: string; label: string; hint?: string; type?: string }[] = [
  { key: 'smtp_server', id: 'smtp-server', label: 'SMTP server', hint: 'smtp.gmail.com, for example' },
  { key: 'smtp_port', id: 'smtp-port', label: 'Port', hint: '587 for STARTTLS', type: 'number' },
  { key: 'smtp_username', id: 'smtp-username', label: 'Username' },
  { key: 'smtp_from', id: 'smtp-from', label: 'From', hint: 'the address the report comes from', type: 'email' },
  { key: 'smtp_to', id: 'smtp-to', label: 'To', hint: 'one or more addresses, separated by commas' },
];

function refusal(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

/**
 * Email: where a watch's report is sent when its Email the report switch is
 * on. The SMTP password is not one of these settings. It goes to the
 * operating system's own credential store, and only whether one is stored
 * ever comes back.
 */
export function Email() {
  const settings = useQuery({
    queryKey: ['email-settings'],
    queryFn: () => answer(engine().GET('/api/settings/email')),
  });
  return (
    <section className="settings-group email" aria-labelledby="email-title" aria-busy={settings.isPending}>
      <h2 id="email-title" className="group-title">Email</h2>
      <p className="group-lede">
        Where a watch sends its report when its <em>Email the report</em> switch is on, through your own mail
        provider’s SMTP server.
      </p>
      <Mailing />
      {settings.isError && <p className="field-error" role="alert">The engine did not answer ({settings.error.message}).</p>}
      {/* Mounted once what is stored arrives, so the form starts from it. A later
          read changes what counts as unsaved, and never what has been typed. */}
      {settings.data && <EmailForm stored={settings.data} />}
    </section>
  );
}

/** Which watches email their reports, so the settings are read against what uses them. */
function Mailing() {
  const watches = useQuery({ queryKey: WATCHES_KEY, queryFn: () => answer(engine().GET('/api/routines')) });
  if (!watches.data) return null;
  const mailing = watches.data.filter((w) => w.email_enabled);
  return (
    <p className="field-lede" data-email="mailing">
      {mailing.length === 0
        ? 'No watch emails its report yet.'
        : <>
            {mailing.length === 1 ? 'One watch emails its report: ' : `${mailing.length} watches email their reports: `}
            {mailing.map((w, i) => (
              <span key={w.id}>{i > 0 && ', '}<Link to={`/watches/${w.id}`}>{w.name}</Link></span>
            ))}.
          </>}
    </p>
  );
}

function EmailForm({ stored }: { stored: EmailSettings }) {
  const client = useQueryClient();
  const [form, setForm] = useState<EmailSettings>(stored);
  const dirty = FIELDS.some((f) => form[f.key] !== stored[f.key]);

  const save = useMutation({
    mutationFn: () => answer(engine().PUT('/api/settings/email', { body: { settings: { ...form } } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ['email-settings'] }),
  });
  // The test reads what is stored, so unsaved changes are saved first rather
  // than tested against values the person has already replaced.
  const test = useMutation({
    mutationFn: async () => {
      if (dirty) await save.mutateAsync();
      return answer(engine().POST('/api/settings/email/test'));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    test.reset();
    save.mutate();
  };

  return (
    <form className="settings-form email-form" {...commandEnter()} onSubmit={submit} aria-label="Email settings">
      <div className="form-grid">
        {FIELDS.map((f) => (
          <label key={f.key} className="form-field" htmlFor={f.id}>
            <span className="form-label">{f.label}</span>
            <input
              id={f.id}
              type={f.type ?? 'text'}
              value={form[f.key]}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setForm({ ...form, [f.key]: event.target.value })}
            />
            {f.hint && <span className="form-hint">{f.hint}</span>}
          </label>
        ))}
      </div>
      <Password />
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving' : 'Save'}
        </button>
        <button type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate()} data-email="test">
          {test.isPending ? 'Sending' : dirty ? 'Save and send a test email' : 'Send a test email'}
        </button>
        {save.isSuccess && !dirty && !test.data && !test.error && <span className="settings-said" role="status">Saved.</span>}
      </div>
      <p className="form-hint">The test sends one message to the first address in To, with what is saved.</p>
      {test.data && (
        <p className="settings-said" role="status" data-email="test-result" data-state="sent">
          Test email sent to {test.data.recipient}. Check that inbox, and its spam folder, to see it arrived.
        </p>
      )}
      {test.error && (
        <p className="field-error" role="alert" data-email="test-result" data-state="refused">{refusal(test.error)}</p>
      )}
      {save.error && !test.error && <p className="field-error" role="alert">{refusal(save.error)}</p>}
    </form>
  );
}

/**
 * The password, stored by its own button. The field is never filled from the
 * engine, because the engine never returns it: what comes back is whether
 * one is stored, or that the keychain would not say.
 */
function Password() {
  const client = useQueryClient();
  const [value, setValue] = useState('');
  const credentials = useQuery({
    queryKey: ['credentials'],
    queryFn: () => answer(engine().GET('/api/credentials')),
  });
  const status = credentials.data?.credentials[PASSWORD]?.status ?? null;
  const store = useMutation({
    mutationFn: () => answer(engine().PUT('/api/credentials/{key_name}', {
      params: { path: { key_name: PASSWORD } }, body: { value },
    })),
    onSuccess: () => {
      setValue('');
      void client.invalidateQueries({ queryKey: ['credentials'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => answer(engine().DELETE('/api/credentials/{key_name}', { params: { path: { key_name: PASSWORD } } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ['credentials'] }),
  });
  const where = keychainName(platform());

  return (
    <div className="password" data-email="password" data-state={status ?? 'unknown'}>
      <label className="form-field" htmlFor="smtp-password">
        <span className="form-label">Password</span>
        <span className="password-row">
          <input
            id="smtp-password"
            type="password"
            value={value}
            autoComplete="new-password"
            placeholder={status === 'present' ? 'Stored; type a new one to replace it' : ''}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="button" className="btn" disabled={!value || store.isPending} onClick={() => store.mutate()}>
            {status === 'present' ? 'Replace' : 'Store'}
          </button>
          {status === 'present' && (
            <button type="button" className="btn quiet" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</button>
          )}
        </span>
      </label>
      <p className="form-hint" data-email="password-status">
        {status === 'present' && `A password is stored in ${where}. resmon reads it only to send, and never shows it.`}
        {status === 'absent' && `No password is stored. One you store goes to ${where}, not to resmon’s database.`}
        {status === 'unreadable' && `A password may be stored in ${where}, but this copy of resmon is not allowed to read it. `
          + 'Store it again to replace it.'}
        {status === null && (credentials.isError ? 'The engine did not say whether a password is stored.' : 'Asking whether a password is stored.')}
      </p>
      {(store.error || remove.error) && <p className="field-error" role="alert">{refusal((store.error ?? remove.error) as Error)}</p>}
    </div>
  );
}
