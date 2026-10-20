/**
 * Configurations page — the Import control, and the file it has to take.
 *
 * Export Selected writes a ZIP holding one JSON file per chosen configuration.
 * The Import control refused anything whose name did not end `.json`, so the
 * one file the page itself produces was the one file it would not accept. The
 * refusal also named only what it had rejected, never what it wanted.
 *
 * These are jsdom tests of the page's own gate and of the request it sends.
 * They cannot tell you the backend reads the archive — that is
 * `verification_scripts/test_config_roundtrip.py`, which exports and imports
 * the real bytes.
 */

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import ConfigurationsPage from '../pages/ConfigurationsPage';
import { callsTo, mockRoutedFetch, renderWithProviders } from './testUtils';

const CATALOG_ROUTES = {
  '/api/repositories/catalog': [],
  '/api/credentials': {},
};

const CONFIGS = [
  {
    id: 7,
    name: 'codex-walk',
    config_type: 'manual_dive',
    parameters: JSON.stringify({ keywords: ['codex walk'], repository: 'arxiv' }),
  },
];

const fileInput = (): HTMLInputElement =>
  document.querySelector('input[type="file"]') as HTMLInputElement;

const choose = (files: File[]) => {
  const input = fileInput();
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
};

describe('Configurations — importing what the page exported', () => {
  test('the archive Export Selected produces is uploaded, not refused', async () => {
    const mock = mockRoutedFetch({
      ...CATALOG_ROUTES,
      '/api/configurations': CONFIGS,
      '/api/configurations/import': { imported: 1, routines_created: 0, errors: [] },
    });
    await renderWithProviders(<ConfigurationsPage />);
    await screen.findByText('Import');

    choose([new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
                     'resmon_configs_20261019T120000.zip',
                     { type: 'application/zip' })]);

    await waitFor(() => {
      expect(callsTo(mock, '/api/configurations/import')).toHaveLength(1);
    });
    expect(screen.queryByText(/Only .json files accepted/)).not.toBeInTheDocument();
  });

  test('loose JSON files out of an archive are still uploaded', async () => {
    const mock = mockRoutedFetch({
      ...CATALOG_ROUTES,
      '/api/configurations': CONFIGS,
      '/api/configurations/import': { imported: 1, routines_created: 0, errors: [] },
    });
    await renderWithProviders(<ConfigurationsPage />);
    await screen.findByText('Import');

    choose([new File(['{"config_type":"manual_dive","name":"x"}'],
                     'config_manual_dive_codex_walk_7.json',
                     { type: 'application/json' })]);

    await waitFor(() => {
      expect(callsTo(mock, '/api/configurations/import')).toHaveLength(1);
    });
  });

  test('a file it genuinely cannot take is refused with what it wanted', async () => {
    const mock = mockRoutedFetch({
      ...CATALOG_ROUTES,
      '/api/configurations': CONFIGS,
      '/api/configurations/import': { imported: 0, routines_created: 0, errors: [] },
    });
    await renderWithProviders(<ConfigurationsPage />);
    await screen.findByText('Import');

    choose([new File(['notes'], 'notes.txt', { type: 'text/plain' })]);

    const message = await screen.findByText(/notes\.txt/);
    // The refusal has to name the thing the user actually has in hand: the
    // .zip the export wrote. Naming only ".json" is what sent the walker
    // looking for a file the page never produces.
    expect(message.textContent).toMatch(/\.zip/);
    expect(message.textContent).toMatch(/\.json/);
    expect(callsTo(mock, '/api/configurations/import')).toHaveLength(0);
  });

  test('the file picker offers both shapes', async () => {
    mockRoutedFetch({ ...CATALOG_ROUTES, '/api/configurations': CONFIGS });
    await renderWithProviders(<ConfigurationsPage />);
    await screen.findByText('Import');

    const accept = fileInput().getAttribute('accept') || '';
    expect(accept).toContain('.zip');
    expect(accept).toContain('.json');
  });

  test('files the backend could not read are reported, not swallowed', async () => {
    mockRoutedFetch({
      ...CATALOG_ROUTES,
      '/api/configurations': CONFIGS,
      '/api/configurations/import': {
        imported: 1,
        routines_created: 0,
        errors: ['holiday-photos.zip: no configuration files inside'],
      },
    });
    await renderWithProviders(<ConfigurationsPage />);
    await screen.findByText('Import');

    choose([new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
                     'holiday-photos.zip', { type: 'application/zip' })]);

    // Assert on the backend's own sentence, not merely the filename: the old
    // client-side refusal also contained the filename, so matching that alone
    // would pass against the very behavior this test exists to change.
    expect(await screen.findByText(/no configuration files inside/))
      .toBeInTheDocument();
  });
});
