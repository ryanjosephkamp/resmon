import React, { useEffect, useState } from 'react';
import PageHelp from '../components/Help/PageHelp';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import SourceWall from '../components/SourceWall/SourceWall';
import { SourceWallGrid, fetchSourceWall } from '../api/sourceWall';

/**
 * Is my monitoring still intact?
 *
 * Every other screen in resmon answers a question about one run or one paper.
 * This one is about the shape of the monitoring itself over time: a source
 * that stopped answering four runs ago costs a user every paper that source
 * would have found, and before this page nothing in the interface would have
 * told them. The rows have been in `execution_sources` since schema 6; what
 * was missing was a reader that crossed runs.
 *
 * The window is deliberately short. This is an instrument to glance at, not
 * an archive to browse — the backend caps it, and the three choices below are
 * the ones that stay readable at the cell size the grid uses.
 */

const WINDOWS = [12, 25, 50];

/** What the last completed request returned, and for which window. */
interface Loaded {
  limit: number;
  grid: SourceWallGrid | null;
  error: string | null;
}

const SourceWallPage: React.FC = () => {
  const [limit, setLimit] = useState<number>(WINDOWS[0]);
  const [loaded, setLoaded] = useState<Loaded>({ limit: 0, grid: null, error: null });

  useEffect(() => {
    // The window the user is looking at can change while a request is in
    // flight, and the older request can land second. Tagging the result with
    // the window it was asked for is what stops a stale grid overwriting the
    // one that was actually requested -- and keeping every setState inside
    // the callback is what keeps the effect from cascading renders.
    let current = true;
    fetchSourceWall(limit)
      .then((grid) => { if (current) setLoaded({ limit, grid, error: null }); })
      .catch((err: Error) => {
        // The failure is named rather than swallowed: a blank wall and a wall
        // that could not be loaded look identical, and only one of them means
        // the monitoring is fine.
        if (current) {
          setLoaded({
            limit,
            grid: null,
            error: err.message || 'The source wall could not be loaded.',
          });
        }
      });
    return () => { current = false; };
  }, [limit]);

  const settled = loaded.limit === limit;
  const grid = settled ? loaded.grid : null;
  const error = settled ? loaded.error : null;

  return (
    <div className="page source-wall-page">
      <PageHelp
        storageKey="source-wall"
        title="Source wall"
        summary="Every source you use, against the runs that asked it."
        sections={[
          {
            heading: 'What this page does',
            body: (
              <p>
                Each cell is one source&rsquo;s recorded answer to one run. The page
                exists to answer one question — is your coverage still what it was —
                rather than how many papers a run returned, which the Results page
                shows.
              </p>
            ),
          },
          {
            heading: 'What the six marks mean',
            body: (
              <ul>
                <li><strong>answered</strong> — the source replied and returned records.</li>
                <li>
                  <strong>answered, nothing new</strong> — it replied and genuinely had
                  nothing. A quiet field is not a fault.
                </li>
                <li>
                  <strong>could not be asked</strong> — no API key, the source is
                  retired, it has no author query for this kind of search, or your
                  window is one it cannot express.
                </li>
                <li><strong>failed</strong> — it was asked and the exchange broke.</li>
                <li>
                  <strong>not recorded</strong> — resmon did not observe an outcome.
                  This is never shown as either a success or a failure, and it is
                  never guessed into one.
                </li>
              </ul>
            ),
          },
          {
            heading: 'What it cannot tell you',
            body: (
              <p>
                Runs recorded before resmon stored a reason read as{' '}
                <em>not recorded</em>, and they are not backfilled: a reason
                reconstructed afterwards would be a guess wearing a fact&rsquo;s
                clothes. A source that is absent from a run&rsquo;s saved selection
                also reads as not recorded — select a cell to see which of the two
                it is.
              </p>
            ),
          },
        ]}
      />

      <div className="page-header">
        <div>
          <h1>Source wall</h1>
          <p className="page-subtitle">
            Is your monitoring still intact? One cell per source per run.
          </p>
        </div>
        <div className="source-wall-controls">
          <label htmlFor="source-wall-limit">Runs shown</label>
          <select
            id="source-wall-limit"
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          >
            {WINDOWS.map((size) => (
              <option key={size} value={size}>{`Last ${size}`}</option>
            ))}
          </select>
          <TutorialLinkButton anchor="source-wall" />
        </div>
      </div>

      {error && (
        <div className="source-wall-error" role="alert">
          {`The source wall could not be loaded: ${error}. Nothing here says
            anything about your coverage until it does.`}
        </div>
      )}
      {!settled && <p className="source-wall-loading">Reading recorded runs\u2026</p>}
      {grid && <SourceWall grid={grid} />}
    </div>
  );
};

export default SourceWallPage;
