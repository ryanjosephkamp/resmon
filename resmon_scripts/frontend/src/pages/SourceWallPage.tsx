import React, { useEffect, useState } from 'react';
import PageHelp from '../components/Help/PageHelp';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import SourceWall from '../components/SourceWall/SourceWall';
import {
  STATE_MARKS, SourceWallGrid, fetchSourceWall, knownState,
} from '../api/sourceWall';

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
      <div className="page-header">
        <div>
          <div className="page-title-row">
            <h1>Source wall</h1>
            <TutorialLinkButton anchor="source-wall" />
          </div>
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
        </div>
      </div>

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
            // Built from the key the backend served, not written out here.
            // The first draft of this panel wrote the six marks by hand and
            // had drifted before the branch was even reviewed: it headed the
            // list "six" and listed five, and called a quiet field "answered,
            // nothing new" while the legend four inches above it said
            // "answered, zero". A second copy of a vocabulary drifts; this
            // one is not a copy.
            heading: 'What the marks mean',
            body: grid ? (
              <ul>
                {grid.state_legend.map((entry) => (
                  <li key={entry.state}>
                    <span aria-hidden="true">
                      {`${STATE_MARKS[knownState(entry.state)]} `}
                    </span>
                    <strong>{entry.label}</strong>
                    {` \u2014 ${entry.meaning}`}
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                The key arrives with the grid, so that it cannot say something
                different from the marks beside it. It appears once the page
                has loaded.
              </p>
            ),
          },
          {
            heading: 'What it cannot tell you',
            body: (
              <p>
                Runs recorded before resmon stored a reason read as{' '}
                <em>not recorded</em>, and they are not backfilled: a reason
                reconstructed afterwards would be a guess wearing a fact&rsquo;s
                clothes. A source that was not in a run&rsquo;s saved selection
                is a different mark again: you chose not to ask it, which is not a
                gap in the record.
              </p>
            ),
          },
        ]}
      />

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
