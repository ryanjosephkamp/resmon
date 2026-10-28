import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { answer, engine } from '../../../api/client';
import { PEOPLE_KEY, lines, livePreviewWarning, type Profile } from './model';

/**
 * A person to watch for: made new, or changed.
 *
 * The warning beside the form is the sentence the saved profile will carry,
 * evaluated as it is typed, and the field it names (an ORCID, or an
 * affiliation) is the one that changes it. An ORCID keeps where it came from
 * even when that is left blank: an empty citation is a visible gap, where a
 * missing one would be an invisible one.
 */
export function PersonEditor({ target, onDone }: { target: Profile | null; onDone: (saved: Profile | null) => void }) {
  const client = useQueryClient();
  const others = (target?.names ?? []).map((n) => n.value).filter((v) => v !== target?.display_name);
  const [name, setName] = useState(target?.display_name ?? '');
  const [orcid, setOrcid] = useState(target?.identifiers.orcid?.value ?? '');
  const [cited, setCited] = useState(target?.identifiers.orcid?.cited ?? '');
  const [affiliations, setAffiliations] = useState((target?.affiliations ?? []).join('\n'));
  const [spellings, setSpellings] = useState(others.join('\n'));
  const [hints, setHints] = useState((target?.field_hints ?? []).join('\n'));
  const [notes, setNotes] = useState(target?.notes ?? '');
  const warning = livePreviewWarning(orcid, lines(affiliations));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        kind: 'person',
        display_name: name.trim(),
        names: [{ value: name.trim() }, ...lines(spellings).map((value) => ({ value }))],
        identifiers: orcid.trim() ? { orcid: { value: orcid.trim(), cited: cited.trim() } } : {},
        affiliations: lines(affiliations),
        field_hints: lines(hints),
        notes: notes.trim() || null,
      };
      return target
        ? answer(engine().PUT('/api/profiles/{profile_id}', { params: { path: { profile_id: target.id } }, body }))
        : answer(engine().POST('/api/profiles', { body }));
    },
    onSuccess: (saved) => {
      void client.invalidateQueries({ queryKey: PEOPLE_KEY });
      void client.invalidateQueries({ queryKey: ['profile', saved.id] });
      onDone(saved);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) save.mutate();
  };

  return (
    <form className="person-editor" onSubmit={submit} aria-label={target ? `Change ${target.display_name}` : 'A new person'}>
      <div className="person-fields">
        <label htmlFor="person-name">Name, as published</label>
        <input id="person-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" autoComplete="off" />
        <label htmlFor="person-orcid">ORCID <span>the only thing that makes a match evidence of identity</span></label>
        <input id="person-orcid" value={orcid} onChange={(e) => setOrcid(e.target.value)} placeholder="0000-0002-1825-0097"
          autoComplete="off" spellCheck={false} />
        <label htmlFor="person-orcid-cited">Where that ORCID came from</label>
        <input id="person-orcid-cited" value={cited} onChange={(e) => setCited(e.target.value)}
          placeholder="their ORCID record, a paper, their department page" />
        <label htmlFor="person-affiliations">Affiliations <span>one a line</span></label>
        <textarea id="person-affiliations" rows={2} value={affiliations} onChange={(e) => setAffiliations(e.target.value)} />
        <label htmlFor="person-spellings">Other spellings of the name <span>one a line</span></label>
        <textarea id="person-spellings" rows={2} value={spellings} onChange={(e) => setSpellings(e.target.value)} />
        <label htmlFor="person-hints">Fields they work in <span>one a line</span></label>
        <textarea id="person-hints" rows={2} value={hints} onChange={(e) => setHints(e.target.value)} />
        <label htmlFor="person-notes">Notes</label>
        <textarea id="person-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <aside className="person-warning" role="note" data-people="warning" data-state={warning ? 'warns' : 'clear'}>
        <p className="why-limits-label">What a match will mean</p>
        <p>{warning ?? 'With an ORCID, a paper whose source returns it is matched by identity. A paper without it can still match by name, or by name and affiliation, and its match says which.'}</p>
      </aside>
      <div className="person-actions">
        <button type="submit" className="btn primary" disabled={!name.trim() || save.isPending}>
          {save.isPending ? 'Saving' : target ? 'Save changes' : 'Save person'}
        </button>
        <button type="button" className="btn quiet" onClick={() => onDone(null)}>Cancel</button>
        {save.error && <p className="field-error" role="alert">{save.error.message}</p>}
      </div>
    </form>
  );
}
