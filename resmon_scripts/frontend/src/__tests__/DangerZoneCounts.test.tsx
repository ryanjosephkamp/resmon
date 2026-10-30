/**
 * The Danger Zone says what an erase removed, from the counts the backend
 * answered, and a count of none says there was nothing there.
 *
 * The backend counts a key only when one was stored and is now gone, so on a
 * computer with no key stored an erase answers 0. That has to read as a fact
 * about the keyring rather than as an erase that did nothing.
 */
import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import AdvancedSettings, { erasedWords } from '../components/Settings/AdvancedSettings';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

const ROUTES = {
  '/api/settings/execution': { max_concurrent_executions: 3, routine_fire_queue_limit: 16 },
  '/api/scheduler/jobs': [],
  '/api/service/status': { installed: false, unit_path: '/x', platform: 'darwin' },
  '/api/service/daemon-status': { lock_present: false, running: false },
};

test('counts above none are named, and none says nothing was there', () => {
  expect(erasedWords({ success: true, ai_keys_removed: 2 })).toBe('Removed 2 AI API keys.');
  expect(erasedWords({ success: true, repo_keys_removed: 1 })).toBe('Removed 1 repo API key.');
  expect(erasedWords({ success: true, ai_keys_removed: 0 })).toBe('No AI API keys were stored, so none were removed.');
  expect(erasedWords({ success: true, documents_removed: 0 })).toBe('There were no papers to remove.');
  expect(erasedWords({
    success: true, configs_removed: 2, executions_removed: 0, documents_removed: 16065, settings_cleared: 9,
    ai_keys_removed: 0, repo_keys_removed: 0, smtp_credentials_removed: 0,
  })).toBe('Removed 2 saved configurations and 16,065 papers. There were no executions to remove. '
    + 'No AI API keys, repo API keys, or email passwords were stored, so none were removed.');
  expect(erasedWords({ success: true })).toBe('');
  expect(erasedWords(null)).toBe('');
});

test('erasing AI keys with none stored says so', async () => {
  mockRoutedFetch({ ...ROUTES, '/api/admin/erase-ai-keys': { success: true, ai_keys_removed: 0 } });
  await renderWithProviders(<AdvancedSettings />);
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Erase all AI API keys' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  });

  expect(await screen.findByRole('status')).toHaveTextContent(
    'Erase all AI API keys: done. No AI API keys were stored, so none were removed.',
  );
});
