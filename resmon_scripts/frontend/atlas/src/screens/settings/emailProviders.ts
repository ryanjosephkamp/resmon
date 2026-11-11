/**
 * Mail providers Settings › Email can fill in, and the one step each asks of
 * a person before resmon can send through it.
 *
 * Each setting is the provider's own, read from its help pages on November
 * 10, 2026:
 * - Gmail: smtp.gmail.com, STARTTLS on 587, the full address as the username
 *   (support.google.com/mail/answer/7104828); an app password needs 2-Step
 *   Verification and is made at myaccount.google.com/apppasswords
 *   (support.google.com/accounts/answer/185833).
 * - iCloud Mail: smtp.mail.me.com on 587, the full iCloud Mail address as the
 *   username, an app-specific password (support.apple.com/en-us/102525),
 *   made under Sign-In and Security at account.apple.com, which needs
 *   two-factor authentication (support.apple.com/en-us/102654).
 *
 * Outlook.com is not here: its own page lists OAuth2 as the only way to sign
 * in to its SMTP server, and resmon signs in with a username and a password.
 */

export type ProviderId = 'gmail' | 'icloud' | 'other';

export interface Provider {
  id: ProviderId;
  label: string;
  /** What choosing it fills in; nothing for Other. */
  server: string | null;
  port: string | null;
  /** The account name a provider signs in with. */
  username: string | null;
  /** The step before a send can work, and where it is taken. */
  step: string | null;
  link: { href: string; words: string } | null;
  caveat: string | null;
}

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'gmail', label: 'Gmail', server: 'smtp.gmail.com', port: '587',
    username: 'Your full Gmail address',
    step: 'Gmail does not accept your Google Account password here. Turn on 2-Step Verification for the account, '
      + 'then make an app password and store it below as the password.',
    link: { href: 'https://myaccount.google.com/apppasswords', words: 'Make an app password' },
    caveat: 'Some work, school, and Advanced Protection accounts do not offer app passwords. '
      + 'Changing the Google Account password revokes them.',
  },
  {
    id: 'icloud', label: 'iCloud Mail', server: 'smtp.mail.me.com', port: '587',
    username: 'Your full iCloud Mail address, such as name@icloud.com, not the name alone',
    step: 'iCloud Mail does not accept your Apple Account password here. Sign in at account.apple.com, choose '
      + 'Sign-In and Security, then App-Specific Passwords, and store the password it makes below.',
    link: { href: 'https://account.apple.com', words: 'Open account.apple.com' },
    caveat: 'The Apple Account needs two-factor authentication. Changing its password revokes app-specific passwords.',
  },
  {
    id: 'other', label: 'Other', server: null, port: null, username: null,
    step: null, link: null, caveat: null,
  },
];

/** The provider a stored server belongs to, or null when none is set yet. */
export function providerOf(server: string): ProviderId | null {
  const host = server.trim().toLowerCase();
  if (!host) return null;
  return PROVIDERS.find((p) => p.server === host)?.id ?? 'other';
}

/** How a port is encrypted, in words: 465 from the start, any other by STARTTLS before anything is sent. */
export function securityWords(port: string): string {
  const n = Number(port.trim() || '587');
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 'A port is a whole number from 1 to 65,535.';
  return n === 465
    ? 'Port 465 is encrypted from the start (TLS).'
    : `Port ${n} starts plain and is encrypted with STARTTLS before anything is sent.`;
}
