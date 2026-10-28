import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { PaperSky, basisWords } from '../sky/PaperSky';
import { RUNS_KEY } from '../runs/RunLog';
import { count, number, when } from '../today/format';
import { CoverageTab } from './CoverageTab';
import { DeliveryTab } from './DeliveryTab';
import { useCalendar } from './MonthAhead';
import { Nights } from './Nights';
import { useWatchPapers } from './Watches';
import {
  CALENDAR_KEY, WATCHES_KEY, instant, promisedFires, scheduleText, watchAsks, type Routine,
} from './model';

const TABS = ['What it finds', 'Where reports go', 'Schedule'] as const;
type Tab = typeof TABS[number];

/** The switches a watch carries, by the column each one writes. */
type SwitchColumn = 'notify_on_complete' | 'email_enabled';

/**
 * One watch: what it asks and when, its constellation (every paper its runs
 * collected, marked where it sits in the collection, the latest night's
 * ringed), its nights, and its record: whether it finds what was meant, where
 * its reports went, and when it fires.
 *
 * **Run now** is on every watch, paused or not. The engine runs a paused
 * watch once when asked, and says so; it refuses a second run while one is
 * going, and the refusal names that run. The screen shows the engine's own
 * sentence in both cases rather than one written here.
 */
export function Watch() {
  const { id } = useParams();
  // Keyed by the watch, so going from one watch to another starts on the
  // first tab at the top rather than where the last one was left.
  return <WatchPage key={id} raw={id ?? ''} />;
}

