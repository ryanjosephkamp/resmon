import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { number } from '../today/format';
import { HealthTabs } from './HealthTabs';
import { WallMark } from './WallMark';
import {
  WALL_SPANS, lastAsked, largestCount, runDays, runTime, runWhen, windowSentence,
  type Wall, type WallCell, type WallRun, type WallSource,
} from './model';

/** The line drawn through a row behind its marks, by state: a run of answers, of failures, of gaps in what could be asked. */
const TRACK: Record<string, string> = {
  answered: 'kept', answered_empty: 'kept', failed: 'fault', could_not_be_asked: 'gap',
};

function selectionWords(inSelection: boolean | null): string {
  if (inSelection === true) return 'Yes';
  if (inSelection === false) return 'No';
  return 'Not known: the run’s saved selection cannot be read';
}

/**
 * The Source wall: every source's recorded answer to each of the last runs,
 * newest on the right, so a source that stopped answering reads as a line
 * that breaks rather than as one more empty inbox.
 *
 * Everything drawn is served classified by `GET /api/coverage/source-wall`:
 * the state of each cell, its label and its sentence, the legend, the verdict
 * and the notes. The screen adds a mark per state and nothing else, so a
 * failure and an empty answer can never look alike here and alike nowhere
 * else, or the other way round.
 */
