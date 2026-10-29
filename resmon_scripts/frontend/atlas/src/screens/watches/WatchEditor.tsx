import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { systemName } from '../../bridge';
import { Icon } from '../../shell/Icon';
import { SAVED_KEY } from '../collection/savedSearches';
import { RUNS_KEY } from '../runs/RunLog';
import type { CatalogEntry } from '../runs/model';
import { coarseFor, coarseSentence, noneAskableAboutAuthors, paceOf, rateLong } from '../sources/catalog';
import { SourceCatalog, TermsField, useSources, useTerms } from '../sources/SourceCatalog';
import {
  CADENCES, HOUR_STEPS, WEEKDAYS, clockValue, formFrom, fromClock, scheduleWords, seededForm, watchBody, whatIsMissing,
  type Follows, type ScheduleChoice, type WatchForm, type WatchSeed,
} from './editor';
import {
  CALENDAR_KEY, CHANNEL_WORDS, WATCHES_KEY, destinationWords, webhookUrl, type DeliveryTarget, type Routine,
} from './model';
import { PEOPLE_KEY, type Profile } from './people/model';

/** What the watch page and the list say after the editor leaves them. */
export interface EditorSaid { said: string }

const FOLLOWS: readonly { follows: Follows; label: string }[] = [
  { follows: 'words', label: 'Words: papers that match its terms' },
  { follows: 'new_papers', label: 'A person: their new papers' },
  { follows: 'retractions', label: 'A person: retractions and corrections on their papers' },
];

function errorWords(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

function quoted(terms: readonly string[]): string {
  const q = terms.map((t) => `“${t}”`);
  return q.length > 1 ? `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}` : q[0] ?? '';
}

/** What a person's matches can rest on, said in the picker. */
function basisNote(person: Profile): string {
  if (!person.basis_warning) return 'has an ORCID';
  return person.affiliations.length ? 'no ORCID: name and affiliation' : 'no ORCID: name only';
}

/**
 * Whether an email can be sent: `email_sender.load_smtp_config`'s rule, a
 * server, a username and a recipient under Settings, and a stored password.
 * `unknown` when the keychain would not say whether the password is there.
 */
function useEmailAccount(): 'ready' | 'missing' | 'unknown' | null {
  const settings = useQuery({ queryKey: ['email-settings'], queryFn: () => answer(engine().GET('/api/settings/email')) });
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => answer(engine().GET('/api/credentials')) });
  if (!settings.data || !credentials.data) return null;
  const { smtp_server: server, smtp_username: username, smtp_to: to } = settings.data;
  if (!server || !username || !to) return 'missing';
  const password = credentials.data.credentials.smtp_password;
  if (password?.present === true) return 'ready';
  if (password?.present === false) return 'missing';
  return 'unknown';
}

function namesOf(entries: readonly CatalogEntry[]): string {
  const n = entries.map((e) => e.name);
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0] ?? '';
}

/**
 * A watch made, or changed: what it follows, where it asks, when it runs,
 * and what happens when a run finishes, beside a statement of what it will
 * do, written from the same facts the engine and the catalog hold.
 *
 * `/watches/new` makes one, begun empty or from a search or a person handed
 * to it; `/watches/:id/edit` changes one. A change never pauses or resumes a
 * watch (its page does that), and leaves its AI settings as they are.
 */
export function WatchEditor() {
  const { id } = useParams();
  const seed = (useLocation().state as { seed?: WatchSeed } | null)?.seed ?? null;
  if (!id) return <EditorForm existing={null} seed={seed} />;
  return <EditingWatch key={id} raw={id} />;
}

function EditingWatch({ raw }: { raw: string }) {
  const id = Number(raw);
  const routine = useQuery({
    queryKey: ['routine', id],
    enabled: Number.isInteger(id) && id > 0,
    queryFn: () => answer(engine().GET('/api/routines/{routine_id}', { params: { path: { routine_id: id } } })),
  });
  if (routine.isPending) return <div className="page"><p className="page-lede">Reading watch {raw}.</p></div>;
  if (routine.isError || !routine.data) {
    return (
      <div className="page">
        <h1 className="page-title">Watch {raw} could not be read</h1>
        <p className="page-lede">{routine.error?.message ?? 'The engine has no such watch.'}</p>
        <p><Link to="/watches" className="btn">Back to the watches</Link></p>
      </div>
    );
  }
  return <EditorForm existing={routine.data} seed={null} />;
}

