import React from 'react';
import { RepoCatalogEntry } from '../../api/repositories';

interface Props {
  entry: RepoCatalogEntry;
}

const REQUIREMENT_LABEL: Record<RepoCatalogEntry['api_key_requirement'], string> = {
  none: 'Not required',
  required: 'Required',
  optional: 'Optional',
  recommended: 'Recommended',
};

// No click handler on purpose. These used to call ``resmonAPI.openPath``,
// which sends the URL to the system browser — while the attribution links a
// few hundred pixels up the same page opened in an in-app window. Two
// behaviors for the same kind of link.
//
// Letting the anchor do its ordinary thing routes it through the main
// process's window-open handler, which is now the single place external links
// are decided. One rule, one implementation.
const ExternalLink: React.FC<{ href: string; label?: string }> = ({ href, label }) => (
  <a href={href} target="_blank" rel="noreferrer noopener">
    {label ?? href}
  </a>
);

const RepoDetailsPanel: React.FC<Props> = ({ entry }) => {
  return (
    <div className="details-panel">
      <dl className="details-grid">
        <dt>Description</dt>
        <dd>{entry.description || '—'}</dd>

        <dt>API Key Req?</dt>
        <dd>{REQUIREMENT_LABEL[entry.api_key_requirement]}</dd>

        <dt>Rate Limit (resmon)</dt>
        <dd>{entry.rate_limit || '—'}</dd>

        {entry.upstream_policy && (
          <>
            <dt>Upstream Policy</dt>
            <dd>{entry.upstream_policy}</dd>
          </>
        )}

        {entry.parallel_safe && (
          <>
            <dt>Parallel-Safe?</dt>
            <dd>{entry.parallel_safe}</dd>
          </>
        )}

        <dt>Endpoint</dt>
        <dd><code>{entry.endpoint || '—'}</code></dd>

        <dt>Query Method</dt>
        <dd>{entry.query_method || '—'}</dd>

        <dt>Credential Name</dt>
        <dd>{entry.credential_name ? <code>{entry.credential_name}</code> : '—'}</dd>

        <dt>Website</dt>
        <dd>{entry.website ? <ExternalLink href={entry.website} /> : '—'}</dd>

        {entry.registration_url && (
          <>
            <dt>Register for API Key</dt>
            <dd><ExternalLink href={entry.registration_url} /></dd>
          </>
        )}

        {entry.notes && (
          <>
            <dt>Notes</dt>
            <dd>{entry.notes}</dd>
          </>
        )}

        {entry.keyword_combination && (
          <>
            <dt>Effective Default Keyword Combination</dt>
            <dd>{entry.keyword_combination}</dd>
          </>
        )}

        {entry.keyword_combination_notes && (
          <>
            <dt>Keyword Combination Notes</dt>
            <dd>{entry.keyword_combination_notes}</dd>
          </>
        )}

        {entry.attribution && (
          <>
            <dt>
              {entry.attribution_requirement === 'required'
                ? 'Attribution (required)'
                : 'Attribution (requested)'}
            </dt>
            <dd>
              <span className="attribution-credit">{entry.attribution}</span>
              {entry.attribution_requirement === 'required' ? (
                <p className="attribution-note">
                  A condition of this source's license, not a courtesy. resmon shows it on
                  this page for every source that requires it.
                </p>
              ) : (
                <p className="attribution-note">
                  The upstream asks for this credit but does not make it a condition of
                  reuse.
                </p>
              )}
              {entry.attribution_source && (
                <p className="attribution-note">
                  Stated at <ExternalLink href={entry.attribution_source} />
                </p>
              )}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
};

export default RepoDetailsPanel;
