import React from 'react';

/**
 * "also appears in {source}" — the badge on a paper resmon has seen twice.
 *
 * Rendered inline rather than behind a disclosure, unlike `WhyThisPaper` and
 * `SimilarPapers`. The reason is the difference between a question and a fact:
 * those two answer something a reader might wonder, and cost a request to open.
 * This one is telling a reader that the list in front of them counts a paper
 * twice, which they need to know *before* they decide whether to read it — and
 * it costs nothing, because a page of links arrives in the same round trip as
 * the page of results.
 *
 * **It never implies the row was adjusted.** Both records stay, both counts
 * stay. The badge is an assertion laid beside them, and the collapse control
 * that acts on it is off until a reader turns it on.
 *
 * The method is in the wording, not in a tooltip: "same DOI" is a fact about an
 * identifier and "near-identical title" is an inference from text, and a reader
 * deciding whether to trust the claim needs to know which one they have.
 */

export interface DuplicateLink {
  id: number;
  title: string;
  source_repository: string;
  kind: string;
  score: number | null;
  method: string;
  label: string;
}

interface Props {
  links: DuplicateLink[];
  /** Called when the reader clicks through to the other record. */
  onOpen?: (documentId: number) => void;
}

const DuplicateLinks: React.FC<Props> = ({ links, onOpen }) => {
  if (!links.length) return null;
  return (
    <p className="duplicate-links" data-testid="duplicate-links">
      {links.map((link) => (
        <span key={link.id} className="duplicate-link">
          <span
            className={`duplicate-badge duplicate-badge-${link.method}`}
            title={
              link.method === 'shared_doi'
                ? 'These two records carry the same DOI, so they name the same work.'
                : 'These two have near-identical titles and closely related text. '
                  + 'That is an inference, not an identifier.'
            }
          >
            {link.method === 'shared_doi' ? 'same DOI' : 'likely duplicate'}
          </span>
          {onOpen ? (
            <button type="button" className="duplicate-link-text"
                    onClick={() => onOpen(link.id)}>
              {link.label}
            </button>
          ) : (
            <span className="duplicate-link-text">{link.label}</span>
          )}
        </span>
      ))}
    </p>
  );
};

export default DuplicateLinks;
