import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import PageHelp from '../components/Help/PageHelp';
import { apiClient } from '../api/client';
import LifecycleBadge, { LifecycleEvent } from '../components/Explain/LifecycleBadge';

/**
 * The watchdog: what has stopped working, and what merely looks odd.
 *
 * A literature monitor fails silently — a dead source and a quiet field
 * produce the same empty inbox. This page is where the difference is shown.
 *
 * The whole design rests on one distinction, and the interface has to carry it
 * as clearly as the backend does. A **broken** finding is a recorded fact: the
 * source raised an error, the key is absent, the routine did not fire. An
 * **unusual** finding is an inference from the user's own history, and its
 * innocent explanation is always genuinely possible. They are coloured, worded
 * and grouped differently on purpose. Presenting an inference with the
 * confidence of a fact is how a watchdog earns the mute button.
 *
 * Advice is not an alarm and is never counted as one.
 */

type Severity = 'broken' | 'unusual' | 'advice';

interface Finding {
  key: string;
  severity: Severity;
  kind: string;
  scope: { type: 'source' | 'routine'; id: string | number; name?: string };
  title: string;
  detail: string;
  what_to_do: string;
  evidence: Record<string, any>;
  muted: boolean;
  muted_at: string | null;
}

interface Unjudged {
  scope: { type: 'source' | 'routine'; id: string | number; name?: string };
  reason: string;
  runs_recorded: number;
  runs_needed: number;
}

interface WatchdogReport {
  checked_at: string;
  findings: Finding[];
  counts: {
    broken: number;
    unusual: number;
    advice: number;
    muted: number;
    alarms: number;
  };
  not_enough_data: Unjudged[];
  watching: { sources: number; routines: number };
  thresholds: Record<string, number>;
  sufficient: boolean;
}

interface LifecycleFinding extends LifecycleEvent {
  document_id: number;
  title: string;
  document_doi: string | null;
  source_repository: string;
  publication_date: string | null;
}

interface LifecycleReport {
  findings: LifecycleFinding[];
  counts: { critical: number; caution: number; informational: number };
  coverage: {
    corpus: number;
    checked: number;
    no_identifier: number;
    errored: number;
    unchecked: number;
    last_checked_at: string | null;
    recheck_after_days: number;
  };
  sufficient: boolean;
  run: { running: boolean; started_at: string | null; error: string | null;
         last: { checked_now: number; remaining: number } | null };
}

const SEVERITY_LABEL: Record<Severity, string> = {
  broken: 'Broken',
  unusual: 'Looks unusual',
  advice: 'Advice',
};

/**
 * The one-line gloss under each chip. It exists so the difference between the
 * two alarm levels is stated, not just implied by colour — colour alone would
 * leave a user to guess which of the two means "resmon is certain".
 */
const SEVERITY_GLOSS: Record<Severity, string> = {
  broken: 'resmon recorded this happening. It is not an inference.',
  unusual: 'A departure from your own history. There may be an innocent reason.',
  advice: 'Nothing is wrong. Worth considering.',
};

const scopeLabel = (scope: Finding['scope']): string =>
  scope.type === 'source' ? `Source · ${scope.id}` : `Routine · ${scope.name ?? scope.id}`;

/** Evidence keys rendered as a readable label rather than a raw field name. */
const EVIDENCE_LABELS: Record<string, string> = {
  consecutive_errors: 'Failed runs in a row',
  last_error: 'Most recent error',
  last_success_at: 'Last successful run',
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
};

const formatEvidence = (value: any): string => {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
};

