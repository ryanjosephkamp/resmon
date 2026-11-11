import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { bridge, systemName } from '../../bridge';
import { count, listWords, when } from '../today/format';
import {
  kindOf, LIBRARY, LIBRARY_KEY, download, retryLibrary, sizeWords, unsupportedWords, type LibraryRemovedFile, type LibraryStatus,
} from '../library/libraryApi';
import { TROUBLE } from '../library/VaultPanels';

function words(error: unknown): string {
  if (error instanceof EngineError && error.detail) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

const REMOVED_KEY = ['library-removed'] as const;

/**
 * Settings › Library: where the Library folder is, changing it, the removed
 * files it still holds, and an inventory of what it keeps.
 *
 * Change folder does two different things and says which: pointing at the
 * folder where it is now (after it was moved in the Finder, or its disk was
 * mounted under another name) changes nothing in it; moving it puts the
 * folder somewhere else, by one rename on the same disk, or by a checked copy
 * across disks that leaves the old folder for you to delete.
 */
export function LibrarySettings() {
  const status = useQuery({
    queryKey: LIBRARY_KEY, queryFn: () => answer(engine().GET('/api/library', LIBRARY)), retry: retryLibrary,
    // While the engine says the folder is being moved or checked, it is asked again each second, so a page
    // opened in the middle of a move, or come back to, knows when it has finished.
    refetchInterval: (query) => (query.state.data?.changing ? 1000 : false),
  });
  const data = status.data;
  const unsupported = unsupportedWords(status.error);
  return (
    <section className="settings-group lib-settings" aria-labelledby="library-settings-title" aria-busy={status.isFetching}>
      <h2 id="library-settings-title" className="group-title">Library</h2>
      <p className="group-lede">
        The folder that keeps your PDFs and text files. Your reading queue and Evidence’s records live in resmon’s database;
        the files themselves live here.
      </p>
      {unsupported && <p className="field-error" role="alert">{unsupported}</p>}
      {status.isError && !unsupported && <p className="field-error" role="alert">The engine did not answer ({words(status.error)}).</p>}
      {data && !data.vault && (
        <p className="field-lede">No Library folder yet. <Link to="/library?show=files">Make one under Library › Your Files</Link>.</p>
      )}
      {data?.vault && <Folder status={data} />}
      {data?.vault && data.status === 'ready' && <Removed vault={data.vault.vault_id} />}
      {data?.vault && data.status === 'ready' && <Inventory vault={data.vault.vault_id} />}
      <Downloads />
    </section>
  );
}

/**
 * Get the PDF's rules, as the engine states them: where the PDFs go, the
 * license rule, the sources never downloaded from, and the limits.
 */
function Downloads() {
  const rules = useQuery({ queryKey: ['full-text-rules'], staleTime: Infinity, queryFn: () => answer(engine().GET('/api/full-text/rules')) });
  const data = rules.data;
  return (
    <div className="lib-downloads" data-library="downloads">
      <h3 className="field-title">Downloads</h3>
      <p className="field-lede">
        Get the PDF, on a paper’s page and on its card, and a watch’s PDFs switch download open-access copies into this
        folder, linked to their paper, with where each came from, its license, and when.
      </p>
      {rules.isError && <p className="field-error" role="alert">The engine did not say its rules ({words(rules.error)}).</p>}
      {data && (
        <ul className="lib-rules">
          <li>Only a copy a source states an open license for: {listWords(data.open_licenses.map((l) => l.words))}.
            A copy that is only free to read, or under a publisher’s own terms, is left at the source.</li>
          <li>Never from {listWords(data.refused_sources.map((s) => s.name))}, or from Crossref’s text-mining links,
            whatever the license: {[...new Set(data.refused_sources.map((s) => s.why))].join(' ')}</li>
          <li>Over https only, to public addresses, every redirect checked; a file must be a PDF and at most{' '}
            {sizeWords(data.max_bytes)}.</li>
          <li>One download at a time from each site, {data.host_interval_seconds} seconds apart; at most{' '}
            {count(data.per_run_cap, 'PDF')} for one watch run, and {count(data.daily_cap, 'PDF')} in any 24 hours.</li>
        </ul>
      )}
    </div>
  );
}

/** Where the folder is, and the two ways to change it; both wait while either runs, here or as the engine reports. */
export function Folder({ status }: { status: LibraryStatus }) {
  const client = useQueryClient();
  const vault = status.vault!;
  const chooser = bridge()?.chooseDirectory;
  const [said, setSaid] = useState<string | null>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: LIBRARY_KEY });
    void client.invalidateQueries({ queryKey: ['library-files'] });
    void client.invalidateQueries({ queryKey: ['library-file'] });
    void client.invalidateQueries({ queryKey: REMOVED_KEY });
  };
  const relink = useMutation({
    mutationFn: async () => {
      const folder = await chooser?.(status.vault?.path);
      if (!folder) return null;
      return answer(engine().POST('/api/library/vault/relink', { ...LIBRARY, body: { expected_vault_id: vault.vault_id, folder } }));
    },
    onMutate: () => setSaid(null),
    onSuccess: (found) => { if (found) { setSaid(`The Library folder is recorded at ${found.vault?.path}. Nothing in it was changed.`); refresh(); } },
  });
  const move = useMutation({
    mutationFn: async () => {
      const parent = await chooser?.();
      if (!parent) return null;
      return answer(engine().POST('/api/library/vault/move', { ...LIBRARY, body: { expected_vault_id: vault.vault_id, parent_directory: parent } }));
    },
    onMutate: () => setSaid(null),
    onSuccess: (moved) => {
      if (!moved) return;
      setSaid(moved.moved.same_disk
        ? `Moved to ${moved.moved.path}.`
        : `Copied to ${moved.moved.path}, every file checked against its recorded hash. The old folder is still at ${moved.moved.old_folder_kept}; delete it when you are sure.`);
      refresh();
    },
  });
  const reveal = () => { if (status.vault?.path) void bridge()?.revealPath?.(status.vault.path); };
  const ready = status.status === 'ready';
  // The engine's word, not this page's: a move started before this page was opened is still a move.
  const moving = move.isPending || status.changing === 'moving';
  const relinking = relink.isPending || status.changing === 'relinking';
  const working = moving || relinking;
  return (
    <div className="lib-folder" data-library="folder" data-status={status.status}>
      <h3 className="field-title">Where the Folder Is</h3>
      <p className="lib-folder-path"><code className="path" data-library="path">{vault.path}</code></p>
      <p className="field-lede">
        {status.changing === 'moving'
          ? <>The Library folder is being moved. This page shows where it is once the move has finished.</>
          : ready
          ? <>{count(status.counts.items, 'file')}, {sizeWords(status.counts.retained_bytes)} recorded{status.counts.missing ? <>; {count(status.counts.missing, 'file')} not in the folder now</> : null}.</>
          : status.status === 'missing'
            ? <>Nothing is at that path now. If the folder is on a disk that is not connected, connect it. If you moved or renamed it, choose where it is now.</>
            : <>{TROUBLE[status.status] ?? `The Library reports “${status.status}”.`}</>}
      </p>
      <div className="form-actions">
        <button type="button" className="btn" disabled={!chooser || working} onClick={() => relink.mutate()}>
          {relinking ? 'Checking the Folder' : 'Choose Where It Is Now'}
        </button>
        <button type="button" className="btn" disabled={!chooser || !ready || working} onClick={() => move.mutate()}>
          {moving ? 'Moving the Files' : 'Move It to Another Folder'}
        </button>
        {ready && <button type="button" className="btn quiet" onClick={reveal}>Show in {systemName() === 'macOS' ? 'Finder' : 'Its Folder'}</button>}
      </div>
      <p className="form-hint">
        Choose where it is now after moving the folder yourself: resmon checks that it is this Library’s folder and changes nothing in it.
        Move it to another folder moves the files for you, keeping the folder’s name; across disks the files are copied and checked, and
        the old folder is left where it was.
      </p>
      {said && <p className="settings-said" role="status" data-library="folder-said">{said}</p>}
      {(relink.error || move.error) && <p className="field-error" role="alert">{words(relink.error ?? move.error)}</p>}
    </div>
  );
}


