import React, { useState } from 'react';
import { apiClient } from '../api/client';
import { useExecution } from '../context/ExecutionContext';
import RepositorySelector from '../components/Forms/RepositorySelector';
import DateRangePicker from '../components/Forms/DateRangePicker';
import KeywordInput from '../components/Forms/KeywordInput';
import ConfigLoader from '../components/Forms/ConfigLoader';
import { notifyConfigurationsChanged } from '../lib/configurationsBus';
import RepoKeyStatus from '../components/Repositories/RepoKeyStatus';
import KeywordCombinationBanner from '../components/Forms/KeywordCombinationBanner';
import { useRepoCatalog } from '../hooks/useRepoCatalog';
import PageHelp from '../components/Help/PageHelp';
import InfoTooltip from '../components/Help/InfoTooltip';

const DeepSweepPage: React.FC = () => {
  const { activeExecutions, startExecution } = useExecution();
  const pageExecIdRef = React.useRef<number | null>(null);
  const pageExec =
    pageExecIdRef.current !== null ? activeExecutions[pageExecIdRef.current] : undefined;
  React.useEffect(() => {
    if (pageExec && pageExec.status !== 'running' && pageExec.status !== 'cancelling') {
      pageExecIdRef.current = null;
    }
  }, [pageExec?.status]);
  const { bySlug, presence, refreshPresence } = useRepoCatalog();
  const [ephemeralKeys, setEphemeralKeys] = useState<Record<string, string>>({});
  const [repositories, setRepositories] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [maxResults, setMaxResults] = useState(100);
  const [aiEnabled, setAiEnabled] = useState(false);
  // IMPL-AI13: per-execution overrides. Only non-empty values are sent.
  const [aiOverrideLength, setAiOverrideLength] = useState('');
  const [aiOverrideTone, setAiOverrideTone] = useState('');
  const [aiOverrideModel, setAiOverrideModel] = useState('');
  const [error, setError] = useState('');
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [configName, setConfigName] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [configRefresh, setConfigRefresh] = useState(0);

  // Populate form fields from a saved manual_sweep configuration. Date range
  // is intentionally skipped — users must choose it fresh per run.
  const applyConfig = (p: Record<string, any>) => {
    if (Array.isArray(p.repositories)) setRepositories(p.repositories);
    if (Array.isArray(p.keywords)) setKeywords(p.keywords);
    if (typeof p.max_results === 'number') setMaxResults(p.max_results);
    if (typeof p.ai_enabled === 'boolean') setAiEnabled(p.ai_enabled);
  };

  const running =
    pageExecIdRef.current !== null &&
    activeExecutions[pageExecIdRef.current]?.status === 'running';
  const buildQuery = () => keywords.join(' ');

  const handleRun = async () => {
    if (repositories.length === 0) { setError('Please select at least one repository.'); return; }
    if (keywords.length === 0) { setError('Please enter at least one keyword.'); return; }
    setError('');
    try {
      // IMPL-AI13: optional per-execution overrides.
      const overrides: Record<string, string> = {};
      if (aiOverrideLength) overrides.length = aiOverrideLength;
      if (aiOverrideTone) overrides.tone = aiOverrideTone;
      if (aiOverrideModel.trim()) overrides.model = aiOverrideModel.trim();
      const body: Record<string, any> = {
        repositories,
        query: buildQuery(),
        keywords,
        date_from: dateFrom || null,
        date_to: dateTo || null,
        max_results: maxResults,
        ai_enabled: aiEnabled,
        ephemeral_credentials: Object.fromEntries(
          Object.entries(ephemeralKeys).filter(([, v]) => v.trim().length > 0),
        ),
      };
      if (Object.keys(overrides).length > 0) body.ai_settings = overrides;
      const resp = await apiClient.post<{ execution_id: number }>('/api/search/sweep', body);
      pageExecIdRef.current = resp.execution_id;
      startExecution(resp.execution_id, 'deep_sweep', repositories);
    } catch (err: any) {
      setError(err.message || 'Failed to start sweep.');
    }
  };

  const handleSaveConfig = async () => {
    if (!configName.trim()) return;
    try {
      await apiClient.post('/api/configurations', {
        name: configName.trim(),
        config_type: 'manual_sweep',
        parameters: {
          repositories,
          date_from: dateFrom,
          date_to: dateTo,
          keywords,
          max_results: maxResults,
          ai_enabled: aiEnabled,
        },
      });
      setSaveStatus('Configuration saved.');
      setSaveModalOpen(false);
      setConfigName('');
      setConfigRefresh((n) => n + 1);
      // Notify ConfigLoader instances on other pages that a new config exists.
      notifyConfigurationsChanged();
      setTimeout(() => setSaveStatus(''), 3000);
    } catch (err: any) {
      setSaveStatus(`Error: ${err.message}`);
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Deep Sweep</h1>
        <p className="text-muted">Multi-repository broad query</p>
      </div>

      <PageHelp
        storageKey="deep-sweep"
        title="Deep Sweep"
        summary="Run a one-off search across many repositories in parallel."
        sections={[
          {
            heading: 'When to use this page',
            body: (
              <p>
                Use <strong>Deep Sweep</strong> to cast a wide net across every
                repository relevant to your topic in a single run. Results are
                merged and de-duplicated by DOI / title + first-author. For a
                thorough look at a single repository, use <strong>Deep Dive</strong> instead.
              </p>
            ),
          },
          {
            heading: 'How to use it',
            body: (
              <ol>
                <li>Select the repositories to query. Each row in the Key Status panel tells you whether a key is stored, needed, or absent for this run.</li>
                <li>Optionally restrict the date range.</li>
                <li>Enter one or more keywords (press Enter after each).</li>
                <li>Adjust the <strong>per-repository</strong> results cap and, if desired, enable AI summarization.</li>
                <li>Click <strong>Run Deep Sweep</strong>. Repositories are queried concurrently (subject to the Concurrent Executions limit in Settings → Advanced).</li>
              </ol>
            ),
          },
          {
            heading: 'Tips',
            body: (
              <ul>
                <li>Save the configuration once you are happy with it; routines reuse the same shape.</li>
                <li>Key-less repositories (arXiv, CrossRef, OpenAlex, bioRxiv, medRxiv, etc.) always work; keyed repositories (CORE, IEEE Xplore, NASA ADS) require a stored or ephemeral key.</li>
              </ul>
            ),
          },
        ]}
      />

      <form className="form-card" onSubmit={(e) => { e.preventDefault(); handleRun(); }}>
        <ConfigLoader configType="manual_sweep" onLoad={applyConfig} refreshKey={configRefresh} />
        <RepositorySelector mode="multi" value={repositories} onChange={(v) => setRepositories(v as string[])} />
        {repositories.length > 0 && (
          <KeywordCombinationBanner
            entries={repositories.map((slug) => bySlug[slug]).filter(Boolean)}
          />
        )}
        {repositories.length > 0 && (
          <div className="form-field">
            <label className="form-label">Key Status</label>
            <div className="repo-key-status-stack">
              {repositories.map((slug) => {
                const entry = bySlug[slug];
                if (!entry) return null;
                const credName = entry.credential_name;
                return (
                  <RepoKeyStatus
                    key={slug}
                    entry={entry}
                    present={!!(credName && presence[credName]?.present)}
                    ephemeralValue={credName ? (ephemeralKeys[credName] || '') : ''}
                    onEphemeralChange={(v) => {
                      if (!credName) return;
                      setEphemeralKeys((prev) => ({ ...prev, [credName]: v }));
                    }}
                    onPresenceChange={() => { void refreshPresence(); }}
                    variant="sweep"
                  />
                );
              })}
            </div>
          </div>
        )}
        <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} onDateFromChange={setDateFrom} onDateToChange={setDateTo} />
        <KeywordInput keywords={keywords} onChange={setKeywords} />

        <div className="form-field">
          <label className="form-label">
            Max Results (per repository)
            <InfoTooltip text="Upper bound per repository. A sweep across five repositories with cap 100 retrieves up to 500 records total before de-duplication." />
          </label>
          <div className="range-row">
            <input
              type="range"
              min={10}
              max={500}
              step={10}
              value={maxResults}
              onChange={(e) => setMaxResults(Number(e.target.value))}
            />
            <span className="range-value">{maxResults}</span>
          </div>
        </div>

        <div className="form-field">
          <label className="checkbox-label">
            <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} />
            <span>Enable AI Summarization</span>
            <InfoTooltip text="When enabled, resmon sends each result's abstract to the configured LLM provider and attaches a concise summary to the report. Requires an API key (or local model) in Settings → AI." />
          </label>
        </div>

        {aiEnabled && (
          <details className="form-field">
            <summary>Override AI settings for this run</summary>
            <div className="form-field">
              <label className="form-label">Length</label>
              <select className="form-select" value={aiOverrideLength} onChange={(e) => setAiOverrideLength(e.target.value)}>
                <option value="">Use app default</option>
                <option value="brief">Brief</option>
                <option value="standard">Standard</option>
                <option value="detailed">Detailed</option>
              </select>
            </div>
            <div className="form-field">
              <label className="form-label">Tone</label>
              <select className="form-select" value={aiOverrideTone} onChange={(e) => setAiOverrideTone(e.target.value)}>
                <option value="">Use app default</option>
                <option value="technical">Technical</option>
                <option value="neutral">Neutral</option>
                <option value="accessible">Accessible</option>
              </select>
            </div>
            <div className="form-field">
              <label className="form-label">Model</label>
              <input
                className="form-input"
                value={aiOverrideModel}
                onChange={(e) => setAiOverrideModel(e.target.value)}
                placeholder="Model ID (optional)"
              />
            </div>
          </details>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            {running ? 'Run Another' : 'Run Deep Sweep'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setSaveModalOpen(true)}>
            Save Configuration
          </button>
        </div>

        {saveStatus && <div className="form-success">{saveStatus}</div>}
      </form>

      {pageExec && pageExec.status !== 'running' && pageExec.status !== 'cancelling' && (
        <div className={`result-card ${pageExec.status === 'completed' ? 'result-success' : 'result-failure'}`}>
          <h2>Execution #{pageExec.executionId}</h2>
          <div className="result-stats">
            <span>Status: <strong>{pageExec.status}</strong></span>
            <span>Results: <strong>{pageExec.resultCount}</strong></span>
            <span>New: <strong>{pageExec.newCount}</strong></span>
            {pageExec.elapsedSeconds !== undefined && <span>Time: <strong>{pageExec.elapsedSeconds.toFixed(1)}s</strong></span>}
          </div>
          <a className="btn btn-sm" href={`#/results?exec=${pageExec.executionId}`}>View Report</a>
        </div>
      )}

      {saveModalOpen && (
        <div className="modal-overlay" onClick={() => setSaveModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Save Configuration</h3>
            <div className="form-field">
              <label className="form-label">Configuration Name</label>
              <input
                type="text"
                className="form-input"
                value={configName}
                onChange={(e) => setConfigName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={handleSaveConfig}>Save</button>
              <button className="btn btn-secondary" onClick={() => setSaveModalOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DeepSweepPage;
