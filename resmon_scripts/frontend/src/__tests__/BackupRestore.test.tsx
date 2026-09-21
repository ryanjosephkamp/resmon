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
  fk_violations: [],
  fk_violations_total: 0,
  fk_violations_message: '',
  needs_fk_acceptance: false,
  fk_violations_rows: 0,
  vault_destination: {
    root_path: '/Users/someone/Papers/resmon-library-v1',
    parent: '/Users/someone/Papers',
    name: 'resmon-library-v1',
    parent_exists: true,
    parent_writable: true,
  },
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
    confirm: 'CONFIRM', path: REPORT.path, accept_fk_violations: false,
  });
});

test('orphaned rows must be accepted before the restore can be staged', async () => {
  const fetchMock = mockRoutedFetch({
    '/api/backup/last': EMPTY,
    '/api/backup/verify': {
      ...REPORT,
      fk_violations: [{ table: 'library_file_documents', rowid: 4, parent: 'documents', fkid: 0 }],
      fk_violations_total: 1,
      fk_violations_message: '1 reference to a parent that is not there.',
      needs_fk_acceptance: true,
    },
    '/api/restore': { success: true, staged: {}, report: REPORT, next_step: 'Restart resmon to restore.' },
  });
  (window as any).resmonAPI = { getBackendPort: () => '1', platform: 'darwin',
    versions: { node: '', electron: '' }, chooseDirectory: async () => REPORT.path };

  await renderWithProviders(<BackupRestore />);
  fireEvent.click(screen.getByRole('button', { name: /Restore from backup/i }));

  const card = await screen.findByTestId('fk-violations');
  expect(card).toHaveTextContent('library_file_documents');
  // The bundle verifies fine; it is the orphans that hold the button.
  expect(screen.getByRole('button', { name: /Restart to restore/i })).toBeDisabled();

  fireEvent.click(screen.getByLabelText(/Restore anyway/i));
  expect(screen.getByRole('button', { name: /Restart to restore/i })).toBeEnabled();

  fireEvent.click(screen.getByRole('button', { name: /Restart to restore/i }));
  await waitFor(() => expect(callsTo(fetchMock, '/api/restore').length).toBe(1));
  expect(JSON.parse(String(callsTo(fetchMock, '/api/restore')[0].init?.body))).toEqual({
    confirm: 'CONFIRM', path: REPORT.path, accept_fk_violations: true,
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
        fk_violations_total: 2,
        fk_violations_rows: 1,
        fk_violations_message: '2 references to a parent that is not there, from 1 row.',
      },
    },
  });
  await renderWithProviders(<BackupRestore />);

  const card = await screen.findByTestId('reentry-card');
  expect(card).toHaveTextContent('smtp_password');
  expect(card).toHaveTextContent('openai_api_key');
  expect(card).toHaveTextContent(/row id/);
  // R2-3: the orphans the user chose to keep are named again after the fact.
  expect(screen.getByTestId('reentry-fk')).toHaveTextContent(
    '2 references, from 1 row, to a missing parent');
});

test('a bundle written before the row count says references and no row count', async () => {
  // The field is additive: an older bundle has no number here, and the card
  // must not print one — "not measured" is not "none".
  mockRoutedFetch({
    '/api/backup/last': {
      ...EMPTY,
      last_restore: {
        ok: true, acknowledged: false, bundle: '/backups/b1',
        credentials_to_reenter: [],
        fk_violations_total: 2,
        fk_violations_message: '2 references to a parent that is not there.',
      },
    },
  });
  await renderWithProviders(<BackupRestore />);

  const card = await screen.findByTestId('reentry-fk');
  expect(card).toHaveTextContent('2 references to a missing parent');
  expect(card).not.toHaveTextContent(/from \d+ rows?/);
});

test('the verify card says where the vault would go and can be pointed elsewhere', async () => {
  const fetchMock = mockRoutedFetch({
    '/api/backup/last': EMPTY,
    '/api/backup/verify': REPORT,
    '/api/restore': { success: true, staged: {}, report: REPORT, next_step: 'Restart resmon to restore.' },
  });
  const picked = ['/backups/resmon-backup-20260922T120000Z', '/Volumes/Archive/vaults'];
  (window as any).resmonAPI = { getBackendPort: () => '1', platform: 'darwin',
    versions: { node: '', electron: '' }, chooseDirectory: async () => picked.shift() };

  await renderWithProviders(<BackupRestore />);
  fireEvent.click(screen.getByRole('button', { name: /Restore from backup/i }));

  const destination = await screen.findByTestId('vault-destination');
  expect(destination).toHaveTextContent('/Users/someone/Papers/resmon-library-v1');
  expect(screen.queryByTestId('vault-parent-problem')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Restore the vault somewhere else/i }));
  await waitFor(() => expect(screen.getByTestId('vault-destination'))
    .toHaveTextContent('/Volumes/Archive/vaults'));
  expect(screen.getByTestId('vault-destination')).toHaveTextContent('resmon-library-v1');

  fireEvent.click(screen.getByRole('button', { name: /Restart to restore/i }));
  await waitFor(() => expect(callsTo(fetchMock, '/api/restore').length).toBe(1));
  expect(JSON.parse(String(callsTo(fetchMock, '/api/restore')[0].init?.body))).toEqual({
    confirm: 'CONFIRM',
    path: REPORT.path,
    accept_fk_violations: false,
    vault_parent: '/Volumes/Archive/vaults',
  });
});

test('a vault parent that is not on this machine is flagged before anything is staged', async () => {
  mockRoutedFetch({
    '/api/backup/last': EMPTY,
    '/api/backup/verify': {
      ...REPORT,
      vault_destination: { ...REPORT.vault_destination, parent_exists: false, parent_writable: false },
    },
  });
  (window as any).resmonAPI = { getBackendPort: () => '1', platform: 'darwin',
    versions: { node: '', electron: '' }, chooseDirectory: async () => REPORT.path };

  await renderWithProviders(<BackupRestore />);
  fireEvent.click(screen.getByRole('button', { name: /Restore from backup/i }));

  const problem = await screen.findByTestId('vault-parent-problem');
  expect(problem).toHaveTextContent('/Users/someone/Papers');
  expect(problem).toHaveTextContent('does not exist on this machine');
});

test('a backup with no vault shows no destination and no picker', async () => {
  mockRoutedFetch({
    '/api/backup/last': EMPTY,
    '/api/backup/verify': { ...REPORT, vault_relation: 'none_in_backup', vault_destination: null },
  });
  (window as any).resmonAPI = { getBackendPort: () => '1', platform: 'darwin',
    versions: { node: '', electron: '' }, chooseDirectory: async () => REPORT.path };

  await renderWithProviders(<BackupRestore />);
  fireEvent.click(screen.getByRole('button', { name: /Restore from backup/i }));

  await screen.findByTestId('verify-report');
  expect(screen.queryByTestId('vault-destination')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Restore the vault somewhere else/i }))
    .not.toBeInTheDocument();
});
