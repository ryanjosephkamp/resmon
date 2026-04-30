import React, { useState } from 'react';
import { apiClient } from '../../api/client';
import { notifyConfigurationsChanged } from '../../lib/configurationsBus';

/**
 * Update 3 — `Save Config` button for manual executions.
 *
 * Appears on the Calendar event popover and in the Dashboard's Recent
 * Activity actions column. Only renders for ``deep_dive`` / ``deep_sweep``
 * executions; routine executions are already auto-saved as configs.
 *
 * On click, opens a small modal asking for a configuration name. The name
 * is validated against the existing ``manual_dive`` / ``manual_sweep`` set
 * for case-sensitive uniqueness; duplicates surface a red toast and keep
 * the modal open. Successful saves emit a green toast, close the modal,
 * and broadcast ``notifyConfigurationsChanged()`` so the Configurations
 * page table and any mounted ``ConfigLoader`` dropdowns refetch.
 */

export interface ExecutionLike {
  id: number;
  execution_type: string;
  parameters?: string | Record<string, any>;
  // Update 3 / 4_27_26: when set, the SaveConfig button surfaces a
  // "Saved as <name>" badge so the user knows this manual execution
  // already has a saved configuration linked to it.
  saved_configuration_id?: number | null;
  saved_configuration_name?: string | null;
}

interface SaveConfigButtonProps {
  execution: ExecutionLike;
  buttonClassName?: string;
  /** Called after a successful save (e.g., to close a parent popover). */
  onSaved?: () => void;
}

const targetConfigType = (
  t: string,
): 'manual_dive' | 'manual_sweep' | null => {
  if (t === 'deep_dive' || t === 'dive') return 'manual_dive';
  if (t === 'deep_sweep' || t === 'sweep') return 'manual_sweep';
  return null;
};

const SaveConfigButton: React.FC<SaveConfigButtonProps> = ({
  execution,
  buttonClassName,
  onSaved,
}) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const configType = targetConfigType(execution.execution_type);
  if (!configType) return null;

  const showToast = (kind: 'success' | 'error', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 4000);
  };

  const buildParams = (raw: string | Record<string, any> | undefined) => {
    let p: any = raw;
    if (typeof raw === 'string') {
      try { p = JSON.parse(raw); } catch { p = {}; }
    }
    if (!p || typeof p !== 'object') p = {};
    const keywords = Array.isArray(p.keywords)
      ? p.keywords
      : (typeof p.query === 'string' && p.query.trim() ? [String(p.query).trim()] : []);
    const max_results = typeof p.max_results === 'number' ? p.max_results : 100;
    const ai_enabled = !!p.ai_enabled;
    const date_from = p.date_from ?? '';
    const date_to = p.date_to ?? '';
    if (configType === 'manual_dive') {
      const repo = (Array.isArray(p.repositories) && p.repositories[0]) || p.repository || '';
      return { repository: repo, date_from, date_to, keywords, max_results, ai_enabled };
    }
    const repos = Array.isArray(p.repositories)
      ? p.repositories
      : (p.repository ? [p.repository] : []);
    return { repositories: repos, date_from, date_to, keywords, max_results, ai_enabled };
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setModalError('');
    try {
      const existing = await apiClient.get<Array<{ name: string }>>(
        `/api/configurations?config_type=${configType}`,
      );
      if (existing.some((c) => c.name === trimmed)) {
        const label = configType === 'manual_dive' ? 'Deep Dive' : 'Deep Sweep';
        setModalError(`A ${label} configuration named "${trimmed}" already exists.`);
        setBusy(false);
        return;
      }
      // Fetch full execution to read its raw ``parameters`` JSON; the
      // calendar/dashboard rows we receive do not always carry it.
      let paramsSource: string | Record<string, any> | undefined = execution.parameters;
      try {
        const exec = await apiClient.get<ExecutionLike>(`/api/executions/${execution.id}`);
        if (exec && exec.parameters !== undefined) paramsSource = exec.parameters;
      } catch { /* fall back to whatever the row carried */ }
      const parameters = buildParams(paramsSource);
      await apiClient.post('/api/configurations', {
        name: trimmed,
        config_type: configType,
        parameters,
        // Update 3 / 4_27_26: link the brand-new config back to this
        // execution so the UI can render a "Saved as" indicator and the
        // user does not accidentally save the same execution twice under
        // different names. "Last save wins" \u2014 the backend overwrites
        // the column on each subsequent save from the same execution.
        link_to_execution_id: execution.id,
      });
      notifyConfigurationsChanged();
      setOpen(false);
      setName('');
      showToast('success', `Configuration "${trimmed}" saved.`);
      onSaved?.();
    } catch (err: any) {
      showToast('error', err?.message || 'Failed to save configuration.');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    setModalError('');
  };

  return (
    <>
      {execution.saved_configuration_name ? (
        <span
          className="badge badge-info"
          title={`This execution is already saved as the ${
            configType === 'manual_dive' ? 'Deep Dive' : 'Deep Sweep'
          } configuration "${execution.saved_configuration_name}".`}
          style={{ marginRight: 6, whiteSpace: 'nowrap' }}
        >
          Saved as: {execution.saved_configuration_name}
        </span>
      ) : null}
      <button
        type="button"
        className={buttonClassName || 'btn btn-sm'}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={
          execution.saved_configuration_name
            ? `Already saved as "${execution.saved_configuration_name}". Click to save under a new name (most recent wins).`
            : undefined
        }
      >
        {execution.saved_configuration_name ? 'Save Again' : 'Save Config'}
      </button>
      {open && (
        <div
          className="modal-overlay"
          onClick={close}
          style={{ zIndex: 2000 }}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>
              Save as {configType === 'manual_dive' ? 'Deep Dive' : 'Deep Sweep'} Configuration
            </h3>
            <div className="form-field">
              <label className="form-label">Configuration Name</label>
              <input
                type="text"
                className="form-input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (modalError) setModalError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && name.trim() && !busy) {
                    e.preventDefault();
                    handleSave();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    close();
                  }
                }}
                autoFocus
                disabled={busy}
              />
            </div>
            {modalError && <div className="form-error">{modalError}</div>}
            <div className="form-actions">
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={busy || !name.trim()}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={close}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div
          role="status"
          className={toast.kind === 'success' ? 'form-success' : 'form-error'}
          style={{
            position: 'fixed',
            top: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 3000,
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            maxWidth: '90vw',
          }}
        >
          {toast.text}
        </div>
      )}
    </>
  );
};

export default SaveConfigButton;
