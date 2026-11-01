import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { when } from '../today/format';
import { HealthTabs } from './HealthTabs';
import { LifecycleCheck } from './LifecycleCheck';
import {
  SEVERITY_MEANING, SEVERITY_WORDS, WATCHDOG_KEY, findingWords, instantOf, scopeWords, thresholdWords, watchdogVerdict,
  type WatchdogFinding, type WatchdogUnjudged,
} from './model';

/**
 * Evidence keys a person can read, the classic page's labels. A key without
 * one is machine detail the finding's own sentences already state, and is
 * left out rather than printed raw.
 */
const EVIDENCE: Record<string, string> = {
  consecutive_errors: 'Failed runs in a row',
  last_error: 'Most recent error',
  last_success_at: 'Last answer on record',
  runs_recorded: 'Runs on record',
  credential_name: 'Credential needed',
  last_run_at: 'Last run',
  selected_by_active_routines: 'Selected by',
  zero_runs: 'Empty runs in a row',
  baseline_runs: 'Runs it used to deliver on',
  typical_results: 'Typical result count',
  last_productive_run_at: 'Last run that returned papers',
  quiet_for: 'Quiet for',
  silent_days: 'Days silent',
  typical_gap_days: 'Usual gap between runs (days)',
  runs_without_new_results: 'Runs with nothing new',
  last_new_result_at: 'Last new paper found',
  cadence_days: 'Runs about every (days)',
  skipped_fires: 'Fires skipped',
  runs_in_part: 'Runs answered in part, in a row',
  last_skipped_due_at_utc: 'Last skipped fire was due',
};

/** What an evidence key with no value means, where "—" would not say it. */
const NONE: Record<string, string> = {
  last_success_at: 'None on record',
};

/**
 * A withdrawn source's evidence, labeled for what it is. resmon declines to
 * ask it, so its streak is runs that got nothing from it, not failures; and
 * its most recent error is the withdrawal paragraph the detail already says in
 * full, so it is not said twice.
 */
const WITHDRAWN: Record<string, string | null> = {
  consecutive_errors: 'Runs in a row with nothing from it',
  last_error: null,
};

function evidenceWords(key: string, value: unknown, now: Date): string {
  if (value === null || value === undefined) return NONE[key] ?? '—';
  // A timestamp the engine stored reads as a time, not as ISO.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) {
    const at = instantOf(value);
    if (at) return when(at.toISOString(), now);
  }
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The Watchdog: what resmon can say is wrong with its watching, and what it
 * cannot judge yet.
 *
 * Broken is a thing resmon recorded happening; looks unusual is a departure
 * from your own history; advice is never an alarm, and neither is a source
 * resmon withdrew, which is listed apart. With no history, the
 * screen says there is nothing to check yet rather than that all is well. A
 * muted finding stays on the screen, in its own section, and goes when its
 * reason goes, so a recurrence is reported afresh.
 *
 * Below it is the check for retractions and updates (`LifecycleCheck`):
 * whether the papers already found still stand.
 */
