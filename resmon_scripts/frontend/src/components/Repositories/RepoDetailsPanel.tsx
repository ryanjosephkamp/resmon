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

function openExternal(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  const opener = window.resmonAPI?.openPath;
  if (opener) {
    e.preventDefault();
    void opener(href);
  }
}

const ExternalLink: React.FC<{ href: string; label?: string }> = ({ href, label }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer noopener"
    onClick={(e) => openExternal(e, href)}
  >
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
      </dl>
    </div>
  );
};

export default RepoDetailsPanel;
