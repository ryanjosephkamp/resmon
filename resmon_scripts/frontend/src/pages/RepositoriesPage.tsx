import React, { useCallback, useEffect, useState } from 'react';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import { useNavigate } from 'react-router-dom';
import RepoCatalogTable from '../components/Repositories/RepoCatalogTable';
import KeywordSemanticsGlossary from '../components/Repositories/KeywordSemanticsGlossary';
import RequiredAttributions from '../components/Repositories/RequiredAttributions';
import {
  repositoriesApi,
  RepoCatalogEntry,
  CredentialPresenceMap,
} from '../api/repositories';
import PageHelp from '../components/Help/PageHelp';

const RepositoriesPage: React.FC = () => {
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<RepoCatalogEntry[]>([]);
  const [presence, setPresence] = useState<CredentialPresenceMap>({});
  const [keyringResponsive, setKeyringResponsive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refreshPresence = useCallback(async () => {
    try {
      const res = await repositoriesApi.getCredentials();
      setPresence(res.credentials);
      setKeyringResponsive(res.keyring_responsive);
    } catch (err: any) {
      setError(err?.message || 'Failed to load credential presence.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cat, pres] = await Promise.all([
          repositoriesApi.getCatalog(),
          repositoriesApi.getCredentials(),
        ]);
        if (cancelled) return;
        setCatalog(cat);
        setPresence(pres.credentials);
        setKeyringResponsive(pres.keyring_responsive);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Failed to load catalog.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="page-content">
        <p className="text-muted">Loading repository catalog…</p>
      </div>
    );
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Repositories &amp; API Keys</h1>
        <TutorialLinkButton anchor="repositories" />
      </div>

      <PageHelp
        storageKey="repositories"
        title="Repositories & API Keys"
        summary="Browse every repository resmon can query and manage their API keys."
        sections={[
          {
            heading: 'What this page does',
            body: (
              <ul>
                <li>Lists every repository in the catalog, its subject coverage, rate limit, and key-requirement status.</li>
                <li>Click a repository's name to expand details including the upstream policy notes and the current stored-key status.</li>
                <li>API keys entered here are stored in your OS-native keyring. The key value is never logged or echoed back; a stored key shows a fixed 12-character mask.</li>
              </ul>
            ),
          },
          {
            heading: 'Key-less repositories',
            body: (
              <p>
                arXiv, CrossRef, OpenAlex, bioRxiv, medRxiv, DOAJ, EuropePMC,
                DBLP, HAL, PubMed are key-less — they will work out of the
                box. Key-required repositories (CORE, NASA ADS, Springer Nature)
                are skipped in a sweep if no key is stored; Deep Dive will
                prompt for an ephemeral key at run time.
              </p>
            ),
          },
          {
            heading: 'Looking for AI API keys?',
            body: (
              <p>
                This page only manages keys for <strong>scholarly repositories</strong> (CORE,
                NASA ADS, Springer Nature, etc.). Keys for AI providers (OpenAI,
                Anthropic, Gemini, Together AI, &hellip;) live on
                {' '}<strong>Settings → AI</strong>. Use the
                {' '}<strong>Looking for AI API key settings?</strong> button at the top of the
                page to jump there directly.
              </p>
            ),
          },
        ]}
      />

      <RequiredAttributions catalog={catalog} />

      <p className="text-muted">
        Every active repository that resmon can query is listed below. Click a
        repository name to expand its details. API keys entered here are stored
        securely in your operating system&rsquo;s native keyring and are never
        logged or echoed back to the UI. A saved key is displayed as a fixed
        12-character mask.
      </p>

      <div style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => navigate('/settings/ai')}
          data-testid="ai-key-settings-link"
          aria-label="Looking for AI API key settings? Go to Settings, AI panel."
        >
          Looking for AI API key settings?
        </button>
      </div>

      {!keyringResponsive && (
        <div className="form-error" role="status">
          <strong>Your keychain is not responding.</strong> Saved API keys cannot be
          read right now, so the statuses below say <em>Unreadable</em> rather than
          claiming no key is stored — your keys are most likely still there. On macOS
          this happens when an unsigned build asks for items a previous build saved:
          the system wants authorisation that no background process can be shown.
          Re-entering a key here will store it for this build.
        </div>
      )}

      {error && <div className="form-error">{error}</div>}

      <KeywordSemanticsGlossary />

      <div className="card">
        <RepoCatalogTable
          catalog={catalog}
          presence={presence}
          onPresenceRefresh={refreshPresence}
        />
      </div>
    </div>
  );
};

export default RepositoriesPage;
