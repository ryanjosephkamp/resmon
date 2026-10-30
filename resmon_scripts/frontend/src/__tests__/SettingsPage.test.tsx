/**
 * Settings — the tab bar's contract: five tabs. Cloud Account went with the
 * cloud service, and Cloud Storage with the Google sign-in: a backup is
 * written into a folder chosen on the Storage tab, Google Drive's among them.
 */

import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { screen } from '@testing-library/react';
import SettingsPage from '../pages/SettingsPage';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

const SETTINGS_ROUTES = {
  '/api/settings/email': {},
  '/api/settings/ai': {},
  '/api/settings/storage': {},
  '/api/settings/execution': {},
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
  test('renders exactly the five tabs', async () => {
    await mockRoutedFetch(SETTINGS_ROUTES);
    await renderSettings('/settings/email');

    for (const tab of ['Email', 'AI', 'Storage', 'Notifications', 'Advanced']) {
      expect(screen.getByRole('link', { name: tab })).toBeInTheDocument();
    }
    for (const gone of ['Cloud Account', 'Cloud Storage']) {
      expect(screen.queryByRole('link', { name: gone })).not.toBeInTheDocument();
    }
  });
});