function EditorForm({ existing, seed }: { existing: Routine | null; seed: WatchSeed | null }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const initial = useMemo(() => (existing ? formFrom(existing) : seededForm(seed)), [existing, seed]);
  const [form, setForm] = useState<WatchForm>(initial);
  const terms = useTerms(initial.keywords);
  const set = (patch: Partial<WatchForm>) => setForm((f) => ({ ...f, ...patch }));
  const setSchedule = (patch: Partial<ScheduleChoice>) => setForm((f) => ({ ...f, schedule: { ...f.schedule, ...patch } }));
  /** Whether the stored schedule is one the choices cannot state, so "As it is" is offered. */
  const keptOffered = initial.schedule.cadence === 'kept' && !!existing;

  const { sources, keyMissing, pending, failed } = useSources();
  const people = useQuery({ queryKey: PEOPLE_KEY, queryFn: () => answer(engine().GET('/api/profiles')) });
  const persons = (people.data?.profiles ?? []).filter((p) => p.kind === 'person');
  const person: Profile | null = persons.find((p) => p.id === form.profileId) ?? null;

  const current: WatchForm = { ...form, keywords: terms.all };
  const picked = form.sources.flatMap((slug) => sources.filter((entry) => entry.slug === slug));
  const unknown = sources.length ? form.sources.filter((slug) => !sources.some((entry) => entry.slug === slug)) : [];
  const missing = whatIsMissing(current, form.follows === 'retractions' ? 0 : picked.length);

  const choose = (slug: string) => set({
    sources: form.sources.includes(slug) ? form.sources.filter((s) => s !== slug) : [...form.sources, slug],
  });

  const changed = (watchId: number) => {
    void client.invalidateQueries({ queryKey: WATCHES_KEY });
    void client.invalidateQueries({ queryKey: ['routine', watchId] });
    void client.invalidateQueries({ queryKey: CALENDAR_KEY });
    // The engine keeps a saved copy of every watch, so Saved changes with it.
    void client.invalidateQueries({ queryKey: SAVED_KEY });
    void client.invalidateQueries({ queryKey: ['coverage', watchId] });
  };

  const save = useMutation({
    mutationFn: async (): Promise<{ id: number; warning: string | null }> => {
      const body = watchBody(current, existing);
      if (existing) {
        await answer(engine().PUT('/api/routines/{routine_id}', { params: { path: { routine_id: existing.id } }, body }));
        return { id: existing.id, warning: null };
      }
      // A new watch asks no model: summaries go with Ask.
      const made = await answer(engine().POST('/api/routines', { body: { ...body, is_active: body.is_active ?? true, ai_enabled: false } }));
      return { id: made.id, warning: made.entity_warning ?? null };
    },
    onSuccess: ({ id, warning }) => {
      changed(id);
      const said = existing ? 'Saved.' : form.start ? 'Saved, and watching.' : 'Saved, paused.';
      navigate(`/watches/${id}`, { state: { said: warning ? `${said} ${warning}` : said } satisfies EditorSaid });
    },
  });

  const remove = useMutation({
    mutationFn: (watch: Routine) => answer(engine().DELETE('/api/routines/{routine_id}', { params: { path: { routine_id: watch.id } } })),
    onSuccess: (_done, watch) => {
      changed(watch.id);
      void client.invalidateQueries({ queryKey: RUNS_KEY });
      client.removeQueries({ queryKey: ['routine', watch.id] });
      navigate('/watches', {
        state: { said: `Deleted “${watch.name}”. Its runs stay in the run log, and the papers they found stay in your collection.` } satisfies EditorSaid,
      });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (terms.draft.trim()) terms.add();
    if (!missing.length && !save.isPending) save.mutate();
  };

  const back = existing ? `/watches/${existing.id}` : '/watches';
  const { words, cron } = scheduleWords(form, existing);

  return (
    <div className="search watch-editor">
      <form className="ask editor" onSubmit={submit} aria-label={existing ? `Change ${existing.name}` : 'A new watch'}>
        <Link to={back} className="back"><Icon name="back" size={14} />{existing ? existing.name : 'Watches'}</Link>
        <h1 className="page-title editor-title">{existing ? `Change ${existing.name}` : 'A new watch'}</h1>
        <p className="page-lede">
          A watch asks the same question on a schedule and keeps every paper it finds, with a record of what each source did.
        </p>

        <div className="form-field editor-name">
          <label className="form-label" htmlFor="watch-name">Name</label>
          <input id="watch-name" value={form.name} autoComplete="off" placeholder="For example, Perovskite stability"
            onChange={(e) => set({ name: e.target.value })} />
        </div>

        <fieldset className="choices" data-editor="follows">
          <legend className="field-title">What it follows</legend>
          {FOLLOWS.map(({ follows, label }) => (
            <label key={follows} className="choice">
              <input type="radio" name="watch-follows" value={follows} checked={form.follows === follows}
                onChange={() => set({ follows })} />
              <span>{label}</span>
            </label>
          ))}
          {form.follows !== 'words' && (
            <div className="form-field person-pick">
              <label className="form-label" htmlFor="watch-person">Who</label>
              {people.data && !persons.length ? (
                <p className="form-hint" data-editor="no-people">
                  There is no one to watch for yet. <Link to="/watches/people">Add a person under People</Link>, then come back.
                </p>
              ) : (
                <select id="watch-person" value={form.profileId ?? ''}
                  onChange={(e) => set({ profileId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Choose a person</option>
                  {persons.map((p) => (
                    <option key={p.id} value={p.id}>{p.display_name} ({basisNote(p)})</option>
                  ))}
                </select>
              )}
              {person && (
                <p className="form-hint" data-editor="person-basis">
                  {person.basis_warning
                    ? person.basis_warning.replace(/\*\*/g, '')
                    : 'This person has an ORCID, so a paper whose source returns it is matched by identity rather than by a name.'}
                </p>
              )}
            </div>
          )}
        </fieldset>

        {form.follows === 'words' ? (
          <TermsField id="watch-terms" label="Terms to watch for" state={terms} className="compact" />
        ) : (
          <p className="form-hint editor-aside" data-editor="no-keywords">
            A watch on a person uses no terms. Narrowing a person’s work by topic would silently hide the rest of it.
          </p>
        )}

        {form.follows === 'retractions' ? (
          <p className="form-hint editor-aside" data-editor="no-sources">
            This watch asks no source. It checks the papers already matched to this person against the retraction and
            correction notices resmon holds.
          </p>
        ) : (
          <SourceCatalog
            name="watch-source"
            legend="Sources"
            count={`${picked.length} of ${sources.length} chosen`}
            sources={sources}
            chosen={form.sources}
            multiple
            keyMissing={keyMissing}
            pending={pending}
            failed={failed}
            onChoose={choose}
          />
        )}

        <ScheduleField form={form} keptOffered={keptOffered} storedWords={keptOffered ? scheduleWords(initial, existing).words : null}
          storedCron={existing?.schedule_cron ?? ''} onCadence={(cadence) => setSchedule({ cadence })} onChange={setSchedule} />

        {form.follows !== 'retractions' && (
          <div className="ask-window">
            <fieldset className="window">
              <legend>Published</legend>
              <label className="date">
                <span>From</span>
                <input type="date" value={form.dateFrom} onChange={(e) => set({ dateFrom: e.target.value })} />
              </label>
              <label className="date">
                <span>To</span>
                <input type="date" value={form.dateTo} onChange={(e) => set({ dateTo: e.target.value })} />
              </label>
            </fieldset>
            <label className="cap">
              <span>Up to</span>
              <input type="number" min={1} max={1000} value={form.cap} aria-label="Most papers per source"
                onChange={(e) => set({ cap: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })} />
              <span>papers per source, each run</span>
            </label>
            <p className="form-hint window-hint">
              Leave both dates empty to ask for the newest papers on every run. Dates set here are the same window on
              every run.
            </p>
          </div>
        )}

        <div className="form-field editor-intent">
          <label className="form-label" htmlFor="watch-intent">What it is really looking for <span className="form-optional">optional</span></label>
          <textarea id="watch-intent" rows={2} value={form.intent} placeholder="Methods that keep perovskite cells stable outdoors"
            onChange={(e) => set({ intent: e.target.value })} />
          <p className="form-hint">
            In your own words. Its coverage audit compares what it finds with this sentence; without one, the audit can only
            compare the results with the terms that found them.
          </p>
        </div>

        <fieldset className="choices editor-switches" data-editor="finish">
          <legend className="field-title">When a run finishes</legend>
          <EditorSwitch label="Notify me" on={form.notify} name="notify_on_complete" onFlip={(notify) => set({ notify })} />
          <EditorSwitch label="Email the report" on={form.email} name="email_enabled" onFlip={(email) => set({ email })} />
          <EditorSwitch label="Attach its results to the email" on={form.email && form.attach} name="email_ai_summary_enabled"
            disabled={!form.email} onFlip={(attach) => set({ attach })} />
          <p className="form-hint">
            Email goes through the account under <Link to="/settings/email">Settings, Email</Link>; notifications follow{' '}
            <Link to="/settings/notifications">Settings, Notifications</Link>.
          </p>
          {!existing && (
            <EditorSwitch label="Start watching when saved" on={form.start} name="is_active" onFlip={(start) => set({ start })} />
          )}
        </fieldset>

        {existing?.ai_enabled && (
          <p className="form-hint editor-aside" data-editor="ai">
            This watch also asks a model to summarize what it finds. That is set where Ask is, and a save here leaves it as
            it is.
          </p>
        )}

        <div className="ask-go">
          <button type="submit" className="btn primary go" disabled={missing.length > 0 || save.isPending}>
            {save.isPending ? 'Saving' : existing ? 'Save changes' : 'Save watch'}
          </button>
          <Link to={back} className="btn quiet go-cancel">Cancel</Link>
          <div className="ask-facts" aria-live="polite">
            {missing.map((m) => <p key={m}>{m}</p>)}
            {save.error && <p className="ask-refusal" role="alert" data-editor="refusal">{errorWords(save.error)}</p>}
          </div>
        </div>

        {existing && (
          <div className="editor-delete">
            <button type="button" className="btn quiet" data-editor="delete" disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete “${existing.name}”? Its schedule, its destinations and its record of missed fires go. Its runs stay in the run log, and the papers they found stay in your collection.`)) {
                  remove.mutate(existing);
                }
              }}>
              Delete this watch
            </button>
            {remove.error && <p className="field-error" role="alert">{errorWords(remove.error)}</p>}
          </div>
        )}
      </form>

      <WillDo form={current} existing={existing} picked={picked} unknown={unknown} person={person}
        keyMissing={keyMissing} words={words} cron={cron} />
    </div>
  );
}

function EditorSwitch({ label, on, name, disabled, onFlip }: {
  label: string; on: boolean; name: string; disabled?: boolean; onFlip: (on: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} className="switch" data-switch={name} disabled={disabled}
      onClick={() => onFlip(!on)}>
      <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
      {label}
    </button>
  );
}

function ScheduleField({ form, keptOffered, storedWords, storedCron, onCadence, onChange }: {
  form: WatchForm;
  keptOffered: boolean;
  storedWords: string | null;
  storedCron: string;
  onCadence: (cadence: ScheduleChoice['cadence']) => void;
  onChange: (patch: Partial<ScheduleChoice>) => void;
}) {
  const s = form.schedule;
  const timed = s.cadence !== 'hours' && s.cadence !== 'kept';
  return (
    <fieldset className="choices schedule" data-editor="schedule" data-cadence={s.cadence}>
      <legend className="field-title">When it runs</legend>
      <div className="seg" role="group" aria-label="How often">
        {keptOffered && (
          <button type="button" aria-pressed={s.cadence === 'kept'} onClick={() => onCadence('kept')}>As it is</button>
        )}
        {CADENCES.map(({ cadence, label }) => (
          <button key={cadence} type="button" aria-pressed={s.cadence === cadence} onClick={() => onCadence(cadence)}>{label}</button>
        ))}
      </div>
      <div className="schedule-row">
        {s.cadence === 'kept' && (
          <p className="form-hint">
            {storedWords ? `${storedWords}, ` : 'On '}
            <code className="cron">{storedCron}</code>{storedWords ? '' : ', which the choices here cannot state'}. Kept as it is
            unless you choose another.
          </p>
        )}
        {s.cadence === 'weekly' && (
          <label className="date">
            <span>On</span>
            <select aria-label="Day of the week" value={s.weekday} onChange={(e) => onChange({ weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((day, i) => <option key={day} value={i}>{day}</option>)}
            </select>
          </label>
        )}
        {s.cadence === 'monthly' && (
          <label className="date">
            <span>On day</span>
            <select aria-label="Day of the month" value={s.monthDay} onChange={(e) => onChange({ monthDay: Number(e.target.value) })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        )}
        {s.cadence === 'hours' && (
          <>
            <label className="date">
              <span>Every</span>
              <select aria-label="Every how many hours" value={s.everyHours} onChange={(e) => onChange({ everyHours: Number(e.target.value) })}>
                {HOUR_STEPS.map((n) => <option key={n} value={n}>{n === 1 ? 'hour' : `${n} hours`}</option>)}
              </select>
            </label>
            <label className="date">
              <span>at minute</span>
              <input type="number" min={0} max={59} aria-label="Minute past the hour" value={s.minute} className="minute"
                onChange={(e) => onChange({ minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })} />
            </label>
          </>
        )}
        {timed && (
          <label className="date">
            <span>At</span>
            <input type="time" aria-label="Time of day" value={clockValue(s.hour, s.minute)}
              onChange={(e) => { const t = fromClock(e.target.value); if (t) onChange(t); }} />
          </label>
        )}
      </div>
      {s.cadence === 'monthly' && (
        <p className="form-hint">Days 29 to 31 are not offered: some months do not have them, and those months would not run.</p>
      )}
    </fieldset>
  );
}

/**
 * What the watch will do, said from the form as it stands: when it runs, in
 * the scheduler's words; what it asks of which sources; what the catalog
 * says about those sources for this question; and what happens when a run
 * finishes. Each sentence is the form's own fact or the catalog's, and none
 * guesses at how many papers a run will find.
 */
function WillDo({ form, existing, picked, unknown, person, keyMissing, words, cron }: {
  form: WatchForm;
  existing: Routine | null;
  picked: readonly CatalogEntry[];
  unknown: readonly string[];
  person: Profile | null;
  keyMissing: (entry: CatalogEntry) => boolean;
  words: string | null;
  cron: string;
}) {
  const pace = form.follows === 'retractions' ? null : paceOf(picked);
  const coarse = form.follows === 'retractions' ? [] : coarseFor(picked, form.dateFrom, form.dateTo);
  const window = form.dateFrom || form.dateTo
    ? `, published ${form.dateFrom ? `from ${form.dateFrom}` : 'any time'}${form.dateTo ? ` to ${form.dateTo}` : ' onward'}, the same dates on every run`
    : ', the newest each time';
  const who = person?.display_name ?? 'the person you choose';
  const where = picked.length ? namesOf(picked) : 'the sources you choose';
  const unkeyed = form.follows === 'retractions' ? [] : picked.filter(keyMissing);
  const account = useEmailAccount();
  const targets = useQuery({
    queryKey: ['delivery-targets', existing?.id],
    enabled: !!existing,
    queryFn: () => answer(engine().GET('/api/routines/{routine_id}/delivery-targets', {
      params: { path: { routine_id: existing?.id ?? 0 } },
    })),
  });
  const stored: DeliveryTarget[] = targets.data?.targets ?? [];
  // `delivery.enqueue_for_execution`: the email switch gates every email
  // destination, and with it on and none stored, one to the Settings address
  // is made on the next run. Other channels send whatever the switch says.
  const emailTargets = stored.filter((t) => t.channel === 'email');
  const emailsOn = emailTargets.filter((t) => t.enabled);
  const emailOff = form.email && emailTargets.length > 0 && emailsOn.length === 0;
  const others = stored.filter((t) => t.channel !== 'email' && t.enabled);
  // A webhook with no shared secret is refused before anything is sent
  // (`delivery`'s webhook adapter), so it is named as failing, not as a destination.
  const secrets = useQuery({ queryKey: ['credentials'], queryFn: () => answer(engine().GET('/api/credentials')) });
  const unsigned = (t: DeliveryTarget) => t.channel === 'webhook'
    && secrets.data?.credentials[`webhook_secret_${t.id}`]?.status === 'absent';
  const sends = form.notify || (form.email && !emailOff) || others.length > 0;

  return (
    <aside className="index will-do" aria-label="What it will do">
      <div className="index-bar"><h2>What it will do</h2></div>
      <div className="index-scroll">
        <section className="will" data-will="schedule">
          <h3>When</h3>
          <p>
            {words ? `${words}, in this computer’s time.` : <>On the schedule <code className="cron">{cron || 'none'}</code>, which the words here cannot state exactly.</>}
          </p>
          <p className="will-quiet">
            {existing
              ? (existing.is_active ? 'It is watching. Saving does not change that.' : 'It is paused. Saving does not resume it; its page does.')
              : (form.start ? 'It starts watching when it is saved.' : 'It is saved paused, and runs only when you ask it to.')}
            {' '}A run due while resmon is closed is recorded as missed.
          </p>
        </section>

        <section className="will" data-will="asks">
          <h3>What it asks</h3>
          {form.follows === 'words' && (
            <p>
              Asks {where} for papers matching {form.keywords.length ? quoted(form.keywords) : 'its terms'}{window}, up to {form.cap} from
              each.
            </p>
          )}
          {form.follows === 'new_papers' && (
            <p>
              Asks {where} for new papers by {who}{window}, up to {form.cap} from each.{' '}
              {person?.basis_warning
                ? `${who} has no ORCID, so no match rests on identity: each says whether it rests on a name and an affiliation, or on the name alone.`
                : `Each paper’s match to ${who} says what it rests on: an ORCID the source returned, or the name, with or without an affiliation.`}
            </p>
          )}
          {form.follows === 'retractions' && (
            <p>Checks the papers already matched to {who} against the retraction and correction notices resmon holds. It asks no source.</p>
          )}
          {form.follows === 'words' && picked.length > 1 && (
            <p className="will-quiet">Each source combines the terms its own way, as its row in the catalog says.</p>
          )}
          {form.follows === 'new_papers' && noneAskableAboutAuthors(picked) && (
            <p className="will-warn" data-will="unaskable">
              None of these sources can be asked about an author, so it will find nothing until you add one that can.
            </p>
          )}
          {pace && <p className="will-quiet">{pace.entry.name} allows {rateLong(pace.rate)}, the slowest of these; it sets how long each run takes.</p>}
          {coarse.length > 0 && <p className="will-quiet">{coarseSentence(coarse)}</p>}
          {unkeyed.map((entry) => (
            <p key={entry.slug} className="will-warn">{entry.name} has no API key here, so every run will record it as not queried.</p>
          ))}
          {unknown.length > 0 && (
            <p className="will-warn" data-will="unknown-sources">
              {unknown.join(', ')} {unknown.length === 1 ? 'is' : 'are'} stored on this watch but {unknown.length === 1 ? 'is not a source' : 'are not sources'} this
              copy of resmon can ask. Saving keeps {unknown.length === 1 ? 'it' : 'them'}, and no run here can ask {unknown.length === 1 ? 'it' : 'them'}.
            </p>
          )}
        </section>

        <section className="will" data-will="finish">
          <h3>When a run finishes</h3>
          {!sends && <p>Nothing is sent. Its runs and reports are kept here.</p>}
          {form.notify && <p>A notification, if {systemName()} lets resmon post them. Clicking it opens the run.</p>}
          {form.email && !emailOff && (
            <p>
              An email with the report{form.attach ? ', and its results attached' : ''}, to{' '}
              {emailsOn.length ? emailsOn.map((t) => destinationWords('email', t.target)).join(', ') : 'the address in Settings'}.
            </p>
          )}
          {emailOff && (
            <p className="will-warn" data-will="email-off">
              Its email destinations are turned off under Where reports go, so no email is sent.
            </p>
          )}
          {others.map((t) => (unsigned(t)
            ? (
              <p key={t.id} className="will-warn" data-will="unsigned">
                Webhook: {webhookUrl(t.target)} has no shared secret stored, so each delivery to it will fail until one is.
              </p>
            )
            : (
              <p key={t.id} data-will="destination">
                {CHANNEL_WORDS[t.channel] ?? t.channel}: {t.channel === 'webhook' ? webhookUrl(t.target) : destinationWords(t.channel, t.target)}
                {t.mode === 'review' ? ', after you release each report' : ''}.
              </p>
            )))}
          {form.email && !emailOff && account === 'missing' && (
            <p className="will-warn" data-will="no-email-account">
              No email account is fully set up under Settings, Email, so each email will fail, and say so under Where
              reports go, until one is.
            </p>
          )}
          {form.email && account === 'unknown' && (
            <p className="will-quiet">The keychain would not say whether the email password is stored.</p>
          )}
          <p className="will-quiet">
            {existing
              ? 'Destinations are added and changed on its page, under Where reports go.'
              : 'Once it is saved, its page can send reports to a folder, a feed, a webhook, or another address.'}
          </p>
        </section>

        <section className="will" data-will="intent">
          <h3>Its coverage audit</h3>
          <p>
            {form.intent.trim()
              ? `Compares what it finds with “${form.intent.trim()}”.`
              : 'With no sentence of yours, it compares what it finds with the terms that found it, which is circular.'}
          </p>
        </section>
      </div>
    </aside>
  );
}
