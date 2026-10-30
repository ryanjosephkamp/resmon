import { useEffect, useEffectEvent, useState, type ToggleEvent } from 'react';
import { Icon } from '../../shell/Icon';
import { number } from '../today/format';
import {
  chosenIn, dateRangeProblem, facetCaption, facetRows, othersSet,
  type DateKey, type FacetKey, type Facets, type Filters,
} from './filters';

/** The menu that is open: a group of values, or the publication dates. */
export type Menu = FacetKey | 'published';

const GROUPS: readonly { key: FacetKey; label: string; field: keyof Omit<Facets, 'max_values'>; singular: string }[] = [
  { key: 'source', label: 'Source', field: 'sources', singular: 'a source' },
  { key: 'category', label: 'Category', field: 'categories', singular: 'a category' },
  { key: 'author', label: 'Author', field: 'authors', singular: 'an author' },
];

/** How long a date being typed waits before it narrows the list, as the search box does. */
const SETTLE_MS = 350;

interface Props {
  filters: Filters;
  /** The engine's counts for the filters as they stand; asked for only while a group's menu is open. */
  facets: { data: Facets | undefined; error: Error | null; busy: boolean; stale: boolean };
  /** Whether the search box's words narrow the collection (they do not when it is ranked by meaning). */
  words: boolean;
  nameOf: (slug: string) => string;
  onMenu: (menu: Menu, open: boolean) => void;
  onToggle: (key: FacetKey, value: string) => void;
  onDate: (key: DateKey, value: string) => void;
}

/**
 * The collection's filters, one menu per group: every value the engine
 * counts, with its number, ticked to narrow the list. Each menu says what its
 * numbers count. The dates are a menu of their own; the engine counts no
 * values for them, and the count above the list moves as they change.
 *
 * Native popovers: one open at a time, closed by Escape or a click outside,
 * and drawn above the list rather than pushing it down.
 */
export function FacetMenus({ filters, facets, words, nameOf, onMenu, onToggle, onDate }: Props) {
  const toggle = (menu: Menu) => (event: ToggleEvent<HTMLDivElement>) => onMenu(menu, event.newState === 'open');
  const dates = (filters.from ? 1 : 0) + (filters.to ? 1 : 0);
  const problem = dateRangeProblem(filters);
  return (
    <div className="facet-bar" role="group" aria-label="Narrow the collection">
      {GROUPS.map((group) => {
        const chosen = chosenIn(filters, group.key);
        const id = `collection-facet-${group.key}`;
        const listed = facets.data?.[group.field] ?? [];
        const rows = facets.data ? facetRows(listed, chosen, facets.data.max_values) : [];
        const scope = { words, others: othersSet(filters, group.key) };
        return (
          <span key={group.key} className="facet">
            <Trigger menu={group.key} target={id} label={group.label} chosen={chosen.length} />
            <div id={id} popover="auto" className="facet-menu" data-facet={group.key} role="dialog"
              aria-label={`Filter by ${group.label.toLowerCase()}`} aria-busy={facets.busy} onToggle={toggle(group.key)}>
              {facets.error ? (
                <p className="facet-caption">The engine did not count these ({facets.error.message}).</p>
              ) : !facets.data ? (
                <p className="facet-caption">Counting.</p>
              ) : (
                <>
                  <p className="facet-caption">{facetCaption(group.key, scope, listed.length, facets.data.max_values)}</p>
                  {rows.length === 0 && (
                    <p className="facet-empty">
                      No paper {scope.words || scope.others ? 'that matches' : 'in your collection'} has {group.singular} recorded.
                    </p>
                  )}
                  <ul className="facet-list" data-stale={facets.stale || undefined}>
                    {rows.map((row) => (
                      <li key={row.value} data-value={row.value}>
                        <label className="facet-option">
                          <input type="checkbox" checked={row.chosen} onChange={() => onToggle(group.key, row.value)} />
                          <span className="facet-name">{group.key === 'source' ? nameOf(row.value) : row.value}</span>
                          {row.count === null
                            ? <span className="facet-count uncounted" title="Not among the values the engine listed, so not counted">not counted</span>
                            : <span className="facet-count num">{number(row.count)}</span>}
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </span>
        );
      })}
      <span className="facet">
        <Trigger menu="published" target="collection-facet-published" label="Published" chosen={dates} />
        <div id="collection-facet-published" popover="auto" className="facet-menu facet-dates" data-facet="published"
          role="dialog" aria-label="Filter by publication date" onToggle={toggle('published')}>
          <p className="facet-caption">
            Papers published on or between these days, by the date each source recorded. A paper with no
            publication date is left out once either day is set.
          </p>
          <div className="facet-date-fields">
            <DateField id="collection-from" label="From" value={filters.from} onCommit={(v) => onDate('from', v)} />
            <DateField id="collection-to" label="Through" value={filters.to} onCommit={(v) => onDate('to', v)} />
          </div>
          {problem && <p className="facet-caption facet-problem" role="status">{problem}</p>}
        </div>
      </span>
    </div>
  );
}

function Trigger({ menu, target, label, chosen }: { menu: Menu; target: string; label: string; chosen: number }) {
  return (
    <button type="button" className="facet-trigger" data-facet={menu} popoverTarget={target} aria-haspopup="dialog"
      data-chosen={chosen > 0 || undefined}>
      {label}
      {chosen > 0 && <><span className="facet-n num" aria-hidden="true">{chosen}</span><span className="sr-only">, {chosen} chosen</span></>}
      <Icon name="chevron" size={14} />
    </button>
  );
}

/**
 * A day typed into a date field is held here until it settles, so typing a
 * year digit by digit does not search the collection for the years 2, 20, and
 * 202 on the way. The address stays the record; a chip taking the date off
 * clears the field.
 */
function DateField({ id, label, value, onCommit }: { id: string; label: string; value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [held, setHeld] = useState(value);
  if (value !== held) {
    setHeld(value);
    setDraft(value);
  }
  const commit = useEffectEvent(onCommit);
  useEffect(() => {
    if (draft === value) return undefined;
    const settle = setTimeout(() => commit(draft), SETTLE_MS);
    return () => clearTimeout(settle);
  }, [draft, value]);
  return (
    <label className="date" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="date" value={draft} onChange={(event) => setDraft(event.target.value)}
        onBlur={() => { if (draft !== value) onCommit(draft); }} />
    </label>
  );
}
