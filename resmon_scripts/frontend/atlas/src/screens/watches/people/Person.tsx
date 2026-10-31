import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { answer, engine, engineSentence, EngineError } from '../../../api/client';
import { Icon } from '../../../shell/Icon';
import { saveFile } from '../../runs/downloads';
import { MapPaper } from '../../sky/MapPaper';
import { PaperSky, type PaperSkyHandle, type SkyChoice } from '../../sky/PaperSky';
import { count, number } from '../../today/format';
import { PersonEditor } from './PersonEditor';
import { PersonLifecycle } from './PersonLifecycle';
import { BASIS_MEANING, PEOPLE_KEY, basisWords, evidenceToShow, profileChip } from './model';
import { exportFilename } from './tools';

/**
 * A person as the engine exports them, saved where the person chooses: the
 * engine's own bytes, under their name, through the save dialog every export
 * in Atlas uses.
 */
async function savePerson(id: number, name: string): Promise<string> {
  const { data, error, response } = await engine().GET('/api/profiles/{profile_id}/export', {
    params: { path: { profile_id: id } },
    parseAs: 'text',
  });
  if (error !== undefined || typeof data !== 'string') {
    throw new EngineError(response.status, `${name} could not be exported.`, engineSentence(error));
  }
  const filename = exportFilename(name);
  saveFile(data, filename, 'application/json');
  return filename;
}

/** Matches read for the page and the sky; the count says when there are more. */
const PAGE = 200;

/**
 * One person: what resmon knows about them, what a match to them can mean,
 * and every paper matched so far, each with the basis it matched on and the
 * author string it matched.
 */
export function Person() {
  const { id } = useParams();
  return <PersonPage key={id} id={Number(id)} />;
}

