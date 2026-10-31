import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { answer, engine, EngineError } from '../../api/client';
import { CommandEnterHint, commandEnterKeys } from '../../shell/CommandEnterHint';
import { commandEnter } from '../../shell/shortcuts';
import { coarseFor, coarseSentence } from '../sources/catalog';
import { SourceCatalog, TermsField, useSources, useTerms } from '../sources/SourceCatalog';
import { SAVED_KEY, editedParameters, savedForm, savedFormProblem, type SavedConfiguration } from './savedSearches';

/**
 * A saved search changed in place: its name, and what it asks (the sources,
 * the terms, the dates, and how many papers each source is asked for). Its
 * kind stays as it was made, because the engine keeps a saved search's kind:
 * a Deep Dive asks one source and a Deep Sweep several.
 *
 * What the row shows afterwards is what the engine then holds: the list is
 * read again before the editor closes, and the row is drawn from that.
 */
export function SavedEditor({ config, onDone }: {
  config: SavedConfiguration;
  /** Called with the sentence to show once the change is stored, or null when the editor is left unsaved. */
  onDone: (said: string | null) => void;
}) {
  const client = useQueryClient();
  const [initial] = useState(() => savedForm(config));
  const { sources, keyMissing, pending, failed } = useSources();
  const [name, setName] = useState(initial.name);
  const terms = useTerms(initial.keywords);
  const [chosen, setChosen] = useState<string[]>(initial.sources);
  const [dates, setDates] = useState({ from: initial.dateFrom, to: initial.dateTo });
  const [cap, setCap] = useState(initial.cap);
  const dive = config.config_type === 'manual_dive';
  const id = `saved-${config.id}`;

  const form = { name, sources: chosen, keywords: terms.all, dateFrom: dates.from, dateTo: dates.to, cap };
  const problem = savedFormProblem(config.config_type, form);
  const picked = useMemo(() => chosen.flatMap((slug) => sources.filter((entry) => entry.slug === slug)), [chosen, sources]);
  // A source this copy of resmon cannot ask is kept, and said: the saved
  // search may have come from a newer build, and saving it here should not
  // quietly take the source out of it.
  const unknown = sources.length ? chosen.filter((slug) => !sources.some((entry) => entry.slug === slug)) : [];
  const coarse = useMemo(() => coarseFor(picked, dates.from, dates.to), [picked, dates]);

  const save = useMutation({
    mutationFn: () => answer(engine().PUT('/api/configurations/{config_id}', {
      params: { path: { config_id: config.id } },
      body: { name: name.trim(), parameters: editedParameters(config, form) },
    })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: SAVED_KEY });
      onDone(`Saved the changes to “${name.trim()}”.`);
    },
  });

  const choose = (slug: string) => setChosen((current) => {
    if (dive) return [slug];
    return current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug];
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (terms.draft.trim()) terms.add();
    if (!problem && !save.isPending) save.mutate();
  };

  return (
    <form className="saved-editor" {...commandEnter()} onSubmit={submit} aria-label={`Change the saved search “${config.name}”`} data-saved="editor">
      <div className="form-field saved-editor-name">
        <label className="form-label" htmlFor={`${id}-name`}>Name</label>
        <input id={`${id}-name`} value={name} autoComplete="off" onChange={(event) => setName(event.target.value)} />
      </div>
      <TermsField id={`${id}-terms`} label="Search terms" state={terms} className="compact" />
      <SourceCatalog
        name={`${id}-source`}
        legend={dive ? 'Source' : 'Sources'}
        count={dive ? 'a Deep Dive asks one' : `${picked.length} of ${sources.length} chosen`}
        sources={sources}
        chosen={chosen}
        multiple={!dive}
        keyMissing={keyMissing}
        pending={pending}
        failed={failed}
        onChoose={choose}
      />
      <div className="ask-window">
        <fieldset className="window">
          <legend>Published</legend>
          <label className="date">
            <span>From</span>
            <input type="date" value={dates.from} onChange={(e) => setDates({ ...dates, from: e.target.value })} />
          </label>
          <label className="date">
            <span>To</span>
            <input type="date" value={dates.to} onChange={(e) => setDates({ ...dates, to: e.target.value })} />
          </label>
        </fieldset>
        <label className="cap">
          <span>Up to</span>
          <input type="number" min={1} max={1000} value={cap} aria-label="Most papers per source"
            onChange={(event) => setCap(Math.max(1, Math.min(1000, Number(event.target.value) || 1)))} />
          <span>papers per source</span>
        </label>
      </div>
      <p className="form-hint saved-editor-hint">Leave both dates empty to ask for papers from any date.</p>
      <div className="saved-editor-facts" aria-live="polite">
        {coarse.length > 0 && <p>{coarseSentence(coarse)}</p>}
        {picked.filter(keyMissing).map((entry) => (
          <p key={entry.slug}>{entry.name} has no API key here, so a run will record it as not queried.</p>
        ))}
        {unknown.length > 0 && (
          <p data-saved="unknown-sources">
            {unknown.join(', ')} {unknown.length === 1 ? 'is' : 'are'} in this saved search but {unknown.length === 1 ? 'is not a source' : 'are not sources'}
            {' '}this copy of resmon can ask. Saving keeps {unknown.length === 1 ? 'it' : 'them'}.
          </p>
        )}
      </div>
      <div className="form-actions">
        <button type="submit" className="btn primary" data-saved="save-changes" disabled={!!problem || save.isPending}
          aria-keyshortcuts={commandEnterKeys()}>
          {save.isPending ? 'Saving' : 'Save changes'}
        </button>
        <button type="button" className="btn quiet" disabled={save.isPending} onClick={() => onDone(null)}>Cancel</button>
        <CommandEnterHint />
        {problem && <p className="form-hint" data-saved="problem">{problem}</p>}
      </div>
      {save.error && (
        <p className="field-error" role="alert" data-saved="change-refused">
          {save.error instanceof EngineError && save.error.detail ? save.error.detail : save.error.message}
        </p>
      )}
    </form>
  );
}
