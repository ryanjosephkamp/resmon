/**
 * Required attributions must be on the page without being asked for.
 *
 * Four sources make a credit a condition of reuse. A credit that only appears
 * when the user expands a card is not displayed in the sense the obligation
 * means, so the block renders unconditionally — and a credit the upstream
 * merely *requests* must not be presented as one resmon is compelled to show.
 */

import React from 'react';
import { execFileSync } from 'child_process';
import path from 'path';
import { screen } from '@testing-library/react';
import RepositoriesPage from '../pages/RepositoriesPage';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

const base = {
  description: '', subject_coverage: '', endpoint: '', query_method: '',
  rate_limit: '', client_module: '', credential_name: null,
  website: '', registration_url: null, placeholder: '',
};

const CATALOG = [
  {
    ...base, slug: 'plos', name: 'PLOS', api_key_requirement: 'none',
    attribution: 'Data Provided by PLOS',
    attribution_requirement: 'required',
    attribution_source: 'https://api.plos.org/api-display-policy/',
  },
  {
    ...base, slug: 'openaire', name: 'OpenAIRE', api_key_requirement: 'none',
    attribution: 'Data from the OpenAIRE Graph, licensed CC BY 4.0.',
    attribution_requirement: 'required',
    attribution_source: 'https://graph.openaire.eu/docs/apis/terms/',
  },
  {
    ...base, slug: 'arxiv', name: 'arXiv', api_key_requirement: 'none',
    attribution: 'Thank you to arXiv for use of its open access interoperability.',
    attribution_requirement: 'requested',
    attribution_source: 'https://info.arxiv.org/help/api/index.html',
  },
  {
    ...base, slug: 'dblp', name: 'DBLP', api_key_requirement: 'none',
  },
];

const mount = async () => {
  mockRoutedFetch({
    '/api/repositories/catalog': CATALOG,
    '/api/credentials': { keyring_responsive: true, credentials: {} },
  });
  await renderWithProviders(<RepositoriesPage />);
};

describe('required attributions', () => {
  test('required credits render without expanding anything', async () => {
    await mount();
    expect(await screen.findByTestId('required-attributions')).toBeInTheDocument();
    expect(screen.getByText('Data Provided by PLOS')).toBeInTheDocument();
    expect(
      screen.getByText('Data from the OpenAIRE Graph, licensed CC BY 4.0.'),
    ).toBeInTheDocument();
  });

  test('a merely requested credit is not listed as required', async () => {
    await mount();
    const block = await screen.findByTestId('required-attributions');
    expect(block).not.toHaveTextContent('Thank you to arXiv');
  });

  test('each required credit links to the clause that imposes it', async () => {
    await mount();
    const block = await screen.findByTestId('required-attributions');
    const links = Array.from(block.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(links).toContain('https://api.plos.org/api-display-policy/');
    expect(links).toContain('https://graph.openaire.eu/docs/apis/terms/');
  });

  test('sources with no attribution add no row', async () => {
    await mount();
    const block = await screen.findByTestId('required-attributions');
    expect(block.querySelectorAll('li')).toHaveLength(2);
  });
});

describe('keyed-source terms note', () => {
  test('the page says whose terms bind the user for a keyed source', async () => {
    await mount();
    const note = await screen.findByTestId('keyed-source-terms-note');
    expect(note).toHaveTextContent('your own credential');
    expect(note).toHaveTextContent(/terms bind you/i);
  });
});

// Use the actual backend catalog: a hand-written fixture cannot discover a
// newly required credit. This imports static dataclasses only, with no server,
// network, keyring, or dependency on the live desktop daemon.
const realCatalog: Array<{ slug: string; attribution: string; attribution_requirement: string; attribution_source: string }> = JSON.parse(
  execFileSync(
    process.env.RESMON_PYTHON || 'python3',
    ['-c', 'import json; from implementation_scripts.repo_catalog import catalog_as_dicts; print(json.dumps(catalog_as_dicts()))'],
    { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' },
  ),
);

describe('catalog attribution parity', () => {
  test.each(realCatalog.filter((entry) => entry.attribution_requirement === 'required'))(
    '$slug renders its required credit byte-identically without expanding a row', async (entry) => {
      mockRoutedFetch({
        '/api/repositories/catalog': realCatalog,
        '/api/credentials': { keyring_responsive: true, credentials: {} },
      });
      await renderWithProviders(<RepositoriesPage />);
      const block = await screen.findByTestId('required-attributions');
      const credit = Array.from(block.querySelectorAll('li')).find((li) => li.textContent?.includes(entry.attribution));
      expect(credit).toBeDefined();
      // Compare the credit text itself, excluding the separate license link.
      expect(credit?.querySelector('.required-attributions__credit')?.textContent).toBe(entry.attribution);
      expect(credit?.querySelector('a')).toHaveAttribute('href', entry.attribution_source);
    },
  );
});
