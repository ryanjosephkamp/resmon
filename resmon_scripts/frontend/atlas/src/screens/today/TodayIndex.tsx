import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { components } from '../../api/schema';
import { breakable } from '../../shell/breakable';
import { Icon } from '../../shell/Icon';
import { authors, count, duration, number, troubleParts, when } from './format';
import { SaveButton, SaveLimit, useSaveToRead } from '../library/SaveMany';
import { PickBox, SelectBar, useRowKeys } from '../selection/SelectBar';
import { has, isEmpty, pickedIn, selectedWords, sizeOf, usePicks } from '../selection/picks';
import { LifecycleMarks } from '../lifecycle/LifecycleMarks';
import type { LifecycleEvent } from '../lifecycle/model';
import { FADE_MS, lightsAt, type Opening } from './opening';

type TodayPaper = components['schemas']['TodayPaper'];
type TodayWatch = components['schemas']['TodayWatch'];
type TodayRun = components['schemas']['TodayRun'];

export interface IndexPaper extends TodayPaper {
  /** Its number on the plate and in the index, in the order it was collected. */
  n: number;
  /** "B3", or null when the paper is not on the plate. */
  cell: string | null;
  /** The map region it sits in, when it is on the plate. */
  regionId: number | null;
}

export interface Region { id: number; label: string }

/**
 * How many of a group's papers are listed at first, and how many more each
 * "Show more" adds. A thousand entries took longer to mount than the rest of
 * Today together, on every visit; the plate shows them all either way, and a
 * paper chosen on the plate is listed however far down its group it is.
 */
export const GROUP_FIRST = 25;
export const GROUP_MORE = 50;
/** How many new papers one List earlier papers reads: `today.PAPER_PAGE`. */
export const EARLIER_PAGE = 1_000;

/** How many of a group's papers to list: what was asked for, and as far as the paper chosen on the plate. */
export function listedIn(papers: readonly { id: number }[], asked: number, selected: number | null): number {
  const at = selected === null ? -1 : papers.findIndex((paper) => paper.id === selected);
  return Math.min(papers.length, Math.max(asked, at + 1));
}

interface Group {
  key: string;
  title: string;
  italic: boolean;
  watch?: TodayWatch;
  regionId?: number;
  papers: IndexPaper[];
  /** All of this group's new papers, listed or not. */
  total: number;
}

interface Props {
  papers: readonly IndexPaper[];
  total: number;
  fromSearches: number;
  /** Papers in the whole collection, or null while the map has not said. */
  collectionSize: number | null;
  watches: readonly TodayWatch[];
  regions: ReadonlyMap<number, Region>;
  sourceName: (slug: string) => string;
  heading: string;
  /** Today's opening, which lights the numbers in turn. */
  opening: Opening;
  selected: number | null;
  now: Date;
  saved: ReadonlyMap<number, boolean>;
  /** Notices recorded against the listed papers, by id; absent while they are being read. */
  lifecycle?: Readonly<Record<string, LifecycleEvent[]>>;
  marking: boolean;
  /** Re-reading the engine: the list says so, to a screen reader and to a test. */
  busy: boolean;
  /** Reading the new papers that arrived before the ones listed; null once every one is listed. */
  earlier: { reading: boolean; failed: string | null; read: () => void } | null;
  onSelect: (id: number) => void;
  onPoint: (id: number | null) => void;
  onZoomTo: (target: { watchId?: number; regionId?: number; paperId?: number }) => void;
  onToggleSave: (paper: IndexPaper) => void;
  onMarkRead: () => void;
  footer: React.ReactNode;
  /** How the list is grouped, as Today's view remembers it in the engine. */
  by: 'watch' | 'region';
  onBy: (by: 'watch' | 'region') => void;
  /** Papers a save of many just put in the reading queue, so a mark set by hand gives way to what the engine holds. */
  onSavedMany?: (ids: readonly number[]) => void;
}

/**
 * Today's list, beside the plate: the new papers by watch or by region, each
 * with its number, its place, and Save to read. Select gives each entry a box
 * and puts the selection bar in the list's bar: Save to read saves the
 * entries picked, and Select all every new paper, listed yet or not.
 */
