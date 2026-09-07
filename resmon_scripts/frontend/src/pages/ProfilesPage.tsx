import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PageHelp from '../components/Help/PageHelp';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import ProfileEditor from '../components/Profiles/ProfileEditor';
import { BASIS_LABEL, BASIS_MEANING, MatchEvidence } from '../components/Profiles/BasisBadge';
import {
  MatchBasis, ProfileLifecycle, ProfileMatchPage, WatchProfile,
  WatchProfileDraft, profilesApi,
} from '../api/profiles';

/**
 * Watch profiles — the people this install is watching, and what resmon can
 * actually prove about each of them.
 *
 * This page is where phase 2.1's rule becomes visible. Every profile carries the
 * sentence saying what its matches can ever be, and every paper it has matched
 * carries the basis it was matched on. Before this page existed the basis was
 * stored on every match row and shown nowhere, which is the one state the phase
 * was not allowed to release in: a constraint that "`name_only` is never
 * presented as the person" is kept by nothing when there is no presentation.
 *
 * The per-basis counts are shown before the papers, not after. "Forty-one
 * papers" and "forty-one papers, thirty-eight of them name-only" are different
 * facts, and the second is the one a person needs before they read the list.
 */

const BASIS_ORDER: MatchBasis[] = ['identifier', 'name+affiliation', 'name_only'];

