/**
 * Settings — the tab bar's contract after the cloud removal: six tabs, with
 * Cloud Storage (Google Drive backup) intact and Cloud Account gone.
 */

import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { screen } from '@testing-library/react';
import SettingsPage from '../pages/SettingsPage';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

const SETTINGS_ROUTES = {
  '/api/settings/email': {},
  '/api/settings/cloud': {},
  '/api/settings/ai': {},
  '/api/settings/storage': {},
  '/api/settings/execution': {},
  '/api/cloud/status': { is_linked: false, api_ok: false, api_reason: 'no_token' },
  '/api/service/status': { installed: false, unit_path: '', platform: 'darwin' },
  '/api/service/daemon-status': { running: false },
};

async function renderSettings(path: string) {
  await renderWithProviders(
    <Routes>
      <Route path="/settings/*" element={<SettingsPage />} />
    </Routes>,
    [path],
  );
}

describe('SettingsPage', () => {
  test('renders exactly the six post-cloud tabs', async () => {
    await mockRoutedFetch(SETTINGS_ROUTES);
    await renderSettings('/settings/email');

    for (const tab of ['Email', 'Cloud Storage', 'AI', 'Storage', 'Notifications', 'Advanced']) {
      expect(screen.getByRole('link', { name: tab })).toBeInTheDocument();
    }
    expect(screen.queryByRole('link', { name: 'Cloud Account' })).not.toBeInTheDocument();
  });

  test('Cloud Storage tab is Google Drive backup and still stands', async () => {
    await mockRoutedFetch(SETTINGS_ROUTES);
    await renderSettings('/settings/cloud');

    expect(screen.getAllByText(/Google Drive/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
  });
});
