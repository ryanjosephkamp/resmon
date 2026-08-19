import React, { useEffect, useState } from 'react';
import { apiClient } from '../../api/client';
import PageHelp from '../Help/PageHelp';
import profilePic from '../../assets/kamp_profile_pic.png';

interface HealthResponse {
  version?: string;
}

interface SocialLink {
  label: string;
  href: string;
  icon: React.ReactNode;
}

const GitHubIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 .6A12 12 0 0 0 8.2 24c.6.1.8-.2.8-.6v-2.1c-3.3.7-4-1.4-4-1.4-.5-1.3-1.3-1.6-1.3-1.6-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.4-1.3-5.4-6A4.7 4.7 0 0 1 5.6 8c-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.2 11.2 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.9 1.3 2 1.3 3.4 0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.2c0 .4.2.7.8.6A12 12 0 0 0 12 .6Z" />
  </svg>
);

const LinkedInIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4.98 3.5A2.5 2.5 0 1 0 5 8.5a2.5 2.5 0 0 0-.02-5ZM3 9h4v12H3V9Zm7 0h3.8v1.7h.1c.5-1 1.8-2.1 3.8-2.1 4 0 4.8 2.6 4.8 6V21h-4v-5.4c0-1.3 0-3-1.9-3s-2.1 1.5-2.1 2.9V21h-4V9Z" />
  </svg>
);

const XIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M18.9 2H22l-6.8 7.8L23 22h-6.1l-4.8-6.3L6.6 22H3.5l7.3-8.4L1 2h6.2l4.3 5.8L18.9 2Zm-1.1 18h1.7L6.2 3.9H4.4L17.8 20Z" />
  </svg>
);

const GlobeIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm7.9 9h-3.1a15.8 15.8 0 0 0-1.3-5.2A8 8 0 0 1 19.9 11ZM12 4c1 1.4 1.9 3.8 2.3 7H9.7C10.1 7.8 11 5.4 12 4ZM8.5 5.8A15.8 15.8 0 0 0 7.2 11H4.1a8 8 0 0 1 4.4-5.2ZM4.1 13h3.1a15.8 15.8 0 0 0 1.3 5.2A8 8 0 0 1 4.1 13ZM12 20c-1-1.4-1.9-3.8-2.3-7h4.6c-.4 3.2-1.3 5.6-2.3 7Zm3.5-1.8a15.8 15.8 0 0 0 1.3-5.2h3.1a8 8 0 0 1-4.4 5.2Z" />
  </svg>
);

const MailIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 5h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm0 2v.4l9 5.7 9-5.7V7H3Zm18 10V9.8l-8.5 5.4a1 1 0 0 1-1 0L3 9.8V17h18Z" />
  </svg>
);

const socialLinks: SocialLink[] = [
  {
    label: 'GitHub',
    href: 'https://github.com/ryanjosephkamp',
    icon: <GitHubIcon />,
  },
  {
    label: 'LinkedIn',
    href: 'https://www.linkedin.com/in/rjk1999',
    icon: <LinkedInIcon />,
  },
  {
    label: 'X',
    href: 'https://x.com/ryanjosephkamp',
    icon: <XIcon />,
  },
  {
    label: 'Website',
    href: 'https://sites.google.com/view/ryanjosephkamp',
    icon: <GlobeIcon />,
  },
  {
    label: 'Email',
    href: 'mailto:ryanjosephkamp@gmail.com',
    icon: <MailIcon />,
  },
];