function WatchPage({ raw }: { raw: string }) {
  const id = Number(raw);
  const client = useQueryClient();
  const [now] = useState(() => new Date());
  const [tab, setTab] = useState<Tab>('What it finds');
  const [said, setSaid] = useState<{ run: number | null; text: string } | null>(null);

  const routine = useQuery({
    queryKey: ['routine', id],
    enabled: Number.isInteger(id) && id > 0,
    queryFn: () => answer(engine().GET('/api/routines/{routine_id}', { params: { path: { routine_id: id } } })),
  });
  const nights = useQuery({
    queryKey: ['routine-runs', id],
    enabled: routine.isSuccess,
    queryFn: () => answer(engine().GET('/api/executions', { params: { query: { routine_id: id, limit: 60 } } })),
    refetchInterval: (query) => ((query.state.data ?? []).some((run) => run.status === 'running') ? 1_500 : false),
  });
  const running = (nights.data ?? []).find((run) => run.status === 'running') ?? null;
  const latest = (nights.data ?? []).find((run) => run.status !== 'running') ?? null;
  const papers = useWatchPapers(routine.isSuccess ? id : null);
  const lastNight = useQuery({
    queryKey: ['run-papers-ids', latest?.id],
    enabled: !!latest,
    queryFn: () => answer(engine().GET('/api/executions/{exec_id}/documents', {
      params: { path: { exec_id: latest?.id ?? 0 }, query: { limit: 200, offset: 0 } },
    })),
  });
  const calendar = useCalendar(now);
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = useMemo(() => new Map((catalog.data ?? []).map((e) => [e.slug, e.name])), [catalog.data]);

  const changed = () => {
    void client.invalidateQueries({ queryKey: ['routine', id] });
    void client.invalidateQueries({ queryKey: WATCHES_KEY });
    void client.invalidateQueries({ queryKey: CALENDAR_KEY });
  };
  const schedule = useMutation({
    mutationFn: (active: boolean) => answer(active
      ? engine().POST('/api/routines/{routine_id}/activate', { params: { path: { routine_id: id } } })
      : engine().POST('/api/routines/{routine_id}/deactivate', { params: { path: { routine_id: id } } })),
    onSuccess: changed,
  });
  const flip = useMutation({
    mutationFn: ({ column, on }: { column: SwitchColumn; on: boolean }) => answer(engine().PUT('/api/routines/{routine_id}', {
      params: { path: { routine_id: id } }, body: { [column]: on },
    })),
    onSuccess: changed,
  });
  const runNow = useMutation({
    mutationFn: () => answer(engine().POST('/api/routines/{routine_id}/run', { params: { path: { routine_id: id } } })),
    onMutate: () => setSaid(null),
    onSuccess: (started) => {
      setSaid({ run: started.execution_id, text: started.detail });
      void client.invalidateQueries({ queryKey: ['routine-runs', id] });
      void client.invalidateQueries({ queryKey: RUNS_KEY });
      void client.invalidateQueries({ queryKey: WATCHES_KEY });
    },
    onError: (error) => setSaid({
      run: null,
      text: error instanceof EngineError && error.detail ? error.detail : error.message,
    }),
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

  const data: Routine = routine.data;
  const asks = watchAsks(data.parameters);
  const words = scheduleText(data.schedule_cron, data.parameters);
  const fires = promisedFires(calendar.data ?? [], id, now);
  const ringed = (lastNight.data?.papers ?? []).map((p) => p.id);
  const sourceNames = asks.sources.map((s) => names.get(s) ?? s);

  return (
    <div className="run watch-page" data-routine={data.id} data-active={data.is_active ? 'true' : 'false'}
      aria-busy={routine.isFetching}>
      <header className="run-head">
        <Link to="/watches" className="back"><Icon name="back" size={14} />Watches</Link>
        <div className="run-headline">
          <h1 className="run-name it">{data.name}</h1>
          <div className="run-actions">
            <button type="button" className="btn primary" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
              <Icon name="arrow" size={14} />Run now
            </button>
            <button type="button" className="btn" onClick={() => schedule.mutate(!data.is_active)} disabled={schedule.isPending}>
              {data.is_active ? 'Pause' : 'Resume'}
            </button>
          </div>
        </div>
        <div className="meta run-meta">
          <span className="watch-state" data-active={data.is_active ? 'true' : 'false'}>{data.is_active ? 'Watching' : 'Paused'}</span>
          <span className="sep" />
          {words ? <span>{words}</span> : <code className="cron">{data.schedule_cron}</code>}
          {data.is_active && fires[0] && (<><span className="sep" /><span>next {when(fires[0].start, now)}</span></>)}
          <span className="sep" />
          <span title={sourceNames.join(', ')}>
            {asks.person ? 'a person' : `“${asks.query || asks.keywords.join(', ')}”`} in{' '}
            {sourceNames.length > 4
              ? `${sourceNames.slice(0, 3).join(', ')} and ${sourceNames.length - 3} more`
              : sourceNames.join(', ') || 'no sources'}
          </span>
          {running && (
            <><span className="sep" /><Link to={`/runs/${running.id}`} className="run-status" data-status="running">
              <i className="live-dot" aria-hidden="true" />running now, run {running.id}
            </Link></>
          )}
        </div>
        {said && (
          said.run !== null
            ? <p className="run-note run-now-said" data-run-started={said.run}>
              {said.text} <Link to={`/runs/${said.run}`}>Open run {said.run}</Link>
            </p>
            : <p className="run-note run-now-refusal" role="alert">{said.text}</p>
        )}
        {(schedule.error || flip.error) && (
          <p className="field-error" role="alert">{(schedule.error ?? flip.error)?.message}</p>
        )}
        <div className="watch-switches" role="group" aria-label="When a run finishes">
          <Switch label="Notify me when it finishes" column="notify_on_complete" on={data.notify_on_complete}
            busy={flip.isPending} onFlip={(on) => flip.mutate({ column: 'notify_on_complete', on })} />
          <Switch label="Email the report" column="email_enabled" on={data.email_enabled}
            busy={flip.isPending} onFlip={(on) => flip.mutate({ column: 'email_enabled', on })} />
        </div>
      </header>

      <div className="run-main watch-main">
        <PaperSky
          marked={papers.data?.document_ids ?? []}
          bright={ringed}
          outline
          label={`Where ${data.name}'s papers sit in the collection`}
          caption={({ placed, ready, basis }) => {
            if (!papers.data) return 'Reading this watch\'s papers.';
            const { total, document_ids: ids } = papers.data;
            if (!total) return 'This watch has not collected any papers yet.';
            if (!ready) return `The collection map is not ready yet; this watch's ${count(total, 'paper')} are marked once it is.`;
            const of = ids.length < total ? `the latest ${number(ids.length)} of ${count(total, 'paper')}` : count(total, 'paper');
            const night = latest && ringed.length ? ` Ringed: the ${count(ringed.length, 'paper')} from its latest run.` : '';
            const share = placed === ids.length ? `${of}, ${basisWords(basis)}` : `${number(placed ?? 0)} of ${of} on the map (the rest are not placed yet)`;
            return `Its papers: ${share}.${night}`;
          }}
        />
        <Nights runs={nights.data ?? null} now={now} names={names} />
      </div>

      <section className="run-record" aria-label="The watch's record">
        <div className="run-tabs" role="tablist" aria-label="Record">
          {TABS.map((name) => (
            <button key={name} type="button" role="tab" id={`watch-tab-${name}`} aria-selected={tab === name}
              aria-controls="watch-tab-panel" onClick={() => setTab(name)}>
              {name}
            </button>
          ))}
        </div>
        <div className="run-panel" role="tabpanel" id="watch-tab-panel" aria-labelledby={`watch-tab-${tab}`}>
          {tab === 'What it finds' && <CoverageTab routine={data} />}
          {tab === 'Where reports go' && <DeliveryTab routineId={id} />}
          {tab === 'Schedule' && <ScheduleTab routine={data} fires={fires} now={now} />}
        </div>
      </section>
    </div>
  );
}

function Switch({ label, column, on, busy, onFlip }: {
  label: string; column: SwitchColumn; on: boolean; busy: boolean; onFlip: (on: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} className="switch" data-switch={column}
      disabled={busy} onClick={() => onFlip(!on)}>
      <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
      {label}
    </button>
  );
}

function ScheduleTab({ routine, fires, now }: { routine: Routine; fires: ReturnType<typeof promisedFires>; now: Date }) {
  const words = scheduleText(routine.schedule_cron, routine.parameters);
  const missed = routine.missed_fire_details;
  const created = instant(routine.created_at);
  return (
    <div className="watch-schedule">
      <p className="record-cap">
        {words ? `${words}, in this computer's time` : 'On a schedule the words cannot state exactly'}:{' '}
        <code className="cron">{routine.schedule_cron}</code>.
        {created && ` Made ${when(created.toISOString(), now)}.`}
      </p>
      <h3 className="record-sub">Next fires</h3>
      {routine.is_active
        ? (
          <ol className="next-fires">
            {fires.slice(0, 10).map((fire) => (
              <li key={String(fire.id)} data-at={fire.start}><span className="next-when">{when(fire.start, now)}</span></li>
            ))}
          </ol>
        )
        : <p className="record-cap">None: this watch is paused. It runs only when you ask it to, until it is resumed.</p>}
      <h3 className="record-sub">Fires that did not run</h3>
      {missed.length
        ? (
          <ol className="missed-list">
            {missed.map((fire) => (
              <li key={fire.id}>
                <span>due {when(instant(fire.due_at_utc)?.toISOString(), now)}</span>
                <span className="sep" />
                <span>{fire.disposition === 'ran_late' ? 'ran late, when you asked for a run' : (fire.disposition ?? 'not run')}</span>
              </li>
            ))}
          </ol>
        )
        : <p className="record-cap">None recorded.</p>}
    </div>
  );
}
