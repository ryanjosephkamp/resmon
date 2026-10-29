import { useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { count } from '../today/format';
import { instant, scheduleText } from '../watches/model';
import { SearchTabs } from './SearchTabs';
import { SAVED_KEY, savedAsks, savedKind, type SavedConfiguration } from './savedSearches';

/**
 * What the file chooser offers. An export is a zip of one JSON file per
 * saved search, and a single JSON file is the older form; the engine reads
 * both by their content rather than their names.
 */
const ACCEPTS = '.zip,.json,application/zip,application/json';

const DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

function refusal(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

/**
 * Saved: the searches saved from Ask the sources, and the copy of each watch
 * that resmon keeps beside it, so either can be exported to a file and
 * imported on another machine. A watch imported from a file arrives paused,
 * whatever the file says.
 */
export function Saved() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const chooser = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const saved = useQuery({ queryKey: SAVED_KEY, queryFn: () => answer(engine().GET('/api/configurations')) });
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = new Map((catalog.data ?? []).map((e) => [e.slug, e.name]));

  const exported = useMutation({
    mutationFn: (ids: number[]) => answer(engine().POST('/api/configurations/export', { body: { ids } })),
  });
  const imported = useMutation({
    mutationFn: (files: File[]) => answer(engine().POST('/api/configurations/import', {
      // The typed body names the field; the files themselves go as multipart,
      // which openapi-fetch sends with the browser's own boundary.
      body: { files: files.map((f) => f.name) },
      bodySerializer: () => {
        const form = new FormData();
        for (const file of files) form.append('files', file, file.name);
        return form;
      },
    })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: SAVED_KEY });
      void client.invalidateQueries({ queryKey: ['routines'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => answer(engine().DELETE('/api/configurations/{config_id}', { params: { path: { config_id: id } } })),
    onSuccess: (_done, id) => {
      setChosen((current) => current.filter((c) => c !== id));
      void client.invalidateQueries({ queryKey: SAVED_KEY });
    },
  });

  const rows = saved.data ?? [];
  const searches = rows.filter((c) => c.config_type !== 'routine');
  const watches = rows.filter((c) => c.config_type === 'routine');
  const pick = (id: number) => setChosen((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]));
  const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length) {
      exported.reset();
      imported.mutate(files);
    }
  };

  const row = (config: SavedConfiguration) => {
    const asks = savedAsks(config);
    const sources = asks.sources.map((s) => names.get(s) ?? s);
    const made = instant(config.created_at);
    return (
      <li key={config.id} className="saved" data-config={config.id} data-kind={config.config_type}>
        <label className="saved-pick">
          <input type="checkbox" checked={chosen.includes(config.id)} onChange={() => pick(config.id)} />
          <span className="sr-only">Choose {config.name}</span>
        </label>
        <div className="saved-main">
          <p className="saved-name it">{config.name}</p>
          <p className="meta">
            <span>{savedKind(config.config_type)}</span>
            {asks.keywords.length > 0 && (<><span className="sep" /><span>“{asks.keywords.join(' ')}”</span></>)}
            {sources.length > 0 && (<><span className="sep" /><span>{sources.length > 3 ? `${sources.slice(0, 3).join(', ')} and ${sources.length - 3} more` : sources.join(', ')}</span></>)}
            {asks.cron && (<><span className="sep" /><span>{scheduleText(asks.cron) ?? asks.cron}</span></>)}
            {asks.window && (<><span className="sep" /><span>{asks.window}</span></>)}
            {asks.cap !== null && (<><span className="sep" /><span>up to {asks.cap} per source</span></>)}
          </p>
          {made && <p className="record-cap">Saved {DAY.format(made)}</p>}
        </div>
        <div className="saved-actions">
          {config.config_type === 'routine'
            ? asks.watchId !== null && <Link className="btn sm" to={`/watches/${asks.watchId}`}>Open the watch</Link>
            : (
              <>
                <button type="button" className="btn sm" onClick={() => navigate('/search/ask', { state: { saved: config } })}>
                  Ask again
                </button>
                <button type="button" className="btn sm quiet" disabled={remove.isPending}
                  onClick={() => { if (window.confirm(`Delete the saved search “${config.name}”? Runs it started are kept, and stop naming it.`)) remove.mutate(config.id); }}>
                  Delete
                </button>
              </>
            )}
        </div>
      </li>
    );
  };

  return (
    <div className="page saved-page" aria-busy={saved.isPending || imported.isPending}>
      <SearchTabs />
      <h1 className="page-title">Saved</h1>
      <p className="page-lede">
        Searches saved from Ask the sources, and the copy resmon keeps of every watch. Export any of them to a file, and
        import that file here or on another computer. A watch imported from a file arrives paused, whatever the file says.
      </p>

      <div className="saved-bar">
        <button type="button" className="btn primary" data-saved="export" disabled={!chosen.length || exported.isPending}
          onClick={() => { imported.reset(); exported.mutate(chosen); }}>
          {chosen.length ? `Export ${chosen.length} to a file` : 'Export to a file'}
        </button>
        <button type="button" className="btn" data-saved="import" disabled={imported.isPending} onClick={() => chooser.current?.click()}>
          {imported.isPending ? 'Importing' : 'Import a file'}
        </button>
        <input ref={chooser} id="saved-import" type="file" accept={ACCEPTS} multiple hidden onChange={pickFile} />
        {chosen.length > 0 && <button type="button" className="btn quiet" onClick={() => setChosen([])}>Clear the choice</button>}
      </div>
      {exported.data && (
        <p className="settings-said" role="status" data-saved="exported">
          Exported to <code className="path">{exported.data.path}</code>
        </p>
      )}
      {imported.data && (
        <p className="settings-said" role="status" data-saved="imported">
          {importedWords(imported.data.imported, imported.data.routines_created)}
        </p>
      )}
      {imported.data && imported.data.errors.length > 0 && (
        <p className="field-error" role="alert" data-saved="import-refused">
          {imported.data.errors.join(' ')}
        </p>
      )}
      {(exported.error || imported.error) && (
        <p className="field-error" role="alert" data-saved="import-refused">{refusal((exported.error ?? imported.error) as Error)}</p>
      )}

      {saved.isError && <p className="field-error" role="alert">The engine did not answer ({saved.error.message}).</p>}

      <section className="saved-group" aria-labelledby="saved-searches">
        <h2 id="saved-searches" className="group-title">Searches</h2>
        {saved.data && !searches.length && (
          <p className="record-cap">None yet. On Ask the sources, Save this search keeps the sources, terms, dates, and cap together.</p>
        )}
        <ul className="saved-list">{searches.map(row)}</ul>
      </section>
      <section className="saved-group" aria-labelledby="saved-watches">
        <h2 id="saved-watches" className="group-title">Watches</h2>
        {saved.data && !watches.length && (
          <p className="record-cap">None. resmon keeps a copy here of each watch made or changed in the app.</p>
        )}
        <ul className="saved-list">{watches.map(row)}</ul>
      </section>
    </div>
  );
}

/** "Imported 1 saved search.", "Imported 2 saved searches and 1 watch, which arrives paused." */
export function importedWords(imported: number, watches: number): string {
  const searches = imported - watches;
  const parts = [
    searches > 0 && count(searches, 'saved search', 'saved searches'),
    watches > 0 && count(watches, 'watch', 'watches'),
  ].filter(Boolean);
  if (!parts.length) return 'Nothing was imported.';
  const paused = watches === 1 ? ', which arrives paused' : watches > 1 ? ', which arrive paused' : '';
  return `Imported ${parts.join(' and ')}${paused}.`;
}