export function SourceWall() {
  const [span, setSpan] = useState<number>(WALL_SPANS[0]);
  const [picked, setPicked] = useState<{ slug: string; column: number } | null>(null);
  const wall = useQuery({
    queryKey: ['source-wall', span],
    queryFn: () => answer(engine().GET('/api/coverage/source-wall', { params: { query: { limit: span } } })),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const data = wall.data;

  return (
    <div className="page health wall-page" aria-busy={wall.isFetching}>
      <HealthTabs />
      {wall.isPending && <p className="page-lede">Reading what every source did.</p>}
      {wall.isError && <p className="page-lede">The Source wall could not be read ({wall.error.message}).</p>}
      {data && (
        <>
          <Verdict verdict={data.verdict} />
          <div className="wall-tools">
            <ul className="wall-legend" data-health="legend" aria-label="What each mark means">
              {data.state_legend.map((entry) => (
                <li key={entry.state} data-state={entry.state} title={entry.meaning}>
                  <WallMark state={entry.state} count={1} largest={1} />
                  <span className="wall-legend-name">{entry.label}</span>
                  <b className="wall-legend-count num">{number(data.totals[entry.state] ?? 0)}</b>
                </li>
              ))}
            </ul>
            <div className="wall-span">
              <span data-health="window">{windowSentence(data.window)}</span>
              <div className="seg" role="group" aria-label="Runs shown">
                {WALL_SPANS.map((n) => (
                  <button key={n} type="button" aria-pressed={span === n} onClick={() => { setSpan(n); setPicked(null); }}>{n}</button>
                ))}
              </div>
            </div>
          </div>
          {data.runs.length > 0 && <Grid wall={data} picked={picked} onPick={setPicked} />}
          {picked && <Reading wall={data} slug={picked.slug} column={picked.column} />}
          <ul className="wall-notes">
            {data.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

function Verdict({ verdict }: { verdict: Wall['verdict'] }) {
  return (
    <section className="wall-verdict" data-health="verdict" data-level={verdict.level}>
      <span className="wall-verdict-mark" aria-hidden="true">
        {verdict.level === 'attention' ? <Icon name="fault" /> : verdict.level === 'ok' ? <Icon name="check" /> : <Icon name="minus" />}
      </span>
      <div>
        <h1 className="wall-headline">{verdict.headline}</h1>
        {verdict.detail.map((line) => <p key={line} className="wall-detail-line">{line}</p>)}
      </div>
    </section>
  );
}

function Grid({ wall, picked, onPick }: {
  wall: Wall; picked: { slug: string; column: number } | null; onPick: (p: { slug: string; column: number }) => void;
}) {
  const days = useMemo(() => runDays(wall.runs), [wall.runs]);
  const largest = useMemo(() => largestCount(wall), [wall]);
  return (
    <div className="wall-scroll">
      <table className="wall-grid">
        <thead>
          <tr>
            <th className="wall-corner" rowSpan={2} scope="col">Source</th>
            {days.map((d, i) => <th key={`${d.day}-${i}`} colSpan={d.span} className="wall-day" scope="colgroup">{d.day}</th>)}
            <th className="wall-last" rowSpan={2} scope="col">When last asked</th>
          </tr>
          <tr>
            {wall.runs.map((run, i) => (
              <th key={run.execution_id} className="wall-run" scope="col" data-run={run.execution_id}
                data-selected={picked?.column === i ? 'true' : undefined}>
                <Link to={`/runs/${run.execution_id}`} title={`${run.label}, ${runWhen(run)}: open run ${run.execution_id}`}>
                  {runTime(run)}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {wall.sources.map((source) => (
            <Row key={source.slug} source={source} runs={wall.runs} largest={largest}
              picked={picked?.slug === source.slug ? picked.column : null}
              column={picked?.column ?? null}
              onPick={(column) => onPick({ slug: source.slug, column })} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ source, runs, largest, picked, column, onPick }: {
  source: WallSource; runs: readonly WallRun[]; largest: number; picked: number | null; column: number | null;
  onPick: (column: number) => void;
}) {
  const last = lastAsked(source, runs);
  return (
    <tr data-source={source.slug} data-selected={picked !== null ? 'true' : undefined}>
      <th scope="row" className="wall-source">{source.name}</th>
      {source.cells.map((cell, i) => {
        const run = runs[i];
        return (
          <td key={cell.execution_id} className="wall-cell" data-state={cell.state} data-track={TRACK[cell.state]}
            data-column={column === i ? 'true' : undefined}>
            <button type="button" data-health="cell" data-state={cell.state} aria-pressed={picked === i}
              aria-label={`${source.name}, ${run?.label ?? 'a run'} ${run ? runWhen(run) : ''}: ${cell.label}`}
              title={`${cell.label}. ${cell.note}`}
              onClick={() => onPick(i)}>
              <WallMark state={cell.state} count={cell.result_count} largest={largest} />
              {(cell.state === 'answered' || cell.state === 'answered_empty') && cell.result_count !== null && (
                <span className="wall-count num">{number(cell.result_count)}</span>
              )}
            </button>
          </td>
        );
      })}
      <td className="wall-last" data-state={last?.cell.state}>
        {last
          ? (<><b><WallMark state={last.cell.state} count={1} largest={1} />{last.cell.label}</b><small>{runWhen(last.run)}</small></>)
          : <small>No answer recorded in these runs</small>}
      </td>
    </tr>
  );
}

/**
 * One cell, read: the source, the run and its time, the cell's label and the
 * engine's sentence about what happened, and the facts the sentence rests on.
 */
function Reading({ wall, slug, column }: { wall: Wall; slug: string; column: number }) {
  const source = wall.sources.find((s) => s.slug === slug);
  const cell: WallCell | undefined = source?.cells[column];
  const run = wall.runs[column];
  if (!source || !cell || !run) return null;
  return (
    <section className="wall-reading" data-health="reading" data-state={cell.state} aria-live="polite">
      <div className="wall-reading-main">
        <h2 className="wall-reading-head">{source.name} · <span className="it">{run.label}</span> · {runWhen(run)}</h2>
        <p className="wall-reading-label"><WallMark state={cell.state} count={1} largest={1} />{cell.label}</p>
        <p className="wall-reading-note">{cell.note}</p>
        <p><Link to={`/runs/${run.execution_id}`} className="btn sm">Open run {run.execution_id}</Link></p>
      </div>
      <dl className="wall-reading-facts">
        {/* A count is a fact only about an answer: a failure's recorded zero is not "found none". */}
        {(cell.state === 'answered' || cell.state === 'answered_empty') && (
          <div><dt>Papers</dt><dd>{cell.result_count === null ? 'Not recorded' : number(cell.result_count)}</dd></div>
        )}
        {cell.zero_reason && <div><dt>Recorded reason</dt><dd><code className="cron">{cell.zero_reason}</code></dd></div>}
        <div><dt>In this run’s selection</dt><dd>{selectionWords(cell.in_selection)}</dd></div>
      </dl>
    </section>
  );
}
