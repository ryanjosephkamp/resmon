import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { LifecycleMarks } from '../lifecycle/LifecycleMarks';
import {
  CHECK_FACTS, LIFECYCLE_FOR, LIFECYCLE_KEY, PROFILE_LIFECYCLE, countsWords, coverageSentences, findingsByPaper,
  lastRunLines, quietSentence,
} from '../lifecycle/model';
import { count, number, when } from '../today/format';
import { PlaceHelp } from '../watches/people/People';
import { instantOf } from './model';

function said(error: Error | null): string | null {
  if (!error) return null;
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

/**
 * The check for retractions and updates: run it, stop it, and read what it
 * found, what it could not check, and why.
 *
 * The check runs in this window's engine, in the background, and the screen
 * reads its state each second while it runs. Coverage is always shown beside
 * the findings, because an empty list over papers nobody asked about is not a
 * clean result; and a check a service did not answer says which service, how
 * many papers it left unchecked, and the reason, before anything else.
 */
export function LifecycleCheck() {
  const client = useQueryClient();
  const report = useQuery({
    queryKey: LIFECYCLE_KEY,
    queryFn: () => answer(engine().GET('/api/lifecycle')),
    refetchInterval: (query) => (query.state.data?.run.running ? 1_000 : false),
  });
  const data = report.data;
  const running = data?.run.running ?? false;
  // Times are said against when the engine was last read, which moves while a check runs.
  const now = useMemo(() => (report.dataUpdatedAt ? new Date(report.dataUpdatedAt) : new Date()), [report.dataUpdatedAt]);

  // A run that has ended may have recorded notices that a paper's marks or a
  // person's findings, read before it, do not have.
  useEffect(() => {
    if (running) return;
    void client.invalidateQueries({ queryKey: [LIFECYCLE_FOR] });
    void client.invalidateQueries({ queryKey: [PROFILE_LIFECYCLE] });
  }, [running, client]);

  const start = useMutation({
    mutationFn: (everything: boolean) => answer(engine().POST('/api/lifecycle/check', {
      body: { limit: CHECK_FACTS.perCheck, run_until_done: everything },
    })),
    onSettled: () => client.invalidateQueries({ queryKey: LIFECYCLE_KEY }),
  });
  const stop = useMutation({
    mutationFn: () => answer(engine().POST('/api/lifecycle/stop')),
    onSettled: () => client.invalidateQueries({ queryKey: LIFECYCLE_KEY }),
  });

  const refused = said(start.error) ?? said(stop.error);
  const last = data && !running && data.run.last ? lastRunLines(data.run.last, data.coverage, now) : null;
  const started = instantOf(data?.run.started_at);

  return (
    <section className="watchdog-group lifecycle" data-health="lifecycle" aria-labelledby="lifecycle-title"
      aria-busy={report.isFetching || start.isPending || stop.isPending}>
      <h2 id="lifecycle-title" className="group-title">Papers that changed after you found them</h2>
      <p className="group-lede">
        Retractions, expressions of concern, and corrections registered with Crossref, which carries the Retraction
        Watch database; preprints that bioRxiv says reached a journal; and newer versions on arXiv and bioRxiv. Each is
        the service&rsquo;s own notice, linked, in its own words.
      </p>
      <PlaceHelp summary="What the check asks, and of whom">
        <p>
          Your papers are asked about by their identifiers. Each paper with a DOI is asked of Crossref,
          {' '}{CHECK_FACTS.crossrefBatch} DOIs to a request at no more than {CHECK_FACTS.crossrefPerSecond} requests a
          second. Each arXiv paper held at a version number, such as 2301.00001v2, is asked of arXiv,
          {' '}{CHECK_FACTS.arxivBatch} to a request. Each bioRxiv preprint is asked of bioRxiv, one request each, at no
          more than {CHECK_FACTS.biorxivPerSecond} a second. Asking tells those services which papers you hold, so the
          check runs only when asked: from here, or by a watch set to look for a person&rsquo;s retractions.
        </p>
        <p>
          One check asks about up to {number(CHECK_FACTS.perCheck)} papers, those never checked first and then the least
          recently checked. <i>Check everything</i> repeats until every paper has been asked about. It takes as long as
          those services take to answer: {number(CHECK_FACTS.perCheck)} papers with DOIs are
          {' '}{number(Math.ceil(CHECK_FACTS.perCheck / CHECK_FACTS.crossrefBatch))} requests to Crossref, and bioRxiv
          preprints go one at a time. A paper is asked about again after {count(CHECK_FACTS.recheckDays, 'day')}.
        </p>
        <p>
          What is recorded is only what a service registered: each notice with its link, its date, and who registered
          it. A paper is recorded as checked only when every service it needed answered; one a service did not answer
          for stays unchecked and is asked about again next time, and one with no DOI and no arXiv version number is
          counted apart, never as clear. Crossref&rsquo;s record of corrections and expressions of concern is less
          complete than its record of retractions, so no concern recorded means less than no retraction recorded.
        </p>
      </PlaceHelp>

      {report.isPending && <p className="record-cap">Reading what the check has recorded.</p>}
      {report.isError && <p className="record-cap">What the check has recorded could not be read ({report.error.message}).</p>}
      {data && (
        <>
          <div className="life-controls" data-lifecycle="controls" data-running={running ? 'true' : 'false'}>
            {!running && (
              <button type="button" className="btn primary" disabled={start.isPending} onClick={() => start.mutate(false)}>
                Check for retractions and updates
              </button>
            )}
            {!running && data.coverage.unchecked > 0 && (
              <button type="button" className="btn" disabled={start.isPending} onClick={() => start.mutate(true)}
                title="Keep going until every paper has been asked about">
                Check everything ({number(data.coverage.unchecked)} left)
              </button>
            )}
            {running && (
              <button type="button" className="btn" disabled={stop.isPending || data.run.stop_requested}
                onClick={() => stop.mutate()}>
                <Icon name="stop" size={14} />Stop
              </button>
            )}
            {running && (
              <p className="life-state" role="status" data-lifecycle="running">
                {data.run.stop_requested
                  ? 'Stopping: the request already out is answered first, and nothing more is asked.'
                  : `Checking, since ${when(started?.toISOString(), now)}. Each paper is recorded as its answer comes in.`}
              </p>
            )}
          </div>
          {refused && <p className="field-error" role="alert">{refused}</p>}
          {data.run.error && !running && (
            <p className="field-error" role="alert" data-lifecycle="run-error">
              The check failed: {data.run.error}. Papers it recorded before failing are counted below.
            </p>
          )}

          {last && data.run.last && (
            <div className="life-run" data-lifecycle="last-run" data-stopped={data.run.last.stopped ? 'true' : 'false'}
              data-unanswered={data.run.last.unanswered.length}>
              <p className="life-run-head">{last.headline}</p>
              {last.lines.length > 0 && (
                <ul>{last.lines.map((line) => <li key={line.key} data-line={line.key}>{line.text}</li>)}</ul>
              )}
            </div>
          )}

          <ul className="life-coverage" data-lifecycle="coverage">
            {coverageSentences(data.coverage, now).map((line) => <li key={line}>{line}</li>)}
          </ul>

          {data.findings.length === 0 ? (
            <p className="life-quiet" data-lifecycle="quiet">{quietSentence(data)}</p>
          ) : (
            <>
              <p className="count-sentence" data-lifecycle="counts">{countsWords(data.counts)}</p>
              <ol className="life-papers">
                {findingsByPaper(data.findings).map((paper) => (
                  <li key={paper.documentId} data-document={paper.documentId}>
                    <Link to={`/papers/${paper.documentId}`} className="result-title">{paper.title}</Link>
                    <LifecycleMarks events={paper.events} full />
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </section>
  );
}
