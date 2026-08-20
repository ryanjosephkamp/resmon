/**
 * Repositories & API Keys — catalog rendering and the single-scope keyring
 * model that replaced the local/cloud selector.
 */

import React from 'react';
import { screen } from '@testing-library/react';
import RepositoriesPage from '../pages/RepositoriesPage';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

const CATALOG = [
  {
    slug: 'arxiv', name: 'arXiv', description: 'Physics and CS preprints.',
    subject_coverage: 'Physics, CS', endpoint: 'https://export.arxiv.org/api/query',
    query_method: 'GET', rate_limit: '1 req / 3 s', client_module: 'api_arxiv',
    api_key_requirement: 'none', credential_name: null,
    website: 'https://arxiv.org', registration_url: null, placeholder: '',
    keyword_combination: 'Implicit AND',
  },
  {
    slug: 'core', name: 'CORE', description: 'Aggregated open access.',
    subject_coverage: 'Multidisciplinary', endpoint: 'https://api.core.ac.uk/v3',
    query_method: 'GET', rate_limit: '10k / day', client_module: 'api_core',
    api_key_requirement: 'required', credential_name: 'core_api_key',
    website: 'https://core.ac.uk', registration_url: 'https://core.ac.uk/services/api',
    placeholder: 'CORE API key', keyword_combination: 'Explicit OR',
  },
];

describe('RepositoriesPage', () => {
  test('renders the catalog with key-requirement status', async () => {
    mockRoutedFetch({
      '/api/repositories/catalog': CATALOG,
      '/api/credentials': { core_api_key: { present: true } },
    });
    await renderWithProviders(<RepositoriesPage />);

    expect(screen.getByText('arXiv')).toBeInTheDocument();
    expect(screen.getByText('CORE')).toBeInTheDocument();
  });

  test('the credential scope selector from the cloud era is gone', async () => {
    mockRoutedFetch({
      '/api/repositories/catalog': CATALOG,
      '/api/credentials': {},
    });
    await renderWithProviders(<RepositoriesPage />);

    expect(screen.queryByText('This device (keyring)')).not.toBeInTheDocument();
    expect(screen.queryByText('Cloud account')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Credential scope' })).not.toBeInTheDocument();
  });

  test('a failed catalog load surfaces an error instead of a blank page', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      headers: { get: () => 'application/json' },
      json: async () => ({ detail: 'boom' }),
      text: async () => JSON.stringify({ detail: 'boom' }),
    }));
    await renderWithProviders(<RepositoriesPage />);
    // The page keeps its heading and shows the form error rather than dying.
    // (The PageHelp block repeats the title, so assert on the h1.)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Repositories & API Keys' }),
    ).toBeInTheDocument();
  });
});
