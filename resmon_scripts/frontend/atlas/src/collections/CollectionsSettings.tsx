import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { answer, engine, engineSentence } from '../api/client';
import { number } from '../screens/today/format';
import { invalidateFor } from '../screens/today/freshness';
import { invalidateCollections, useCollection, type CollectionSummary } from './current';
import { papersWords } from './papers';
import './collections.css';

function words(error: unknown): string {
  return engineSentence(error) ?? (error instanceof Error ? error.message : String(error));
}

const watchesWords = (n: number) => `${number(n)} ${n === 1 ? 'watch' : 'watches'}`;

/**
 * Settings › Collections: make one, rename one, show one, and delete one.
 *
 * Each collection is its own Search › Your collection, Today, map, and
 * Analytics; a paper is stored once and can be in more than one. Deleting a
 * collection asks first when it holds papers or a watch puts papers there, and
 * says what happens to each: a paper only it held is kept in the default
 * collection, one also elsewhere stays there, and its watches put their papers
 * in the default collection. No paper leaves the database. The default
 * collection can be renamed and never deleted.
 */
export function CollectionsSettings() {
  const current = useCollection();
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [said, setSaid] = useState<string | null>(null);
  const [name, setName] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const create = (location.state as { create?: boolean } | null)?.create === true;
  useEffect(() => {
    if (!create) return;
    field.current?.focus();
    void navigate(location.pathname, { replace: true, state: null });
  }, [create, navigate, location.pathname]);

  const make = useMutation({
    mutationFn: (asked: string) => answer(engine().POST('/api/collections', { body: { name: asked } })),
    onMutate: () => setSaid(null),
    onSuccess: (made) => {
      setName('');
      setSaid(`Made ${made.name}. Its papers arrive from the runs and watches you start in it, and the ones you move or copy there.`);
      void invalidateCollections(client);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) make.mutate(name.trim());
  };

  return (
    <section className="settings-group" aria-labelledby="collections-title" data-settings="collections">
      <h2 id="collections-title" className="group-title">Collections</h2>
      <p className="group-lede">
        Each collection has its own Search › Your collection, Today, map, and Analytics, so a field can be read on its own.
        A paper is stored once and can be in more than one. Watches, Deep Dives, and Deep Sweeps put their papers in the
        collection they name; moving or copying papers, or deleting a collection, never deletes a paper.
      </p>
      <form className="collection-form collection-make" onSubmit={submit} aria-label="Make a collection">
        <label className="sr-only" htmlFor="collection-name">Name of the new collection</label>
        <input id="collection-name" ref={field} value={name} maxLength={80} autoComplete="off" spellCheck={false}
          placeholder="A name, such as Fluid dynamics" onChange={(event) => setName(event.target.value)} />
        <button type="submit" className="btn primary" disabled={!name.trim() || make.isPending}>
          {make.isPending ? 'Making' : 'Make collection'}
        </button>
      </form>
      {make.error && <p className="field-error" role="alert">{words(make.error)}</p>}
      {said && <p className="settings-said" role="status">{said}</p>}
      {current.error && <p className="field-error" role="alert">The collections could not be read ({words(current.error)}).</p>}
      <ul className="collection-rows" aria-label="Collections">
        {current.list.map((collection) => (
          <CollectionRow key={collection.id} collection={collection} shown={collection.id === current.id}
            defaultName={current.list.find((c) => c.is_default)?.name ?? 'the default collection'}
            onSay={setSaid} />
        ))}
      </ul>
    </section>
  );
}

function CollectionRow({ collection, shown, defaultName, onSay }: {
  collection: CollectionSummary; shown: boolean; defaultName: string; onSay: (said: string | null) => void;
}) {
  const current = useCollection();
  const client = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(collection.name);
  const [asking, setAsking] = useState(false);
  const detail = useQuery({
    queryKey: ['collection', collection.id], enabled: asking,
    queryFn: () => answer(engine().GET('/api/collections/{collection_id}', { params: { path: { collection_id: collection.id } } })),
  });
  const rename = useMutation({
    mutationFn: (name: string) => answer(engine().PUT('/api/collections/{collection_id}', {
      params: { path: { collection_id: collection.id } }, body: { name },
    })),
    onSuccess: (renamed) => { setRenaming(false); onSay(`Renamed to ${renamed.name}.`); void invalidateCollections(client); },
  });
  const remove = useMutation({
    mutationFn: () => answer(engine().DELETE('/api/collections/{collection_id}', { params: { path: { collection_id: collection.id } } })),
    onSuccess: (gone) => {
      setAsking(false);
      const parts = [`Deleted ${gone.name}.`];
      if (gone.kept_in_default) parts.push(`${papersWords(gone.kept_in_default)} only it held ${gone.kept_in_default === 1 ? 'is' : 'are'} kept in ${defaultName}.`);
      if (gone.still_elsewhere) parts.push(`${papersWords(gone.still_elsewhere)} ${gone.still_elsewhere === 1 ? 'stays in the other collection it is' : 'stay in the other collections they are'} in.`);
      if (gone.watches_moved) parts.push(`${watchesWords(gone.watches_moved)} now put${gone.watches_moved === 1 ? 's' : ''} papers in ${defaultName}.`);
      onSay(parts.join(' '));
      void invalidateCollections(client);
      void invalidateFor(client, 'watch-changed');
    },
  });
  const busy = rename.isPending || remove.isPending || current.switching;
  return (
    <li className="collection-row" data-collection-row={collection.id}>
      {renaming ? (
        <form className="collection-form" aria-label={`Rename ${collection.name}`}
          onSubmit={(event) => { event.preventDefault(); if (draft.trim()) rename.mutate(draft.trim()); }}>
          <label className="sr-only" htmlFor={`collection-rename-${collection.id}`}>New name for {collection.name}</label>
          <input id={`collection-rename-${collection.id}`} value={draft} maxLength={80} autoFocus autoComplete="off"
            spellCheck={false} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { setRenaming(false); setDraft(collection.name); } }} />
          <button type="submit" className="btn sm primary" disabled={!draft.trim() || busy}>Save</button>
          <button type="button" className="btn sm quiet" onClick={() => { setRenaming(false); setDraft(collection.name); }}>Cancel</button>
        </form>
      ) : (
        <div className="collection-head">
          <span className="name">{collection.name}</span>
          <span className="collection-facts">
            {papersWords(collection.papers)} · {watchesWords(collection.watches)}
            {shown && ' · shown here'}{collection.is_default && ' · the default'}
          </span>
          <span className="collection-acts">
            {!shown && (
              <button type="button" className="btn sm" disabled={busy} onClick={() => void current.switchTo(collection.id)}>Show</button>
            )}
            <button type="button" className="btn sm quiet" disabled={busy}
              onClick={() => { onSay(null); setDraft(collection.name); setRenaming(true); }}>Rename</button>
            {!collection.is_default && !asking && (
              <button type="button" className="btn sm danger" disabled={busy} aria-label={`Delete ${collection.name}`}
                onClick={() => { onSay(null); setAsking(true); }}>Delete…</button>
            )}
          </span>
        </div>
      )}
      {rename.error && <p className="field-error" role="alert">{words(rename.error)}</p>}
      {collection.is_default && (
        <p className="field-lede">The default collection is never deleted: a paper in no other collection is kept here, and a
          read or a run that names no collection uses it.</p>
      )}
      {asking && (
        <div className="collection-ask" role="group" aria-label={`Delete ${collection.name}?`} data-collection="ask">
          {detail.isPending && <p>Reading what {collection.name} holds.</p>}
          {detail.isError && <p className="field-error" role="alert">{words(detail.error)}</p>}
          {detail.data && (
            detail.data.papers === 0 && detail.data.watch_list.length === 0
              ? <p>Delete {collection.name}? It holds no papers, and no watch puts papers there.</p>
              : (
                <>
                  <p>Delete {collection.name}? No paper leaves resmon:</p>
                  <ul>
                    {detail.data.only_here > 0 && (
                      <li>{papersWords(detail.data.only_here)} {detail.data.only_here === 1 ? 'is' : 'are'} in no other collection, and will be kept in {defaultName}.</li>
                    )}
                    {detail.data.also_elsewhere > 0 && (
                      <li>{papersWords(detail.data.also_elsewhere)} {detail.data.also_elsewhere === 1 ? 'is' : 'are'} also in another collection, and will stay there.</li>
                    )}
                    {detail.data.watch_list.length > 0 && (
                      <li>{detail.data.watch_list.map((w) => w.name).join(', ')} will put {detail.data.watch_list.length === 1 ? 'its' : 'their'} papers
                        in {defaultName}.</li>
                    )}
                  </ul>
                </>
              )
          )}
          <div className="form-actions">
            <button type="button" className="btn danger" disabled={!detail.data || busy} onClick={() => remove.mutate()}>
              {remove.isPending ? 'Deleting' : `Delete ${collection.name}`}
            </button>
            <button type="button" className="btn quiet" onClick={() => setAsking(false)}>Keep it</button>
          </div>
          {remove.error && <p className="field-error" role="alert">{words(remove.error)}</p>}
        </div>
      )}
    </li>
  );
}
