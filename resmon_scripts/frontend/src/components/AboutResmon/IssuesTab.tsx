import React, { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { apiClient } from '../../api/client';
import PageHelp from '../Help/PageHelp';

/**
 * Issues tab — lets a user report a bug, request a feature, or ask a
 * question without the app holding any shared credentials.
 *
 * Submission paths (per Update 3 design):
 *   1. ``Open in Email`` — opens the user's default mail client via a
 *      ``mailto:`` URL pre-filled with the form contents and the
 *      auto-collected diagnostic context. The user reviews and sends.
 *   2. ``File on GitHub`` — opens a pre-filled
 *      ``github.com/ryanjosephkamp/resmon/issues/new`` URL with the
 *      same body. The user reviews and submits.
 *
 * Both buttons rely on ``window.resmonAPI.openPath``, which routes
 * ``mailto:`` and ``http(s)`` URLs through ``shell.openExternal`` in the
 * Electron main process (see ``frontend/electron/main.ts``). When the
 * preload bridge is unavailable (e.g., a non-Electron browser preview),
 * we fall back to ``window.location.href = url`` for the mailto path
 * and ``window.open(url, '_blank')`` for the GitHub path.
 *
 * The tab never auto-sends anything: the user always has the final
 * "Send" / "Submit" click in their own email client or on GitHub. No
 * credentials are stored, transmitted, or required by this surface.
 */

const REPORT_RECIPIENT = 'ryanjosephkamp@gmail.com';
const GITHUB_REPO_NEW_ISSUE = 'https://github.com/ryanjosephkamp/resmon/issues/new';

type IssueType = 'bug' | 'feature' | 'question' | 'other';

interface IssueTypeOption {
  value: IssueType;
  label: string;
  /** Matching label slug used in the GitHub issue template label list. */
  githubLabel: string;
}

const issueTypeOptions: IssueTypeOption[] = [
  { value: 'bug', label: 'Bug', githubLabel: 'bug' },
  { value: 'feature', label: 'Feature request', githubLabel: 'enhancement' },
  { value: 'question', label: 'Question', githubLabel: 'question' },
  { value: 'other', label: 'Other', githubLabel: 'triage' },
];

interface HealthResponse {
  version?: string;
}

const IssuesTab: React.FC = () => {
  const location = useLocation();

  const [issueType, setIssueType] = useState<IssueType>('bug');
  const [title, setTitle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [stepsToReproduce, setStepsToReproduce] = useState<string>('');
  const [expectedActual, setExpectedActual] = useState<string>('');
  const [contactEmail, setContactEmail] = useState<string>('');
  const [validationError, setValidationError] = useState<string>('');
  const [submitStatus, setSubmitStatus] = useState<string>('');
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);

  const [appVersion, setAppVersion] = useState<string>('');

  // Fetch the live backend version once for the diagnostics block. If the
  // health endpoint is unavailable we leave the field blank rather than
  // guessing a version number.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const h = await apiClient.get<HealthResponse>('/api/health');
        if (!cancelled && h?.version) setAppVersion(h.version);
      } catch {
        // Leave appVersion blank when the daemon is unreachable.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const platform = window.resmonAPI?.platform || 'unknown';
  const versions = window.resmonAPI?.versions;

  // Snapshot of every auto-collected diagnostic field. Rendered verbatim
  // in the "Diagnostics included with this report" disclosure so the
  // user can see exactly what is included before they hit Send / Submit.
  const diagnostics = useMemo(() => {
    const lines: string[] = [];
    lines.push(`App version: ${appVersion || 'unknown (daemon unreachable)'}`);
    lines.push(`Platform: ${platform}`);
    if (versions) {
      lines.push(`Electron: ${versions.electron}`);
      lines.push(`Node: ${versions.node}`);
    }
    lines.push(`Current route: ${location.pathname}${location.hash || ''}`);
    lines.push(`Submitted at: ${new Date().toISOString()}`);
    return lines;
  }, [appVersion, platform, versions, location.pathname, location.hash]);

  const selectedTypeOption = issueTypeOptions.find((o) => o.value === issueType) || issueTypeOptions[0];
  const isBug = issueType === 'bug';

  // Validate the form. Bug reports additionally require steps and
  // expected/actual; everything else only needs title + description.
  const validate = (): string | null => {
    if (!title.trim()) return 'Please enter a short title.';
    if (!description.trim()) return 'Please enter a description.';
    if (isBug) {
      if (!stepsToReproduce.trim()) return 'For bug reports, please include steps to reproduce.';
      if (!expectedActual.trim()) return 'For bug reports, please include expected vs. actual behavior.';
    }
    if (contactEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) {
      return 'Contact email is not a valid address.';
    }
    return null;
  };

  // Compose the plain-text body shared by both the mailto and GitHub
  // submission paths. Markdown headings keep the GitHub render readable
  // while remaining legible as plain text in an email client.
  const buildBody = (): string => {
    const parts: string[] = [];
    parts.push(`**Type:** ${selectedTypeOption.label}`);
    parts.push('');
    parts.push('## Description');
    parts.push(description.trim());
    if (isBug || stepsToReproduce.trim()) {
      parts.push('');
      parts.push('## Steps to reproduce');
      parts.push(stepsToReproduce.trim() || '(not provided)');
    }
    if (isBug || expectedActual.trim()) {
      parts.push('');
      parts.push('## Expected vs. actual behavior');
      parts.push(expectedActual.trim() || '(not provided)');
    }
    if (contactEmail.trim()) {
      parts.push('');
      parts.push('## Contact');
      parts.push(contactEmail.trim());
    }
    parts.push('');
    parts.push('## Diagnostics');
    parts.push('```');
    for (const line of diagnostics) parts.push(line);
    parts.push('```');
    return parts.join('\n');
  };

  const buildSubject = (): string => {
    const prefix = `[resmon] [${selectedTypeOption.label}]`;
    return `${prefix} ${title.trim()}`;
  };

  // Open a URL via the Electron preload's ``openPath`` bridge (which
  // routes mailto: and http(s) URLs through ``shell.openExternal``).
  // Fall back to the renderer's own URL navigation when the bridge is
  // unavailable (e.g., during a webpack-only preview).
  const openExternal = async (url: string): Promise<void> => {
    if (window.resmonAPI?.openPath) {
      try {
        await window.resmonAPI.openPath(url);
        return;
      } catch {
        // Fall through to the renderer-side fallback below.
      }
    }
    if (url.startsWith('mailto:')) {
      window.location.href = url;
    } else {
      window.open(url, '_blank');
    }
  };

  const handleOpenInEmail = async () => {
    const err = validate();
    if (err) { setValidationError(err); setSubmitStatus(''); return; }
    setValidationError('');
    const subject = buildSubject();
    const body = buildBody();
    const mailto =
      `mailto:${REPORT_RECIPIENT}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;
    await openExternal(mailto);
    setSubmitStatus('Your default email client has been opened with the report pre-filled. Review the contents and click Send to submit.');
  };

  const handleFileOnGitHub = async () => {
    const err = validate();
    if (err) { setValidationError(err); setSubmitStatus(''); return; }
    setValidationError('');
    const subject = buildSubject();
    const body = buildBody();
    const url =
      `${GITHUB_REPO_NEW_ISSUE}` +
      `?title=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}` +
      `&labels=${encodeURIComponent(selectedTypeOption.githubLabel)}`;
    await openExternal(url);
    setSubmitStatus('A pre-filled GitHub issue has been opened in your browser. Review the contents and click Submit new issue to file it.');
  };

  return (
    <div className="settings-panel issues-panel">
      <h2>Issues</h2>

      <PageHelp
        storageKey="about-resmon-issues"
        title="Issues"
        summary="Report a bug, request a feature, or ask a question about resmon."
        sections={[
          {
            heading: 'How submissions work',
            body: (
              <>
                <p>
                  resmon does not store, transmit, or require any shared email or API credentials
                  for issue reporting. Instead, this form prepares the report text and hands it off
                  to a tool you already trust:
                </p>
                <ul>
                  <li><strong>Open in Email</strong> opens your default mail client with the report pre-filled and addressed to the maintainer; you click Send yourself.</li>
                  <li><strong>File on GitHub</strong> opens a pre-filled issue on the public <code>resmon</code> repository; you click Submit yourself.</li>
                </ul>
                <p>
                  Nothing is sent automatically by the app. You can review the full contents (including the
                  Diagnostics block below) before you submit.
                </p>
              </>
            ),
          },
          {
            heading: 'Privacy',
            body: (
              <p>
                Only the fields you fill in plus the diagnostics shown below are included. The form does
                not read your stored credentials, your routine list, your repository keys, or any
                execution data. Your contact email is included only when you fill it in.
              </p>
            ),
          },
        ]}
      />

      <div className="form-section">
        <div className="form-group">
          <label className="form-label">Type</label>
          <div className="radio-row">
            {issueTypeOptions.map((opt) => (
              <label key={opt.value} className="radio-option">
                <input
                  type="radio"
                  name="issue-type"
                  value={opt.value}
                  checked={issueType === opt.value}
                  onChange={() => setIssueType(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Title</label>
          <input
            className="form-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short summary (one line)"
            maxLength={140}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Description</label>
          <textarea
            className="form-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What happened, what you expected, and any other context."
            rows={5}
          />
        </div>

        <div className="form-group">
          <label className="form-label">
            Steps to reproduce {isBug ? '(required for bugs)' : '(optional)'}
          </label>
          <textarea
            className="form-input"
            value={stepsToReproduce}
            onChange={(e) => setStepsToReproduce(e.target.value)}
            placeholder={'1. Open Deep Dive\n2. Pick repository X\n3. Click Run\n4. Observe …'}
            rows={4}
          />
        </div>

        <div className="form-group">
          <label className="form-label">
            Expected vs. actual behavior {isBug ? '(required for bugs)' : '(optional)'}
          </label>
          <textarea
            className="form-input"
            value={expectedActual}
            onChange={(e) => setExpectedActual(e.target.value)}
            placeholder={'Expected: …\nActual: …'}
            rows={3}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Contact email (optional)</label>
          <input
            className="form-input"
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="Only fill in if you want a follow-up reply."
          />
        </div>

        <div className="form-group">
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => setShowDiagnostics((v) => !v)}
            aria-expanded={showDiagnostics}
            aria-controls="issues-diagnostics-block"
          >
            {showDiagnostics ? 'Hide diagnostics included with this report' : 'Show diagnostics included with this report'}
          </button>
          {showDiagnostics ? (
            <pre
              id="issues-diagnostics-block"
              className="issues-diagnostics-block"
              aria-label="Diagnostic context that will be appended to the report"
            >
              {diagnostics.join('\n')}
            </pre>
          ) : null}
        </div>

        {validationError ? (
          <p className="form-error" role="alert">{validationError}</p>
        ) : null}

        {submitStatus ? (
          <p className="form-status" role="status">{submitStatus}</p>
        ) : null}

        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleOpenInEmail}
            data-testid="issues-open-in-email"
          >
            Open in Email
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleFileOnGitHub}
            data-testid="issues-file-on-github"
          >
            File on GitHub
          </button>
        </div>
      </div>
    </div>
  );
};

export default IssuesTab;
