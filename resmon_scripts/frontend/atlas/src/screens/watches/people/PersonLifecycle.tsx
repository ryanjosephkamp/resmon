import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../../api/client';
import {
  PROFILE_LIFECYCLE, SEVERITY_MEANING, SEVERITY_WORDS, noticeDay, noticeLabel, provenanceWords, type Severity,
} from '../../lifecycle/model';
import { BASIS_MEANING, basisWords } from './model';

/** As many findings as the engine gives at once; the count says when there are more. */
const LIMIT = 500;

/**
 * A person's retractions and updates: the notices recorded against the papers
 * matched to them, and how many of those papers have been checked at all.
 *
 * Nothing here is a new claim. Each row is a notice the engine already holds,
 * on a paper this person was matched to, and the match keeps the basis it was
 * saved with: a notice on a paper matched by name alone is a notice on a paper
 * that carries this name, and the row says so rather than putting it on the
 * person. The coverage sentence comes first and is the engine's, because no
 * notices over papers nobody has checked is not a clean record.
 */
export function PersonLifecycle({ id, name }: { id: number; name: string }) {
  const findings = useQuery({
    queryKey: [PROFILE_LIFECYCLE, id],
    queryFn: () => answer(engine().GET('/api/profiles/{profile_id}/lifecycle', {
      params: { path: { profile_id: id }, query: { limit: LIMIT } },
    })),
  });
  const data = findings.data;
  const looked = data ? data.checked_documents + data.no_identifier_documents + data.errored_documents : 0;
  return (
    <section className="person-lifecycle" aria-label="Retractions and updates" data-people="lifecycle"
      aria-busy={findings.isFetching}>
      <h2 className="nights-title">Retractions and updates</h2>
      {findings.isPending && <p className="record-cap">Reading what has been recorded against their papers.</p>}
      {findings.isError && (
        <p className="record-cap">Their papers&rsquo; retractions and updates could not be read ({findings.error.message}).</p>
      )}
      {data && (
        <>
          <p className="life-quiet" data-people="lifecycle-coverage">
            {data.matched_documents === 0 ? 'No papers are matched to them yet, so there is nothing to check.' : data.coverage_note}
            {data.matched_documents > looked && <>{' '}<Link to="/health/watchdog">Check from the Watchdog</Link>.</>}
          </p>
          {data.matched_documents > 0 && data.findings.length === 0 && (
            <p className="record-cap" data-people="lifecycle-none">
              {data.checked_documents > 0
                ? `Nothing has been recorded against the ${data.checked_documents === 1 ? 'paper' : 'papers'} checked.`
                : 'Nothing is recorded, and none of their papers has been checked, so that says nothing yet.'}
            </p>
          )}
          {data.findings.length > 0 && (
            <>
              <p className="record-cap">
                Each paper keeps the match it was saved with, and whether it is {name}&rsquo;s was not checked again for
                the notice: a notice on a paper matched by name alone is on a paper with this name on it.
              </p>
              <ol className="life-findings">
                {data.findings.map((f) => {
                  const severity = f.severity as Severity;
                  const day = noticeDay(f.notice_date);
                  const from = provenanceWords(f);
                  return (
                    <li key={`${f.document_id}:${f.kind}:${f.notice_url}`} className="life-finding"
                      data-document={f.document_id} data-severity={f.severity} data-basis={f.basis}>
                      <Link to={`/papers/${f.document_id}`} className="result-title">{f.title}</Link>
                      <ul className="life-marks">
                        <li className="life-mark" data-severity={f.severity} data-kind={f.kind}>
                          <span className="life-severity" title={SEVERITY_MEANING[severity]}>{SEVERITY_WORDS[severity] ?? f.severity}</span>
                          <a className="life-notice" href={f.notice_url} target="_blank" rel="noreferrer">{noticeLabel(f)}</a>
                          {day && <span className="life-day">{day}</span>}
                          {from && <span className="life-from">{from}</span>}
                        </li>
                      </ul>
                      <div className="meta">
                        <span className="basis-chip" title={BASIS_MEANING[f.basis]}>{basisWords(f.basis)}</span>
                        <span className="match-author">as {f.matched_author}</span>
                      </div>
                    </li>
                  );
                })}
              </ol>
              {data.findings.length >= LIMIT && (
                <p className="index-cap">The first {LIMIT} notices are listed, the most serious first.</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
