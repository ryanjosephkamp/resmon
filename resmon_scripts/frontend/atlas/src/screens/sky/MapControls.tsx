import { useId, useMemo, useState, type KeyboardEvent, type ToggleEvent } from 'react';
import { Icon } from '../../shell/Icon';
import { number } from '../today/format';
import {
  COLOR_WORDS, DEFAULT_VIEW, FIND_MIN, STATE_WORDS, filterCount, shownWords,
  type ColorBy, type Facts, type Look, type MapView, type StateFilter,
} from './look';

interface Props {
  /** Which map: the anchors and ids are kept apart by it. */
  name: 'today' | 'run';
  view: MapView;
  onView: (view: MapView) => void;
  look: Look | null;
  facts: Facts | null;
  facetsError: Error | null;
  /** How many papers are on this map. */
  total: number;
  names: (slug: string) => string;
  find: { typed: string; setTyped: (text: string) => void; finding: boolean; waiting: boolean; error: Error | null };
  /** Where the chosen paper falls among the find's matches: 1 for the first, or 0 when it is not one. */
  findAt: number;
  onStep: (direction: 1 | -1) => void;
  /** The filters were opened: the facets are wanted now, before any is chosen. */
  onWant: () => void;
  /** Why the view just chosen could not be remembered, when it could not. */
  keepError?: Error | null;
}

/**
 * A map's own bar: find a title or an author, filter what is lit, choose what
 * the colors mean, and how many papers that leaves lit. Two menus rather than
 * a panel of controls, so the bar takes one line over the map. The menus are
 * the collection's (native popovers, Escape or a click outside closes them).
 */
export function MapBar(props: Props) {
  const { name, view, onView, look, facts, facetsError, total, names, find, findAt, onStep, onWant, keepError } = props;
  const filters = filterCount(view);
  const findId = useId();
  const onFindKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onStep(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape' && find.typed) {
      event.preventDefault();
      event.stopPropagation();
      find.setTyped('');
    }
  };
  const matches = look?.found.length ?? 0;
  const said = look ? shownWords(look, total, find.finding) : '';
  return (
    <div className="map-bar" role="group" aria-label="Find and filter on the map" data-map={name}>
      <span className="map-find">
        <Icon name="search" size={14} />
        <label className="sr-only" htmlFor={findId}>Find on the map: part of a title or an author</label>
        <input id={findId} type="search" value={find.typed} placeholder="Find a title or author"
          autoComplete="off" spellCheck={false} aria-describedby={`${findId}-said`}
          onChange={(event) => find.setTyped(event.target.value)} onKeyDown={onFindKey} />
        {find.finding && !find.waiting && matches > 0 && (
          <span className="map-find-at num" aria-hidden="true">{findAt > 0 ? `${number(findAt)} of ${number(matches)}` : number(matches)}</span>
        )}
        {find.finding && !find.waiting && matches > 1 && (
          <>
            <button type="button" className="map-find-step" aria-label="Previous match" title="Previous match (Shift+Enter)"
              onClick={() => onStep(-1)}>
              <Icon name="chevron" size={14} />
            </button>
            <button type="button" className="map-find-step next" aria-label="Next match" title="Next match (Enter)"
              onClick={() => onStep(1)}>
              <Icon name="chevron" size={14} />
            </button>
          </>
        )}
      </span>
      <FilterMenu name={name} view={view} onView={onView} facts={facts} facetsError={facetsError} names={names}
        count={filters} onWant={onWant} />
      <ColorMenu name={name} view={view} onView={onView} onWant={onWant} />
      <span className="map-shown" id={`${findId}-said`} role="status" data-shown={look?.shown ?? ''}>
        {keepError ? `Shown, but not remembered: the engine did not store this view (${keepError.message}).`
          : find.error ? `The find could not be run: ${find.error.message}.`
          : find.typed.trim().length > 0 && find.typed.trim().length < FIND_MIN ? 'Type two letters or more to find.'
            : find.waiting ? 'Finding.' : look?.waiting ? 'Reading the filters.' : said}
      </span>
    </div>
  );
}

