/**
 * People: watch profiles, and what a match to one is worth.
 *
 * A name on a paper is not a person. resmon matches a profile three ways, and
 * the three are different claims rather than three levels of worry: an ORCID
 * the source returned (evidence of identity), a name and an affiliation (not
 * identity), and a name alone (that name is on the paper, and nothing more).
 * Every match carries its basis wherever it is shown.
 */
import type { components } from '../../../api/schema';

export type Profile = components['schemas']['WatchProfile'];
export type MatchRow = components['schemas']['WatchProfileMatchRow'];
export type MatchRef = components['schemas']['WatchProfileMatchRef'];

/** The query key every list of profiles is read under. */
export const PEOPLE_KEY = ['profiles'] as const;

export const BASIS_LABEL: Record<string, string> = {
  identifier: 'ORCID match',
  'name+affiliation': 'name + affiliation',
  name_only: 'name only',
};

export const BASIS_MEANING: Record<string, string> = {
  identifier: 'The source returned this profile’s ORCID on this paper. This is evidence of identity.',
  'name+affiliation': 'A name matched and an affiliation on the record matched one of this profile’s. '
    + 'That is not identity: another researcher with this name at this institution would match too.',
  name_only: 'This name is on the paper. That is the entire claim: resmon cannot tell you it is this person.',
};

/** A basis in words; an unknown one is shown as stored rather than guessed at. */
export function basisWords(basis: string): string {
  return BASIS_LABEL[basis] ?? basis;
}

/**
 * The sentence a saved profile will carry, said while it is still being
 * typed: a warning after saving is a warning about a decision already made.
 *
 * Verbatim from `watch_profiles.basis_warning_for`, less its two markdown
 * emphasis markers. Do not reword either string without changing that
 * function in the same pull request: `test_watch_profiles.py` reads this file
 * and fails when they drift.
 */
export function livePreviewWarning(orcid: string, affiliations: string[]): string | null {
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

/** The short chip a saved profile carries in a list, from its own warning. */
export function profileChip(profile: Pick<Profile, 'basis_warning' | 'identifiers' | 'affiliations'>): string {
  if (!profile.basis_warning) return 'ORCID';
  return profile.affiliations.length ? 'name + affiliation' : 'name only';
}

export function lines(text: string): string[] {
  return text.split('\n').map((v) => v.trim()).filter(Boolean);
}

/**
 * Whether a match's evidence is worth showing on its row. Most say only that
 * the name matched, which the chip already says; an ambiguous single-token
 * name and a conflicting ORCID are the ones a person must see. A match made
 * before the current matching policy says that instead.
 */
export function evidenceToShow(evidence: string | null): string | null {
  if (!evidence?.startsWith('Matching policy 2026-09-07: ')) {
    return 'Historical match: not rechecked under the current matching policy.';
  }
  if (evidence.includes('ambiguous single-token name') || evidence.includes('conflicting ORCID')) return evidence;
  return null;
}
