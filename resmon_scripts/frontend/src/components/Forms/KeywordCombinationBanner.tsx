import React from 'react';
import { RepoCatalogEntry } from '../../api/repositories';
import InfoTooltip from '../Help/InfoTooltip';

interface Props {
  /** Repositories whose keyword-combination behavior should be surfaced. */
  entries: RepoCatalogEntry[];
}

/**
 * Compact banner that surfaces the upstream keyword-combination semantics
 * for the currently-selected repositor(ies). Mounted under the
 * RepositorySelector on Deep Dive, Deep Sweep, and Routines.
 */
const KeywordCombinationBanner: React.FC<Props> = ({ entries }) => {
  const visible = entries.filter((e) => e && (e.keyword_combination || '').trim().length > 0);
  if (visible.length === 0) return null;
  return (
    <div className="form-field" data-testid="keyword-combination-banner">
      <label className="form-label">
        Keyword combination
        <InfoTooltip text="How each selected repository combines the space-separated keywords you enter. Definitions of every term are listed in the consolidated glossary on the Repositories & API Keys page." />
      </label>
      <ul className="repo-key-status-stack" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
        {visible.map((entry) => (
          <li key={entry.slug} style={{ marginBottom: 4 }}>
            <strong>{entry.name}:</strong>{' '}
            <span>{entry.keyword_combination}</span>
            {entry.keyword_combination_notes && (
              <>
                {' '}
                <InfoTooltip text={entry.keyword_combination_notes} ariaLabel={`${entry.name} keyword combination details`} />
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

export default KeywordCombinationBanner;
