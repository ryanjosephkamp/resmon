import React from 'react';
import TutorialLinkButton from '../AboutResmon/TutorialLinkButton';
import PageHelp from '../Help/PageHelp';

/**
 * "Cloud Account" tab — temporarily disabled.
 *
 * The resmon-cloud account feature (sign-in, sync, data export, account
 * deletion) is implemented on the backend (IMPL-27..40) but is not wired
 * to a hosted identity provider in this build. Until a Clerk / Supabase
 * Auth deployment is configured, this tab surfaces an "under construction"
 * notice instead of a non-functional Sign-In button.
 */
const CloudAccountSettings: React.FC = () => {
  return (
    <div className="settings-section">
      <div className="settings-panel-header">
        <h2>Cloud Account</h2>
        <TutorialLinkButton anchor="settings-account" />
      </div>
      <PageHelp
        storageKey="settings-cloud-account"
        title="Cloud Account"
        summary="Sign in or out of your resmon-cloud account."
        sections={[
          {
            heading: 'Why sign in?',
            body: (
              <ul>
                <li>Enables <strong>cloud routines</strong> — sweeps that run on the resmon-cloud scheduler even when your machine is off.</li>
                <li>Enables <strong>cloud-scoped credentials</strong> on the Repositories page — keys that cloud routines use, encrypted server-side.</li>
                <li>Enables browsing / viewing cloud-executed reports on the Results page.</li>
              </ul>
            ),
          },
          {
            heading: 'Privacy',
            body: (
              <p>
                Local executions never depend on cloud sign-in. Your cloud
                session token is stored in your OS keychain; API keys are
                envelope-encrypted server-side (per-user data-encryption
                keys wrapped by a KMS-held key-encryption key).
              </p>
            ),
          },
        ]}
      />
      <div
        className="settings-form"
        style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}
      >
        <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>🔨</div>
        <h3 style={{ marginTop: 0 }}>Under construction</h3>
        <p className="text-muted" style={{ maxWidth: '44ch', margin: '0.75rem auto' }}>
          The resmon-cloud account feature — sign-in, cross-device sync,
          cloud-run routines, and server-side credential storage — is still
          in development and is not available in this build.
        </p>
        <p className="text-muted" style={{ maxWidth: '44ch', margin: '0.75rem auto' }}>
          All local features (manual dives and sweeps, local routines,
          results, and configurations) continue to work as before.
        </p>
      </div>
    </div>
  );
};

export default CloudAccountSettings;
