import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { bridge } from '../../bridge';
import { errorWords } from './Cards';
import { LIBRARY, LIBRARY_KEY, sizeWords, type LibraryStatus } from './libraryApi';

/** The engine's words for a Library folder it cannot use, by the status it reported. */
export const TROUBLE: Record<string, string> = {
  busy: 'Another import into this Library is still finishing. Try again in a moment.',
  mismatch: 'The Library folder on disk is not the one this database recorded, so nothing is read from it.',
  needs_attention: 'The Library folder holds something resmon did not put there, so it keeps nothing new until that is sorted out.',
  unavailable: 'The Library folder cannot be read: the disk may be disconnected, or the folder’s permissions changed.',
};

/**
 * The Library folder, made the first time. resmon makes one new folder inside
 * the one chosen, `resmon-library-…`, holding `vault.json` and `files`; nothing
 * is uploaded anywhere.
 */
export function VaultSetup({ limits }: { limits: LibraryStatus['limits'] }) {
  const client = useQueryClient();
  const [parent, setParent] = useState<string | null>(null);
  const chooser = bridge()?.chooseDirectory;
  const create = useMutation({
    mutationFn: (dir: string) => answer(engine().POST('/api/library/vault', { ...LIBRARY, body: { parent_directory: dir } })),
    onSuccess: (made) => { client.setQueryData(LIBRARY_KEY, made); void client.invalidateQueries({ queryKey: ['evidence-projects'] }); },
  });
  return (
    <section className="library-setup lib-setup" data-library="setup">
      <h2>Keep your own files here</h2>
      <p className="page-lede">
        resmon can keep copies of PDFs and text files you give it, in a folder of yours. It makes one new folder inside
        the one you choose, named <code className="path">resmon-library-…</code>, holding <code className="path">vault.json</code> and
        a <code className="path">files</code> folder. Nothing is uploaded anywhere.
      </p>
      <ul className="setup-facts">
        <li>PDF, TXT, MD, and TeX, up to {sizeWords(limits.file_bytes)} a file, as many as the disk holds.</li>
        <li>Each file is kept exactly as given, under an id of its own; importing the same bytes again reuses that copy.</li>
      </ul>
      <div className="setup-row">
        <button type="button" className="btn" disabled={!chooser} onClick={async () => {
          const chosen = await chooser?.();
          if (chosen) { setParent(chosen); create.reset(); }
        }}>
          Choose parent folder
        </button>
        {parent && <code className="path" data-library="parent">{parent}</code>}
      </div>
      {!chooser && <p className="form-hint">Choosing a folder needs the desktop app.</p>}
      <button type="button" className="btn primary" disabled={!parent || create.isPending} onClick={() => parent && create.mutate(parent)}>
        {create.isPending ? 'Making the folder' : 'Create the library here'}
      </button>
      {create.error && <p className="field-error" role="alert">{errorWords(create.error)}</p>}
    </section>
  );
}

/**
 * A Library folder resmon cannot use now. A folder that is not where it was
 * recorded (moved in the Finder, renamed, or on a disk not connected) is found
 * again by choosing where it is; nothing in it is changed. The reading queue
 * does not live in the folder and keeps working meanwhile.
 */
export function VaultTrouble({ status }: { status: LibraryStatus }) {
  const client = useQueryClient();
  const chooser = bridge()?.chooseDirectory;
  const relink = useMutation({
    mutationFn: async () => {
      const folder = await chooser?.();
      if (!folder) return null;
      return answer(engine().POST('/api/library/vault/relink', {
        ...LIBRARY, body: { expected_vault_id: status.vault!.vault_id, folder },
      }));
    },
    onSuccess: (found) => {
      if (!found) return;
      client.setQueryData(LIBRARY_KEY, found);
      void client.invalidateQueries({ queryKey: ['library-files'] });
      void client.invalidateQueries({ queryKey: ['evidence-projects'] });
    },
  });
  if (status.status === 'missing') {
    return (
      <section className="lib-trouble" role="alert" data-library="missing">
        <h2>The Library folder is not where it was</h2>
        <p>resmon keeps your files in this folder, and nothing is there now:</p>
        <code className="path" data-library="path">{status.vault?.path}</code>
        <p>
          If it is on a disk that is not connected, connect it. If you moved or renamed it, choose where it is now: resmon
          checks that it is this Library’s folder and changes nothing in it. If it was deleted, put it back from the Trash first.
        </p>
        <div className="setup-row">
          <button type="button" className="btn primary" disabled={!chooser || relink.isPending} onClick={() => relink.mutate()}>
            {relink.isPending ? 'Checking the folder' : 'Choose where it is now'}
          </button>
          <Link className="btn quiet sm" to="/settings/library">Settings › Library</Link>
        </div>
        {relink.error && <p className="field-error" role="alert">{errorWords(relink.error)}</p>}
        <p className="form-hint">Your reading queue does not live in this folder and is unaffected.</p>
      </section>
    );
  }
  return (
    <section className="lib-trouble" role="alert" data-library="trouble">
      <p>{TROUBLE[status.status] ?? `The Library reports “${status.status}”.`} Nothing was changed.</p>
      <p className="form-hint"><Link to="/settings/library">Settings › Library</Link> shows where the folder is.</p>
    </section>
  );
}
