/**
 * Settings → Storage → Backup and restore.
 *
 * The two things this panel must not get wrong, pinned here because a jsdom
 * test is the only place that can watch the wire:
 *
 *  * "Restore from backup…" must not restore. It verifies, shows the report,
 *    and only a second, explicit click stages anything — and even that only
 *    schedules the work for the next start.
 *  * Every destructive call carries the literal CONFIRM the backend
 *    re-validates, so a renderer that forgets it is a 400 rather than a
 *    surprise.
 */

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import BackupRestore from '../components/Settings/BackupRestore';
import { callsTo, mockRoutedFetch, renderWithProviders } from './testUtils';

const EMPTY = {
  last_backup: null, pending_restore: null, last_restore: null, undo_copies: [],
};

const REPORT = {
  path: '/backups/resmon-backup-20260922T120000Z',
  manifest: { app_version: '2.2.0', schema_version: 21, vault_id: 'v1' },
  files_checked: 7,
  files_in_manifest: 7,
  schema_relation: 'same',
  vault_relation: 'same',
  problems: [],
  ok: true,
  will_not_restore: {
    credentials: ['smtp_password'],
    process_state: ['daemon.lock'],
    note: 'Executions that were running are reset.',
  },
};

afterEach(() => {
  delete (window as { resmonAPI?: unknown }).resmonAPI;
});

test('backing up sends the literal CONFIRM and the reports choice', async () => {
  const fetchMock = mockRoutedFetch({
    '/api/backup/last': EMPTY,
    '/api/backup': { success: true, path: '/backups/b1', manifest: {} },
  });
  await renderWithProviders(<BackupRestore />);

  fireEvent.click(screen.getByLabelText(/Include the reports folder/i));
  fireEvent.click(screen.getByRole('button', { name: /Back up now/i }));

  await waitFor(() => expect(callsTo(fetchMock, '/api/backup').length).toBeGreaterThan(0));
  const call = callsTo(fetchMock, '/api/backup').find((c) => c.init?.method === 'POST');
  expect(JSON.parse(String(call?.init?.body))).toEqual({
    confirm: 'CONFIRM', include_reports: false,
  });
});

test('choosing a backup verifies it and restores nothing until a second click', async () => {
  const fetchMock = mockRoutedFetch({
    '/api/backup/last': EMPTY,
    '/api/backup/verify': REPORT,
    '/api/restore': { success: true, staged: {}, report: REPORT, next_step: 'Restart resmon to restore.' },
  });
  (window as any).resmonAPI = { getBackendPort: () => '1', platform: 'darwin',
    versions: { node: '', electron: '' }, chooseDirectory: async () => REPORT.path };

  await renderWithProviders(<BackupRestore />);
  fireEvent.click(screen.getByRole('button', { name: /Restore from backup/i }));

  await screen.findByTestId('verify-report');
  expect(screen.getByText(/7 of 7 files re-hashed/)).toBeInTheDocument();
  // Nothing has been staged yet.
  expect(callsTo(fetchMock, '/api/restore')).toHaveLength(0);

  fireEvent.click(screen.getByRole('button', { name: /Restart to restore/i }));
  await waitFor(() => expect(callsTo(fetchMock, '/api/restore').length).toBe(1));
  expect(JSON.parse(String(callsTo(fetchMock, '/api/restore')[0].init?.body))).toEqual({
    confirm: 'CONFIRM', path: REPORT.path,
  });
});

test('a tampered backup shows its problems and cannot be staged', async () => {
  mockRoutedFetch({
    '/api/backup/last': EMPTY,
    '/api/backup/verify': {
      ...REPORT, ok: false, files_checked: 6,
      problems: ['vault/files/a/b.txt does not match the hash the manifest records.'],
    },
  });
  (window as any).resmonAPI = { getBackendPort: () => '1', platform: 'darwin',
    versions: { node: '', electron: '' }, chooseDirectory: async () => REPORT.path };

  await renderWithProviders(<BackupRestore />);
  fireEvent.click(screen.getByRole('button', { name: /Restore from backup/i }));

  await screen.findByTestId('verify-report');
  expect(screen.getByText(/does not match the hash/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Restart to restore/i })).toBeDisabled();
});

test('after a restore the card names the credentials that did not come back', async () => {
  mockRoutedFetch({
    '/api/backup/last': {
      ...EMPTY,
      last_restore: {
        ok: true, acknowledged: false, bundle: '/backups/b1',
        credentials_to_reenter: ['smtp_password', 'openai_api_key'],
      },
    },
  });
  await renderWithProviders(<BackupRestore />);

  const card = await screen.findByTestId('reentry-card');
  expect(card).toHaveTextContent('smtp_password');
  expect(card).toHaveTextContent('openai_api_key');
  expect(card).toHaveTextContent(/row id/);
});
