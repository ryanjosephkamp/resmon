import React, { useState } from 'react';
import {
  SourceWallGrid,
  STATE_MARKS,
  WALL_STATE_ORDER,
  WallCell,
  WallSource,
  knownState,
} from '../../api/sourceWall';

/**
 * The source wall: every source down one axis, the recent runs across the
 * other, one cell per source per run.
 *
 * The question this screen answers is not *how many papers did I get* — the
 * Results page answers that, and Analytics counts it. It is *is my coverage
 * still what it was*. A literature monitor fails silently: a dead source and
 * a quiet field produce the same empty inbox, and until this screen the
 * difference was visible only to someone who opened several runs and compared
 * them by hand.
 *
 * Three things shape how it is drawn.
 *
 * **Status is the content**, so color is spent entirely on state. Nothing
 * else on this screen is saturated, and the four states that mean something
 * are the only saturated marks a user sees.
 *
 * **Hue is never the only channel.** Each state also has its own glyph and
 * its own fill — solid, ring, hatch or nothing — so the grid survives a
 * monochrome screen and the roughly one man in twelve who cannot separate
 * red from green. A status instrument that is ambiguous is worse than no
 * instrument, because it reads as reassurance.
 *
 * **Density with space inside it.** The grid is tight enough to take in at a
 * glance and the cells do not touch; the type is one strict scale and the
 * only large text on the screen is the verdict, which is the one thing a user
 * should be able to read from across the room.
 *
 * Everything the screen *says* is composed by the backend. The verdict
 * headline, the per-cell label and the per-cell sentence all arrive on the
 * payload. The renderer picks a glyph and a column; it does not decide what
 * happened.
 */

interface Props {
  grid: SourceWallGrid;
}

/** `2026-10-08T09:14:00` as a column header a person can scan. */
function shortDate(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fullWhen(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? iso : when.toLocaleString();
}

interface Selected {
  source: WallSource;
  cell: WallCell;
  runLabel: string;
  startedAt: string;
}

const SourceWall: React.FC<Props> = ({ grid }) => {
  const [selected, setSelected] = useState<Selected | null>(null);
  const { runs, sources, verdict, window: bounds } = grid;

  return (
    <div className="source-wall">
      <section
        className="source-wall-verdict"
        data-level={verdict.level}
        data-testid="source-wall-verdict"
        aria-live="polite"
      >
        <p className="source-wall-headline">{verdict.headline}</p>
        {verdict.detail.map((line) => (
          <p className="source-wall-detail-line" key={line}>{line}</p>
        ))}
      </section>

      <div className="source-wall-bar">
        <span className="source-wall-window" data-testid="source-wall-window">
          {`Showing ${bounds.returned} of ${bounds.runs_available} recorded runs`}
        </span>
        <ul className="source-wall-legend" data-testid="source-wall-legend">
          {WALL_STATE_ORDER.map((state) => (
            <li key={state} className="source-wall-legend-item">
              <span className="source-wall-swatch" data-state={state} aria-hidden="true">
                {STATE_MARKS[state].mark}
              </span>
              <span className="source-wall-legend-name" title={STATE_MARKS[state].meaning}>
                {STATE_MARKS[state].name}
              </span>
              <span className="source-wall-legend-count">{grid.totals[state] ?? 0}</span>
            </li>
          ))}
        </ul>
      </div>

      {runs.length === 0 ? (
        <p className="source-wall-empty">
          Nothing to draw yet. Each run you record adds a column here.
        </p>
      ) : (
        <div className="source-wall-scroll">
          <table className="source-wall-grid">
            <caption className="source-wall-caption">
              One cell per source per run. Runs read oldest to newest, left to right.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="source-wall-corner">Source</th>
                {runs.map((run) => (
                  <th
                    scope="col"
                    key={run.execution_id}
                    className="source-wall-run"
                    title={`${run.label} — ${fullWhen(run.started_at)} (${run.status})`}
                  >
                    <span className="source-wall-run-date">{shortDate(run.started_at)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.slug}>
                  <th scope="row" className="source-wall-source" title={source.slug}>
                    {source.name}
                  </th>
                  {source.cells.map((cell, index) => {
                    const run = runs[index];
                    const state = knownState(cell.state);
                    const mark = STATE_MARKS[state];
                    return (
                      <td className="source-wall-slot" key={`${source.slug}:${cell.execution_id}`}>
                        <button
                          type="button"
                          className="source-wall-cell"
                          data-testid="source-wall-cell"
                          data-state={state}
                          data-recorded={String(cell.outcome_recorded)}
                          data-partial={String(cell.partial)}
                          title={cell.note}
                          aria-label={
                            `${source.name}, ${run ? run.label : 'run'} `
                            + `${run ? shortDate(run.started_at) : ''}: ${cell.label}`
                          }
                          onClick={() => setSelected({
                            source,
                            cell,
                            runLabel: run ? run.label : 'Run',
                            startedAt: run ? run.started_at : '',
                          })}
                        >
                          <span aria-hidden="true">{mark.mark}</span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The reading pane. A dense grid can only carry a mark; the sentence
          behind the mark is the backend's and is shown in full, never
          truncated or re-worded. */}
      <section className="source-wall-reading" data-testid="source-wall-detail" aria-live="polite">
        {selected ? (
          <>
            <p className="source-wall-reading-head">
              <strong>{selected.source.name}</strong>
              {` · ${selected.runLabel}`}
              {selected.startedAt ? ` · ${fullWhen(selected.startedAt)}` : ''}
            </p>
            <p className="source-wall-reading-state">
              <span
                className="source-wall-swatch"
                data-state={knownState(selected.cell.state)}
                aria-hidden="true"
              >
                {STATE_MARKS[knownState(selected.cell.state)].mark}
              </span>
              {selected.cell.label}
            </p>
            <p className="source-wall-reading-note">{selected.cell.note}</p>
          </>
        ) : (
          <p className="source-wall-reading-note">
            Select a cell to read what resmon recorded for that source on that run.
          </p>
        )}
      </section>

      <ul className="source-wall-notes">
        {grid.notes.map((note) => <li key={note}>{note}</li>)}
      </ul>
    </div>
  );
};

export default SourceWall;
