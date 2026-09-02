/**
 * Watchdog page — the honesty of the headline, and the two alarm levels.
 *
 * The backend already refuses to promote an inference to a fact. This suite
 * pins the interface to the same standard, because the place that distinction
 * is most easily lost is in the rendering: a red banner over an "unusual"
 * finding would undo the whole design without changing a line of Python.
 *
 * Three things are load-bearing here:
 *
 * 1. "Nothing to check yet" and "Nothing looks wrong" are different claims,
 *    and an install with no history must get the first one.
 * 2. Every finding carries the gloss saying what its severity means.
 * 3. Advice never appears under "what needs your attention".
 */

import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WatchdogPage from '../pages/WatchdogPage';

const THRESHOLDS = {
  consecutive_errors: 3,
  consecutive_zeros: 4,
  min_baseline_runs: 5,
  flatline_runs: 5,
  overdue_cadence_multiple: 3,
  overdue_floor_days: 1,
  cadence_lag_multiple: 2,
  min_runs_for_cadence: 3,
};

const EMPTY = {
  checked_at: '2026-08-20T12:00:00Z',
  findings: [],
  counts: { broken: 0, unusual: 0, advice: 0, muted: 0, alarms: 0 },
  not_enough_data: [],
  watching: { sources: 0, routines: 0 },
  thresholds: THRESHOLDS,
  sufficient: false,
};

const ALL_CLEAR = {
  ...EMPTY,
  watching: { sources: 3, routines: 2 },
  sufficient: true,
};

const BROKEN_FINDING = {
  key: 'source_errors:arxiv',
  severity: 'broken' as const,
  kind: 'source_errors',
  scope: { type: 'source' as const, id: 'arxiv' },
  title: 'arxiv has failed on its last 3 runs',
  detail: 'Every query raised an error. The most recent one was: HTTP 503.',
  what_to_do: 'Check whether arxiv is reachable.',
  evidence: {
    consecutive_errors: 3,
    last_error: 'HTTP 503',
    last_success_at: '2026-08-10T03:00:00Z',
    runs_recorded: 9,
  },
  muted: false,
  muted_at: null,
};

const UNUSUAL_FINDING = {
  key: 'source_quiet:pubmed',
  severity: 'unusual' as const,
  kind: 'source_quiet',
  scope: { type: 'source' as const, id: 'pubmed' },
  title: 'pubmed has returned nothing on its last 4 runs',
  detail: 'It used to return a median of 30 results. resmon cannot tell which.',
  what_to_do: 'Run a Deep Dive with a broad query.',
  evidence: { zero_runs: 4, baseline_runs: 6, typical_results: 30 },
  muted: false,
  muted_at: null,
};

const ADVICE_FINDING = {
  key: 'cadence_advice:1',
  severity: 'advice' as const,
  kind: 'cadence_advice',
  scope: { type: 'routine' as const, id: 1, name: 'ADS daily' },
  title: "'ADS daily' may be running more often than its sources update",
  detail: 'nasa_ads has taken a median of 6 days to surface a paper to you.',
  what_to_do: 'Consider a slower schedule.',
  evidence: { cadence_days: 1, lag_includes_polling_interval: true },
  muted: false,
  muted_at: null,
};

const WITH_FINDINGS = {
  ...EMPTY,
  findings: [BROKEN_FINDING, UNUSUAL_FINDING, ADVICE_FINDING],
  counts: { broken: 1, unusual: 1, advice: 1, muted: 0, alarms: 2 },
  watching: { sources: 3, routines: 2 },
  sufficient: true,
};

/** No paper checked yet — the state a fresh install is in. */
const LIFECYCLE_EMPTY = {
  findings: [],
  counts: { critical: 0, caution: 0, informational: 0 },
  coverage: {
    corpus: 0, checked: 0, no_identifier: 0, errored: 0, unchecked: 0,
    last_checked_at: null, recheck_after_days: 30,
  },
  sufficient: false,
  run: { running: false, started_at: null, error: null, last: null },
};

function mockFetch(payload: unknown, lifecycle: unknown = LIFECYCLE_EMPTY) {
  const mock = jest.fn(async (input?: RequestInfo | URL, _init?: RequestInit) => {
    const body = String(input).includes('/api/lifecycle') ? lifecycle : payload;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
  (global as any).fetch = mock;
  return mock;
}

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <WatchdogPage />
      </MemoryRouter>,
    );
  });
}

