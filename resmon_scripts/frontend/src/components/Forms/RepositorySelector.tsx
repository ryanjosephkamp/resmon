import React, { useEffect, useState } from 'react';
import { apiClient } from '../../api/client';
import InfoTooltip from '../Help/InfoTooltip';

interface Props {
  mode: 'single' | 'multi';
  value: string | string[];
  onChange: (value: string | string[]) => void;
}

const RepositorySelector: React.FC<Props> = ({ mode, value, onChange }) => {
  const [repositories, setRepositories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<string[]>('/api/search/repositories')
      .then(setRepositories)
      .catch(() => {
        setRepositories([
          'arxiv', 'biorxiv', 'core', 'crossref', 'dblp', 'doaj',
          'europepmc', 'hal', 'ieee', 'nasa_ads', 'openalex', 'plos',
          'pubmed', 'semantic_scholar', 'springer',
        ]);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="form-field"><span className="text-muted">Loading repositories…</span></div>;
  }

  if (mode === 'single') {
    return (
      <div className="form-field">
        <label className="form-label">
          Repository
          <InfoTooltip text="The single scholarly repository to query. Keyed repositories (CORE, IEEE Xplore, NASA ADS) will prompt you for an ephemeral API key if none is stored. See the Repositories page for subject coverage and rate limits." />
        </label>
        <select
          className="form-select"
          value={value as string}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Select a repository</option>
          {repositories.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>
    );
  }

  const selected = value as string[];

  const handleToggle = (repo: string) => {
    if (selected.includes(repo)) {
      onChange(selected.filter((r) => r !== repo));
    } else {
      onChange([...selected, repo]);
    }
  };

  const handleSelectAll = () => {
    if (selected.length === repositories.length) {
      onChange([]);
    } else {
      onChange([...repositories]);
    }
  };

  return (
    <div className="form-field">
      <label className="form-label">
        Repositories
        <InfoTooltip text="Every selected repository is queried in parallel (subject to the Concurrent Executions limit in Settings → Advanced). Keyed repositories are silently skipped if no key is stored for them in this scope." />
      </label>
      <div className="repo-multi-header">
        <button type="button" className="btn btn-sm" onClick={handleSelectAll}>
          {selected.length === repositories.length ? 'Deselect All' : 'Select All'}
        </button>
        <span className="text-muted">{selected.length} of {repositories.length} selected</span>
      </div>
      <div className="repo-checkbox-grid">
        {repositories.map((r) => (
          <label key={r} className="checkbox-label">
            <input
              type="checkbox"
              checked={selected.includes(r)}
              onChange={() => handleToggle(r)}
            />
            <span>{r}</span>
          </label>
        ))}
      </div>
    </div>
  );
};

export default RepositorySelector;