const FindingCard: React.FC<{
  finding: Finding;
  onMute: (finding: Finding) => void;
  busy: boolean;
}> = ({ finding, onMute, busy }) => {
  const [showEvidence, setShowEvidence] = useState(false);

  // Only the fields with a human label are shown. Anything else in the payload
  // is machine detail (flags the copy already states in words) and printing it
  // raw would pad the card without informing anyone.
  const evidenceRows = Object.entries(finding.evidence).filter(
    ([key]) => key in EVIDENCE_LABELS,
  );

  return (
    <article
      className={`watchdog-finding watchdog-${finding.severity}${finding.muted ? ' watchdog-muted' : ''}`}
    >
      <header className="watchdog-finding-head">
        <div>
          <span className={`watchdog-chip watchdog-chip-${finding.severity}`}>
            {SEVERITY_LABEL[finding.severity]}
          </span>
          <span className="watchdog-scope">{scopeLabel(finding.scope)}</span>
          {finding.muted && <span className="watchdog-chip watchdog-chip-muted">Muted</span>}
        </div>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={busy}
          onClick={() => onMute(finding)}
        >
          {finding.muted ? 'Unmute' : 'Mute'}
        </button>
      </header>

      <h3>{finding.title}</h3>
      <p className="watchdog-gloss">{SEVERITY_GLOSS[finding.severity]}</p>
      <p>{finding.detail}</p>

      <p className="watchdog-todo">
        <strong>What to do:</strong> {finding.what_to_do}
      </p>

      {evidenceRows.length > 0 && (
        <>
          <button
            type="button"
            className="watchdog-evidence-toggle"
            aria-expanded={showEvidence}
            onClick={() => setShowEvidence((v) => !v)}
          >
            {showEvidence ? 'Hide the evidence' : 'Show the evidence'}
          </button>
          {showEvidence && (
            <dl className="watchdog-evidence">
              {evidenceRows.map(([key, value]) => (
                <div key={key} className="watchdog-evidence-row">
                  <dt>{EVIDENCE_LABELS[key]}</dt>
                  <dd>{formatEvidence(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </article>
  );
};

const WatchdogPage: React.FC = () => {
  const [data, setData] = useState<WatchdogReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [life, setLife] = useState<LifecycleReport | null>(null);
  const [lifeBusy, setLifeBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiClient.get<WatchdogReport>('/api/watchdog'));
    } catch (err: any) {
      setError(err?.message || 'Failed to load the watchdog report.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLifecycle = useCallback(async () => {
    try {
      const payload = await apiClient.get<LifecycleReport>('/api/lifecycle');
      // Shape-checked before it reaches the render. This section is an addition
      // to the page, and a malformed body must not be able to take the watchdog
      // findings down with it — those are the reason someone opened the page.
      if (payload && payload.coverage && Array.isArray(payload.findings)) {
        setLife(payload);
      }
    } catch { /* the watchdog findings above still stand without this */ }
  }, []);

  useEffect(() => { void load(); void loadLifecycle(); }, [load, loadLifecycle]);

  // The check makes outbound requests, so it runs on the server in the
  // background and this polls. Two seconds is unhurried — the run takes as long
  // as the sources take to answer, and hammering our own backend to watch it
  // would be silly.
  useEffect(() => {
    if (!life?.run?.running) return undefined;
    const timer = setInterval(() => { void loadLifecycle(); }, 2000);
    return () => clearInterval(timer);
  }, [life?.run?.running, loadLifecycle]);

  const startLifecycleCheck = useCallback(async () => {
    setLifeBusy(true);
    try {
      await apiClient.post('/api/lifecycle/check', {});
      await loadLifecycle();
    } catch (err: any) {
      setError(err?.message || 'Could not start the lifecycle check.');
    } finally {
      setLifeBusy(false);
    }
  }, [loadLifecycle]);


  const toggleMute = useCallback(async (finding: Finding) => {
    setBusyKey(finding.key);
    try {
      await apiClient.post(
        finding.muted ? '/api/watchdog/unmute' : '/api/watchdog/mute',
        { finding_key: finding.key },
      );
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to change that finding.');
    } finally {
      setBusyKey(null);
    }
  }, [load]);

  const help = (
    <PageHelp
      storageKey="watchdog"
      title="Watchdog"
      summary="Whether your monitoring is still working — because silence alone cannot tell you."
      sections={[
        {
          heading: 'Why this page exists',
          body: (
            <p>
              An empty week looks exactly the same whether nothing was published or your
              sources stopped answering. Everything here is computed from runs resmon has
              already done on this machine, so opening this page costs no API quota and
              works offline.
            </p>
          ),
        },
        {
          heading: 'Broken versus looks unusual',
          body: (
            <p>
              <strong>Broken</strong> means resmon recorded the failure — the source
              returned an error, a required key is missing, a routine did not fire. It is
              not a guess. <strong>Looks unusual</strong> means something departed from
              the pattern your own history established, and there is often an innocent
              reason: a genuinely quiet field looks identical to a dead query. Those
              findings are worded as prompts to check, never as faults.
            </p>
          ),
        },
        {
          heading: 'Why it stays quiet so often',
          body: (
            <p>
              The thresholds are deliberately conservative — three failing runs in a row
              before a source is called broken, four empty runs on top of an established
              baseline before it is called unusual. A watchdog that cries wolf gets muted,
              and a muted watchdog misses the failure it existed to catch. The exact
              numbers it is using are listed at the bottom of this page.
            </p>
          ),
        },
        {
          heading: 'Muting',
          body: (
            <p>
              Mute a finding you already know about — a source you never intend to add a
              key for, a routine you know is quiet. It stays listed but stops counting.
              Mutes are per finding and are dropped automatically once the condition
              clears, so if the same source fails again later you are told again.
            </p>
          ),
        },
        {
          heading: 'Papers that changed after you found them',
          body: (
            <p>
              Your corpus is frozen at the moment resmon found each paper. This
              section unfreezes it: retractions and expressions of concern through
              Crossref, which has distributed the Retraction Watch database openly
              since 2023; preprints that have since reached a journal; and newer
              versions of what you hold. <strong>resmon never asserts any of this
              on its own authority</strong> — every entry links the notice, and the
              wording is the publisher&rsquo;s own, never a paraphrase. The check
              makes outbound requests, so it runs only when you ask, takes the least
              recently checked papers first, and can be run again to continue.
              Crossref&rsquo;s coverage of non-retraction notices is less complete
              than for retractions, so the absence of an expression of concern means
              less than the absence of a retraction.
            </p>
          ),
        },
        {
          heading: 'Cadence advice',
          body: (
            <p>
              Discovery lag is measured from when resmon first saw each paper, which
              includes however long your routine waited before asking. That is why advice
              only appears when a source&rsquo;s median lag is several times the interval:
              below that, the polling schedule could account for the gap on its own. The
              real indexing delay is at most the figure shown, never more.
            </p>
          ),
        },
      ]}
    />
  );

  const header = (
    <div className="page-header">
      <h1>Watchdog</h1>
      <TutorialLinkButton anchor="watchdog" />
    </div>
  );

  if (loading) {
    return (
      <div className="page">
        {header}
        {help}
        <p className="text-muted">Checking your sources and routines…</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="page">
        {header}
        {help}
        <div className="alert alert-error" role="alert">{error}</div>
        <button className="btn" onClick={() => void load()}>Try again</button>
      </div>
    );
  }

  const report = data!;
  const alarms = report.findings.filter(
    (f) => !f.muted && (f.severity === 'broken' || f.severity === 'unusual'),
  );
  const advice = report.findings.filter((f) => !f.muted && f.severity === 'advice');
  const muted = report.findings.filter((f) => f.muted);

  return (
    <div className="page">
      {header}
      {help}

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {/*
        The headline. On an install with no history this must say so rather
        than "all clear" — a watchdog with nothing to go on and a watchdog that
        checked and found nothing are very different claims, and only one of
        them has been earned.
      */}
      {!report.sufficient ? (
        <section className="card watchdog-verdict watchdog-verdict-unknown">
          <h2>Nothing to check yet</h2>
          <p>
            The watchdog compares each source and routine against its own history, and
            there is no history here yet. Run a <Link to="/dive">Deep Dive</Link> or
            a <Link to="/sweep">Deep Sweep</Link>, or set up
            a <Link to="/routines">routine</Link>, and this page starts watching from the
            first run.
          </p>
        </section>
      ) : alarms.length === 0 ? (
        <section className="card watchdog-verdict watchdog-verdict-clear">
          <h2>Nothing looks wrong</h2>
          <p>
            Watching {report.watching.sources}{' '}
            {report.watching.sources === 1 ? 'source' : 'sources'} and{' '}
            {report.watching.routines} active{' '}
            {report.watching.routines === 1 ? 'routine' : 'routines'}. No source has
            failed repeatedly, no routine is overdue, and nothing has departed from its
            usual pattern.
          </p>
        </section>
      ) : (
        <section className="card watchdog-verdict watchdog-verdict-alarm">
          <h2>
            {report.counts.broken > 0 && (
              <>
                {report.counts.broken}{' '}
                {report.counts.broken === 1 ? 'thing is' : 'things are'} broken
              </>
            )}
            {report.counts.broken > 0 && report.counts.unusual > 0 && ', and '}
            {report.counts.unusual > 0 && (
              <>
                {report.counts.unusual}{' '}
                {report.counts.unusual === 1 ? 'looks' : 'look'} unusual
              </>
            )}
          </h2>
          <p>
            Checked against {report.watching.sources}{' '}
            {report.watching.sources === 1 ? 'source' : 'sources'} and{' '}
            {report.watching.routines} active{' '}
            {report.watching.routines === 1 ? 'routine' : 'routines'}.
          </p>
        </section>
      )}

      {alarms.length > 0 && (
        <section className="card">
          <h2>What needs your attention</h2>
          <div className="watchdog-list">
            {alarms.map((f) => (
              <FindingCard
                key={f.key}
                finding={f}
                onMute={toggleMute}
                busy={busyKey === f.key}
              />
            ))}
          </div>
        </section>
      )}

      {advice.length > 0 && (
        <section className="card">
          <h2>Worth considering</h2>
          <p className="text-muted">
            Not problems. Suggestions drawn from how quickly your sources actually
            surface papers.
          </p>
          <div className="watchdog-list">
            {advice.map((f) => (
              <FindingCard
                key={f.key}
                finding={f}
                onMute={toggleMute}
                busy={busyKey === f.key}
              />
            ))}
          </div>
        </section>
      )}

      {/*
        The corpus half of trust. The watchdog above asks whether the monitoring
        still works; this asks whether the papers it already found still say
        what they said. Both are "is what resmon is showing me true?".

        Nothing here is asserted on resmon's own authority — every row links the
        notice, and the wording is the publisher's own.
      */}
      <section className="card">
        <h2>Papers that changed after you found them</h2>
        <p className="text-muted">
          Retractions and expressions of concern via Crossref, which has distributed
          the Retraction Watch database openly since 2023; preprints that have since
          reached a journal; and newer versions of what you hold. resmon never asserts
          any of this on its own — every entry links the notice so you can read it and
          judge for yourself.
        </p>

        {life?.run?.error && (
          <div className="alert alert-error" role="alert">{life.run.error}</div>
        )}

        <div className="lifecycle-controls">
          <button
            className="btn btn-sm"
            onClick={() => void startLifecycleCheck()}
            disabled={lifeBusy || !!life?.run?.running}
          >
            {life?.run?.running ? 'Checking…' : 'Check for retractions and updates'}
          </button>
          {life && (
            <span className="text-muted lifecycle-coverage">
              {life.coverage.checked === 0 ? (
                <>Nothing checked yet, of {life.coverage.corpus} papers.</>
              ) : (
                <>
                  {life.coverage.checked} of {life.coverage.corpus} papers checked
                  {life.coverage.unchecked > 0 && (
                    <>, {life.coverage.unchecked} still to go</>
                  )}
                  {life.coverage.no_identifier > 0 && (
                    <>
                      {' '}· {life.coverage.no_identifier} carry no DOI or supported
                      identifier and cannot be checked
                    </>
                  )}
                  {life.coverage.errored > 0 && (
                    <> · {life.coverage.errored} errored</>
                  )}
                </>
              )}
            </span>
          )}
        </div>

        {/*
          This distinction is the whole reason coverage is displayed at all. An
          empty list on an unchecked corpus is not "nothing has been retracted";
          it is "nobody has looked". Saying "all clear" there would be exactly
          the kind of false comfort 1.7 exists to remove.
        */}
        {!life || !life.sufficient ? (
          <p className="analytics-thin">
            No paper has been checked yet, so nothing here can be read as a clean
            bill of health. The check makes outbound requests to Crossref and the
            preprint servers, which is why it does not run on its own.
          </p>
        ) : life.findings.length === 0 ? (
          <p className="analytics-thin">
            Nothing has changed in the {life.coverage.checked} papers checked so far.
            {life.coverage.unchecked > 0 && (
              <> The remaining {life.coverage.unchecked} have not been looked at.</>
            )}
          </p>
        ) : (
          <>
            <div className="lifecycle-counts">
              {life.counts.critical > 0 && (
                <span className="lifecycle-chip lifecycle-count-critical">
                  {life.counts.critical} withdrawn
                </span>
              )}
              {life.counts.caution > 0 && (
                <span className="lifecycle-chip lifecycle-count-caution">
                  {life.counts.caution} with a registered concern
                </span>
              )}
              {life.counts.informational > 0 && (
                <span className="lifecycle-chip lifecycle-count-informational">
                  {life.counts.informational} otherwise changed
                </span>
              )}
            </div>
            <ul className="lifecycle-list">
              {life.findings.map((f) => (
                <li key={`${f.document_id}:${f.kind}:${f.notice_url}`}>
                  <p className="lifecycle-paper">{f.title}</p>
                  <LifecycleBadge events={[f]} />
                </li>
              ))}
            </ul>
            <p className="analytics-thin">
              Crossref&rsquo;s coverage of non-retraction update types is less
              complete than for retractions, so the absence of an expression of
              concern means less than the absence of a retraction. Papers are
              re-checked after {life.coverage.recheck_after_days} days.
            </p>
          </>
        )}
      </section>

      {/*
        Reported rather than hidden. A watchdog that is silent because it has
        three data points looks identical to one that is silent because all is
        well, and a user deciding whether to trust it needs to see which.
      */}
      {report.not_enough_data.length > 0 && (
        <section className="card">
          <h2>Not enough history to judge yet</h2>
          <p className="text-muted">
            These are being watched, but there is not yet enough on record to say whether
            anything has changed.
          </p>
          <ul className="watchdog-unjudged">
            {report.not_enough_data.map((u) => (
              <li key={`${u.scope.type}:${u.scope.id}`}>
                <span className="watchdog-scope">{scopeLabel(u.scope as Finding['scope'])}</span>
                <span>{u.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {muted.length > 0 && (
        <section className="card">
          <h2>Muted ({muted.length})</h2>
          <p className="text-muted">
            Still checked, not counted. Each of these is dropped automatically if the
            condition clears, so a recurrence is reported again.
          </p>
          <div className="watchdog-list">
            {muted.map((f) => (
              <FindingCard
                key={f.key}
                finding={f}
                onMute={toggleMute}
                busy={busyKey === f.key}
              />
            ))}
          </div>
        </section>
      )}

      <section className="card watchdog-thresholds">
        <h2>How it decides</h2>
        <p className="text-muted">
          The watchdog is deliberately slow to raise an alarm. These are the numbers it
          is using, shown so you can judge whether silence from it means anything.
        </p>
        <ul>
          <li>
            A source is called <strong>broken</strong> after{' '}
            {report.thresholds.consecutive_errors} failing runs in a row.
          </li>
          <li>
            A source is called <strong>unusual</strong> after{' '}
            {report.thresholds.consecutive_zeros} empty runs, and only once at least{' '}
            {report.thresholds.min_baseline_runs} runs are on record.
          </li>
          <li>
            A routine is <strong>overdue</strong> once it has been silent for more than{' '}
            {report.thresholds.overdue_cadence_multiple}× its usual gap, and at least{' '}
            {report.thresholds.overdue_floor_days} day.
          </li>
          <li>
            A routine is called <strong>unusual</strong> after{' '}
            {report.thresholds.flatline_runs} runs finding nothing new — and only if it
            used to find things.
          </li>
          <li>
            Cadence <strong>advice</strong> appears when a source&rsquo;s median discovery
            lag is more than {report.thresholds.cadence_lag_multiple}× the routine&rsquo;s
            interval.
          </li>
        </ul>
        <p className="text-muted">
          Last checked {new Date(report.checked_at).toLocaleString()}.{' '}
          <button type="button" className="watchdog-evidence-toggle" onClick={() => void load()}>
            Check again
          </button>
        </p>
      </section>
    </div>
  );
};

export default WatchdogPage;