const ProfilesPage: React.FC = () => {
  const [profiles, setProfiles] = useState<WatchProfile[]>([]);
  const [starter, setStarter] = useState<WatchProfileDraft[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [matches, setMatches] = useState<ProfileMatchPage | null>(null);
  const [lifecycle, setLifecycle] = useState<ProfileLifecycle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<WatchProfile | null>(null);
  const [prefill, setPrefill] = useState<WatchProfileDraft | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const rows = await profilesApi.list();
      setProfiles(rows);
      setSelected((current) => (
        current !== null && rows.some((p) => p.id === current)
          ? current
          : (rows[0]?.id ?? null)
      ));
    } catch (err: any) {
      setError(err?.message || 'Could not load profiles.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The starter set is *served* rather than bundled into this file, so the
      // picker shows what is on disk and a user who edits or removes one of the
      // shipped files sees that.
      try {
        const rows = await profilesApi.starter();
        if (!cancelled) setStarter(rows);
      } catch { /* the picker simply has nothing to offer */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (selected === null) { setMatches(null); setLifecycle(null); return undefined; }
    (async () => {
      try {
        const [page, cycle] = await Promise.all([
          profilesApi.matches(selected),
          profilesApi.lifecycle(selected),
        ]);
        if (cancelled) return;
        setMatches(page);
        setLifecycle(cycle);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Could not load matches.');
      }
    })();
    return () => { cancelled = true; };
  }, [selected]);

  const current = useMemo(
    () => profiles.find((p) => p.id === selected) || null,
    [profiles, selected],
  );

  const save = async (draft: WatchProfileDraft, id: number | null) => {
    if (id === null) {
      const created = await profilesApi.create(draft);
      setSelected(created.id);
    } else {
      await profilesApi.update(id, draft);
    }
    setEditorOpen(false);
    setPrefill(null);
    await refresh();
  };

  const remove = async (profile: WatchProfile) => {
    try {
      const result = await profilesApi.remove(profile.id);
      // The backend names the routines this leaves pointing at nothing, because
      // no foreign key can cascade into a routine's JSON parameters. Repeating
      // it here is the difference between a surprise and a consequence.
      setNotice(result.detail
        || `Deleted ${profile.display_name}. The papers it matched are still in your corpus.`);
      setSelected(null);
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'Could not delete the profile.');
    }
  };

  const exportOne = async (profile: WatchProfile) => {
    const document_ = await profilesApi.exportOne(profile.id);
    // A download, not a file dialog: the renderer has no filesystem access of
    // its own and the profile is small. The blob is revoked immediately after
    // the click so it does not outlive the export.
    const blob = new Blob([JSON.stringify(document_, null, 2)],
                          { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${profile.display_name.replace(/\s+/g, '-').toLowerCase()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const documents = Array.isArray(parsed) ? parsed : [parsed];
      const result = await profilesApi.import(documents);
      // Per profile, never per file: one bad entry must not lose the good ones,
      // and the alternative is a user editing JSON to find out which line
      // resmon objected to.
      setNotice(
        result.failed.length === 0
          ? `Imported ${result.imported.length} profile(s).`
          : `Imported ${result.imported.length}; ${result.failed.length} could not be read: `
            + result.failed.map((f) => `#${f.index + 1} ${f.reason}`).join('; '),
      );
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'That file is not a profile export.');
    }
  };

  if (loading) {
    return (
      <div className="page-content">
        <p className="text-muted">Loading watch profiles…</p>
      </div>
    );
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Watch Profiles</h1>
        <TutorialLinkButton anchor="profiles" />
      </div>

      <PageHelp
        storageKey="profiles"
        title="Watch Profiles"
        summary="The people you are watching, and what resmon can actually prove about each match."
        sections={[
          {
            heading: 'What this page does',
            body: (
              <ul>
                <li>A profile is a person you point a routine at, instead of guessing a keyword query that catches them.</li>
                <li>A routine can watch a profile for <strong>new papers</strong> or for <strong>retractions</strong> on the papers it has already matched. You set that on the Routines page.</li>
                <li>Profiles export and import as JSON, one documented shape, so you can move them between machines or share one.</li>
              </ul>
            ),
          },
          {
            heading: 'Why every match carries a basis',
            body: (
              <>
                <p>Names keep initials and surname particles. Affiliations match whole tokens,
                  so MIT does not match SUMMIT. Single-token names stay ambiguous candidates;
                  conflicting ORCIDs are counterevidence and cannot raise a name match.
                  Historical matches are labeled and kept, not automatically rechecked.
                  The field-test figures below describe the earlier matching policy.</p>

                <p>
                  Scholarly sources do not agree on who anybody is. Most of them
                  return an author&rsquo;s <em>name</em> and nothing else, so
                  &ldquo;papers by Jane Doe&rdquo; from such a source means
                  &ldquo;papers with the string <em>Jane Doe</em> in the author
                  field&rdquo; — which includes every other Jane Doe who has
                  ever published.
                </p>
                <p>
                  resmon will not present that as identity. Every match records
                  <strong> how</strong> it was made, and the badge says so:
                </p>
                <ul>
                  {BASIS_ORDER.map((basis) => (
                    <li key={basis}>
                      <strong>{BASIS_LABEL[basis]}</strong> — {BASIS_MEANING[basis]}
                    </li>
                  ))}
                </ul>
                <p>
                  A profile with no ORCID can only ever produce the weaker two,
                  and the editor says so while you are filling it in rather than
                  after you save.
                </p>
                <p>
                  <strong>What that is worth, measured.</strong> On 7 September
                  2026 four profiles were run against every source resmon can ask
                  about a person, producing <strong>1,369 matches</strong>, and a
                  sample of them was graded by hand:
                </p>
                <ul>
                  <li>
                    <strong>ORCID match — 30 of 30 correct.</strong> Every one
                    was the right person. This is the basis worth having.
                  </li>
                  <li>
                    <strong>name + affiliation — 9 matches in all 1,369</strong>{' '}
                    (0.7%). Two were a distinctive name and were correct. The
                    other seven were one common name at one large institution and
                    span <strong>at least five different researchers</strong>, all
                    labelled the same way. The affiliation raises the evidence; it
                    does not identify a person.
                  </li>
                  <li>
                    <strong>name only — 90% of all matches</strong> (1,237 of
                    1,369). Of the 30 graded, 17 named somebody whose identity
                    could be checked: <strong>15 were right, one was wrong, one
                    could not be settled</strong>. The wrong one was a library
                    catalogue record that lists a molecular biologist as a
                    co-author of a book on Coleridge. The other 13 came from
                    profiles that name no particular person, and there is no
                    answer to &ldquo;is this them&rdquo; for those — which is
                    exactly why resmon does not claim one.
                  </li>
                </ul>
                <p>
                  <strong>6% of all matches came from initials alone</strong>{' '}
                  (&ldquo;J. Smith&rdquo; against &ldquo;John Smith&rdquo;). Every
                  one says so in its evidence. In the graded sample the initials
                  rule was right every time it was checkable — but it is a guess
                  by construction, and a name-only badge is the honest label for
                  it.
                </p>
              </>
            ),
          },
          {
            heading: 'What resmon asks a source, and what it does with the answer',
            body: (
              <p>
                A source&rsquo;s author search is a <em>candidate generator</em>,
                never a verdict: resmon re-checks every record it gets back
                against the profile itself, and only what survives that check
                becomes a match. Sources that cannot be asked about a person at
                all say so on the run&rsquo;s own source row rather than
                returning a bare zero.
              </p>
            ),
          },
        ]}
      />

      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && (
        <p className="form-notice" role="status" data-testid="profiles-notice">{notice}</p>
      )}

      <div className="profiles-actions">
        <button
          className="btn btn-primary"
          onClick={() => { setEditTarget(null); setPrefill(null); setEditorOpen(true); }}
        >
          New profile
        </button>
        <button className="btn" onClick={() => setPickerOpen((v) => !v)}>
          {pickerOpen ? 'Hide the starter set' : `Starter set (${starter.length})`}
        </button>
        <label className="btn" htmlFor="profile-import">Import JSON</label>
        <input
          id="profile-import" type="file" accept="application/json,.json"
          data-testid="profile-import"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {pickerOpen && (
        <div className="card profiles-starter" data-testid="starter-picker">
          <h2>Starter profiles</h2>
          <p className="text-muted">
            Shipped with resmon as examples. Each ORCID was checked against the
            public ORCID record on the day it was added, and the citation says
            so. Adding one copies it into your own profiles — the file on disk is
            not changed.
          </p>
          <ul className="profiles-starter-list">
            {starter.map((draft) => (
              <li key={draft.display_name}>
                <span className="profiles-starter-name">{draft.display_name}</span>
                {draft.affiliations[0] && (
                  <span className="text-muted">{draft.affiliations[0]}</span>
                )}
                <button
                  className="btn btn-small"
                  onClick={() => {
                    setEditTarget(null);
                    setPrefill(draft);
                    setEditorOpen(true);
                  }}
                >
                  Add
                </button>
              </li>
            ))}
            {starter.length === 0 && (
              <li className="text-muted">No starter files are installed.</li>
            )}
          </ul>
        </div>
      )}

      <div className="profiles-layout">
        <aside className="profiles-list card">
          <h2>Profiles</h2>
          {profiles.length === 0 ? (
            <p className="text-muted">
              None yet. Create one, or add somebody from the starter set.
            </p>
          ) : (
            <ul data-testid="profiles-list">
              {profiles.map((p) => (
                <li key={p.id}>
                  <button
                    className={`profiles-list-item${p.id === selected ? ' active' : ''}`}
                    onClick={() => setSelected(p.id)}
                  >
                    <span className="profiles-list-name">{p.display_name}</span>
                    {/*
                      The weakness marker is on the *list*, not only on the
                      detail view. A list is what a person scans, and a profile
                      that can never match on identity should be legible as such
                      without opening it.
                    */}
                    {p.basis_warning && (
                      <span className="basis-chip" title={p.basis_warning}>
                        name only
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="profiles-detail">
          {!current ? (
            <div className="card">
              <h2>Nothing selected</h2>
              <p className="text-muted">Choose a profile, or create one.</p>
            </div>
          ) : (
            <>
              <div className="card">
                <div className="page-header">
                  <h2>{current.display_name}</h2>
                  <div className="profiles-detail-actions">
                    <button
                      className="btn btn-small"
                      onClick={() => { setEditTarget(current); setPrefill(null); setEditorOpen(true); }}
                    >
                      Edit
                    </button>
                    <button className="btn btn-small" onClick={() => void exportOne(current)}>
                      Export
                    </button>
                    <button className="btn btn-small btn-danger" onClick={() => void remove(current)}>
                      Delete
                    </button>
                  </div>
                </div>

                {current.basis_warning ? (
                  <p className="profile-basis-preview profile-basis-weak"
                     data-testid="profile-basis-warning">
                    {current.basis_warning}
                  </p>
                ) : (
                  <p className="profile-basis-preview profile-basis-strong"
                     data-testid="profile-basis-warning">
                    This profile carries an ORCID, so a paper that comes back
                    with that identifier is matched on identity rather than on a
                    string.
                  </p>
                )}

                <dl className="profile-fields">
                  {current.identifiers.orcid && (
                    <>
                      <dt>ORCID</dt>
                      <dd>
                        {current.identifiers.orcid.value}
                        {current.identifiers.orcid.cited && (
                          <span className="text-muted"> — {current.identifiers.orcid.cited}</span>
                        )}
                      </dd>
                    </>
                  )}
                  {current.affiliations.length > 0 && (
                    <>
                      <dt>Affiliations</dt>
                      <dd>{current.affiliations.join('; ')}</dd>
                    </>
                  )}
                  {current.names.length > 1 && (
                    <>
                      <dt>Other spellings</dt>
                      <dd>
                        {current.names.slice(1).map((n) => n.value).join('; ')}
                        <span className="text-muted">
                          {' '}— used when checking a source&rsquo;s answer, not sent to the source
                        </span>
                      </dd>
                    </>
                  )}
                  {current.notes && (<><dt>Notes</dt><dd>{current.notes}</dd></>)}
                </dl>
              </div>

              <div className="card">
                <h3>Matched papers</h3>
                {!matches || matches.total === 0 ? (
                  <p className="text-muted" data-testid="no-matches">
                    No papers have been matched to this profile yet. Point a
                    routine at it on the Routines page — choose <em>Watch a
                    person</em> and this profile.
                  </p>
                ) : (
                  <>
                    <p className="profiles-basis-counts" data-testid="basis-counts">
                      {matches.total} paper(s):{' '}
                      {BASIS_ORDER
                        .filter((b) => (matches.by_basis[b] || 0) > 0)
                        .map((b) => `${matches.by_basis[b]} ${BASIS_LABEL[b]}`)
                        .join(', ')}
                    </p>
                    <ul className="profiles-matches" data-testid="profile-matches">
                      {matches.matches.map((m) => (
                        <li key={m.document_id} className={`basis-${m.basis.replace('+', '-')}`}>
                          <span className="basis-chip" title={BASIS_MEANING[m.basis]}>
                            {BASIS_LABEL[m.basis]}
                          </span>
                          {m.url ? (
                            <a href={m.url} target="_blank" rel="noreferrer noopener">
                              {m.title}
                            </a>
                          ) : m.title}
                          <span className="text-muted">{m.source_repository}</span>
                          <MatchEvidence evidence={m.evidence} expanded />
                          {m.matched_author && (
                            <span className="basis-author">matched &ldquo;{m.matched_author}&rdquo;</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              {lifecycle && (
                <div className="card">
                  <h3>Retractions and other changes</h3>
                  {/*
                    Coverage before findings, always. "Nothing found" means
                    nothing at all unless the reader can see how much of this
                    person's work has actually been looked at.
                  */}
                  <p className="text-muted" data-testid="lifecycle-coverage">
                    {lifecycle.coverage_note}
                  </p>
                  {lifecycle.findings.length === 0 ? (
                    <p className="text-muted">
                      Nothing has been recorded against the papers matched to
                      this profile.
                    </p>
                  ) : (
                    <ul className="profiles-findings" data-testid="profile-findings">
                      {lifecycle.findings.map((f) => (
                        <li key={`${f.document_id}:${f.notice_url}`}>
                          <span className={`lifecycle-chip lifecycle-${f.severity}`}>
                            {f.label || f.kind}
                          </span>
                          <a href={f.notice_url} target="_blank" rel="noreferrer noopener">
                            {f.title}
                          </a>
                          {/*
                            The basis rides on the finding, and this is the place
                            it matters most: a retraction attached to a name is
                            not a retraction attached to a person, and saying
                            otherwise about somebody named is defamatory.
                          */}
                          <span className="basis-history">Saved match basis — identity has not been rechecked for this finding.</span>
                          <span className="basis-chip" title={BASIS_MEANING[f.basis]}>
                            {BASIS_LABEL[f.basis]}
                          </span>
                          {f.provider_source && (
                            <span className="text-muted">via {f.provider_source}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <ProfileEditor
        open={editorOpen}
        target={editTarget}
        prefill={prefill}
        onCancel={() => { setEditorOpen(false); setPrefill(null); }}
        onSave={save}
      />
    </div>
  );
};

export default ProfilesPage;
