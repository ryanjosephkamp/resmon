import React from 'react';
import { DocumentMatch, MatchBasis } from '../../api/profiles';

/**
 * Why resmon thinks this paper is that person's.
 *
 * **This component is the whole of phase 2.1's rule made visible.** An author
 * match is a string match unless the source gave an identifier, and the product
 * says so on every paper. Until this existed the basis was stored on every match
 * row and shown nowhere, which meant the constraint "`name_only` is never
 * presented as the person" was kept by nothing at all — there was no
 * presentation to keep it in.
 *
 * The three bases are deliberately not a severity scale with one alarming end.
 * They are three different *claims*, and the wording says which claim is being
 * made rather than how worried to be:
 *
 *   identifier        the source returned this profile's ORCID on this paper
 *   name+affiliation  a name matched and an affiliation matched — not identity
 *   name_only         this name is on the paper, and that is the entire claim
 *
 * `name_only` is the common case and is not an error. Colouring it as one would
 * train a user to ignore the colour, and then the distinction that matters —
 * that only the first is evidence of identity — goes unread too. So the two
 * weaker bases are muted and the strongest is the one that stands out, which is
 * the opposite of the lifecycle badge's arrangement and is right for the
 * opposite reason.
 */

export const BASIS_LABEL: Record<MatchBasis, string> = {
  identifier: 'ORCID match',
  'name+affiliation': 'name + affiliation',
  name_only: 'name only',
};

/** The sentence, in full, for a tooltip and for the profile page's legend. */
export const BASIS_MEANING: Record<MatchBasis, string> = {
  identifier:
    'The source returned this profile’s ORCID on this paper. This is evidence '
    + 'of identity.',
  'name+affiliation':
    'A name matched and an affiliation on the record matched one of this '
    + 'profile’s. That is not identity: another researcher with this name at '
    + 'this institution would match too.',
  name_only:
    'This name is on the paper. That is the entire claim — resmon cannot tell '
    + 'you it is this person.',
};

/** Old rows remain untouched; only freshly evaluated evidence has this prefix. */
export const isHistoricalMatch = (evidence: string | null): boolean =>
  !evidence?.startsWith('Matching policy 2026-09-07: ');

export const MatchEvidence: React.FC<{ evidence: string | null; expanded?: boolean }> =
  ({ evidence, expanded }) => (
    <>
      {isHistoricalMatch(evidence) && (
        <span className="basis-history">Historical match — not rechecked under the current matching policy.</span>
      )}
      {evidence && (expanded || evidence.includes('ambiguous single-token name')
        || evidence.includes('conflicting ORCID')) && (
        <span className="basis-evidence">{evidence}</span>
      )}
    </>
  );

interface Props {
  matches: DocumentMatch[];
  /** Off in dense lists, where the profile name alone is enough. */
  showEvidence?: boolean;
}

const BasisBadge: React.FC<Props> = ({ matches, showEvidence }) => {
  if (!matches || matches.length === 0) return null;

  return (
    <ul className="basis-matches" data-testid="basis-matches">
      {matches.map((m) => (
        <li
          key={`${m.profile_id}:${m.basis}`}
          className={`basis-match basis-${m.basis.replace('+', '-')}`}
        >
          <span className="basis-chip" title={BASIS_MEANING[m.basis]}>
            {BASIS_LABEL[m.basis]}
          </span>
          <span className="basis-profile">{m.display_name}</span>
          {m.matched_author && (
            /*
              The string the source actually returned, shown verbatim. It is
              what makes a name match auditable: "J. Smith" beside a profile
              named "John Smith" tells the reader exactly how weak the match is,
              and no summary of ours could say it better.
            */
            <span className="basis-author">matched “{m.matched_author}”</span>
          )}
          <MatchEvidence evidence={m.evidence} expanded={showEvidence} />
        </li>
      ))}
    </ul>
  );
};

export default BasisBadge;
