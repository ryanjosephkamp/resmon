import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { bridge, systemName } from '../../bridge';
import { count, number, when } from '../today/format';
import { LibraryTabs } from './LibraryTabs';
import {
  LIBRARY, LIBRARY_KEY, download, importFile, importWords, kindOf, readable, sizeWords,
  type LibraryFile, type LibraryImported, type LibraryStatus,
} from './libraryApi';

function errorWords(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

/** The engine's words for a vault it cannot use, by the status it reported. */
const TROUBLE: Record<string, string> = {
  busy: 'Another import into this library is still finishing. Try again in a moment.',
  mismatch: 'The library folder on disk is not the one this database recorded, so nothing is read from it.',
  needs_attention: 'The library folder needs attention before resmon can use it.',
  unavailable: 'The library folder cannot be reached: a disk may be disconnected, or the folder moved.',
};

/**
 * Library › Your files: copies of PDFs and text files kept in a folder you own.
 *
 * The engine makes one folder inside the one you choose, `resmon-library-<id>`,
 * holding `vault.json` and `files/`, and keeps each file's bytes there under its
 * own id, never editing them. A file can be linked to papers in your
 * collection; a link is your association, and resmon does not claim the file is
 * that publication. Text files are read here as literal text; a PDF opens in
 * the system's own viewer.
 */
export function Files() {
  const status = useQuery({
    queryKey: LIBRARY_KEY,
    queryFn: () => answer(engine().GET('/api/library', LIBRARY)),
  });
  const data = status.data;
  return (
    <div className="page library files-page" aria-busy={status.isFetching}>
      <LibraryTabs />
      <div className="library-head"><h1 className="page-title">Your files</h1></div>
      {status.isPending && <p className="page-lede">Reading the library.</p>}
      {status.isError && <p className="page-lede">The library could not be read ({errorWords(status.error)}).</p>}
      {data?.status === 'unconfigured' && <Setup limits={data.limits} />}
      {data && data.vault && data.status !== 'unconfigured' && (
        data.status === 'ready'
          ? <Vault status={data} />
          : (
            <p className="page-lede" role="alert" data-library="trouble">
              {TROUBLE[data.status] ?? `The library reports “${data.status}”.`} Nothing was changed.
            </p>
          )
      )}
    </div>
  );
}

function Setup({ limits }: { limits: LibraryStatus['limits'] }) {
  const client = useQueryClient();
  const [parent, setParent] = useState<string | null>(null);
  const chooser = bridge()?.chooseDirectory;
  const create = useMutation({
    mutationFn: (dir: string) => answer(engine().POST('/api/library/vault', { ...LIBRARY, body: { parent_directory: dir } })),
    onSuccess: (made) => client.setQueryData(LIBRARY_KEY, made),
  });
  return (
    <section className="library-setup" data-library="setup">
      <p className="page-lede">
        resmon can keep copies of PDFs and text files you give it, in a folder of yours. It makes one new folder inside
        the one you choose, named <code className="path">resmon-library-…</code>, holding <code className="path">vault.json</code> and
        a <code className="path">files</code> folder. Nothing is uploaded anywhere.
      </p>
      <ul className="setup-facts">
        <li>Up to {sizeWords(limits.file_bytes)} a file, {number(limits.batch_files)} files at a time, {number(limits.items)} files in all.</li>
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

function Vault({ status }: { status: LibraryStatus }) {
  const client = useQueryClient();
  const vault = status.vault!;
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const settle = setTimeout(() => setQ(draft.trim()), 300);
    return () => clearTimeout(settle);
  }, [draft]);
  const [picked, setPicked] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const files = useQuery({
    queryKey: ['library-files', vault.vault_id, q],
    queryFn: () => answer(engine().GET('/api/library/files', {
      ...LIBRARY, params: { query: { expected_vault_id: vault.vault_id, q, limit: 100 } },
    })),
    placeholderData: keepPreviousData,
  });
  const list = files.data?.files ?? [];
  const shown = picked ?? list[0]?.file_id ?? null;

  const changed = () => {
    void client.invalidateQueries({ queryKey: LIBRARY_KEY });
    void client.invalidateQueries({ queryKey: ['library-files'] });
    void client.invalidateQueries({ queryKey: ['library-file'] });
  };
  const importing = useMutation({
    mutationFn: async (chosen: File[]) => {
      const results: LibraryImported[] = [];
      const refused: string[] = [];
      // One at a time: the engine holds one import lock per vault.
      for (const file of chosen) {
        try {
          results.push(await importFile(vault.vault_id, file));
        } catch (error) {
          refused.push(`${file.name}: ${error instanceof Error ? errorWords(error) : String(error)}`);
        }
      }
      return { results, refused };
    },
    onMutate: () => { setSaid(null); setRefusals([]); },
    onSuccess: ({ results, refused }) => {
      setSaid(importWords(results, refused.length));
      setRefusals(refused);
      if (results[0]) setPicked(results[0].file.file_id);
      changed();
    },
  });
  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (chosen.length) importing.mutate(chosen);
  };
  const inventory = useMutation({
    mutationFn: () => answer(engine().GET('/api/library/export', {
      ...LIBRARY, params: { query: { expected_vault_id: vault.vault_id, format: 'json' } },
    })),
    onSuccess: (doc) => download(doc.text, doc.filename, doc.content_type),
  });

  return (
    <div className="library-vault" data-library="vault" data-vault={vault.vault_id}>
      <div className="vault-bar">
        <p className="vault-facts">
          <code className="path" title="The library folder, inside the one you chose">{vault.label}</code>
          <span>{count(status.counts.items, 'file')}, {sizeWords(status.counts.retained_bytes)} recorded</span>
        </p>
        <div className="vault-actions">
          <label className="btn primary" aria-disabled={importing.isPending}>
            {importing.isPending ? 'Importing' : 'Import files'}
            <input ref={input} type="file" multiple accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
              aria-label="Import PDF, TXT or MD" className="sr-only" disabled={importing.isPending} onChange={onChosen} />
          </label>
          <button type="button" className="btn" disabled={inventory.isPending} onClick={() => inventory.mutate()}>
            Save an inventory
          </button>
        </div>
      </div>
      {said && <p className="settings-said" role="status" data-library="imported">{said}</p>}
      {refusals.length > 0 && (
        <ul className="field-error library-refusals" role="alert">{refusals.map((r) => <li key={r}>{r}</li>)}</ul>
      )}
      {inventory.error && <p className="field-error" role="alert">{errorWords(inventory.error)}</p>}
      <p className="form-hint">
        PDF, TXT and MD, up to {sizeWords(status.limits.file_bytes)} each. An inventory lists what the database records
        about each file; it is not a copy of the files.
      </p>

      <div className="library-split">
        <section className="library-list" aria-label="Library files" aria-busy={files.isFetching}>
          <label className="terms compact" htmlFor="library-q">
            <input id="library-q" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Filter by file name"
              aria-label="Filter by file name" autoComplete="off" spellCheck={false} />
          </label>
          {files.data && !list.length && (
            <p className="index-empty">{q ? `No file name contains “${q}”.` : 'Nothing is kept yet. Import a PDF, TXT or MD file.'}</p>
          )}
          <ol className="library-files">
            {list.map((file) => (
              <li key={file.file_id}>
                <button type="button" className="library-file" aria-pressed={file.file_id === shown}
                  data-file={file.file_id} onClick={() => setPicked(file.file_id)}>
                  <span className="lib-name">{file.original_name}</span>
                  <span className="meta">
                    <span className="lib-kind">{kindOf(file.media_type)}</span>
                    <span className="sep" />
                    <span>{sizeWords(file.byte_size)}</span>
                    {file.paper_links.length > 0 && (<><span className="sep" /><span>{count(file.paper_links.length, 'paper')}</span></>)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {files.data?.has_more && <p className="index-cap">Showing the newest 100; filter by name to find others.</p>}
        </section>
        {shown && <Detail key={shown} vaultId={vault.vault_id} fileId={shown} onChanged={changed} />}
      </div>
    </div>
  );
}

function Detail({ vaultId, fileId, onChanged }: { vaultId: string; fileId: string; onChanged: () => void }) {
  const now = useMemo(() => new Date(), []);
  const [paper, setPaper] = useState('');
  const [reading, setReading] = useState(false);
  const detail = useQuery({
    queryKey: ['library-file', vaultId, fileId],
    queryFn: () => answer(engine().GET('/api/library/files/{file_id}', {
      ...LIBRARY, params: { path: { file_id: fileId }, query: { expected_vault_id: vaultId } },
    })),
  });
  const file: LibraryFile | undefined = detail.data?.file;
  const link = useMutation({
    mutationFn: (documentId: number) => answer(engine().POST('/api/library/files/{file_id}/paper-links', {
      ...LIBRARY, params: { path: { file_id: fileId } }, body: { expected_vault_id: vaultId, document_id: documentId },
    })),
    onSuccess: () => { setPaper(''); onChanged(); },
  });
  const open = useMutation({
    mutationFn: async (how: 'open' | 'reveal') => {
      if (!file) return null;
      const verified = await answer(engine().POST('/api/library/files/{file_id}/open', {
        ...LIBRARY, params: { path: { file_id: fileId } },
        body: { expected_vault_id: vaultId, expected_version_id: file.version_id },
      }));
      const desktop = bridge();
      if (how === 'reveal') return desktop?.revealPath?.(verified.path) ?? null;
      const failed = await desktop?.openPath?.(verified.path);
      if (failed) throw new Error(failed);
      return null;
    },
  });
  const paperId = Number(paper);
  const linked = link.data;

  if (detail.isPending) return <section className="library-detail" aria-label="Selected Library item"><p className="record-cap">Reading the file’s record.</p></section>;
  if (detail.isError || !file) {
    return (
      <section className="library-detail" aria-label="Selected Library item">
        <p className="field-error" role="alert">{detail.error ? errorWords(detail.error) : 'The file’s record could not be read.'}</p>
      </section>
    );
  }
  return (
    <section className="library-detail" aria-label="Selected Library item" data-file={file.file_id} data-media={file.media_type}>
      <h2 className="lib-detail-name">{file.original_name}</h2>
      <div className="lib-actions">
        <button type="button" className="btn sm" disabled={open.isPending} onClick={() => open.mutate('open')}>Open</button>
        <button type="button" className="btn sm" disabled={open.isPending} onClick={() => open.mutate('reveal')}>
          Show in {systemName() === 'macOS' ? 'Finder' : 'its folder'}
        </button>
        {readable(file.media_type) && (
          <button type="button" className="btn sm" aria-pressed={reading} onClick={() => setReading((r) => !r)}>
            {reading ? 'Close the text' : 'Read here'}
          </button>
        )}
        <Link className="btn sm" to={`/library/evidence?file=${encodeURIComponent(file.file_id)}`}>Open in Evidence</Link>
      </div>
      {open.error && <p className="field-error" role="alert">{errorWords(open.error)}</p>}
      <dl className="facts lib-facts">
        <div><dt>Kind</dt><dd><span data-library="media">{file.media_type}</span> ({kindOf(file.media_type)})</dd></div>
        <div><dt>Size</dt><dd>{sizeWords(file.byte_size)}</dd></div>
        <div><dt>Kept</dt><dd>{when(file.created_at_utc, now)}</dd></div>
        <div><dt>SHA-256</dt><dd><code className="path" data-library="sha256">{file.sha256}</code></dd></div>
        <div><dt>File id</dt><dd><code className="path" data-library="file-id">{file.file_id}</code></dd></div>
        <div><dt>Version id</dt><dd><code className="path" data-library="version-id">{file.version_id}</code></dd></div>
        <div><dt>In the folder</dt><dd><code className="path">{file.relative_path}</code></dd></div>
      </dl>
      <p className="form-hint">The hash is the one recorded when the file was kept; this view does not re-read the bytes.</p>

      <h3 className="record-sub">Papers you linked it to</h3>
      {file.paper_links.length === 0
        ? <p className="record-cap">None.</p>
        : (
          <ul className="lib-links" data-library="links">
            {file.paper_links.map((l) => (
              <li key={l.document_id}>
                <Link to={`/papers/${l.document_id}`}>Paper {l.document_id}</Link>
                {l.title ? <>: {l.title}</> : null}
              </li>
            ))}
          </ul>
        )}
      <form className="lib-link-form" onSubmit={(e) => { e.preventDefault(); if (paperId > 0) link.mutate(paperId); }}>
        <label htmlFor="lib-paper">Link to a paper by its number</label>
        <input id="lib-paper" inputMode="numeric" value={paper} onChange={(e) => { setPaper(e.target.value.replace(/[^0-9]/g, '')); link.reset(); }}
          placeholder="Paper number, from its page" autoComplete="off" />
        <button type="submit" className="btn sm" disabled={!(paperId > 0) || link.isPending}>Link</button>
      </form>
      {linked && (
        <p className="settings-said" role="status" data-library="linked">
          Linked paper {linked.document_id}. A link is your association, not verified publication identity.
        </p>
      )}
      {link.error && <p className="field-error" role="alert">{errorWords(link.error)}</p>}
      {reading && <TextReader vaultId={vaultId} file={file} />}
    </section>
  );
}

/**
 * A kept TXT or MD file as literal text with line numbers. Nothing is
 * rendered as Markdown or HTML. The engine reads only what it verified against
 * the recorded size and hash, and refuses a file over its bounds rather than
 * showing part of one.
 */
function TextReader({ vaultId, file }: { vaultId: string; file: LibraryFile }) {
  const text = useQuery({
    queryKey: ['library-text', vaultId, file.file_id, file.version_id],
    queryFn: () => answer(engine().GET('/api/library/files/{file_id}/text', {
      ...LIBRARY, params: { path: { file_id: file.file_id }, query: { expected_vault_id: vaultId, expected_version_id: file.version_id } },
    })),
  });
  if (text.isPending) return <p className="record-cap">Reading the text.</p>;
  if (text.isError) return <p className="field-error" role="alert">{errorWords(text.error)}</p>;
  const lines = text.data.text.split('\n');
  return (
    <section className="lib-text" aria-label={`The text of ${file.original_name}`} data-library="text">
      <p className="record-cap">{count(text.data.line_count, 'line')}, read from the kept bytes. Line endings are shown as single breaks.</p>
      <ol className="lib-lines">
        {lines.map((line, i) => <li key={i}><span className="lib-line">{line || ' '}</span></li>)}
      </ol>
    </section>
  );
}