function FilterMenu({ name, view, onView, facts, facetsError, names, count, onWant }: {
  name: 'today' | 'run'; view: MapView; onView: (view: MapView) => void; facts: Facts | null; facetsError: Error | null;
  names: (slug: string) => string; count: number; onWant: () => void;
}) {
  const id = `${name}-map-filters`;
  const fromId = `${name}-map-from`, toId = `${name}-map-to`, basisId = `${name}-map-dates`;
  const watches = useMemo(() => {
    if (!facts) return [];
    const chosen = new Set(view.watches);
    return facts.watches.filter((w) => w.members.length > 0 || chosen.has(w.id))
      .map((w) => ({ id: w.id, name: w.name, count: w.members.length }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [facts, view.watches]);
  const sources = useMemo(() => {
    if (!facts) return [];
    const counts = new Map<string, number>();
    for (const k of facts.source) {
      const slug = facts.sources[k];
      if (slug !== undefined) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
    for (const slug of view.sources) if (!counts.has(slug)) counts.set(slug, 0);
    return [...counts.entries()].map(([slug, n]) => ({ slug, count: n }))
      .sort((a, b) => b.count - a.count || names(a.slug).localeCompare(names(b.slug)));
  }, [facts, view.sources, names]);
  const toggle = <T,>(list: readonly T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const onToggle = (event: ToggleEvent<HTMLDivElement>) => { if (event.newState === 'open') onWant(); };
  const problem = view.date_from && view.date_to && view.date_from > view.date_to
    ? 'The first day is after the last, so no paper falls between them.' : null;
  return (
    <span className="facet">
      {/* Pointed at or reached by Tab, the menu asks for the facets, so they are often here before it opens. */}
      <button type="button" className="facet-trigger map-facet" data-facet={`${name}-filters`} popoverTarget={id}
        aria-haspopup="dialog" data-chosen={count > 0 || undefined} onPointerEnter={onWant} onFocus={onWant}>
        <Icon name="settings" size={14} />
        Filters
        {count > 0 && <><span className="facet-n num" aria-hidden="true">{count}</span><span className="sr-only">, {count} set</span></>}
        <Icon name="chevron" size={14} />
      </button>
      <div id={id} popover="auto" className="facet-menu map-menu" data-facet={`${name}-filters`} role="dialog"
        aria-label="Filter what is lit on the map" onToggle={onToggle}>
        <div className="map-menu-head">
          <p className="facet-caption">Papers the filters leave out are dimmed, not removed, so the map keeps its shape.</p>
          <button type="button" className="btn sm quiet" disabled={count === 0}
            onClick={() => onView({ ...DEFAULT_VIEW, color: view.color, list_by: view.list_by })}>Clear filters</button>
        </div>
        {facetsError && <p className="facet-caption facet-problem">The engine did not answer ({facetsError.message}).</p>}
        {!facts && !facetsError && <p className="facet-caption">Reading each paper&rsquo;s watches, source, and dates.</p>}
        {facts && (
          <>
            <fieldset className="map-menu-group">
              <legend>Watch</legend>
              {watches.length === 0
                ? <p className="facet-empty">No watch found any paper on this map.</p>
                : (
                  <ul className="facet-list">
                    {watches.map((w) => (
                      <li key={w.id}>
                        <label className="facet-option">
                          <input type="checkbox" checked={view.watches.includes(w.id)}
                            onChange={() => onView({ ...view, watches: toggle(view.watches, w.id) })} />
                          <span className="facet-name">{w.name}</span>
                          <span className="facet-count num">{number(w.count)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
            </fieldset>
            <fieldset className="map-menu-group">
              <legend>Source</legend>
              <ul className="facet-list">
                {sources.map((s) => (
                  <li key={s.slug}>
                    <label className="facet-option">
                      <input type="checkbox" checked={view.sources.includes(s.slug)}
                        onChange={() => onView({ ...view, sources: toggle(view.sources, s.slug) })} />
                      <span className="facet-name">{names(s.slug)}</span>
                      <span className="facet-count num">{number(s.count)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <fieldset className="map-menu-group map-menu-dates">
              <legend>Dates</legend>
              <div className="map-menu-row">
                <label htmlFor={basisId}>Read</label>
                <select id={basisId} value={view.dates}
                  onChange={(event) => onView({ ...view, dates: event.target.value as MapView['dates'] })}>
                  <option value="found">when resmon found it</option>
                  <option value="published">when it was published</option>
                </select>
              </div>
              <div className="map-menu-row">
                <label htmlFor={fromId}>From</label>
                <input id={fromId} type="date" value={view.date_from ?? ''}
                  onChange={(event) => onView({ ...view, date_from: event.target.value || null })} />
              </div>
              <div className="map-menu-row">
                <label htmlFor={toId}>Through</label>
                <input id={toId} type="date" value={view.date_to ?? ''}
                  onChange={(event) => onView({ ...view, date_to: event.target.value || null })} />
              </div>
              <p className="facet-caption">
                {view.dates === 'published'
                  ? 'By the date each source recorded; a year or a month alone counts from its first day. A paper with no publication date is dimmed once either day is set.'
                  : 'By the day resmon first collected each paper, on this computer’s clock.'}
              </p>
              {problem && <p className="facet-caption facet-problem" role="status">{problem}</p>}
            </fieldset>
            <fieldset className="map-menu-group">
              <legend>Your reading</legend>
              <ul className="facet-list">
                {(Object.keys(STATE_WORDS) as StateFilter[]).map((state) => (
                  <li key={state}>
                    <label className="facet-option">
                      <input type="radio" name={`${name}-map-state`} checked={view.state === state}
                        onChange={() => onView({ ...view, state })} />
                      <span className="facet-name">
                        {state === 'new' && facts.window === 'first_look' ? 'New this week (nothing marked read yet)' : STATE_WORDS[state]}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          </>
        )}
      </div>
    </span>
  );
}

function ColorMenu({ name, view, onView, onWant }: {
  name: 'today' | 'run'; view: MapView; onView: (view: MapView) => void; onWant: () => void;
}) {
  const id = `${name}-map-colors`;
  // The choice drawn is held here as it is made, so the radio never shows the stored one mid-change.
  const [shown, setShown] = useState<ColorBy | null>(null);
  const current = shown ?? view.color;
  if (shown !== null && shown === view.color) setShown(null);
  const hints: Record<ColorBy, string> = {
    region: 'One ink; the regions are where papers gather and their names.',
    watch: 'The four watches with the most papers here, each its own color.',
    source: 'The four sources with the most papers here, each its own color.',
    age: 'How long ago resmon collected each paper.',
  };
  return (
    <span className="facet">
      <button type="button" className="facet-trigger map-facet" data-facet={`${name}-colors`} popoverTarget={id}
        aria-haspopup="dialog" onPointerEnter={onWant} onFocus={onWant}>
        <span className="map-facet-label">Color</span>
        <span className="map-facet-value">{COLOR_WORDS[current]}</span>
        <Icon name="chevron" size={14} />
      </button>
      <div id={id} popover="auto" className="facet-menu map-menu map-colors" data-facet={`${name}-colors`} role="dialog"
        aria-label="Color the papers by">
        <fieldset className="map-menu-group">
          <legend>Color the papers by</legend>
          <ul className="facet-list">
            {(Object.keys(COLOR_WORDS) as ColorBy[]).map((color) => (
              <li key={color}>
                <label className="facet-option map-color-option">
                  <input type="radio" name={`${name}-map-color`} checked={current === color}
                    onChange={() => { setShown(color); onView({ ...view, color }); }} />
                  <span className="facet-name">{COLOR_WORDS[color]}</span>
                  <span className="map-color-hint">{hints[color]}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      </div>
    </span>
  );
}

/** What the colors mean, each with how many lit papers wear it; null while the papers wear one ink. */
export function ColorKey({ look }: { look: Look | null }) {
  if (!look || look.legend.length === 0) return null;
  return (
    <span className="plate-key-colors">
      {look.legend.map((entry) => (
        <span key={entry.key} className="plate-key-item map-key-entry" data-key={entry.key}>
          <svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill={entry.color} /></svg>
          {entry.label}
          <span className="map-key-n num">{number(entry.count)}</span>
        </span>
      ))}
    </span>
  );
}

/** What a dimmed paper is, while some are. */
export function DimKey({ look, finding, filtered }: { look: Look | null; finding: boolean; filtered: boolean }) {
  if (!look?.lit) return null;
  const why = finding && filtered ? 'left out by the find or the filters' : finding ? 'not matching the find' : 'left out by the filters';
  return (
    <span className="plate-key-item" data-key="dimmed">
      <svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="2" fill="var(--dim-mark)" /></svg>
      {why}
    </span>
  );
}
