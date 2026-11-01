import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { answer, engine, EngineError } from '../../../api/client';
import { count } from '../../today/format';
import { WatchTabs } from '../WatchTabs';
import { PersonEditor } from './PersonEditor';
import { PEOPLE_KEY, profileChip, type Profile } from './model';
import { alreadyWatched, importSentence, profilesInFile, starterBody, type Starter } from './tools';

/**
 * People: the researchers resmon recognizes on papers, each with what a match
 * to them can ever be worth.
 *
 * A profile with no ORCID can only ever be matched by name, and its row says
 * so in the list, without opening it: a list is what a person scans. The
 * sentence is shown while the profile is still being typed, too, so the
 * warning arrives before the decision rather than after it.
 *
 * People come in three ways besides being typed: from the starter set that
 * ships with resmon, each added exactly as shipped; from a file of exported
 * profiles, which the engine reads entry by entry and answers for each; and
 * from a person's own page, which saves them as a file.
 */
export function People() {
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);
  const said = (useLocation().state as { said?: string | null } | null)?.said ?? null;
  const people = useQuery({ queryKey: PEOPLE_KEY, queryFn: () => answer(engine().GET('/api/profiles')) });
  const list = people.data?.profiles ?? [];

  const imported = useMutation({
    mutationFn: async (file: File) => {
      const read = profilesInFile(await file.text(), file.name);
      if ('refused' in read) throw new Error(read.refused);
      const result = await answer(engine().POST('/api/profiles/import', { body: { profiles: read.profiles } }));
      return importSentence(result, file.name);
    },
    onSettled: () => client.invalidateQueries({ queryKey: PEOPLE_KEY }),
  });
  const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) imported.mutate(file);
  };

  return (
    <div className="page people" aria-busy={people.isFetching || imported.isPending}>
      <WatchTabs />
      <div className="library-head">
        <h1 className="page-title">People</h1>
        {!adding && (
          <div className="people-actions">
            <button type="button" className="btn" aria-expanded={starting} aria-controls="people-starter"
              onClick={() => setStarting(!starting)}>
              Starter set
            </button>
            <button type="button" className="btn" data-people="import" disabled={imported.isPending}
              onClick={() => chooser.current?.click()}>
              {imported.isPending ? 'Importing' : 'Import a file'}
            </button>
            <input ref={chooser} id="people-import" type="file" accept=".json,application/json" hidden onChange={pickFile} />
            <button type="button" className="btn primary" onClick={() => setAdding(true)}>New person</button>
          </div>
        )}
      </div>
      <p className="page-lede">
        The researchers resmon looks for on the papers it collects. A match says how it was made: by ORCID, by name and
        affiliation, or by name alone.
      </p>
      <PlaceHelp summary="How matching works">
        <p>
          A match by ORCID is the only one that is evidence of identity, and only when the source returned the ORCID on
          the paper. A name and an affiliation together are not identity: another researcher with this name at this
          institution would match too. A name alone means the name is on the paper, and that is the whole claim.
        </p>
        <p>
          A source&rsquo;s author search is a candidate generator, never a verdict: resmon re-checks every record it gets
          back against the profile, and only what survives that check becomes a match. Sources that cannot be asked about
          a person at all say so on the run&rsquo;s own source row rather than returning a bare zero; Ask the sources
          lists which can.
        </p>
      </PlaceHelp>

      {said && <p className="run-note" role="status">{said}</p>}
      {imported.data && <p className="settings-said" role="status" data-people="imported">{imported.data}</p>}
      {imported.error && (
        <p className="field-error" role="alert" data-people="import-refused">
          {imported.error instanceof EngineError && imported.error.detail ? imported.error.detail : imported.error.message}
        </p>
      )}
      {starting && !adding && <StarterSet people={list} />}
      {adding && <PersonEditor target={null} onDone={() => setAdding(false)} />}

      <section className="people-list" aria-label="People">
        {people.isPending && <p className="index-cap">Reading the people you watch.</p>}
        {people.isError && <p className="index-cap">They could not be read ({people.error.message}).</p>}
        {people.data && !list.length && !adding && (
          <p className="index-empty">Nobody yet. Add a person and resmon will mark their papers as it collects them.</p>
        )}
        <ol className="watch-list">
          {list.map((profile) => (
            <li key={profile.id} className="person" data-profile={profile.id}>
              <Link to={`/watches/people/${profile.id}`} className="watch-name it">{profile.display_name}</Link>
              <span className="basis-chip" title={profile.basis_warning ?? undefined}>{profileChip(profile)}</span>
              <div className="meta">
                {profile.identifiers.orcid && <><span>ORCID {profile.identifiers.orcid.value}</span><span className="sep" /></>}
                <span>{profile.affiliations.length ? profile.affiliations.join('; ') : 'no affiliation given'}</span>
                {profile.names.length > 1 && (<><span className="sep" /><span>{count(profile.names.length - 1, 'other spelling')}</span></>)}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/**
 * The starter set: people shipped with resmon, served from the files on disk
 * so the list is what is installed. Adding one copies it into your people
 * exactly as it ships, its ORCID's citation included; someone already watched
 * under that ORCID is linked rather than added twice.
 */
function StarterSet({ people }: { people: readonly Profile[] }) {
  const client = useQueryClient();
  const starters = useQuery({ queryKey: ['profiles-starter'], queryFn: () => answer(engine().GET('/api/profiles/starter')) });
  const add = useMutation({
    mutationFn: (starter: Starter) => answer(engine().POST('/api/profiles', { body: starterBody(starter) })),
    onSuccess: () => client.invalidateQueries({ queryKey: PEOPLE_KEY }),
  });
  const rows = starters.data?.profiles ?? [];
  return (
    <section id="people-starter" className="starter-set" aria-label="Starter set" data-people="starter"
      aria-busy={starters.isFetching || add.isPending}>
      <h2 className="group-title">The starter set</h2>
      <p className="group-lede">
        People shipped with resmon as examples, not endorsements. Each ORCID was checked against the public ORCID record
        on the day it was added, and its citation says so. Adding one copies it into your people as it ships; the file is
        not changed, and the copy is yours to change or remove.
      </p>
      {starters.isPending && <p className="index-cap">Reading the starter files.</p>}
      {starters.isError && <p className="index-cap">The starter files could not be read ({starters.error.message}).</p>}
      {starters.data && !rows.length && <p className="index-empty">No starter files are installed with this copy of resmon.</p>}
      <ol className="starter-list">
        {rows.map((starter) => {
          const have = alreadyWatched(starter, people);
          const orcid = starter.identifiers.orcid;
          return (
            <li key={starter.source_file} className="starter-person" data-starter={starter.source_file}>
              <span className="starter-name it">{starter.display_name}</span>
              <span className="basis-chip" title={starter.basis_warning ?? undefined}>{profileChip(starter)}</span>
              {have ? (
                <Link to={`/watches/people/${have.id}`} className="btn sm quiet">In your people</Link>
              ) : (
                <button type="button" className="btn sm" disabled={add.isPending} onClick={() => add.mutate(starter)}>Add</button>
              )}
              <div className="meta">
                {orcid && <><span>ORCID {orcid.value}</span><span className="sep" /></>}
                <span>{starter.notes ?? (starter.affiliations.join('; ') || 'no affiliation given')}</span>
              </div>
              {orcid?.cited && <p className="match-evidence">{orcid.cited}</p>}
            </li>
          );
        })}
      </ol>
      {add.data && (
        <p className="settings-said" role="status" data-people="added">
          Added {add.data.display_name}. <Link to={`/watches/people/${add.data.id}`}>Open their page</Link>.
        </p>
      )}
      {add.error && (
        <p className="field-error" role="alert">
          {add.error instanceof EngineError && add.error.detail ? add.error.detail : add.error.message}
        </p>
      )}
    </section>
  );
}

/**
 * A place's own explanation, closed until asked for: what the place does and
 * what it cannot know, in prose, on the place itself.
 */
export function PlaceHelp({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="place-help">
      <summary>{summary}</summary>
      <div className="place-help-body">{children}</div>
    </details>
  );
}
