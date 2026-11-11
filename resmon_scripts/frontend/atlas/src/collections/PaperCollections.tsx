import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { components } from '../api/schema';
import { when } from '../screens/today/format';
import { useCollection } from './current';
import { MoveCopy } from './MoveCopy';
import './collections.css';

type PaperCollection = components['schemas']['PaperCollection'];

/** How a paper arrived in a collection, in the words a paper's page uses. */
export function arrivalWords(c: PaperCollection, now: Date): string {
  const at = when(c.added_at, now);
  switch (c.added_by) {
    case 'run': return c.execution_id ? `found by run ${c.execution_id}, ${at}` : `found by a run, ${at}`;
    case 'move': return `moved here ${at}`;
    case 'copy': return `copied here ${at}`;
    case 'upgrade': return `here since before collections, first collected ${at}`;
    case 'kept': return `kept here ${at}, when the collection it was in was deleted`;
    default: return at;
  }
}

/**
 * The collections one paper is in, how it arrived in each, and Move to or Copy
 * to another. A move takes it out of the collection this window shows, so it
 * is offered only when the paper is in that one; a copy is offered to the
 * collections that do not hold it yet.
 */
export function PaperCollections({ paper, collections }: { paper: number; collections: readonly PaperCollection[] }) {
  const current = useCollection();
  const [now] = useState(() => new Date());
  const here = collections.some((c) => c.id === current.id);
  const n = collections.length;
  return (
    <section className="paper-section paper-collections" aria-label="Collections" data-paper="collections">
      <h2>{n === 1 ? 'In One Collection' : `In ${n} Collections`}</h2>
      <ul>
        {collections.map((c) => (
          <li key={c.id} data-collection={c.id}>
            <span className="name" data-shown={c.id === current.id}>{c.name}</span>
            <span>
              {c.added_by === 'run' && c.execution_id
                ? <>found by <Link to={`/runs/${c.execution_id}`}>run {c.execution_id}</Link>, {when(c.added_at, now)}</>
                : arrivalWords(c, now)}
            </span>
          </li>
        ))}
      </ul>
      {!here && current.name && (
        <p className="field-lede">Not in {current.name}, the collection this window shows. Copy it there to see it on its Search, Today, and map.</p>
      )}
      <MoveCopy which={{ ids: [paper] }} from={here ? current.id : null} count={1} canMove={here}
        skip={collections.map((c) => c.id)} size="sm" />
    </section>
  );
}
