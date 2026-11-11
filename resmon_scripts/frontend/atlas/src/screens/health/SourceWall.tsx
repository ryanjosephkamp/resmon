import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { tipWords, useChartTip, type MarkTip, type TipContent } from '../../charts/ChartTip';
import { exactCount } from '../../charts/exact';
import { joined, useGridRoving } from '../../charts/roving';
import { Icon } from '../../shell/Icon';
import { number } from '../today/format';
import { HealthTabs } from './HealthTabs';
import { SOURCE_ANSWERS_GUIDE } from '../runs/model';
import { WallMark } from './WallMark';
import {
  WALL_SPANS, lastAsked, largestCount, runDays, runTime, runWhen, windowSentence,
  type Wall, type WallCell, type WallRun, type WallSource,
} from './model';

/**
 * The line drawn through a row behind its marks, by state: a run of answers,
 * of failures, of gaps in what could be asked or answered. A source that
 * rate-limited resmon is up, so its line is a gap, not a fault.
 */
const TRACK: Record<string, string> = {
  answered: 'kept', answered_empty: 'kept', answered_in_part: 'kept', failed: 'fault', could_not_be_asked: 'gap',
  rate_limited: 'gap',
};

/** The states that answered with papers a cell can count: an answer, or one in part. */
const COUNTED = new Set(['answered', 'answered_empty', 'answered_in_part']);

function selectionWords(inSelection: boolean | null): string {
  if (inSelection === true) return 'Yes';
  if (inSelection === false) return 'No';
  return 'Not known: the run’s saved selection cannot be read';
}

/** Whether a cell's count is a count of papers: an answer, never a failure's recorded zero or a part read with none. */
function counts(cell: WallCell): boolean {
  return COUNTED.has(cell.state) && cell.result_count !== null && !(cell.state === 'answered_in_part' && cell.result_count === 0);
}

/** A cell's tip: the source, the run and its time, the engine's label and sentence, and the papers it answered with. */
export function cellTip(source: WallSource, cell: WallCell, run: WallRun | undefined): TipContent {
  const n = cell.result_count ?? 0;
  return {
    name: `${source.name} · ${run ? `${run.label}, ${runWhen(run)}` : 'a run'}`,
    value: cell.label,
    lines: counts(cell) ? [{
      value: exactCount(n),
      label: `${n === 1 ? 'paper' : 'papers'}${cell.state === 'answered_in_part' ? ', from the part of the window read' : ''}`,
    }] : undefined,
    notes: cell.note ? [cell.note] : undefined,
    opens: 'Opens its reading below the wall',
  };
}

/** A run's head: its name, its time, and the way to its page. */
export function runTip(run: WallRun): TipContent {
  return { name: run.label, value: `Run ${run.execution_id}`, notes: [runWhen(run)], opens: `Opens run ${run.execution_id}` };
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
      {wall.isError && <p className="page-lede">The Source Wall could not be read ({wall.error.message}).</p>}
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
            <a className="record-link" href={SOURCE_ANSWERS_GUIDE} target="_blank" rel="noreferrer" data-health="guide">
              What a Source&rsquo;s Answer Means
            </a>
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
  const tip = useChartTip();
  // One stop for the keyboard: Tab reaches the chosen cell, or the first source's newest run, and the arrow keys move on.
  const pickedRow = picked ? wall.sources.findIndex((s) => s.slug === picked.slug) : -1;
  const roving = useGridRoving(wall.sources.length, wall.runs.length,
    pickedRow >= 0 && picked ? { row: pickedRow, column: picked.column } : { row: 0, column: wall.runs.length - 1 });
  // The newest runs are on the right: where the window is too narrow for every run, the wall opens
  // scrolled to them, beside When last asked, and older runs are a scroll to the left.
  const scroller = useRef<HTMLDivElement>(null);
  const newest = wall.runs[wall.runs.length - 1]?.execution_id;
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [newest, wall.runs.length]);
  return (
    <div className="wall-scroll" ref={scroller}>
      <table className="wall-grid">
        <thead>
          <tr>
            <th className="wall-corner" rowSpan={2} scope="col">Source</th>
            {days.map((d, i) => <th key={`${d.day}-${i}`} colSpan={d.span} className="wall-day" scope="colgroup">{d.day}</th>)}
            <th className="wall-last" rowSpan={2} scope="col">When last asked</th>
          </tr>
          <tr>
            {wall.runs.map((run, i) => {
              const content = runTip(run);
              return (
                <th key={run.execution_id} className="wall-run" scope="col" data-run={run.execution_id}
                  data-selected={picked?.column === i ? 'true' : undefined}>
                  <Link to={`/runs/${run.execution_id}`} aria-label={tipWords(content)} {...tip.mark(content)}>
                    {runTime(run)}
                  </Link>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {wall.sources.map((source, row) => (
            <Row key={source.slug} source={source} runs={wall.runs} largest={largest}
              picked={picked?.slug === source.slug ? picked.column : null}
              column={picked?.column ?? null}
              tip={tip}
              cell={(column) => roving.cell(row, column)}
              onPick={(column) => onPick({ slug: source.slug, column })} />
          ))}
        </tbody>
      </table>
      {tip.layer}
    </div>
  );
}

function Row({ source, runs, largest, picked, column, tip, cell: cellProps, onPick }: {
  source: WallSource; runs: readonly WallRun[]; largest: number; picked: number | null; column: number | null;
  tip: MarkTip; cell: (column: number) => ReturnType<ReturnType<typeof useGridRoving>['cell']>;
  onPick: (column: number) => void;
}) {
  const last = lastAsked(source, runs);
  return (
    <tr data-source={source.slug} data-selected={picked !== null ? 'true' : undefined}>
      <th scope="row" className="wall-source">{source.name}</th>
      {source.cells.map((cell, i) => {
        const content = cellTip(source, cell, runs[i]);
        return (
          <td key={cell.execution_id} className="wall-cell" data-state={cell.state} data-track={TRACK[cell.state]}
            data-column={column === i ? 'true' : undefined}>
            <button type="button" data-health="cell" data-state={cell.state} aria-pressed={picked === i}
              aria-label={tipWords(content)} {...joined(cellProps(i), tip.mark(content))}
              onClick={() => onPick(i)}>
              <WallMark state={cell.state} count={cell.result_count} largest={largest} />
              {/* An answer in part with nothing is not drawn as a count of none: the window was not all read. */}
              {counts(cell) && <span className="wall-count num">{number(cell.result_count ?? 0)}</span>}
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
 * The recorded zero reason is not listed among them: the label is the
 * engine's words for it and the sentence says it in full, so its stored code
 * would only say the same thing again, as an identifier.
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
        {COUNTED.has(cell.state) && (
          <div>
            <dt>Papers</dt>
            <dd>
              {cell.result_count === null ? 'Not recorded' : number(cell.result_count)}
              {cell.state === 'answered_in_part' && cell.result_count !== null && ', from the part of the window read'}
            </dd>
          </div>
        )}
        <div><dt>In this run’s selection</dt><dd>{selectionWords(cell.in_selection)}</dd></div>
      </dl>
    </section>
  );
}
