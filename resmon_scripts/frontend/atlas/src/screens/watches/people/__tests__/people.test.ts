import { basisWords, evidenceToShow, livePreviewWarning, profileChip } from '../model';

describe('what a match to a person can mean', () => {
  test('the warning while typing: name only, then name and affiliation, then none with an ORCID', () => {
    expect(livePreviewWarning('', [])).toMatch(/every match will be name-only/);
    expect(livePreviewWarning('', ['', 'MIT'])).toMatch(/never by identity/);
    expect(livePreviewWarning('0000-0002-1825-0097', [])).toBeNull();
  });

  test('the chip a saved profile carries comes from its own warning', () => {
    expect(profileChip({ basis_warning: 'x', identifiers: {}, affiliations: [] })).toBe('name only');
    expect(profileChip({ basis_warning: 'x', identifiers: {}, affiliations: ['MIT'] })).toBe('name + affiliation');
    expect(profileChip({ basis_warning: null, identifiers: {}, affiliations: [] })).toBe('ORCID');
  });

  test('a basis resmon has no words for is shown as stored, not guessed at', () => {
    expect(basisWords('name_only')).toBe('name only');
    expect(basisWords('identifier')).toBe('ORCID match');
    expect(basisWords('something_new')).toBe('something_new');
  });

  test('evidence is shown when it changes what the match means, and an old match says it is old', () => {
    const policy = 'Matching policy 2026-09-07: ';
    expect(evidenceToShow(`${policy}name matched 'Ada' (exact)`)).toBeNull();
    expect(evidenceToShow(`${policy}name matched 'Ada' (ambiguous single-token name)`)).toContain('ambiguous');
    expect(evidenceToShow(`${policy}conflicting ORCID: record X differs`)).toContain('conflicting ORCID');
    expect(evidenceToShow('name matched')).toMatch(/^Historical match/);
    expect(evidenceToShow(null)).toMatch(/^Historical match/);
  });
});
