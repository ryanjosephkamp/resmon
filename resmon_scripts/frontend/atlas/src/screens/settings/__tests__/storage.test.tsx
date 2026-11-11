/**
 * Settings › Backup says where the copy an update kept of the database is, and
 * when it was written, from the engine's `pre_upgrade_copy`; with none, it says
 * there is none rather than leaving the line out.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { engine } from '../../../api/client';
import { Storage } from '../Storage';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../../bridge', () => ({ bridge: () => ({ getBackendPort: () => '51000' }) }));

// jsdom has no `Response`; the calls read only `data` and `error` on success.
const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

const LAST = {
  last_backup: null, last_backup_path_recorded: null, pending_restore: null, pending_restore_runs_when: null,
  pending_restore_runs_on: null, last_restore: null, undo_copies: [], drive_upload_retired: false, pre_upgrade_copy: null,
};
const HELD = {
  path: '/Users/ada/Library/Application Support/resmon/resmon-before-schema-24.db',
  schema_version: 24, written_at_utc: '2026-11-05T09:12:00+00:00', bytes: 52_428_800,
};

function mount(last: Record<string, unknown>) {
  (engine as jest.Mock).mockReturnValue({
    GET: jest.fn((path: string) => reply(path === '/api/backup/last' ? last : { export_directory: '/Users/ada/Backups' })),
    POST: jest.fn(), PUT: jest.fn(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Storage /></QueryClientProvider>);
}

afterEach(() => { jest.resetAllMocks(); });

test('names the copy kept before the last update, with its path and the day it was written', async () => {
  const { container } = mount({ ...LAST, pre_upgrade_copy: HELD });
  expect(await screen.findByRole('heading', { name: 'Before an Update' })).toBeInTheDocument();
  const line = container.querySelector('[data-backup="pre-upgrade-copy"]')!;
  expect(line.textContent).toContain('Before the last update changed your database, resmon kept a copy of it as it was');
  expect(line.querySelector('code')?.textContent).toBe(HELD.path);
  expect(line.textContent).toMatch(/written on November 5, 2026/);
  // Read-only: nothing on the line acts on the copy.
  expect(container.querySelectorAll('[data-backup="before-update"] button')).toHaveLength(0);
});

test('with no copy beside the database, says one is kept before an update and that there is none now', async () => {
  const { container } = mount(LAST);
  await screen.findByRole('heading', { name: 'Before an Update' });
  const line = container.querySelector('[data-backup="pre-upgrade-copy"]')!;
  expect(line.textContent).toBe(
    'Before an update changes your database, resmon keeps a copy of it in the same folder, if the disk has room. '
    + 'There is none there now.');
  expect(line.querySelector('code')).toBeNull();
});