/**
 * The files removed from the Library, held in its folder's `removed` folder
 * until they are put back or sent to the Trash. Nothing is deleted by resmon:
 * Move to the Trash hands the file to the system's Trash, from which it can
 * still be put back in the Finder.
 */
function Removed({ vault }: { vault: string }) {
  const client = useQueryClient();
  const removed = useQuery({
    queryKey: [...REMOVED_KEY, vault],
    queryFn: () => answer(engine().GET('/api/library/removed', { ...LIBRARY, params: { query: { expected_vault_id: vault } } })),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: REMOVED_KEY });
    void client.invalidateQueries({ queryKey: LIBRARY_KEY });
    void client.invalidateQueries({ queryKey: ['library-files'] });
    void client.invalidateQueries({ queryKey: ['evidence-projects'] });
  };
  const restore = useMutation({
    mutationFn: (file: LibraryRemovedFile) => answer(engine().POST('/api/library/removed/{file_id}/restore', {
      ...LIBRARY, params: { path: { file_id: file.file_id } }, body: { expected_vault_id: vault },
    })),
    onSuccess: refresh,
  });
  const trash = useMutation({
    mutationFn: async (file: LibraryRemovedFile) => {
      if (file.bytes === 'held') {
        const trashItem = bridge()?.trashPath;
        if (!trashItem) throw new Error('Moving a file to the Trash needs the desktop app.');
        const released = await answer(engine().POST('/api/library/removed/{file_id}/release', {
          ...LIBRARY, params: { path: { file_id: file.file_id } }, body: { expected_vault_id: vault },
        }));
        const failed = await trashItem(released.path);
        if (failed) throw new Error(failed);
      }
      await answer(engine().DELETE('/api/library/removed/{file_id}', {
        ...LIBRARY, params: { path: { file_id: file.file_id } }, body: { expected_vault_id: vault },
      }));
    },
    onSuccess: refresh,
  });
  const list = removed.data?.removed ?? [];
  return (
    <div className="lib-removed" data-library="removed">
      <h3 className="field-title">Removed Files</h3>
      <p className="field-lede">
        {list.length
          ? <>{count(list.length, 'file')} removed from the Library{removed.data?.bytes ? `, ${sizeWords(removed.data.bytes)} still held in its folder` : ''}. Put one back, or move it to the Trash.</>
          : 'Nothing removed is held. A file you remove is kept here until you put it back or move it to the Trash.'}
      </p>
      {list.length > 0 && (
        <ul className="lib-removed-list">
          {list.map((file) => (
            <li key={file.file_id} data-file={file.file_id} data-bytes={file.bytes}>
              <div>
                <p className="lib-removed-name">{file.original_name}</p>
                <p className="meta">
                  <span>{kindOf(file.media_type)}</span><span className="sep" /><span>{sizeWords(file.byte_size)}</span>
                  <span className="sep" /><span>removed {when(file.removed_at_utc, new Date())}</span>
                  {(file.notes > 0 || file.projects.length > 0) && (<><span className="sep" /><span>with {[...(file.projects.length ? [count(file.projects.length, 'project')] : []), ...(file.notes ? [count(file.notes, 'note')] : [])].join(' and ')}</span></>)}
                </p>
                {file.bytes !== 'held' && (
                  <p className="form-hint">{file.bytes === 'gone' ? 'Its bytes are no longer in the removed folder, so it cannot be put back.' : 'It was not in the Library folder when it was removed; only its record is kept.'}</p>
                )}
              </div>
              <div className="form-actions">
                <button type="button" className="btn sm" disabled={file.bytes === 'gone' || restore.isPending} onClick={() => restore.mutate(file)}>Put Back</button>
                <button type="button" className="btn quiet sm" disabled={trash.isPending} onClick={() => trash.mutate(file)}>
                  {file.bytes === 'held' ? 'Move to the Trash' : 'Forget It'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {(restore.error || trash.error || removed.error) && <p className="field-error" role="alert">{words(restore.error ?? trash.error ?? removed.error)}</p>}
    </div>
  );
}

function Inventory({ vault }: { vault: string }) {
  const inventory = useMutation({
    mutationFn: () => answer(engine().GET('/api/library/export', { ...LIBRARY, params: { query: { expected_vault_id: vault, format: 'json' } } })),
    onSuccess: (doc) => download(doc.text, doc.filename, doc.content_type),
  });
  return (
    <div className="lib-inventory">
      <h3 className="field-title">An Inventory</h3>
      <p className="field-lede">A JSON list of what the database records about each kept file: names, kinds, sizes, hashes, and links. It is not a copy of the files.</p>
      <div className="form-actions"><button type="button" className="btn" disabled={inventory.isPending} onClick={() => inventory.mutate()}>Save an Inventory</button></div>
      {inventory.error && <p className="field-error" role="alert">{words(inventory.error)}</p>}
    </div>
  );
}
