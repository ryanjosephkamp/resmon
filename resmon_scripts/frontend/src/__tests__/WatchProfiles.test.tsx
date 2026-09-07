/**
 * P8's renderer half and P10's jsdom half — the interface that makes the basis
 * rule visible.
 *
 * Until phase 2.1a′ every match row carried `identifier`, `name+affiliation` or
 * `name_only` and **nothing displayed it**, which meant the constraint
 * "`name_only` is never presented as the person" was kept by nothing at all:
 * there was no presentation to keep it in. These are the checks that it is now
 * kept by something.
 *
 * jsdom, so what they establish is that the component renders the field it was
 * given. That a real Chromium paints it on the real route is
 * `e2e/watch-profiles.spec.ts`, and the two are deliberately not the same claim.
 */

import React from 'react';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import ProfilesPage from '../pages/ProfilesPage';
import RoutineEditModal from '../components/Routines/RoutineEditModal';
import BasisBadge from '../components/Profiles/BasisBadge';
import { livePreviewWarning } from '../components/Profiles/ProfileEditor';
import { mockRoutedFetch, renderWithProviders, callsTo } from './testUtils';

function bodyOf(mock: jest.Mock, path: string, method: string): any {
  const call = callsTo(mock, path).find(
    (c) => (c.init?.method || 'GET').toUpperCase() === method,
  );
  return call ? JSON.parse(String(call.init?.body)) : undefined;
}

const NAME_ONLY_WARNING =
  'This profile has neither an identifier nor an affiliation, so **every match '
  + 'will be name-only**: resmon can tell you a paper has this name on it and '
  + 'nothing more. Add an ORCID, or an affiliation, to do better.';

const AFFILIATION_WARNING =
  'This profile has no ORCID, so a paper can only be matched by name and '
  + 'affiliation — never by identity. Two researchers with the same name at the '
  + 'same institution would both match.';

const WEAK_PROFILE = {
  id: 1, kind: 'person', display_name: 'John Smith',
  names: [{ value: 'John Smith' }], identifiers: {}, affiliations: [],
  field_hints: [], notes: null, basis_warning: NAME_ONLY_WARNING,
};

const STRONG_PROFILE = {
  id: 2, kind: 'person', display_name: 'Jane Doe',
  names: [{ value: 'Jane Doe' }],
  identifiers: { orcid: { value: '0000-0002-1825-0097', cited: 'her ORCID record' } },
  affiliations: ['University of Somewhere'], field_hints: [], notes: null,
  basis_warning: null,
};

const PROFILE_ROUTES = {
  '/api/profiles': { profiles: [WEAK_PROFILE, STRONG_PROFILE] },
  '/api/profiles/starter': { profiles: [] },
  '/api/profiles/1/matches': { matches: [], total: 0, by_basis: {} },
  '/api/profiles/1/lifecycle': {
    findings: [], matched_documents: 0, checked_documents: 0,
    coverage_note: '0 of 0 matched papers have been through a lifecycle check.',
  },
};

// ---------------------------------------------------------------------------
// The badge itself
// ---------------------------------------------------------------------------

test('a name-only match is labelled as one, with the string the source returned',
  async () => {
    await renderWithProviders(
      <BasisBadge matches={[{
        profile_id: 1, display_name: 'John Smith', basis: 'name_only',
        matched_author: 'J. Smith', evidence: 'name matched on initials',
      }]} />,
    );
    expect(screen.getByText('name only')).toBeInTheDocument();
    // The verbatim string is what makes the weakness auditable: "J. Smith"
    // beside a profile named "John Smith" says how weak this is better than any
    // summary of ours could.
    expect(screen.getByText(/matched “J\. Smith”/)).toBeInTheDocument();
  });

test('an ORCID match says ORCID and never says name only', async () => {
  await renderWithProviders(
    <BasisBadge matches={[{
      profile_id: 2, display_name: 'Jane Doe', basis: 'identifier',
      matched_author: 'Jane Doe', evidence: 'ORCID 0000-0002-1825-0097',
    }]} />,
  );
  expect(screen.getByText('ORCID match')).toBeInTheDocument();
  expect(screen.queryByText('name only')).not.toBeInTheDocument();
});