function PersonPage({ id }: { id: number }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const profile = useQuery({
    queryKey: ['profile', id],
    enabled: Number.isInteger(id) && id > 0,
    queryFn: () => answer(engine().GET('/api/profiles/{profile_id}', { params: { path: { profile_id: id } } })),
  });
  const matches = useQuery({
    queryKey: ['profile-matches', id],
    enabled: profile.isSuccess,
    queryFn: () => answer(engine().GET('/api/profiles/{profile_id}/matches', {
      params: { path: { profile_id: id }, query: { limit: PAGE, offset: 0 } },
    })),
  });
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = new Map((catalog.data ?? []).map((e) => [e.slug, e.name]));
  const nameOf = (slug: string) => names.get(slug) ?? slug;
  const marked = useMemo(() => (matches.data?.matches ?? []).map((row) => row.document_id), [matches.data]);
  // A paper chosen on the map opens in the matches' place, beside the map.
  const [opened, setOpened] = useState<SkyChoice | null>(null);
  const sky = useRef<PaperSkyHandle>(null);
  const remove = useMutation({
    mutationFn: () => answer(engine().DELETE('/api/profiles/{profile_id}', { params: { path: { profile_id: id } } })),
    onSuccess: (done) => {
      void client.invalidateQueries({ queryKey: PEOPLE_KEY });
      // A watch pointed at this person is named rather than silently orphaned:
      // the engine's sentence goes with the person back to the list.
      navigate('/watches/people', { state: { said: done.detail ?? null } });
    },
  });
  const exported = useMutation({ mutationFn: (name: string) => savePerson(id, name) });

  if (profile.isPending) return <div className="page"><p className="page-lede">Reading this person.</p></div>;
  if (profile.isError || !profile.data) {
    return (
      <div className="page">
        <h1 className="page-title">This person could not be read</h1>
        <p className="page-lede">{profile.error?.message ?? 'The engine has no such profile.'}</p>
        <p><Link to="/watches/people" className="btn">Back to people</Link></p>
      </div>
    );
  }
  const data = profile.data;
  const rows = matches.data?.matches ?? [];
  const byBasis = Object.entries(matches.data?.by_basis ?? {}).filter(([, n]) => n > 0);
  const orcid = data.identifiers.orcid;

  return (
    <div className="run person-page" data-profile={data.id} aria-busy={profile.isFetching || matches.isFetching}>
      <header className="run-head">
        <Link to="/watches/people" className="back"><Icon name="back" size={14} />People</Link>
        <div className="run-headline">
          <h1 className="run-name it">{data.display_name}</h1>
          {!editing && (
            <div className="run-actions">
              <Link to="/watches/new" state={{ seed: { name: `New papers by ${data.display_name}`, profileId: data.id } }}
                className="btn" data-people="watch-for">Watch for their papers</Link>
              <button type="button" className="btn" onClick={() => setEditing(true)}>Change</button>
              <button type="button" className="btn" data-people="export" disabled={exported.isPending}
                onClick={() => exported.mutate(data.display_name)}>
                <Icon name="download" size={14} />Export
              </button>
              <button type="button" className="btn quiet" disabled={remove.isPending}
                onClick={() => { if (window.confirm(`Stop watching for ${data.display_name}? Their matches are removed; the papers stay.`)) remove.mutate(); }}>
                Remove
              </button>
            </div>
          )}
        </div>
        <div className="meta run-meta">
          <span className="basis-chip">{profileChip(data)}</span>
          {orcid && (<><span className="sep" /><span>ORCID {orcid.value}{orcid.cited ? `, from ${orcid.cited}` : ', source not recorded'}</span></>)}
          <span className="sep" />
          <span>{data.affiliations.length ? data.affiliations.join('; ') : 'no affiliation given'}</span>
          {data.names.length > 1 && (<><span className="sep" /><span>also published as {data.names.slice(1).map((n) => n.value).join(', ')}</span></>)}
        </div>
        {data.basis_warning && <p className="run-note" data-people="basis-warning">{data.basis_warning.replace(/\*\*/g, '')}</p>}
        {remove.error && (
          <p className="field-error" role="alert">
            {remove.error instanceof EngineError && remove.error.detail ? remove.error.detail : remove.error.message}
          </p>
        )}
        {exported.data && (
          <p className="settings-said" role="status" data-people="exported">
            {data.display_name}, as resmon exports a person, into <code className="path">{exported.data}</code>; the save
            dialog asks where it goes. Import it on the People page here or in another copy of resmon.
          </p>
        )}
        {exported.error && (
          <p className="field-error" role="alert">
            {exported.error instanceof EngineError && exported.error.detail ? exported.error.detail : exported.error.message}
          </p>
        )}
      </header>

      {editing && <PersonEditor target={data} onDone={() => setEditing(false)} />}

      <div className="run-main">
        {opened && (
          <MapPaper
            key={opened.id}
            id={opened.id}
            cell={opened.cell}
            region={opened.region}
            sourceName={nameOf}
            backLabel="Back to the matches"
            inline
            onBack={() => { setOpened(null); sky.current?.focus(); }}
            onShow={() => sky.current?.show(opened.id)}
          />
        )}
        <div className="person-column" hidden={opened !== null}>
          <PersonLifecycle id={data.id} name={data.display_name} />
          <section className="person-matches" aria-label="Papers matched">
            <h2 className="nights-title">Papers matched</h2>
            {matches.isPending && <p className="record-cap">Reading the matches.</p>}
            {matches.data && !matches.data.total && (
              <p className="record-cap" data-people="no-matches">
                None yet. Papers are matched as they are stored, by a watch on this person or by any search that brings in
                their work.
              </p>
            )}
            {byBasis.length > 0 && (
              <p className="count-sentence" data-people="counts">
                {count(matches.data?.total ?? 0, 'match', 'matches')}:{' '}
                {byBasis.map(([basis, n]) => `${number(n)} ${basisWords(basis)}`).join(', ')}
              </p>
            )}
            <ol className="match-list">
              {rows.map((row) => (
                <li key={row.document_id} className="match" data-document={row.document_id} data-basis={row.basis}>
                  <Link to={`/papers/${row.document_id}`} className="result-title">{row.title}</Link>
                  <div className="meta">
                    <span className="basis-chip" title={BASIS_MEANING[row.basis]}>{basisWords(row.basis)}</span>
                    <span className="sep" />
                    <span className="match-author">as {row.matched_author}</span>
                    <span className="sep" />
                    <span>{names.get(row.source_repository) ?? row.source_repository}</span>
                    {row.publication_date && (<><span className="sep" /><span>{row.publication_date}</span></>)}
                  </div>
                  {evidenceToShow(row.evidence) && <p className="match-evidence">{evidenceToShow(row.evidence)}</p>}
                </li>
              ))}
            </ol>
            {matches.data && matches.data.total > rows.length && (
              <p className="index-cap">The first {number(rows.length)} of {number(matches.data.total)} are listed.</p>
            )}
          </section>
        </div>
        <PaperSky
          ref={sky}
          marked={marked}
          outline={data.display_name}
          chosen={opened?.id ?? null}
          onChoose={setOpened}
          sourceName={nameOf}
          label={`Where ${data.display_name}'s matched papers sit in the collection`}
          caption={({ placed, ready }) => {
            if (!rows.length) return 'No papers are matched to mark yet.';
            if (!ready) return 'The collection map is not ready yet.';
            return `${number(placed ?? 0)} of the ${count(rows.length, 'matched paper')} listed are on the map.`;
          }}
        />
      </div>
    </div>
  );
}