describe('Watchdog page', () => {
  test('an install with no history is told so, not given a clean bill of health', async () => {
    mockFetch(EMPTY);
    await renderPage();

    expect(screen.getByText('Nothing to check yet')).toBeInTheDocument();
    // The distinction the whole page rests on: silence from a watchdog with
    // nothing to go on is not the same claim as silence after checking.
    expect(screen.queryByText('Nothing looks wrong')).not.toBeInTheDocument();
  });

  test('a checked install with no findings says so, and says what it checked', async () => {
    mockFetch(ALL_CLEAR);
    await renderPage();

    expect(screen.getByText('Nothing looks wrong')).toBeInTheDocument();
    expect(screen.getByText(/3 sources and 2 active routines/)).toBeInTheDocument();
  });

  test('broken and unusual are counted separately in the headline', async () => {
    mockFetch(WITH_FINDINGS);
    await renderPage();

    const heading = screen.getByRole('heading', { level: 2, name: /broken/ });
    expect(heading).toHaveTextContent('1 thing is broken');
    expect(heading).toHaveTextContent('1 looks unusual');
  });

  test('each severity states what it claims, so color is not the only signal', async () => {
    mockFetch(WITH_FINDINGS);
    await renderPage();

    expect(screen.getByText(/It is not an inference/)).toBeInTheDocument();
    expect(screen.getByText(/There may be an innocent reason/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is wrong\. Worth considering/)).toBeInTheDocument();
  });

  test('advice is kept out of the attention section', async () => {
    mockFetch(WITH_FINDINGS);
    await renderPage();

    const attention = screen.getByRole('heading', { name: 'What needs your attention' })
      .closest('section')!;
    expect(attention).toHaveTextContent('arxiv has failed');
    expect(attention).not.toHaveTextContent('may be running more often');

    const considering = screen.getByRole('heading', { name: 'Worth considering' })
      .closest('section')!;
    expect(considering).toHaveTextContent('may be running more often');
  });

  test('the evidence behind a finding is available but not shouted', async () => {
    mockFetch(WITH_FINDINGS);
    await renderPage();

    expect(screen.queryByText('Most recent error')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getAllByText('Show the evidence')[0]);
    });

    expect(screen.getByText('Most recent error')).toBeInTheDocument();
    expect(screen.getByText('HTTP 503')).toBeInTheDocument();
  });

  test('the thresholds it used are published on the page', async () => {
    mockFetch(WITH_FINDINGS);
    await renderPage();

    const how = screen.getByRole('heading', { name: 'How it decides' }).closest('section')!;
    expect(how).toHaveTextContent('3 failing runs in a row');
    expect(how).toHaveTextContent('4 empty runs');
  });

  test('muting posts the finding key and re-reads the report', async () => {
    const mock = mockFetch(WITH_FINDINGS);
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getAllByText('Mute')[0]);
    });

    await waitFor(() => {
      const posts = mock.mock.calls.filter(
        ([, init]: any) => init?.method === 'POST',
      );
      expect(posts).toHaveLength(1);
      expect(String(posts[0][0])).toContain('/api/watchdog/mute');
      expect(JSON.parse((posts[0][1] as any).body).finding_key).toBe('source_errors:arxiv');
    });
  });

  test('a muted finding stays listed and stops counting', async () => {
    mockFetch({
      ...WITH_FINDINGS,
      findings: [{ ...BROKEN_FINDING, muted: true, muted_at: '2026-08-20T09:00:00Z' }],
      counts: { broken: 0, unusual: 0, advice: 0, muted: 1, alarms: 0 },
    });
    await renderPage();

    expect(screen.getByText('Nothing looks wrong')).toBeInTheDocument();
    // Listed under Muted, with a way back.
    expect(screen.getByRole('heading', { name: 'Muted (1)' })).toBeInTheDocument();
    expect(screen.getByText('Unmute')).toBeInTheDocument();
  });

  test('what it cannot yet judge is shown rather than hidden', async () => {
    mockFetch({
      ...ALL_CLEAR,
      not_enough_data: [
        {
          scope: { type: 'source', id: 'hal' },
          reason: '2 runs on record; a baseline needs 5.',
          runs_recorded: 2,
          runs_needed: 5,
        },
      ],
    });
    await renderPage();

    expect(screen.getByText('Not enough history to judge yet')).toBeInTheDocument();
    expect(screen.getByText('2 runs on record; a baseline needs 5.')).toBeInTheDocument();
  });

  // --- Papers that changed after you found them ---------------------------
  //
  // The distinction that matters here is the same one the watchdog rests on: an
  // empty list on an unchecked corpus is "nobody looked", not "all clear".

  test('an unchecked corpus is never presented as free of retractions', async () => {
    mockFetch(ALL_CLEAR, LIFECYCLE_EMPTY);
    await renderPage();

    expect(screen.getByText(/No paper has been checked yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing has changed/)).not.toBeInTheDocument();
  });

  test('a checked corpus with nothing found says how much was checked', async () => {
    mockFetch(ALL_CLEAR, {
      ...LIFECYCLE_EMPTY,
      coverage: { ...LIFECYCLE_EMPTY.coverage, corpus: 100, checked: 60, unchecked: 40 },
      sufficient: true,
    });
    await renderPage();

    expect(screen.getByText(/Nothing has changed in the 60 papers checked/))
      .toBeInTheDocument();
    // And it does not let the unchecked remainder pass unmentioned.
    expect(screen.getByText(/remaining 40 have not been looked at/))
      .toBeInTheDocument();
  });

  test('a retraction is listed with its notice as a link', async () => {
    mockFetch(ALL_CLEAR, {
      ...LIFECYCLE_EMPTY,
      sufficient: true,
      counts: { critical: 1, caution: 0, informational: 0 },
      coverage: { ...LIFECYCLE_EMPTY.coverage, corpus: 10, checked: 10 },
      findings: [{
        document_id: 4,
        title: 'Ileal-lymphoid-nodular hyperplasia',
        document_doi: '10.1016/s0140-6736(97)11096-0',
        source_repository: 'crossref',
        publication_date: '1998-02-28',
        kind: 'retraction',
        severity: 'critical',
        label: 'Retraction',
        notice_doi: '10.1016/s0140-6736(10)60175-4',
        notice_url: 'https://doi.org/10.1016/s0140-6736(10)60175-4',
        notice_date: '2010-02-06',
        detail: null,
        provider: 'crossref',
        provider_source: 'retraction-watch',
      }],
    });
    await renderPage();

    expect(screen.getByText('Ileal-lymphoid-nodular hyperplasia')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retraction' }))
      .toHaveAttribute('href', 'https://doi.org/10.1016/s0140-6736(10)60175-4');
    expect(screen.getByText('1 withdrawn')).toBeInTheDocument();
  });

  test('the weaker coverage of non-retraction notices is stated', async () => {
    mockFetch(ALL_CLEAR, {
      ...LIFECYCLE_EMPTY,
      sufficient: true,
      counts: { critical: 0, caution: 1, informational: 0 },
      coverage: { ...LIFECYCLE_EMPTY.coverage, corpus: 10, checked: 10 },
      findings: [{
        document_id: 4, title: 'A paper', document_doi: '10.1/a',
        source_repository: 'crossref', publication_date: '2020-01-01',
        kind: 'expression_of_concern', severity: 'caution',
        label: 'Expression of concern', notice_doi: '10.1/eoc',
        notice_url: 'https://doi.org/10.1/eoc', notice_date: '2024-01-01',
        detail: null, provider: 'crossref', provider_source: 'publisher',
      }],
    });
    await renderPage();

    // Scoped to the section: the same caveat also appears in the page help,
    // which is deliberate — it should be readable both before and after running
    // the check.
    const section = screen
      .getByRole('heading', {
        level: 2, name: 'Papers that changed after you found them',
      })
      .closest('section')!;
    expect(section).toHaveTextContent(/less complete than for retractions/);
  });

  test('a malformed lifecycle response does not take the page down', async () => {
    // The section is an addition; the watchdog findings are why someone opened
    // the page, and they must survive a bad body from the other endpoint.
    mockFetch(WITH_FINDINGS, { unexpected: true });
    await renderPage();

    expect(screen.getByText('arxiv has failed on its last 3 runs')).toBeInTheDocument();
    expect(screen.getByText(/No paper has been checked yet/)).toBeInTheDocument();
  });
});
