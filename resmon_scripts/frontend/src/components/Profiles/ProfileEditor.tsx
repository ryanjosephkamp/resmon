import React, { useCallback, useEffect, useState } from 'react';
import {
  WatchProfile, WatchProfileDraft, emptyProfileDraft,
} from '../../api/profiles';

/**
 * Create or edit one watch profile.
 *
 * **The warning is live, and that is the design.** `watch_profiles.py` decides
 * what a profile can ever prove, and the API returns `basis_warning` on every
 * read — but a warning that only appears *after* saving is a warning about a
 * decision already made. So the same rule is evaluated here while the user
 * types, the sentence is the one they will see again on the saved profile, and
 * it is the field they are being asked to fill that makes it go away.
 *
 * The rule is duplicated deliberately, and the duplication is held closed from
 * the other side. The two sentences below are the ones
 * `watch_profiles.basis_warning_for` returns, **verbatim except for the two
 * markdown emphasis markers**, which would render as literal asterisks here.
 * `test_watch_profiles.py::test_the_editor_previews_the_sentences_the_api_returns`
 * reads this file and fails when they drift — a guard on the renderer written in
 * the backend suite, because the backend is where the sentence is decided.
 */

/**
 * The live half of `watch_profiles.basis_warning_for`.
 *
 * Verbatim from the backend. Do not reword either string without changing
 * `basis_warning_for` in the same pull request; a Python test enforces it.
 */
export function livePreviewWarning(
  orcid: string, affiliations: string[],
): string | null {
  if (orcid.trim()) return null;
  if (affiliations.some((a) => a.trim())) {
    return (
      'This profile has no ORCID, so a paper can only be matched by name '
      + 'and affiliation — never by identity. Two researchers with the same '
      + 'name at the same institution would both match.'
    );
  }
  return (
    'This profile has neither an identifier nor an affiliation, so every '
    + 'match will be name-only: resmon can tell you a paper has this name on '
    + 'it and nothing more. Add an ORCID, or an affiliation, to do better.'
  );
}

const listToText = (values: string[]): string => values.join('\n');
const textToList = (text: string): string[] =>
  text.split('\n').map((v) => v.trim()).filter(Boolean);

interface Props {
  open: boolean;
  /** Null for a new profile; a starter draft prefills without an id. */
  target: WatchProfile | null;
  prefill?: WatchProfileDraft | null;
  onCancel: () => void;
  onSave: (draft: WatchProfileDraft, id: number | null) => Promise<void>;
}

const ProfileEditor: React.FC<Props> = ({ open, target, prefill, onCancel, onSave }) => {
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [orcid, setOrcid] = useState('');
  const [orcidCited, setOrcidCited] = useState('');
  const [affiliations, setAffiliations] = useState('');
  const [fieldHints, setFieldHints] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const hydrate = useCallback((source: WatchProfile | WatchProfileDraft | null) => {
    const base = source ?? emptyProfileDraft();
    const names = base.names || [];
    setName(base.display_name || (names[0]?.value ?? ''));
    setAliases(listToText(
      names.map((n) => n.value).filter((v) => v && v !== base.display_name)));
    const identifier = (base.identifiers || {}).orcid;
    setOrcid(identifier?.value || '');
    setOrcidCited(identifier?.cited || '');
    setAffiliations(listToText(base.affiliations || []));
    setFieldHints(listToText(base.field_hints || []));
    setNotes(base.notes || '');
    setError('');
  }, []);

  useEffect(() => {
    if (!open) return;
    hydrate(target ?? prefill ?? null);
  }, [open, target, prefill, hydrate]);

  if (!open) return null;

  const affiliationList = textToList(affiliations);
  const warning = livePreviewWarning(orcid, affiliationList);

  const submit = async () => {
    if (!name.trim()) { setError('A profile needs a name.'); return; }
    const identifiers: Record<string, { value: string; cited?: string }> = {};
    if (orcid.trim()) {
      identifiers.orcid = {
        value: orcid.trim(),
        // Kept even when blank rather than dropped: the field exists so an
        // identifier can be traced back, and an empty citation is a visible
        // gap where a missing key would be an invisible one.
        cited: orcidCited.trim(),
      };
    }
    const draft: WatchProfileDraft = {
      kind: 'person',
      display_name: name.trim(),
      names: [{ value: name.trim() }, ...textToList(aliases).map((v) => ({ value: v }))],
      identifiers,
      affiliations: affiliationList,
      field_hints: textToList(fieldHints),
      notes: notes.trim() || null,
    };
    setSaving(true);
    try {
      await onSave(draft, target ? target.id : null);
    } catch (err: any) {
      setError(err?.message || 'Could not save the profile.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" data-testid="profile-editor">
      <div className="modal modal-wide">
        <h2>{target ? `Edit ${target.display_name}` : 'New watch profile'}</h2>

        <label className="form-label" htmlFor="profile-name">Name, as published</label>
        <input
          id="profile-name" className="form-input" value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
        />

        <label className="form-label" htmlFor="profile-orcid">
          ORCID <span className="text-muted">— the only thing that makes a match
          evidence of identity</span>
        </label>
        <input
          id="profile-orcid" className="form-input" value={orcid}
          onChange={(e) => setOrcid(e.target.value)}
          placeholder="0000-0002-1825-0097"
        />

        <label className="form-label" htmlFor="profile-orcid-cited">
          Where you got that ORCID
        </label>
        <input
          id="profile-orcid-cited" className="form-input" value={orcidCited}
          onChange={(e) => setOrcidCited(e.target.value)}
          placeholder="their ORCID record, a paper, their department page"
        />

        {/*
          The whole reason this editor exists rather than a bare form. It moves
          as the ORCID and affiliation fields are filled, so the user learns the
          rule by watching it change rather than by reading a paragraph.
        */}
        <div
          className={`profile-basis-preview ${warning ? 'profile-basis-weak' : 'profile-basis-strong'}`}
          data-testid="basis-warning"
          role="status"
        >
          {warning || (
            'With an ORCID, a paper carrying that identifier is matched on '
            + 'identity rather than on a string.'
          )}
        </div>

        <label className="form-label" htmlFor="profile-affiliations">
          Affiliations, one per line
        </label>
        <textarea
          id="profile-affiliations" className="form-input" rows={2}
          value={affiliations} onChange={(e) => setAffiliations(e.target.value)}
          placeholder={'Massachusetts Institute of Technology'}
        />

        <label className="form-label" htmlFor="profile-aliases">
          Other spellings of the name, one per line
        </label>
        <textarea
          id="profile-aliases" className="form-input" rows={2}
          value={aliases} onChange={(e) => setAliases(e.target.value)}
        />
        <p className="form-hint">
          Used when resmon checks a source&rsquo;s answer. They are <strong>not</strong>{' '}
          sent to the source, which takes one name — so a paper filed only under
          an alias can still be missed.
        </p>

        <label className="form-label" htmlFor="profile-hints">
          Disambiguators, one per line
        </label>
        <textarea
          id="profile-hints" className="form-input" rows={2}
          value={fieldHints} onChange={(e) => setFieldHints(e.target.value)}
        />
        <p className="form-hint">
          Used only to tell two people apart. Never used to narrow a search —
          that would silently hide this person&rsquo;s other work.
        </p>

        <label className="form-label" htmlFor="profile-notes">Notes</label>
        <textarea
          id="profile-notes" className="form-input" rows={2}
          value={notes} onChange={(e) => setNotes(e.target.value)}
        />

        {error && <p className="form-error" role="alert">{error}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProfileEditor;
