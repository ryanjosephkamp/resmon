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
import AIOverridePanel, {
  AIOverrideValue,
  EMPTY_AI_OVERRIDE,
  buildAIOverridePayload,
} from '../components/Forms/AIOverridePanel';
import AIDefaultsInfo from '../components/Forms/AIDefaultsInfo';

const DeepDivePage: React.FC = () => {
  const { activeExecutions, startExecution } = useExecution();
  const pageExecIdRef = React.useRef<number | null>(null);
  const pageExec =
    pageExecIdRef.current !== null ? activeExecutions[pageExecIdRef.current] : undefined;
  // Reset the ref as soon as our page's execution reaches a terminal state
  // so the form becomes submittable again without a page reload.
  React.useEffect(() => {
    if (pageExec && pageExec.status !== 'running' && pageExec.status !== 'cancelling') {
      pageExecIdRef.current = null;
    }
  }, [pageExec?.status]);
  const { bySlug, presence, refreshPresence } = useRepoCatalog();
  const [ephemeralKeys, setEphemeralKeys] = useState<Record<string, string>>({});
  const [repository, setRepository] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [maxResults, setMaxResults] = useState(100);
  const [aiEnabled, setAiEnabled] = useState(false);
  // Update 2 — Feature 2: full per-execution AI override (Provider /
  // Model / Length / Tone / Temperature / Extraction Goals). Empty
  // fields are dropped before posting so they don't clobber persisted
  // app-wide defaults during the backend per-field merge.
  const [aiOverride, setAiOverride] = useState<AIOverrideValue>(EMPTY_AI_OVERRIDE);
  const [error, setError] = useState('');
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [configName, setConfigName] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [configRefresh, setConfigRefresh] = useState(0);

  // Populate form fields from a saved manual_dive configuration. The date
  // range is intentionally skipped — users must choose it fresh per run.
  const applyConfig = (p: Record<string, any>) => {
    if (typeof p.repository === 'string') setRepository(p.repository);
    if (Array.isArray(p.keywords)) setKeywords(p.keywords);
    if (typeof p.max_results === 'number') setMaxResults(p.max_results);
    if (typeof p.ai_enabled === 'boolean') setAiEnabled(p.ai_enabled);
  };

  const running =
    pageExecIdRef.current !== null &&
    activeExecutions[pageExecIdRef.current]?.status === 'running';
  const buildQuery = () => keywords.join(' ');

  const handleRun = async () => {
    if (!repository) { setError('Please select a repository.'); return; }
    if (keywords.length === 0) { setError('Please enter at least one keyword.'); return; }
    setError('');
    try {
      // IMPL-AI13 / Update 2 Feature 2: build optional ai_settings
      // overlay from the disclosure inputs.
      const overrides = buildAIOverridePayload(aiOverride);
      const body: Record<string, any> = {
        repository,
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
      const resp = await apiClient.post<{ execution_id: number }>('/api/search/dive', body);
      pageExecIdRef.current = resp.execution_id;
      startExecution(resp.execution_id, 'deep_dive', [repository]);
    } catch (err: any) {
      setError(err.message || 'Failed to start dive.');
    }
  };

  const handleSaveConfig = async () => {
    if (!configName.trim()) return;
    try {
      await apiClient.post('/api/configurations', {
        name: configName.trim(),
        config_type: 'manual_dive',
        parameters: {
          repository,
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
        <h1>Deep Dive</h1>
        <p className="text-muted">Targeted single-repository query</p>
      </div>

      <PageHelp
        storageKey="deep-dive"
        title="Deep Dive"
        summary="Run a one-off, in-depth search of a single repository."
        sections={[
          {
            heading: 'When to use this page',
            body: (
              <p>
                Use <strong>Deep Dive</strong> when you want the most thorough
                look at a single repository — for example, exhausting every
                arXiv hit for a narrow topic. For a broad sweep across many
                repositories at once, use <strong>Deep Sweep</strong> instead.
              </p>
            ),
          },
          {
            heading: 'How to use it',
            body: (
              <ol>
                <li>Pick a repository. If it requires an API key, the key-status panel will tell you whether a key is already stored or needs to be provided for this run.</li>
                <li>Optionally restrict the date range.</li>
                <li>Enter one or more keywords (press Enter after each).</li>
                <li>Adjust the results cap and, if desired, enable AI summarization.</li>
                <li>Click <strong>Run Deep Dive</strong>. Progress streams to the Monitor page and the floating widget.</li>
                <li>Click <strong>Save Configuration</strong> to reuse the same parameters later (the date range is intentionally not saved — set it fresh per run).</li>
              </ol>
            ),
          },
        ]}
      />

      <form className="form-card" onSubmit={(e) => { e.preventDefault(); handleRun(); }}>
        <ConfigLoader configType="manual_dive" onLoad={applyConfig} refreshKey={configRefresh} />
        <RepositorySelector mode="single" value={repository} onChange={(v) => setRepository(v as string)} />
        {repository && bySlug[repository] && (
          <KeywordCombinationBanner entries={[bySlug[repository]]} />
        )}
        {repository && bySlug[repository] && (
          <RepoKeyStatus
            entry={bySlug[repository]}
            present={!!(bySlug[repository].credential_name && presence[bySlug[repository].credential_name!]?.present)}
            ephemeralValue={ephemeralKeys[bySlug[repository].credential_name || ''] || ''}
            onEphemeralChange={(v) => {
              const name = bySlug[repository].credential_name;
              if (!name) return;
              setEphemeralKeys((prev) => ({ ...prev, [name]: v }));
            }}
            onPresenceChange={() => { void refreshPresence(); }}
            variant="dive"
          />
        )}
        <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} onDateFromChange={setDateFrom} onDateToChange={setDateTo} />
        <KeywordInput keywords={keywords} onChange={setKeywords} />

        <div className="form-field">
          <label className="form-label">
            Max Results
            <InfoTooltip text="Upper bound on the number of records to retrieve from this repository. Lower values finish faster and are gentler on the API; higher values give broader coverage. Repositories return fewer than this if the query has fewer matches." />
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
            <InfoTooltip text="When enabled, resmon sends each result's abstract to the configured LLM provider and attaches a concise summary to the report. Requires an API key (or local model) in Settings → AI. Consumes tokens / quota on every run." />
          </label>
        </div>

        {aiEnabled && <AIDefaultsInfo />}

        {aiEnabled && (
          <details className="form-field">
            <summary>Override AI settings for this run</summary>
            <AIOverridePanel value={aiOverride} onChange={setAiOverride} />
          </details>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            {running ? 'Run Another' : 'Run Deep Dive'}
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
            <span>Time: <strong>{pageExec.elapsedSeconds.toFixed(1)}s</strong></span>
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
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && configName.trim()) {
                    e.preventDefault();
                    handleSaveConfig();
                  }
                }}
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

export default DeepDivePage;
