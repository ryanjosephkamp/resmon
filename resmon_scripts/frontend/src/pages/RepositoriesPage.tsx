import React, { useCallback, useEffect, useState } from 'react';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import { useNavigate } from 'react-router-dom';
import RepoCatalogTable from '../components/Repositories/RepoCatalogTable';
import KeywordSemanticsGlossary from '../components/Repositories/KeywordSemanticsGlossary';
import {
  repositoriesApi,
  RepoCatalogEntry,
  CredentialPresenceMap,
  CredentialScope,
} from '../api/repositories';
import { useAuth } from '../context/AuthContext';
import PageHelp from '../components/Help/PageHelp';

const RepositoriesPage: React.FC = () => {
  const { isSignedIn } = useAuth();
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<RepoCatalogEntry[]>([]);
  const [localPresence, setLocalPresence] = useState<CredentialPresenceMap>({});
  const [cloudPresence, setCloudPresence] = useState<CredentialPresenceMap>({});
  const [scope, setScope] = useState<CredentialScope>('local');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Force scope back to 'local' if the user signs out while viewing cloud.
  useEffect(() => {
    if (!isSignedIn && scope === 'cloud') setScope('local');
  }, [isSignedIn, scope]);

  const refreshLocal = useCallback(async () => {
    try {
      const p = await repositoriesApi.getCredentialsPresence();
      setLocalPresence(p);
    } catch (err: any) {
      setError(err?.message || 'Failed to load local credential presence.');
    }
  }, []);

  const refreshCloud = useCallback(async () => {
    if (!isSignedIn) {
      setCloudPresence({});
      return;
    }
    try {
      const p = await repositoriesApi.getCloudCredentials();
      setCloudPresence(p);
    } catch (err: any) {
      setError(err?.message || 'Failed to load cloud credential presence.');
    }
  }, [isSignedIn]);

  const refreshActive = useCallback(() => {
    if (scope === 'cloud') void refreshCloud();
    else void refreshLocal();
  }, [scope, refreshCloud, refreshLocal]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cat, pres] = await Promise.all([
          repositoriesApi.getCatalog(),
          repositoriesApi.getCredentialsPresence(),
        ]);
        if (cancelled) return;
        setCatalog(cat);
        setLocalPresence(pres);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Failed to load catalog.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Lazy-fetch cloud presence the first time the user switches to or signs
  // into the cloud scope.
  useEffect(() => {
    if (scope === 'cloud' && isSignedIn) void refreshCloud();
  }, [scope, isSignedIn, refreshCloud]);

  if (loading) {
    return (
      <div className="page-content">
        <p className="text-muted">Loading repository catalog…</p>
      </div>
    );
  }

  const activePresence = scope === 'cloud' ? cloudPresence : localPresence;
  const cloudDisabled = !isSignedIn;

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
                <li>API keys entered here are stored in your OS-native keyring (local scope) or encrypted in your cloud account (cloud scope). The key value is never logged or echoed back; a stored key shows a fixed 12-character mask.</li>
              </ul>
            ),
          },
          {
            heading: 'Scope selector',
            body: (
              <ul>
                <li><strong>This device (keyring)</strong> — keys used by local executions; fetched from your OS keychain.</li>
                <li><strong>Cloud account</strong> — keys used by cloud-scheduler runs; envelope-encrypted in your resmon-cloud account. Requires sign-in.</li>
              </ul>
            ),
          },
          {
            heading: 'Key-less repositories',
            body: (
              <p>
                arXiv, CrossRef, OpenAlex, bioRxiv, medRxiv, DOAJ, EuropePMC,
                DBLP, HAL, PubMed are key-less — they will work out of the
                box. Key-required repositories (CORE, IEEE Xplore, NASA ADS)
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
                IEEE Xplore, NASA ADS, etc.). Keys for AI providers (OpenAI,
                Anthropic, Gemini, Together AI, &hellip;) live on
                {' '}<strong>Settings → AI</strong>. Use the
                {' '}<strong>Looking for AI API key settings?</strong> button at the top of the
                page to jump there directly.
              </p>
            ),
          },
        ]}
      />

      <p className="text-muted">
        Every active repository that resmon can query is listed below. Click a
        repository name to expand its details. API keys entered here are stored
        securely in your operating system&rsquo;s native keyring (or, when the
        cloud scope is selected, encrypted in your resmon-cloud account) and
        are never logged or echoed back to the UI. A saved key is displayed as
        a fixed 12-character mask.
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

      <div
        role="tablist"
        aria-label="Credential scope"
        className="segmented-control"
        style={{ marginBottom: 12, display: 'inline-flex', gap: 0 }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'local'}
          className={`btn btn-sm ${scope === 'local' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setScope('local')}
          data-testid="scope-local"
        >
          This device (keyring)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'cloud'}
          className={`btn btn-sm ${scope === 'cloud' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setScope('cloud')}
          disabled={cloudDisabled}
          aria-disabled={cloudDisabled}
          title={cloudDisabled ? 'Sign in to manage cloud credentials' : undefined}
          data-testid="scope-cloud"
        >
          Cloud account
        </button>
      </div>

      {scope === 'cloud' && !isSignedIn && (
        <p className="text-muted">Sign in to manage credentials stored in your cloud account.</p>
      )}

      {error && <div className="form-error">{error}</div>}

      <KeywordSemanticsGlossary />

      <div className="card">
        <RepoCatalogTable
          catalog={catalog}
          presence={activePresence}
          onPresenceRefresh={refreshActive}
          scope={scope}
        />
      </div>
    </div>
  );
};

export default RepositoriesPage;
