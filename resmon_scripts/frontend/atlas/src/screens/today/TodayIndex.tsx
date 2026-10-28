import { useEffect, useMemo, useRef, useState } from 'react';
import type { components } from '../../api/schema';
import { Icon } from '../../shell/Icon';
import { authors, duration, number, when } from './format';

type TodayPaper = components['schemas']['TodayPaper'];
type TodayWatch = components['schemas']['TodayWatch'];

export interface IndexPaper extends TodayPaper {
  /** Its number on the plate and in the index, in the order it was collected. */
  n: number;
  /** "B3", or null when the paper is not on the plate. */
  cell: string | null;
  /** The map region it sits in, when it is on the plate. */
  regionId: number | null;
}

export interface Region { id: number; label: string }

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
  lit: number;
  selected: number | null;
  now: Date;
  saved: ReadonlyMap<number, boolean>;
  marking: boolean;
  /** Re-reading the engine: the list says so, to a screen reader and to a test. */
  busy: boolean;
  onSelect: (id: number) => void;
  onPoint: (id: number | null) => void;
  onZoomTo: (target: { watchId?: number; regionId?: number; paperId?: number }) => void;
  onToggleSave: (paper: IndexPaper) => void;
  onMarkRead: () => void;
  footer: React.ReactNode;
}

export function TodayIndex(props: Props) {
  const {
    papers, total, fromSearches, collectionSize, watches, regions, sourceName, heading, lit, selected, now, saved, marking, busy,
    onSelect, onPoint, onZoomTo, onToggleSave, onMarkRead, footer,
  } = props;
  const [by, setBy] = useState<'watch' | 'region'>('watch');
  const scroller = useRef<HTMLDivElement>(null);

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

  // The plate chose a paper: bring its entry into view.
  useEffect(() => {
    if (selected === null) return;
    const entry = scroller.current?.querySelector<HTMLElement>(`[data-paper="${selected}"]`);
    entry?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [selected]);

  const shown = papers.length;
  return (
    <section className="index" aria-labelledby="index-title" aria-busy={busy}>
      <header className="index-bar">
        <h2 id="index-title">{heading} <span>{number(total)}</span></h2>
        <div className="seg" role="group" aria-label="Group by">
          <button type="button" aria-pressed={by === 'watch'} onClick={() => setBy('watch')}>By watch</button>
          <button type="button" aria-pressed={by === 'region'} onClick={() => setBy('region')}>By region</button>
        </div>
        <button type="button" className="btn sm" onClick={onMarkRead} disabled={marking || total === 0}
          title="Today will start from now the next time you open it">
          <Icon name="check" size={14} />
          Mark all read
        </button>
      </header>

      <div className="index-scroll" ref={scroller}>
        {total > shown && (
          <p className="index-cap">The newest {number(shown)} of {number(total)} are listed here; the plate shows them all.</p>
        )}
        {groups.map((group) => (
          <section key={group.key} className="group" aria-label={group.title}>
            <div className="ghead">
              <h3 className={group.italic ? 'it' : 'rg'}>
                {group.watch || group.regionId !== undefined ? (
                  <button type="button" className="zoomto"
                    onClick={() => onZoomTo(group.watch ? { watchId: group.watch.id } : { regionId: group.regionId })}>
                    {group.title}
                  </button>
                ) : group.title}
              </h3>
              <span className="n">{number(group.total)} new</span>
            </div>
            {group.watch && <RunLine watch={group.watch} now={now} sourceName={sourceName} />}
            {group.papers.length < group.total && (
              <p className="gsub">
                {group.papers.length === 0
                  ? `None of them is among the newest ${number(papers.length)} listed; they are on the plate.`
                  : `${number(group.papers.length)} of them are among the newest ${number(papers.length)} listed; the rest are on the plate.`}
              </p>
            )}
            {group.papers.map((paper) => (
              <Entry
                key={`${group.key}:${paper.id}`}
                paper={paper}
                lit={paper.n <= lit}
                selected={paper.id === selected}
                saved={saved.get(paper.id) ?? paper.queue_status !== null}
                sourceName={sourceName}
                onSelect={onSelect}
                onPoint={onPoint}
                onZoomTo={onZoomTo}
                onToggleSave={onToggleSave}
              />
            ))}
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
                <span className="it">{watch.name}</span>
                <RunLine watch={watch} now={now} sourceName={sourceName} />
              </div>
            ))}
          </section>
        )}
      </div>
      <footer className="index-foot">{footer}</footer>
    </section>
  );
}

function RunLine({ watch, now, sourceName }: { watch: TodayWatch; now: Date; sourceName: (slug: string) => string }) {
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
      {run.sources_not_answered.map((s) => (
        <div key={s.source} className="note" role="note">
          <span className="note-mark"><Icon name="fault" size={14} /></span>
          <p><b>{sourceName(s.source)} {s.label}.</b> {s.note}</p>
        </div>
      ))}
    </>
  );
}

function Entry(props: {
  paper: IndexPaper; lit: boolean; selected: boolean; saved: boolean;
  sourceName: (slug: string) => string;
  onSelect: (id: number) => void;
  onPoint: (id: number | null) => void;
  onZoomTo: (target: { paperId: number }) => void;
  onToggleSave: (paper: IndexPaper) => void;
}) {
  const { paper, lit, selected, saved, sourceName, onSelect, onPoint, onZoomTo, onToggleSave } = props;
  const link = paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : null);
  return (
    <article
      className={selected ? 'entry sel' : 'entry'}
      data-paper={paper.id}
      onMouseEnter={() => onPoint(paper.id)}
      onMouseLeave={() => onPoint(null)}
    >
      <span className={lit ? 'badge' : 'badge dim'} aria-label={`Number ${paper.n}`}>{paper.n}</span>
      <div className="entry-body">
        <h4>
          <button type="button" className="entry-title" onClick={() => onSelect(paper.id)} aria-pressed={selected}>
            {paper.title}
          </button>
        </h4>
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
