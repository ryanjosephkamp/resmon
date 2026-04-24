import React, { useCallback, useEffect, useState } from 'react';

/**
 * Collapsible "About this page" panel that renders near the top of every
 * page so users can see (1) what the page is for and (2) how to use it.
 *
 * Expansion state is persisted to ``localStorage`` under a per-page key
 * so the user's last preference survives reloads. The default is
 * collapsed on subsequent visits so the help does not clutter a page the
 * user already understands; on first visit it is shown open.
 */
export interface PageHelpSection {
  heading: string;
  body: React.ReactNode;
}

interface PageHelpProps {
  /**
   * Stable identifier used as the localStorage key for the
   * collapsed/expanded preference. Use a short slug such as
   * ``"dashboard"``, ``"deep-dive"``, etc.
   */
  storageKey: string;
  /** Short title rendered on the collapsed header. */
  title: string;
  /** One-line summary that accompanies the title. */
  summary: string;
  /** Optional structured body. If omitted, ``children`` is rendered. */
  sections?: PageHelpSection[];
  children?: React.ReactNode;
}

const LS_PREFIX = 'resmon:pagehelp:';

const PageHelp: React.FC<PageHelpProps> = ({ storageKey, title, summary, sections, children }) => {
  const key = LS_PREFIX + storageKey;

  // Default: expanded on first visit, collapsed afterwards. We persist the
  // user's explicit choice so "open" vs "closed" is sticky.
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === 'open') return true;
      if (stored === 'closed') return false;
    } catch { /* localStorage unavailable — fall through */ }
    return true;
  });

  useEffect(() => {
    try { window.localStorage.setItem(key, open ? 'open' : 'closed'); } catch { /* ignore */ }
  }, [key, open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className={`page-help ${open ? 'page-help-open' : 'page-help-closed'}`}>
      <button
        type="button"
        className="page-help-header"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`page-help-body-${storageKey}`}
      >
        <span className="page-help-icon" aria-hidden="true">i</span>
        <span className="page-help-title">{title}</span>
        <span className="page-help-summary">{summary}</span>
        <span className="page-help-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div id={`page-help-body-${storageKey}`} className="page-help-body">
          {sections
            ? sections.map((s, i) => (
                <div key={i} className="page-help-section">
                  <h3>{s.heading}</h3>
                  <div>{s.body}</div>
                </div>
              ))
            : children}
        </div>
      )}
    </div>
  );
};

export default PageHelp;