const AboutAppTab: React.FC = () => {
  const [backendVersion, setBackendVersion] = useState<string>('1.3.0');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const h = await apiClient.get<HealthResponse>('/api/health');
        if (!cancelled && h?.version) setBackendVersion(h.version);
      } catch {
        // Keep the default version when daemon health is unavailable.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="settings-panel about-app-panel">
      <h2>About App</h2>

      <PageHelp
        storageKey="about-resmon-about-app"
        title="About App"
        summary="Version, license, privacy, and author information for this resmon build."
        sections={[
          {
            heading: 'Purpose',
            body: (
              <p>
                This page centralizes release metadata and trust details so users can quickly confirm
                the app version, licensing terms, privacy policy, and official author channels.
              </p>
            ),
          },
        ]}
      />

      <div className="about-grid">
        <section className="about-card">
          <h3>Version</h3>
          <p><strong>resmon</strong> version <strong>{backendVersion || '1.3.0'}</strong></p>
          <p className="text-muted">Current release line: 1.3.x</p>
        </section>

        <section className="about-card">
          <h3>Recent Update</h3>
          <p>
            <strong>Update 5</strong> — Hardening: A Clean Install That Actually Starts, a
            Suite That Actually Finishes, and CI to Keep It That Way.
          </p>
          <p className="text-muted">
            Twenty defects found by installing resmon the way the README tells a new user to,
            then running everything the project ships; eighteen are fixed. A fresh clone could
            not start at all, because <code>requirements.txt</code> never listed
            <code>python-dateutil</code>. The cloud service's dependencies were pinned nowhere,
            and behind them <code>cloud/metrics.py</code> turned out never to have parsed.
            Reading the OS keychain had no time limit, so <code>/api/cloud/status</code> could
            hang forever on a macOS authorisation prompt — and hung the test suite with it;
            keyring access is now bounded. An execution could permanently strand its concurrency
            slot when persisting progress failed, after which every Deep Dive and Deep Sweep was
            refused with HTTP 429 while nothing was running. The shared rate limiter had no lock,
            so concurrent sweeps issued up to four times a source's advertised request ceiling.
            Closing the focused Monitor tab left focus on the execution that had just been
            removed. Three renderer specs that had never had a test runner now run under Jest —
            and caught that focus bug within minutes. Live-network tests are separated from unit
            tests so the suite runs offline, and a GitHub Actions workflow now runs the whole
            thing on every push.
          </p>
          <p className="text-muted">
            Two findings are documented rather than fixed: Python 3.12 is not currently supported
            (one sqlite connection is shared across threads without serialisation, which 3.12
            surfaces), and the Electron window's <code>webSecurity: false</code> flag was left
            alone pending a proper runtime check.
          </p>
        </section>

        <section className="about-card">
          <h3>License</h3>
          <p>
            This project is distributed under the <strong>MIT License</strong>.
          </p>
          <p className="text-muted">
            Permission is granted, free of charge, to use, copy, modify, merge, publish,
            distribute, sublicense, and/or sell copies of the software, subject to inclusion
            of the copyright and permission notice.
          </p>
        </section>

        <section className="about-card">
          <h3>Privacy Notice</h3>
          <ul>
            <li>resmon is local-first: execution data and reports are stored on your machine.</li>
            <li>Credentials are stored in the OS keychain via keyring, not in plaintext project files.</li>
            <li>Only services you explicitly configure are contacted (repository APIs, optional LLM providers, optional SMTP, optional cloud sync).</li>
            <li>You control what is exported, emailed, or uploaded to cloud storage.</li>
          </ul>
        </section>

        <section className="about-card about-author-card">
          <h3>Author</h3>
          <div className="about-author-head">
            <img className="about-author-photo" src={profilePic} alt="Ryan Kamp" />
            <div>
              <p><strong>Ryan Kamp</strong></p>
              <p className="text-muted">Creator of resmon</p>
            </div>
          </div>
          <div className="about-links" aria-label="Author links">
            {socialLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target={link.href.startsWith('mailto:') ? undefined : '_blank'}
                rel={link.href.startsWith('mailto:') ? undefined : 'noreferrer'}
                className="about-link-btn"
                title={link.label}
              >
                <span className="about-link-icon">{link.icon}</span>
                <span>{link.label}</span>
              </a>
            ))}
          </div>
        </section>
      </div>

      <p className="about-footer-note text-muted">
        Copyright (c) {new Date().getFullYear()} Ryan Kamp.
      </p>
    </div>
  );
};

export default AboutAppTab;
