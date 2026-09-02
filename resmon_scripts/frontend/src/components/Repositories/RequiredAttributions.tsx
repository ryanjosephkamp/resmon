import React from 'react';
import { RepoCatalogEntry } from '../../api/repositories';

interface Props {
  catalog: RepoCatalogEntry[];
}

/**
 * The credits resmon is obliged to display, shown unconditionally.
 *
 * Four of the sources resmon queries make attribution a condition of reuse
 * rather than a courtesy — OpenAIRE's Graph metadata is CC BY, PLOS's API
 * display policy names an exact phrase, CORE asks discovery products to carry
 * its snippet, and the Semantic Scholar API license requires its credit. Until
 * v1.8.2 resmon met none of them: the obligations were real, the catalog knew
 * nothing about them, and nothing was rendered anywhere.
 *
 * This block is deliberately *not* collapsible and not behind a card
 * expansion. A credit that only appears when the user goes looking for it is
 * not displayed in any sense the obligation means. Sources whose credit is
 * merely requested are shown on their own detail panel instead — putting them
 * here would imply resmon is compelled to show them, which is its own kind of
 * overclaim.
 */
const RequiredAttributions: React.FC<Props> = ({ catalog }) => {
  const required = catalog
    .filter((e) => e.attribution_requirement === 'required' && e.attribution)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (required.length === 0) return null;

  return (
    <section className="required-attributions" data-testid="required-attributions">
      <h2 className="required-attributions__heading">Attributions</h2>
      <p className="text-muted">
        These sources make a credit a condition of using their data, so resmon shows it
        here whether or not you have queried them. Sources that merely ask for a credit
        are listed on their own row instead.
      </p>
      <ul className="required-attributions__list">
        {required.map((entry) => (
          <li key={entry.slug} data-testid={`attribution-${entry.slug}`}>
            <span className="required-attributions__credit">{entry.attribution}</span>
            <span className="text-muted">
              {' '}&mdash; {entry.name}
              {entry.attribution_source && (
                <>
                  {' ('}
                  <a
                    href={entry.attribution_source}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    terms
                  </a>
                  {')'}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default RequiredAttributions;
