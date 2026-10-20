/**
 * The requirement, driven through the real Deep Sweep form: a user who picks
 * DBLP and sets a window inside one calendar year learns what DBLP will do
 * with it **before** they press Run.
 *
 * Today that fact arrives after the sweep, as a zero with an explanation
 * attached — accurate, and too late to act on. This file is the difference,
 * so it is written against the page rather than against the component: a
 * notice that renders in isolation and is never mounted would pass a
 * component test and change nothing for anybody.
 */

import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import DeepSweepPage from '../pages/DeepSweepPage';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

const DBLP = {
  slug: 'dblp',
  name: 'DBLP',
  description: 'Computer science bibliography.',
  subject_coverage: 'Computer science',
  endpoint: 'https://dblp.org/search/publ/api',
  query_method: 'GET',
  rate_limit: '0.5 req/s',
  client_module: 'api_dblp.py',
  api_key_requirement: 'none',
  credential_name: null,
  website: 'https://dblp.org',
  registration_url: null,
  placeholder: '',
  keyword_combination: 'Implicit AND',
  keyword_combination_notes: 'DBLP ANDs the terms.',
  date_granularity: 'year',
  constraints: {
    window_effect: 'whole_years',
    window_rounding: 'inward',
    window_refiltered_locally: false,
    keyword_search: 'upstream',
    records_per_request: null,
    notices: [
      {
        kind: 'date_window',
        effect:
          'DBLP records only a year, so resmon searches the whole calendar '
          + 'years inside your window.',
        established: 'api_dblp.py:138-152.',
        applies_when: 'with_date_window',
      },
    ],
    established: 'api_dblp.py:138-152 and api_dblp.py:239-242.',
  },
};

const ARXIV = {
  ...DBLP,
  slug: 'arxiv',
  name: 'arXiv',
  description: 'Preprints.',
  client_module: 'api_arxiv.py',
  website: 'https://arxiv.org',
  date_granularity: 'day',
  constraints: {
    window_effect: 'as_asked',
    window_rounding: 'none',
    window_refiltered_locally: false,
    keyword_search: 'upstream',
    records_per_request: null,
    notices: [],
    established: 'api_arxiv.py:70-75.',
  },
};

function routes() {
  return {
    '/api/search/repositories': ['arxiv', 'dblp'],
    '/api/repositories/catalog': [ARXIV, DBLP],
    '/api/credentials': { keyring_responsive: true, credentials: {} },
    '/api/configurations?config_type=manual_sweep': [],
  };
}

async function selectRepository(slug: string) {
  // The multi-select renders one checkbox per slug, labeled with the slug.
  const checkbox = screen.getByRole('checkbox', { name: slug });
  await act(async () => {
    fireEvent.click(checkbox);
  });
}

async function setDates(from: string, to: string) {
  // DateRangePicker's two labels are not associated with their inputs, so
  // the inputs are found by type rather than by label.
  const inputs = document.querySelectorAll('input[type="date"]');
  expect(inputs).toHaveLength(2);
  await act(async () => {
    fireEvent.change(inputs[0], { target: { value: from } });
    fireEvent.change(inputs[1], { target: { value: to } });
  });
}

describe('Deep Sweep tells the user before they submit', () => {
  test('a window inside one calendar year says DBLP will not be searched', async () => {
    mockRoutedFetch(routes());
    await renderWithProviders(<DeepSweepPage />);

    await selectRepository('dblp');
    await setDates('2025-03-01', '2025-09-30');

    const notice = screen.getByTestId('source-constraint-notice');
    expect(notice).toHaveTextContent('DBLP will not be searched at all');
    expect(notice).toHaveTextContent('no complete calendar year');

    // Nothing was submitted to get this.
    expect(screen.getByRole('button', { name: /Run Deep Sweep/i })).toBeInTheDocument();
  });

  test('widening the window to whole years changes the sentence, still before submission', async () => {
    mockRoutedFetch(routes());
    await renderWithProviders(<DeepSweepPage />);

    await selectRepository('dblp');
    await setDates('2025-01-01', '2026-12-31');

    expect(screen.getByTestId('source-constraint-notice')).toHaveTextContent(
      'DBLP will search all of 2025 and 2026',
    );
  });

  test('selecting only an unconstrained source leaves the form quiet', async () => {
    mockRoutedFetch(routes());
    await renderWithProviders(<DeepSweepPage />);

    await selectRepository('arxiv');
    await setDates('2025-03-01', '2025-09-30');

    expect(screen.queryByTestId('source-constraint-notice')).not.toBeInTheDocument();
  });
});