export function TodayIndex(props: Props) {
  const {
    papers, total, fromSearches, collectionSize, watches, regions, sourceName, heading, opening, selected, now, saved, lifecycle,
    marking, busy, earlier, onSelect, onPoint, onZoomTo, onToggleSave, onMarkRead, footer, by, onBy: setBy, onSavedMany,
  } = props;
  const scroller = useRef<HTMLDivElement>(null);
  // How far each group's list has been opened with Show more, by group.
  const [reach, setReach] = useState<ReadonlyMap<string, number>>(new Map());
  // After Show more, the caret goes to the first paper it listed.
  const focusNext = useRef<number | null>(null);
  useEffect(() => {
    const id = focusNext.current;
    if (id === null) return;
    focusNext.current = null;
    scroller.current?.querySelector<HTMLElement>(`[data-paper="${id}"] .entry-title`)?.focus();
  }, [reach]);

  const groups = useMemo<Group[]>(() => {
    if (by === 'region') {
      const byRegion = new Map<number | null, IndexPaper[]>();
      for (const paper of papers) {
        const list = byRegion.get(paper.regionId) ?? [];
        list.push(paper);
        byRegion.set(paper.regionId, list);
      }
      return [...byRegion.entries()]
        .sort(([a, pa], [b, pb]) => (a === null ? 1 : b === null ? -1 : pb.length - pa.length))
        .map(([regionId, list]) => ({
          key: `region:${regionId}`,
          title: regionId === null ? 'Not on the map' : regions.get(regionId)?.label || 'Unnamed region',
          italic: regionId !== null,
          regionId: regionId ?? undefined,
          papers: list,
          total: list.length,
        }));
    }
    const out: Group[] = [];
    for (const watch of [...watches].sort((a, b) => b.new_count - a.new_count)) {
      if (watch.new_count === 0) continue;
      out.push({
        key: `watch:${watch.id}`, title: watch.name, italic: true, watch,
        papers: papers.filter((p) => p.watches.includes(watch.id)),
        total: watch.new_count,
      });
    }
    const mine = papers.filter((p) => p.watches.length === 0);
    if (fromSearches > 0) {
      out.push({ key: 'searches', title: 'From your own searches', italic: false, papers: mine, total: fromSearches });
    }
    return out;
  }, [by, papers, watches, regions, fromSearches]);

  const quiet = by === 'watch' ? watches.filter((w) => w.new_count === 0) : [];

  // The entries as listed, top to bottom, which the arrows and a Shift-pick go by; a paper two watches found is listed twice.
  const listedOf = useCallback((group: Group) => listedIn(group.papers, reach.get(group.key) ?? GROUP_FIRST, selected),
    [reach, selected]);
  const starts = useMemo(() => {
    const out = new Map<string, number>();
    let at = 0;
    for (const group of groups) { out.set(group.key, at); at += listedOf(group); }
    return out;
  }, [groups, listedOf]);
  const order = useMemo(() => groups.flatMap((group) => group.papers.slice(0, listedOf(group)).map((paper) => paper.id)),
    [groups, listedOf]);
  const [selecting, setSelecting] = useState(false);
  // Nothing new (Mark all read, say) leaves select mode, so it does not come back by itself with tomorrow's papers.
  if (selecting && total === 0) setSelecting(false);
  // Out of select mode nothing is picked, however it was left.
  const picks = usePicks<number>(order, selecting ? 'today' : 'idle');
  const picked = sizeOf(picks.picks, total);
  const allPicked = picks.picks.all && picks.picks.except.size === 0;
  const saving = useSaveToRead((done) => { picks.release('all'); onSavedMany?.(done.saved_ids); });
  const { pick, selectAll, clear } = picks;
  const { cancel } = saving;
  const endSelecting = useCallback(() => { setSelecting(false); clear(); cancel(); }, [clear, cancel]);
  const { onKeyDown: rowKeys } = useRowKeys({
    count: order.length, onAll: selectAll, within: scroller,
    onRange: (to, from) => { const id = order[to]; if (id !== undefined) pick(id, true, order[from]); },
  });
  const savePicked = () => {
    if (!picked) return;
    if (picks.picks.all) {
      saving.save({
        target: { kind: 'today', except: [...picks.picks.except], atMost: picked }, n: picked, all: allPicked,
        what: allPicked ? `all ${count(picked, 'new paper')}` : `these ${count(picked, 'paper')}`,
      });
    } else {
      const ids = [...new Set(pickedIn(picks.picks, order))];
      saving.save({ target: { kind: 'listed', ids }, n: ids.length, all: false, what: `these ${count(ids.length, 'paper')}` });
    }
  };

  // The plate chose a paper: bring its entry into view.
  useEffect(() => {
    if (selected === null) return;
    const entry = scroller.current?.querySelector<HTMLElement>(`[data-paper="${selected}"]`);
    entry?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [selected]);

  /** A group's papers as far as they are listed, and the Show more that lists the next ones. */
  const listOf = (group: Group) => {
    const listed = listedOf(group);
    const rest = group.papers.length - listed;
    const first = starts.get(group.key) ?? 0;
    return (
      <>
        {group.papers.slice(0, listed).map((paper, k) => (
          <Entry
            key={`${group.key}:${paper.id}`}
            paper={paper}
            picking={selecting ? { picked: has(picks.picks, paper.id), index: first + k, onPick: (range) => pick(paper.id, range) } : null}
            opening={opening}
            listed={papers.length}
            firstNumber={papers[0]?.n ?? 1}
            selected={paper.id === selected}
            saved={saved.get(paper.id) ?? paper.queue_status !== null}
            events={lifecycle?.[String(paper.id)]}
            sourceName={sourceName}
            onSelect={onSelect}
            onPoint={onPoint}
            onZoomTo={onZoomTo}
            onToggleSave={onToggleSave}
          />
        ))}
        {rest > 0 && (
          <button type="button" className="btn sm more" data-today="show-more"
            aria-label={`Show ${number(Math.min(GROUP_MORE, rest))} more of ${group.title}, ${number(rest)} not listed yet`}
            onClick={() => {
              focusNext.current = group.papers[listed]?.id ?? null;
              setReach((was) => new Map(was).set(group.key, listed + GROUP_MORE));
            }}>
            Show {number(Math.min(GROUP_MORE, rest))} more
          </button>
        )}
      </>
    );
  };

  const shown = papers.length;
  return (
    <section className="index" aria-labelledby="index-title" aria-busy={busy}>
      <header className="index-bar">
        <h2 id="index-title">{heading} <span>{number(total)}</span></h2>
        <div className="seg" role="group" aria-label="Group by">
          <button type="button" aria-pressed={by === 'watch'} onClick={() => setBy('watch')}>By watch</button>
          <button type="button" aria-pressed={by === 'region'} onClick={() => setBy('region')}>By region</button>
        </div>
        <span className="index-acts">
          {total > 0 && (
            <button type="button" className="btn sm" data-today="select" aria-pressed={selecting}
              onClick={() => (selecting ? endSelecting() : setSelecting(true))}>Select</button>
          )}
          <button type="button" className="btn sm" onClick={onMarkRead} disabled={marking || total === 0}
            title="Today will start from now the next time you open it">
            <Icon name="check" size={14} />
            Mark all read
          </button>
        </span>
      </header>
      {selecting && total > 0 && (
        <SelectBar label="The selected new papers" className="today-select" said={selectedWords(picked, total)}
          tick={isEmpty(picks.picks, total) ? 'none' : allPicked ? 'on' : 'part'}
          allLabel={allPicked ? null : `Select all ${count(total, 'new paper')}`} onAll={selectAll} onDone={endSelecting}
          below={<><SaveLimit n={picked} />{saving.question}{saving.refused}</>}>
          <SaveButton n={picked} all={allPicked} busy={saving.pending || saving.asking} saving={saving.pending} onSave={savePicked} />
        </SelectBar>
      )}

      <div className="index-scroll" ref={scroller}
        onKeyDown={selecting ? rowKeys : undefined}>
        {total > shown && (
          <div className="index-cap earlier" data-today="earlier">
            <p>The newest {number(shown)} of {number(total)} are listed and ringed on the plate.</p>
            {earlier && (
              <button type="button" className="btn sm" disabled={earlier.reading} onClick={earlier.read}>
                {earlier.reading ? 'Reading earlier papers' : `List the ${number(Math.min(EARLIER_PAGE, total - shown))} before them`}
              </button>
            )}
            {earlier?.failed && <p className="field-error" role="alert">The earlier papers were not read: {earlier.failed}.</p>}
          </div>
        )}
        {groups.map((group) => (
          <section key={group.key} className="group" aria-label={group.title}>
            <div className="ghead">
              <h3 className={group.italic ? 'it' : 'rg'}>
                {group.watch || group.regionId !== undefined ? (
                  <button type="button" className="zoomto"
                    onClick={() => onZoomTo(group.watch ? { watchId: group.watch.id } : { regionId: group.regionId })}>
                    {breakable(group.title)}
                  </button>
                ) : breakable(group.title)}
              </h3>
              <span className="n">{number(group.total)} new</span>
            </div>
            {group.watch && <RunLine watch={group.watch} now={now} />}
            {group.papers.length < group.total && (
              <p className="gsub">
                {group.papers.length === 0
                  ? `None of them is among the newest ${number(papers.length)} listed; they arrived before them.`
                  : `${number(group.papers.length)} of them are among the newest ${number(papers.length)} listed; the rest arrived before them.`}
              </p>
            )}
            {listOf(group)}
          </section>
        ))}
        {total === 0 && (
          <p className="index-empty">
            {collectionSize === 0
              ? 'Nothing collected yet. Papers your watches and searches find will be listed here.'
              : 'Nothing new since then. The plate still shows everything you have.'}
          </p>
        )}
        {quiet.length > 0 && (
          <section className="group quietgroup" aria-label="Watches with nothing new">
            <div className="ghead"><h3 className="rg">Nothing new from</h3></div>
            {quiet.map((watch) => (
              <div key={watch.id} className="quietwatch">
                <span className="it">{breakable(watch.name)}</span>
                <RunLine watch={watch} now={now} />
              </div>
            ))}
          </section>
        )}
      </div>
      <footer className="index-foot">{footer}</footer>
      {saving.notice}
    </section>
  );
}

function RunLine({ watch, now }: { watch: TodayWatch; now: Date }) {
  const run = watch.last_run;
  if (!run) return <p className="gsub">Has not run yet.</p>;
  const took = duration(run.started_at, run.ended_at);
  const state = run.status === 'completed' ? 'Ran' : run.status === 'running' ? 'Running since' : `Run ${run.status},`;
  return (
    <>
      <p className="gsub">
        {state} {when(run.started_at, now)}{took ? ` in ${took}` : ''}
        {run.status === 'completed' && <> · {number(run.result_count)} found · {run.sources_answered} of {run.sources_total} sources answered</>}
      </p>
      {run.sources_not_answered.length > 0 && <SourceTrouble run={run} />}
    </>
  );
}

/**
 * The sources that did not answer on a watch's last run, as one line under
 * it: Today is the morning's papers, and source health is the Source wall's.
 * The line names every such source by what happened to it, a mark for a
 * failure and another for an unknown, so a quiet run (no line) and a broken
 * one never look alike; each source's own sentence is one click away, in
 * place, and the run's page has its whole record.
 */
function SourceTrouble({ run }: { run: TodayRun }) {
  const [open, setOpen] = useState(false);
  const notes = useId();
  const parts = troubleParts(run.sources_not_answered);
  return (
    <div className="trouble" role="note" data-sources-not-answered={run.sources_not_answered.length}>
      <p className="trouble-line">
        {parts.map((part) => (
          <span key={`${part.category}|${part.label}`} className="trouble-part" data-category={part.category}>
            {part.category === 'non_answer'
              ? <span className="trouble-mark fault"><Icon name="fault" size={14} /></span>
              : <svg className="trouble-mark unknown" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="4.5" y="4.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>}
            {part.text}
          </span>
        ))}
        <button type="button" className="trouble-why" aria-expanded={open} aria-controls={notes} onClick={() => setOpen(!open)}>
          {open ? 'Hide why' : 'Why'}
        </button>
      </p>
      {open && (
        <ul id={notes} className="trouble-notes">
          {run.sources_not_answered.map((s) => (
            <li key={s.source} data-source={s.source}><b>{s.name}.</b> {s.note}</li>
          ))}
          <li className="trouble-run">
            <Link to={`/runs/${run.execution_id}`}>Open run {run.execution_id}</Link> for every source&rsquo;s record.
          </li>
        </ul>
      )}
    </div>
  );
}

function Entry(props: {
  paper: IndexPaper; opening: Opening; listed: number; firstNumber: number; selected: boolean; saved: boolean;
  events?: LifecycleEvent[];
  /** Select mode: whether it is picked, its place among the entries listed, and picking it. */
  picking: { picked: boolean; index: number; onPick: (range: boolean) => void } | null;
  sourceName: (slug: string) => string;
  onSelect: (id: number) => void;
  onPoint: (id: number | null) => void;
  onZoomTo: (target: { paperId: number }) => void;
  onToggleSave: (paper: IndexPaper) => void;
}) {
  const { paper, opening, listed, firstNumber, selected, saved, events, picking, sourceName, onSelect, onPoint, onZoomTo, onToggleSave } = props;
  const badge = useRef<HTMLSpanElement>(null);
  // The number brightens at its turn in the opening, as an animation of its
  // own: the page is not changed again as the opening goes, only drawn.
  useEffect(() => {
    const node = badge.current;
    if (opening.state !== 'running' || !node || typeof node.animate !== 'function') return undefined;
    // Lit in turn among the papers listed, which start at `firstNumber`.
    const delay = lightsAt(paper.n - firstNumber + 1, listed) - (performance.now() - opening.start);
    if (delay + FADE_MS <= 0) return undefined;
    const fade = node.animate([{ opacity: 0.18 }, { opacity: 1 }], {
      duration: FADE_MS, delay: Math.max(0, delay), easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards',
    });
    return () => fade.cancel();
  }, [opening, paper.n, listed, firstNumber]);
  const link = paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : null);
  return (
    <article
      className={`entry${selected ? ' sel' : ''}${picking ? ' picking' : ''}${picking?.picked ? ' picked' : ''}`}
      data-paper={paper.id}
      onMouseEnter={() => onPoint(paper.id)}
      onMouseLeave={() => onPoint(null)}
    >
      {picking && <PickBox picked={picking.picked} label={`Select “${paper.title}”`} index={picking.index} onPick={picking.onPick} />}
      <span ref={badge} className={opening.state === 'waiting' ? 'badge dim' : 'badge'} aria-label={`Number ${paper.n}`}>{paper.n}</span>
      <div className="entry-body">
        <h4>
          <button type="button" className="entry-title" onClick={() => onSelect(paper.id)} aria-pressed={selected}>
            {paper.title}
          </button>
        </h4>
        <LifecycleMarks events={events} />
        <div className="meta">
          <span className="who">{authors(paper.authors)}</span>
          <span className="sep" aria-hidden="true" />
          <span>{sourceName(paper.source)}</span>
          {paper.cell && (
            <>
              <span className="sep" aria-hidden="true" />
              <button type="button" className="cell" onClick={() => onZoomTo({ paperId: paper.id })}
                aria-label={`Show on the map, at ${paper.cell}`}>{paper.cell}</button>
            </>
          )}
          <span className="acts">
            <button type="button" className="iconbtn" aria-pressed={saved}
              aria-label={saved ? 'Saved to your reading queue; remove it' : 'Save to your reading queue'}
              title={saved ? 'Saved to your reading queue' : 'Save to your reading queue'}
              onClick={() => onToggleSave(paper)}>
              <Icon name={saved ? 'bookmarked' : 'bookmark'} size={14} />
            </button>
            {link && (
              <a className="iconbtn" href={link} target="_blank" rel="noreferrer"
                aria-label={`Open at ${sourceName(paper.source)}`} title={`Open at ${sourceName(paper.source)}`}>
                <Icon name="open" size={14} />
              </a>
            )}
          </span>
        </div>
        {paper.abstract_lede && (
          <p className="sum"><span className="by">From the abstract</span>{paper.abstract_lede}</p>
        )}
      </div>
    </article>
  );
}
