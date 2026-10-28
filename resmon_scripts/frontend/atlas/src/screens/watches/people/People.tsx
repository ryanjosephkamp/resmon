import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { answer, engine } from '../../../api/client';
import { count } from '../../today/format';
import { WatchTabs } from '../WatchTabs';
import { PersonEditor } from './PersonEditor';
import { PEOPLE_KEY, profileChip } from './model';

/**
 * People: the researchers resmon recognizes on papers, each with what a match
 * to them can ever be worth.
 *
 * A profile with no ORCID can only ever be matched by name, and its row says
 * so in the list, without opening it: a list is what a person scans. The
 * sentence is shown while the profile is still being typed, too, so the
 * warning arrives before the decision rather than after it.
 */
export function People() {
  const [adding, setAdding] = useState(false);
  const said = (useLocation().state as { said?: string | null } | null)?.said ?? null;
  const people = useQuery({ queryKey: PEOPLE_KEY, queryFn: () => answer(engine().GET('/api/profiles')) });
  const list = people.data?.profiles ?? [];
  return (
    <div className="page people" aria-busy={people.isFetching}>
      <WatchTabs />
      <div className="library-head">
        <h1 className="page-title">People</h1>
        {!adding && <button type="button" className="btn primary" onClick={() => setAdding(true)}>New person</button>}
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
 * A place's own explanation, closed until asked for. Atlas's counterpart of
 * the classic interface's page help: what the place does and what it cannot
 * know, in prose, on the place itself.
 */
export function PlaceHelp({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="place-help">
      <summary>{summary}</summary>
      <div className="place-help-body">{children}</div>
    </details>
  );
}