test('every basis the backend can store has a label here', async () => {
  /**
   * The denominator. `watch_profile_matches.basis` is a CHECK over three
   * values; a fourth added to the backend without a label would render as an
   * empty chip, which is the one thing worse than a weak claim — a claim with
   * no words on it at all.
   */
  const bases = ['identifier', 'name+affiliation', 'name_only'] as const;
  await renderWithProviders(
    <BasisBadge matches={bases.map((basis, i) => ({
      profile_id: i, display_name: `P${i}`, basis,
      matched_author: null, evidence: null,
    }))} />,
  );
  const chips = screen.getAllByTestId('basis-matches')[0]
    .querySelectorAll('.basis-chip');
  expect(chips).toHaveLength(3);
  chips.forEach((chip) => {
    expect(chip.textContent?.trim().length).toBeGreaterThan(0);
    // The tooltip is the full sentence, and it is what a reader hovering a
    // three-word chip actually needs.
    expect(chip.getAttribute('title')?.length).toBeGreaterThan(40);
  });
});

test('a paper nobody is watching renders nothing at all', async () => {
  await renderWithProviders(<BasisBadge matches={[]} />);
  expect(screen.queryByTestId('basis-matches')).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// The editor's live warning
// ---------------------------------------------------------------------------

test('the editor previews exactly the three states the backend decides', () => {
  /**
   * The renderer duplicates `basis_warning_for`, because a warning that appears
   * only after saving is a warning about a decision already made. The two
   * strings are the backend's own, minus its markdown emphasis;
   * `test_watch_profiles.py` reads this file's source and fails on drift.
   */
  expect(livePreviewWarning('0000-0002-1825-0097', [])).toBeNull();
  expect(livePreviewWarning('', ['MIT']))
    .toBe(AFFILIATION_WARNING);
  expect(livePreviewWarning('', []))
    .toBe(NAME_ONLY_WARNING.replace(/\*\*/g, ''));
  // Whitespace is not an affiliation and not an ORCID.
  expect(livePreviewWarning('  ', ['  '])).toBe(NAME_ONLY_WARNING.replace(/\*\*/g, ''));
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test('the profile list marks the ones that can never match on identity', async () => {
  mockRoutedFetch(PROFILE_ROUTES);
  await renderWithProviders(<ProfilesPage />);
  await screen.findByTestId('profiles-list');
  const items = screen.getByTestId('profiles-list').querySelectorAll('.basis-chip');
  // One of the two, not both: the marker is on the profile that has no ORCID.
  expect(items).toHaveLength(1);
  expect(items[0].getAttribute('title')).toContain('name-only');
});

test('the selected profile shows the sentence the API returned, verbatim', async () => {
  mockRoutedFetch(PROFILE_ROUTES);
  await renderWithProviders(<ProfilesPage />);
  const warning = await screen.findByTestId('profile-basis-warning');
  // Not paraphrased in the renderer. The backend owns the sentence so that the
  // app, a harness and the assistant all say the same thing.
  expect(warning.textContent).toBe(NAME_ONLY_WARNING);
});

test('a profile with an ORCID is told what that buys, not left silent', async () => {
  mockRoutedFetch(PROFILE_ROUTES);
  await renderWithProviders(<ProfilesPage />);
  await screen.findByTestId('profiles-list');
  fireEvent.click(screen.getByText('Jane Doe'));
  await waitFor(() => {
    expect(screen.getByTestId('profile-basis-warning').textContent)
      .toContain('matched on identity');
  });
});

test('matches are counted by basis before the papers are listed', async () => {
  mockRoutedFetch({
    ...PROFILE_ROUTES,
    '/api/profiles/1/matches': {
      total: 3,
      by_basis: { identifier: 1, name_only: 2 },
      matches: [
        { document_id: 10, basis: 'identifier', matched_author: 'John Smith',
          evidence: 'ORCID', first_seen_at: '2026-09-01', title: 'A',
          source_repository: 'arxiv', doi: null, url: null, publication_date: null },
        { document_id: 11, basis: 'name_only', matched_author: 'J. Smith',
          evidence: 'initials', first_seen_at: '2026-09-01', title: 'B',
          source_repository: 'arxiv', doi: null, url: null, publication_date: null },
        { document_id: 12, basis: 'name_only', matched_author: 'John Smith',
          evidence: 'name', first_seen_at: '2026-09-01', title: 'C',
          source_repository: 'arxiv', doi: null, url: null, publication_date: null },
      ],
    },
  });
  await renderWithProviders(<ProfilesPage />);
  const counts = await screen.findByTestId('basis-counts');
  // "Three papers" and "three papers, two of them name-only" are different
  // facts, and the second is the one a reader needs before the list.
  expect(counts.textContent).toContain('1 ORCID match');
  expect(counts.textContent).toContain('2 name only');
  const rows = screen.getByTestId('profile-matches').querySelectorAll('li');
  expect(rows).toHaveLength(3);
  rows.forEach((row) => {
    expect(row.querySelector('.basis-chip')).not.toBeNull();
  });
});

test('coverage is shown before findings, and zero findings is not a claim about the world',
  async () => {
    mockRoutedFetch({
      ...PROFILE_ROUTES,
      '/api/profiles/1/lifecycle': {
        findings: [], matched_documents: 12, checked_documents: 3,
        coverage_note: '3 of 12 matched papers have been through a lifecycle check. '
          + 'The rest have not been looked at, which is not the same as having '
          + 'nothing to report.',
      },
    });
    await renderWithProviders(<ProfilesPage />);
    const coverage = await screen.findByTestId('lifecycle-coverage');
    expect(coverage.textContent).toContain('3 of 12');
    expect(coverage.textContent).toContain('not the same as having nothing to report');
  });

test('a retraction on a name-only match is shown as a finding about a name', async () => {
  /**
   * The single most consequential rendering in this phase. A retraction
   * attached to a named person who did not write the paper is defamatory, so
   * the basis travels onto the finding and is printed beside it.
   */
  mockRoutedFetch({
    ...PROFILE_ROUTES,
    '/api/profiles/1/lifecycle': {
      matched_documents: 1, checked_documents: 1,
      coverage_note: '1 of 1 matched papers have been through a lifecycle check.',
      findings: [{
        document_id: 10, kind: 'retraction', severity: 'critical',
        label: 'Retraction', notice_doi: '10.1/n',
        notice_url: 'https://doi.org/10.1/n', notice_date: '2026-02-02',
        provider: 'crossref', provider_source: 'Retraction Watch',
        title: 'A paper with this name on it', doi: '10.1/p',
        source_repository: 'crossref', basis: 'name_only',
        matched_author: 'J. Smith',
      }],
    },
  });
  await renderWithProviders(<ProfilesPage />);
  const findings = await screen.findByTestId('profile-findings');
  expect(findings.textContent).toContain('Retraction');
  expect(findings.querySelector('.basis-chip')?.textContent).toBe('name only');
  // The notice is a link, never resmon's own assertion.
  expect(findings.querySelector('a')?.getAttribute('href'))
    .toBe('https://doi.org/10.1/n');
});

test('deleting a profile repeats what the backend said about orphaned routines',
  async () => {
    mockRoutedFetch({
      ...PROFILE_ROUTES,
      '/api/profiles/1': () => ({
        deleted: 1,
        routines_watching: [{ id: 4, name: 'Watch John' }],
        detail: "1 routine(s) watched this profile: 'Watch John'. They are still "
          + 'saved and will now fail on their next run until you point them '
          + 'somewhere else or delete them.',
      }),
    });
    await renderWithProviders(<ProfilesPage />);
    await screen.findByTestId('profiles-list');
    fireEvent.click(screen.getByText('Delete'));
    const notice = await screen.findByTestId('profiles-notice');
    expect(notice.textContent).toContain('Watch John');
  });

// ---------------------------------------------------------------------------
// The routine editor's Watch mode
// ---------------------------------------------------------------------------

const ROUTINE_ROUTES = {
  '/api/repositories/catalog': [],
  '/api/credentials': { credentials: {}, keyring_responsive: true },
  '/api/configurations': [],
  '/api/settings/ai': {},
  '/api/profiles': { profiles: [WEAK_PROFILE, STRONG_PROFILE] },
};

test('a routine watching a person sends an entity and clears the keywords', async () => {
  const mock = mockRoutedFetch({ ...ROUTINE_ROUTES, '/api/routines': { id: 9 } });
  await renderWithProviders(
    <RoutineEditModal open target={null} onClose={() => {}} />,
  );
  // The name input's label carries no `htmlFor`, so it is reached through the
  // label's own field wrapper — the same route `RoutineIntentField.test.tsx` takes.
  fireEvent.change(
    screen.getByText('Routine Name').parentElement!.querySelector('input')!,
    { target: { value: 'Watch Jane' } },
  );
  await act(async () => {
    fireEvent.change(screen.getByLabelText('What this routine follows'),
                     { target: { value: 'new_papers' } });
  });
  await screen.findByTestId('routine-watch-profile');
  fireEvent.change(screen.getByLabelText('Who to watch'), { target: { value: '2' } });
  fireEvent.click(screen.getByText('Create'));

  await waitFor(() => {
    const body = bodyOf(mock, '/api/routines', 'POST');
    expect(body).toBeDefined();
    expect(body.parameters.entity).toEqual({ profile_id: 2, mode: 'new_papers' });
    // Cleared rather than sent and ignored: what is stored is what runs, and
    // narrowing a person's work by topic would silently hide the rest of it.
    expect(body.parameters.keywords).toEqual([]);
    expect(body.parameters.query).toBe('');
  });
});

test('choosing a name-only profile repeats its warning where the schedule is set',
  async () => {
    mockRoutedFetch(ROUTINE_ROUTES);
    await renderWithProviders(
      <RoutineEditModal open target={null} onClose={() => {}} />,
    );
    await act(async () => {
      fireEvent.change(screen.getByLabelText('What this routine follows'),
                       { target: { value: 'new_papers' } });
    });
    await screen.findByTestId('routine-watch-profile');
    fireEvent.change(screen.getByLabelText('Who to watch'), { target: { value: '1' } });
    const warning = await screen.findByTestId('routine-basis-warning');
    // This is the last moment somebody can decide to go and find an ORCID
    // before putting a schedule behind a name match.
    expect(warning.textContent).toBe(NAME_ONLY_WARNING);
  });

test('the retractions mode says it queries no source', async () => {
  mockRoutedFetch(ROUTINE_ROUTES);
  await renderWithProviders(
    <RoutineEditModal open target={null} onClose={() => {}} />,
  );
  await act(async () => {
    fireEvent.change(screen.getByLabelText('What this routine follows'),
                     { target: { value: 'retractions' } });
  });
  const hint = await screen.findByTestId('retractions-hint');
  expect(hint.textContent).toContain('queries no source');
});

test('a keyword routine is unchanged: no entity, keywords still sent', async () => {
  const mock = mockRoutedFetch({ ...ROUTINE_ROUTES, '/api/routines': { id: 9 } });
  await renderWithProviders(
    <RoutineEditModal open target={null} onClose={() => {}} />,
  );
  fireEvent.change(
    screen.getByText('Routine Name').parentElement!.querySelector('input')!,
    { target: { value: 'Keywords' } },
  );
  fireEvent.click(screen.getByText('Create'));
  await waitFor(() => {
    const body = bodyOf(mock, '/api/routines', 'POST');
    expect(body).toBeDefined();
    expect(body.parameters.entity).toBeUndefined();
  });
});

test('the mode picker offers only the modes the backend accepts', async () => {
  /**
   * `institution_output` is in the plan and is refused by the API. Offering it
   * here would be a promise the app does not keep, and the person who chose it
   * would get a 400 for a choice the interface presented as available.
   */
  mockRoutedFetch(ROUTINE_ROUTES);
  await renderWithProviders(
    <RoutineEditModal open target={null} onClose={() => {}} />,
  );
  const modes = Array.from(
    (screen.getByLabelText('What this routine follows') as HTMLSelectElement).options,
  ).map((o) => o.value);
  expect(modes).toEqual(['', 'new_papers', 'retractions']);
});

test('editing a watch routine brings its profile and mode back', async () => {
  mockRoutedFetch(ROUTINE_ROUTES);
  await renderWithProviders(
    <RoutineEditModal
      open
      target={{
        id: 7, name: 'Watch Jane', schedule_cron: '0 8 * * *',
        email_enabled: 0, email_ai_summary_enabled: 0, ai_enabled: 0,
        parameters: JSON.stringify({
          repositories: ['arxiv'], keywords: [], query: '',
          entity: { profile_id: 2, mode: 'retractions' },
        }),
      }}
      onClose={() => {}}
    />,
  );
  await waitFor(() => {
    expect((screen.getByLabelText('What this routine follows') as HTMLSelectElement).value)
      .toBe('retractions');
  });
  await waitFor(() => {
    expect((screen.getByLabelText('Who to watch') as HTMLSelectElement).value).toBe('2');
  });
});


// ---------------------------------------------------------------------------
// The field test's numbers, in the interface
// ---------------------------------------------------------------------------

test('the page states the measured precision per basis, with its denominators',
  async () => {
    /**
     * Decision 7 requires the field test's numbers to be *in the interface copy*,
     * not only in a handback. This is the guard on that: the three figures a
     * person needs in order to read a badge correctly must be on the page, with
     * the denominator each was drawn from.
     *
     * It asserts the numbers rather than the prose, so the copy can be rewritten
     * freely and a *changed measurement* still has to be a deliberate edit here.
     */
    mockRoutedFetch(PROFILE_ROUTES);
    await renderWithProviders(<ProfilesPage />);
    await screen.findByTestId('profiles-list');

    // The panel is collapsed by default — help that interrupts is help nobody
    // reads — so the copy is opened the way a person opens it.
    fireEvent.click(screen.getByText('Watch Profiles', { selector: '.page-help-title' }));

    const help = document.querySelector('.page-help-body') as HTMLElement;
    expect(help).not.toBeNull();
    const copy = help.textContent || '';

    expect(copy).toContain('1,369');          // the population every figure is out of
    expect(copy).toContain('30 of 30');       // identifier precision
    expect(copy).toContain('0.7%');           // how rarely name+affiliation fires
    expect(copy).toContain('five different researchers');
    expect(copy).toContain('15 were right');  // the graded name-only sample
    expect(copy).toContain('6% of all matches');   // the initials rule's share
  });


test('old evidence is visibly historical and is preserved verbatim', async () => {
  await renderWithProviders(<BasisBadge showEvidence matches={[{
    profile_id: 1, display_name: 'Smith', basis: 'name+affiliation',
    matched_author: 'Smith', evidence: 'old affiliation claim',
  }]} />);
  expect(screen.getByText(/Historical match — not rechecked/)).toBeInTheDocument();
  expect(screen.getByText('old affiliation claim')).toBeInTheDocument();
});

test.each(['ambiguous single-token name', 'conflicting ORCID'])(
  'dense Explorer badges show %s counterevidence without expansion', async (reason) => {
    await renderWithProviders(<BasisBadge matches={[{
      profile_id: 1, display_name: 'Smith', basis: 'name_only',
      matched_author: 'Smith', evidence: `Matching policy 2026-09-07: ${reason}; not identity`,
    }]} />);
    expect(screen.getByText(new RegExp(reason))).toBeInTheDocument();
    expect(screen.queryByText(/Historical match/)).not.toBeInTheDocument();
  },
);
