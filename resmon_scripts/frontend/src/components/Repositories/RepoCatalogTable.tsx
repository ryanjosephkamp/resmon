import React, { useState } from 'react';
import ApiKeyField from './ApiKeyField';
import RepoDetailsPanel from './RepoDetailsPanel';
import {
  repositoriesApi,
  RepoCatalogEntry,
  CredentialPresenceMap,
  CredentialScope,
} from '../../api/repositories';

interface Props {
  catalog: RepoCatalogEntry[];
  presence: CredentialPresenceMap;
  onPresenceRefresh: () => void;
  /** Which credential store to read/write — local OS keyring (default) or the
   *  signed-in cloud account. Defaults to 'local' for backward compatibility. */
  scope?: CredentialScope;
}

const RepoCatalogTable: React.FC<Props> = ({ catalog, presence, onPresenceRefresh, scope = 'local' }) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [inlineValues, setInlineValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const toggleRow = (slug: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const expandAll = () => setExpanded(new Set(catalog.map((e) => e.slug)));
  const collapseAll = () => setExpanded(new Set());

  const setInline = (slug: string, value: string) =>
    setInlineValues((prev) => ({ ...prev, [slug]: value }));

  const setError = (slug: string, message: string) =>
    setErrors((prev) => ({ ...prev, [slug]: message }));

  const handleSave = async (entry: RepoCatalogEntry) => {
    if (!entry.credential_name) return;
    const value = (inlineValues[entry.slug] || '').trim();
    if (!value) return;
    try {
      if (scope === 'cloud') {
        await repositoriesApi.putCloudCredential(entry.credential_name, value);
      } else {
        await repositoriesApi.saveCredential(entry.credential_name, value);
      }
      setInline(entry.slug, '');
      setError(entry.slug, '');
      onPresenceRefresh();
    } catch (err: any) {
      setError(entry.slug, err?.message || 'Save failed.');
    }
  };

  const handleClear = async (entry: RepoCatalogEntry) => {
    if (!entry.credential_name) return;
    try {
      if (scope === 'cloud') {
        await repositoriesApi.deleteCloudCredential(entry.credential_name);
      } else {
        await repositoriesApi.deleteCredential(entry.credential_name);
      }
      setError(entry.slug, '');
      onPresenceRefresh();
    } catch (err: any) {
      setError(entry.slug, err?.message || 'Clear failed.');
    }
  };

  const keyForEntry = (entry: RepoCatalogEntry): boolean =>
    !!(entry.credential_name && presence[entry.credential_name]?.present);

  return (
    <>
      <div className="form-actions" style={{ marginBottom: 12 }}>
        <button type="button" className="btn btn-sm btn-secondary" onClick={expandAll}>
          Expand All
        </button>
        <button type="button" className="btn btn-sm btn-secondary" onClick={collapseAll}>
          Collapse All
        </button>
      </div>

      <table className="simple-table">
        <thead>
          <tr>
            <th style={{ width: '28%' }}>Repo (Click to Expand)</th>
            <th style={{ width: '32%' }}>Subject Coverage</th>
            <th>API Key</th>
          </tr>
        </thead>
        <tbody>
          {catalog.map((entry) => {
            const isOpen = expanded.has(entry.slug);
            const present = keyForEntry(entry);
            const needsKey = entry.api_key_requirement !== 'none';
            return (
              <React.Fragment key={entry.slug}>
                <tr>
                  <td>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-expanded={isOpen}
                      className="repo-row-toggle"
                      onClick={() => toggleRow(entry.slug)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleRow(entry.slug);
                        }
                      }}
                    >
                      <span className="repo-row-caret">{isOpen ? '▾' : '▸'}</span>
                      {entry.name}
                    </span>
                  </td>
                  <td>{entry.subject_coverage || '—'}</td>
                  <td>
                    {needsKey ? (
                      <div className="repo-keycell">
                        <ApiKeyField
                          present={present}
                          value={inlineValues[entry.slug] || ''}
                          onChange={(v) => setInline(entry.slug, v)}
                          onSave={() => handleSave(entry)}
                          onClear={() => handleClear(entry)}
                          placeholder={entry.placeholder || 'Enter API key'}
                          ariaLabel={`API key for ${entry.name}`}
                        />
                        {errors[entry.slug] && (
                          <div className="form-error">{errors[entry.slug]}</div>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted">Not required</span>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="repo-details-row">
                    <td colSpan={3}>
                      <RepoDetailsPanel entry={entry} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
};

export default RepoCatalogTable;
