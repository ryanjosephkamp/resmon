import React, { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../../api/client';
import { cloudClient } from '../../api/cloudClient';
import { useAuth } from '../../context/AuthContext';
import { useExecution } from '../../context/ExecutionContext';
import RepositorySelector from '../Forms/RepositorySelector';
import DateRangePicker from '../Forms/DateRangePicker';
import KeywordInput from '../Forms/KeywordInput';
import ScheduleConfigurator, { StructuredSchedule } from '../Forms/ScheduleConfigurator';
import ConfigLoader from '../Forms/ConfigLoader';
import RepoKeyStatus from '../Repositories/RepoKeyStatus';
import KeywordCombinationBanner from '../Forms/KeywordCombinationBanner';
import { useRepoCatalog } from '../../hooks/useRepoCatalog';
import InfoTooltip from '../Help/InfoTooltip';
import AIOverridePanel, {
  AIOverrideValue,
  EMPTY_AI_OVERRIDE,
  buildAIOverridePayload,
} from '../Forms/AIOverridePanel';
import AIDefaultsInfo from '../Forms/AIDefaultsInfo';
import { notifyRoutinesChanged } from '../../lib/routinesBus';
import { notifyConfigurationsChanged } from '../../lib/configurationsBus';

/**
 * Shape of a local routine row as returned by ``GET /api/routines``.
 *
 * Kept loose so callers (RoutinesPage, CalendarPage) can pass their own
 * row types as long as the listed fields are present.
 */
export interface RoutineEditTarget {
  id: number;
  name: string;
  schedule_cron?: string;
  email_enabled?: number | boolean;
  email_ai_summary_enabled?: number | boolean;
  ai_enabled?: number | boolean;
  notify_on_complete?: number | boolean;
  parameters?: string | Record<string, any>;
  ai_settings?: string | Record<string, any> | null;
  execution_location?: 'local' | 'cloud';
}

interface Props {
  open: boolean;
  /** ``null`` = create mode, otherwise the local routine being edited. */
  target: RoutineEditTarget | null;
  onClose: () => void;
  /** Called after a successful save (after the bus has been notified). */
  onSaved?: () => void;
}

/**
 * Reusable routine create/edit modal.
 *
 * Rendered both from the Routines page (Edit / Create New buttons) and
 * the Calendar page popover (Edit Routine button). On save the modal
 * notifies both the routines bus and the configurations bus so every
 * page that lists routines or routine-typed configurations refetches
 * without requiring a manual reload.
 */
const RoutineEditModal: React.FC<Props> = ({ open, target, onClose, onSaved }) => {
  const editId = target?.id ?? null;
  const isEdit = editId !== null;
  const { isSignedIn } = useAuth();
  const cloudSyncEnabled = isSignedIn;
  const { completionCounter } = useExecution();
  const { bySlug, presence, refreshPresence } = useRepoCatalog();

  const [formName, setFormName] = useState('');
  const [formCron, setFormCron] = useState('0 8 * * *');
  const [formSchedule, setFormSchedule] = useState<StructuredSchedule>(null);
  const [formRepos, setFormRepos] = useState<string[]>([]);
  const [formDateFrom, setFormDateFrom] = useState('');
  const [formDateTo, setFormDateTo] = useState('');
  const [formKeywords, setFormKeywords] = useState<string[]>([]);
  const [formMaxResults, setFormMaxResults] = useState(100);
  const [formAi, setFormAi] = useState(false);
  const [formEmail, setFormEmail] = useState(false);
  const [formEmailAi, setFormEmailAi] = useState(false);
  const [formNotify, setFormNotify] = useState(false);
  const [formLocation, setFormLocation] = useState<'local' | 'cloud'>('local');
  const [formAiOverride, setFormAiOverride] = useState<AIOverrideValue>(EMPTY_AI_OVERRIDE);
  const [error, setError] = useState('');

  const resetForm = useCallback(() => {
    setFormName('');
    setFormCron('0 8 * * *');
    setFormSchedule(null);
    setFormRepos([]);
    setFormDateFrom('');
    setFormDateTo('');
    setFormKeywords([]);
    setFormMaxResults(100);
    setFormAi(false);
    setFormEmail(false);
    setFormEmailAi(false);
    setFormNotify(false);
    setFormLocation('local');
    setFormAiOverride(EMPTY_AI_OVERRIDE);
    setError('');
  }, []);

  const hydrateFrom = useCallback((r: RoutineEditTarget) => {
    const rawParams = r.parameters;
    const params = typeof rawParams === 'string'
      ? JSON.parse(rawParams)
      : (rawParams || {});
    setFormName(r.name);
    setFormCron(r.schedule_cron || '0 8 * * *');
    setFormSchedule(
      params && typeof params === 'object' && params._schedule && params._schedule.type === 'interval'
        ? (params._schedule as StructuredSchedule)
        : null,
    );
    setFormRepos(params.repositories || []);
    setFormDateFrom(params.date_from || '');
    setFormDateTo(params.date_to || '');
    setFormKeywords(params.keywords || []);
    setFormMaxResults(params.max_results || 100);
    setFormAi(!!r.ai_enabled);
    setFormEmail(!!r.email_enabled);
    setFormEmailAi(!!r.email_ai_summary_enabled);
    setFormNotify(!!r.notify_on_complete);
    setFormLocation((r.execution_location as 'local' | 'cloud') || 'local');
    let overlay: Record<string, any> = {};
    if (r.ai_settings) {
      try {
        overlay = typeof r.ai_settings === 'string'
          ? JSON.parse(r.ai_settings)
          : r.ai_settings;
      } catch { overlay = {}; }
    }
    setFormAiOverride({
      provider: typeof overlay.provider === 'string' ? overlay.provider : '',
      model: typeof overlay.model === 'string' ? overlay.model : '',
      length: typeof overlay.length === 'string' ? overlay.length : '',
      tone: typeof overlay.tone === 'string' ? overlay.tone : '',
      temperature: overlay.temperature !== undefined && overlay.temperature !== null
        ? String(overlay.temperature)
        : '',
      extraction_goals: typeof overlay.extraction_goals === 'string'
        ? overlay.extraction_goals
        : '',
    });
    setError('');
  }, []);

  // Re-hydrate whenever the modal opens (or the target changes while
  // open). This guarantees that re-opening the modal after a previous
  // close shows fresh data rather than stale form state.
  useEffect(() => {
    if (!open) return;
    if (target) hydrateFrom(target); else resetForm();
  }, [open, target, hydrateFrom, resetForm]);

  const handleSubmit = async () => {
    if (!formName.trim()) return;
    const parameters: Record<string, any> = {
      repositories: formRepos,
      date_from: formDateFrom,
      date_to: formDateTo,
      keywords: formKeywords,
      query: formKeywords.join(' '),
      max_results: formMaxResults,
    };
    if (formSchedule) {
      parameters._schedule = formSchedule;
    }
    const overrides = buildAIOverridePayload(formAiOverride);
    const aiSettings = Object.keys(overrides).length > 0 ? overrides : null;
    const goingCloud = formLocation === 'cloud' && cloudSyncEnabled;
    try {
      if (isEdit) {
        const body = {
          name: formName.trim(),
          schedule_cron: formCron,
          parameters,
          is_active: true,
          email_enabled: formEmail,
          email_ai_summary_enabled: formEmailAi,
          ai_enabled: formAi,
          ai_settings: aiSettings,
          notify_on_complete: formNotify,
          execution_location: formLocation,
        };
        await apiClient.put(`/api/routines/${editId}`, body);
      } else if (goingCloud) {
        await cloudClient.post('/api/v2/routines', {
          name: formName.trim(),
          cron: formCron,
          parameters,
          enabled: true,
        });
      } else {
        const body = {
          name: formName.trim(),
          schedule_cron: formCron,
          parameters,
          is_active: true,
          email_enabled: formEmail,
          email_ai_summary_enabled: formEmailAi,
          ai_enabled: formAi,
          ai_settings: aiSettings,
          notify_on_complete: formNotify,
          execution_location: 'local',
        };
        await apiClient.post('/api/routines', body);
      }
      // Broadcast both invalidations so the Routines page, Calendar
      // page, and any mounted ConfigLoader instances refetch without
      // needing a manual reload.
      notifyRoutinesChanged();
      notifyConfigurationsChanged();
      onClose();
      onSaved?.();
    } catch (err: any) {
      setError(err.message || 'Failed to save routine');
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-lg" onClick={(e) => e.stopPropagation()}>
        <h3>{isEdit ? 'Edit Routine' : 'Create New Routine'}</h3>
        {!isEdit && (
          <ConfigLoader
            configType="routine"
            refreshKey={completionCounter}
            onLoad={(p) => {
              if (typeof p.schedule_cron === 'string') setFormCron(p.schedule_cron);
              const nested = p.parameters && typeof p.parameters === 'object' ? p.parameters : {};
              if (Array.isArray(nested.repositories)) setFormRepos(nested.repositories);
              if (Array.isArray(nested.keywords)) setFormKeywords(nested.keywords);
              if (typeof nested.max_results === 'number') setFormMaxResults(nested.max_results);
              if (typeof p.ai_enabled === 'boolean') setFormAi(p.ai_enabled);
              if (typeof p.email_enabled === 'boolean') setFormEmail(p.email_enabled);
              if (typeof p.email_ai_summary_enabled === 'boolean') setFormEmailAi(p.email_ai_summary_enabled);
              if (typeof p.notify_on_complete === 'boolean') setFormNotify(p.notify_on_complete);
              if (p.execution_location === 'local' || p.execution_location === 'cloud') {
                setFormLocation(p.execution_location);
              }
            }}
          />
        )}
        <div className="form-field">
          <label className="form-label">Routine Name</label>
          <input type="text" className="form-input" value={formName} onChange={(e) => setFormName(e.target.value)} autoFocus />
        </div>
        <ScheduleConfigurator
          cron={formCron}
          onChange={setFormCron}
          schedule={formSchedule}
          onScheduleChange={setFormSchedule}
        />
        <RepositorySelector mode="multi" value={formRepos} onChange={(v) => setFormRepos(v as string[])} />
        {formRepos.length > 0 && (
          <KeywordCombinationBanner
            entries={formRepos.map((slug) => bySlug[slug]).filter(Boolean)}
          />
        )}
        {formRepos.length > 0 && (
          <div className="form-field">
            <label className="form-label">Key Status</label>
            <div className="repo-key-status-stack">
              {formRepos.map((slug) => {
                const entry = bySlug[slug];
                if (!entry) return null;
                const credName = entry.credential_name;
                return (
                  <RepoKeyStatus
                    key={slug}
                    entry={entry}
                    present={!!(credName && presence[credName]?.present)}
                    onPresenceChange={() => { void refreshPresence(); }}
                    variant="routine"
                  />
                );
              })}
            </div>
          </div>
        )}
        <DateRangePicker dateFrom={formDateFrom} dateTo={formDateTo} onDateFromChange={setFormDateFrom} onDateToChange={setFormDateTo} />
        <KeywordInput keywords={formKeywords} onChange={setFormKeywords} />
        <div className="form-field">
          <label className="form-label">Max Results (per repository)</label>
          <div className="range-row">
            <input type="range" min={10} max={500} step={10} value={formMaxResults} onChange={(e) => setFormMaxResults(Number(e.target.value))} />
            <span className="range-value">{formMaxResults}</span>
          </div>
        </div>
        <div className="form-field toggles-row">
          <label className="checkbox-label"><input type="checkbox" checked={formAi} onChange={(e) => setFormAi(e.target.checked)} /><span>AI Summarization</span><InfoTooltip text="Attach LLM summaries to each report produced by this routine. Requires a configured provider and key in Settings → AI." /></label>
          <label className="checkbox-label"><input type="checkbox" checked={formEmail} onChange={(e) => setFormEmail(e.target.checked)} /><span>Email Notifications</span><InfoTooltip text="Send a report email via the SMTP server configured in Settings → Email whenever this routine completes a run." /></label>
          <label className="checkbox-label"><input type="checkbox" checked={formEmailAi} onChange={(e) => setFormEmailAi(e.target.checked)} /><span>Results in Email</span><InfoTooltip text="Include the AI summary in the body of the routine email (instead of just a link / attachment). Requires both Email Notifications and AI Summarization to be on." /></label>
          <label className="checkbox-label"><input type="checkbox" checked={formNotify} onChange={(e) => setFormNotify(e.target.checked)} /><span>Notify on Completion</span><InfoTooltip text="Send a desktop notification when this routine finishes. Only effective when Settings → Notifications → Automatic routines is set to 'selected'." /></label>
        </div>
        {formAi && <AIDefaultsInfo />}
        {formAi && (
          <details className="form-field">
            <summary>Override AI settings for this routine</summary>
            <AIOverridePanel value={formAiOverride} onChange={setFormAiOverride} />
          </details>
        )}
        <div
          className="form-field"
          role="radiogroup"
          aria-label="Execution location"
          data-testid="execution-location-radio"
        >
          <label className="form-label">
            Execution location
            <InfoTooltip text="Where this routine runs. 'Local' uses the resmon daemon on this device (requires the background service for firing while the app is closed). 'Cloud' runs on the resmon-cloud scheduler and does not require this machine to be online." />
          </label>
          <div className="toggles-row">
            <label className="checkbox-label">
              <input
                type="radio"
                name="execution_location"
                value="local"
                checked={formLocation === 'local'}
                onChange={() => setFormLocation('local')}
              />
              <span>Local (this device)</span>
            </label>
            <label
              className="checkbox-label"
              title={
                cloudSyncEnabled
                  ? 'Run this routine in the resmon-cloud scheduler'
                  : 'Sign in and enable Cloud sync to run routines in the cloud'
              }
            >
              <input
                type="radio"
                name="execution_location"
                value="cloud"
                disabled={!cloudSyncEnabled}
                checked={formLocation === 'cloud'}
                onChange={() => setFormLocation('cloud')}
              />
              <span>Cloud{!cloudSyncEnabled ? ' (sign in to enable)' : ''}</span>
            </label>
          </div>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="form-actions">
          <button className="btn btn-primary" onClick={handleSubmit}>{isEdit ? 'Update' : 'Create'}</button>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
};

export default RoutineEditModal;