export function Watchdog() {
  const client = useQueryClient();
  const now = useMemo(() => new Date(), []);
  const report = useQuery({
    queryKey: WATCHDOG_KEY,
    queryFn: () => answer(engine().GET('/api/watchdog')),
    refetchInterval: 15_000,
  });
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = useMemo(() => new Map((catalog.data ?? []).map((e) => [e.slug, e.name])), [catalog.data]);
  const mute = useMutation({
    mutationFn: ({ finding, muted }: { finding: WatchdogFinding; muted: boolean }) => answer(muted
      ? engine().POST('/api/watchdog/unmute', { body: { finding_key: finding.key } })
      : engine().POST('/api/watchdog/mute', { body: { finding_key: finding.key } })),
    onSettled: () => client.invalidateQueries({ queryKey: WATCHDOG_KEY }),
  });

  const data = report.data;
  const verdict = data ? watchdogVerdict(data) : null;
  const alarms = (data?.findings ?? []).filter((f) => !f.muted && (f.severity === 'broken' || f.severity === 'unusual'));
  const advice = (data?.findings ?? []).filter((f) => !f.muted && f.severity === 'advice');
  const withdrawn = (data?.findings ?? []).filter((f) => !f.muted && f.severity === 'withdrawn');
  const muted = (data?.findings ?? []).filter((f) => f.muted);
  const checked = instantOf(data?.checked_at);

  return (
    <div className="page health watchdog-page" aria-busy={report.isFetching || mute.isPending}>
      <HealthTabs />
      {report.isPending && <p className="page-lede">Reading what the watchdog found.</p>}
      {report.isError && <p className="page-lede">The watchdog could not be read ({report.error.message}).</p>}
      {data && verdict && (
        <>
          <section className="wall-verdict watchdog-verdict" data-health="watchdog-verdict" data-level={verdict.level}>
            <span className="wall-verdict-mark" aria-hidden="true">
              {verdict.level === 'alarm' ? <Icon name="fault" /> : verdict.level === 'clear' ? <Icon name="check" /> : <Icon name="minus" />}
            </span>
            <div>
              <h1 className="wall-headline">{verdict.headline}</h1>
              <p className="wall-detail-line">
                {verdict.detail}
                {verdict.level === 'unknown' && <> <Link to="/search/ask">Ask the sources</Link> or <Link to="/watches/new">make a watch</Link>.</>}
              </p>
              {checked && <p className="wall-detail-line">Checked {when(checked.toISOString(), now)}.</p>}
            </div>
          </section>
          {mute.error && (
            <p className="field-error" role="alert">
              {mute.error instanceof EngineError && mute.error.detail ? mute.error.detail : mute.error.message}
            </p>
          )}

          {alarms.length > 0 && (
            <FindingGroup title="What needs your attention" findings={alarms} names={names} now={now}
              busy={mute.isPending} onMute={(f) => mute.mutate({ finding: f, muted: false })} />
          )}
          {advice.length > 0 && (
            <FindingGroup title="Worth considering" findings={advice} names={names} now={now}
              busy={mute.isPending} onMute={(f) => mute.mutate({ finding: f, muted: false })} />
          )}
          {withdrawn.length > 0 && (
            <FindingGroup title="Withdrawn from resmon"
              lede="Sources resmon no longer asks. Runs from before still name them; nothing about them can be checked or fixed."
              findings={withdrawn} names={names} now={now}
              busy={mute.isPending} onMute={(f) => mute.mutate({ finding: f, muted: false })} />
          )}
          {muted.length > 0 && (
            <FindingGroup title={`Muted (${muted.length})`} lede="Still true, and not counted as alarms. Each goes, with its mute, when its reason does."
              findings={muted} names={names} now={now} busy={mute.isPending}
              onMute={(f) => mute.mutate({ finding: f, muted: true })} muted />
          )}
          {data.not_enough_data.length > 0 && (
            <section className="watchdog-group" data-health="unjudged">
              <h2 className="group-title">Not judged yet ({data.not_enough_data.length})</h2>
              <p className="group-lede">Watched, but without enough history to compare against. Not a clean bill.</p>
              <ul className="unjudged">
                {data.not_enough_data.map((u, i) => <Unjudged key={i} item={u} names={names} />)}
              </ul>
            </section>
          )}
          <section className="watchdog-group">
            <h2 className="group-title">What it judges by</h2>
            <ul className="watchdog-rules">
              {thresholdWords(data.thresholds).map((line) => <li key={line}>{line}</li>)}
            </ul>
          </section>
        </>
      )}
      {/* The corpus half: whether the papers already found still stand. Read on its own, so it stays when the watchdog cannot be read. */}
      <LifecycleCheck />
    </div>
  );
}

function FindingGroup({ title, lede, findings, names, now, busy, onMute, muted = false }: {
  title: string; lede?: string; findings: WatchdogFinding[]; names: ReadonlyMap<string, string>; now: Date;
  busy: boolean; onMute: (f: WatchdogFinding) => void; muted?: boolean;
}) {
  return (
    <section className="watchdog-group" data-health={muted ? 'muted' : 'findings'}>
      <h2 className="group-title">{title}</h2>
      {lede && <p className="group-lede">{lede}</p>}
      <ol className="findings">
        {findings.map((f) => {
          const said = findingWords(f, names);
          return (
            <li key={f.key} className="finding" data-severity={f.severity} data-muted={f.muted ? 'true' : 'false'} data-key={f.key}
              data-withdrawn={said.withdrawn ? 'true' : undefined}>
              <div className="finding-head">
                <span className="finding-severity" data-severity={f.severity} title={SEVERITY_MEANING[f.severity]}>
                  {SEVERITY_WORDS[f.severity] ?? f.severity}
                </span>
                <span className="finding-scope">{scopeWords(f.scope, names)}</span>
                <button type="button" className="btn sm quiet" disabled={busy} onClick={() => onMute(f)}>
                  {f.muted ? 'Unmute' : 'Mute'}
                </button>
              </div>
              <h3 className="finding-title">{said.title}</h3>
              <p className="finding-meaning">{SEVERITY_MEANING[f.severity]}</p>
              <p className="finding-detail">{said.detail}</p>
              <p className="finding-todo"><b>What to do.</b> {said.what_to_do}</p>
              <Evidence evidence={f.evidence} now={now} withdrawn={said.withdrawn} />
              {f.muted && f.muted_at && <p className="record-cap">Muted {when(instantOf(f.muted_at)?.toISOString(), now)}.</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Evidence({ evidence, now, withdrawn }: { evidence: Record<string, unknown>; now: Date; withdrawn: boolean }) {
  const label = (key: string): string | null | undefined => (withdrawn && key in WITHDRAWN ? WITHDRAWN[key] : EVIDENCE[key]);
  const rows = Object.entries(evidence).filter(([key]) => label(key));
  if (!rows.length) return null;
  return (
    <dl className="finding-evidence">
      {rows.map(([key, value]) => (
        <div key={key}><dt>{label(key)}</dt><dd>{evidenceWords(key, value, now)}</dd></div>
      ))}
    </dl>
  );
}

function Unjudged({ item, names }: { item: WatchdogUnjudged; names: ReadonlyMap<string, string> }) {
  return (
    <li>
      <span className="finding-scope">{scopeWords(item.scope, names)}</span>
      <span>{item.reason}</span>
      <span className="record-cap num">{item.runs_recorded} of {item.runs_needed} runs</span>
    </li>
  );
}
