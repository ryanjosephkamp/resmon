/**
 * Why nothing came back — the three surfaces that show it.
 *
 * The failure this file guards is not a crash. It is the app looking calm: a
 * green tick beside a source whose endpoint 503'd, "answered" in a
 * reproducible search record beside a database that never replied, and a
 * results row that says 0 with nothing to distinguish a quiet field from a
 * broken one. Every one of those renders happily.
 *
 * The **sentences** are not asserted to be composed here. They are rendered
 * by the backend and arrive as data, which is deliberate — one vocabulary in
 * one place. What is asserted is that each surface shows the sentence it was
 * given and picks the right affordance around it.
 *
 * jsdom, and that is a real limit: this proves the components render from the
 * data, not that the assembled app does. The real-browser check over these
 * routes is phase 1.8.7's.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import RepoProgressGrid from '../components/Monitor/RepoProgressGrid';
import ResultsList from '../components/Results/ResultsList';
import SearchRecord from '../components/Results/SearchRecord';
import LiveActivityLog from '../components/Monitor/LiveActivityLog';

/* ------------------------------------------------------------------ */
/* The live monitor                                                    */
/* ------------------------------------------------------------------ */

const OUTAGE_SENTENCE =
  'CrossRef could not be queried: HTTP 503 after 3 attempts. This is not a '
  + 'zero — the source did not answer.';

function execWith(overrides: any = {}) {
  return {
    executionId: 1,
    executionType: 'deep_sweep',
    repositories: ['arxiv', 'crossref', 'eric'],
    startTime: '2026-09-04T10:00:00Z',
    events: [],
    status: 'completed',
    repoStatuses: {
      arxiv: 'done', crossref: 'no_answer', eric: 'no_answer',
    },
    repoZeroReasons: {
      crossref: { reason: 'upstream_failure', message: OUTAGE_SENTENCE },
      eric: {
        reason: 'window_unanswerable',
        message: 'ERIC filters by publication year only, so a window shorter '
          + 'than one whole calendar year cannot be answered. resmon did not '
          + 'widen your window.',
      },
    },
    resultCount: 12,
    newCount: 12,
    ...overrides,
  } as any;
}

test('the repository grid does not tick a source that never answered', () => {
  const { container } = render(<RepoProgressGrid exec={execWith()} />);

  const icons = Array.from(
    container.querySelectorAll('.mon-repo-icon'),
  ).map((el) => el.textContent);
  // arXiv answered. The other two did not, and a ✓ on them would be the app
  // agreeing that nothing went wrong.
  expect(icons).toEqual(['✓', '⚠', '⚠']);
  expect(screen.getByText(OUTAGE_SENTENCE)).toBeInTheDocument();
  expect(screen.getAllByText('no answer')).toHaveLength(2);
});

test('a source that answered with zero keeps its tick and says so', () => {
  const exec = execWith({
    repoStatuses: { arxiv: 'done', crossref: 'done', eric: 'done' },
    repoZeroReasons: {
      crossref: {
        reason: 'answered_empty',
        message: 'CrossRef answered (HTTP 200) and resmon found no records in '
          + 'the reply.',
      },
    },
  });
  const { container } = render(<RepoProgressGrid exec={exec} />);

  const icons = Array.from(
    container.querySelectorAll('.mon-repo-icon'),
  ).map((el) => el.textContent);
  expect(icons).toEqual(['✓', '✓', '✓']);
  expect(screen.getByText(/found no records in the reply/)).toBeInTheDocument();
});

test('the activity log shows the reason on a zero, and no raw event names', () => {
  render(
    <LiveActivityLog
      events={[
        {
          type: 'repo_done', timestamp: '2026-09-04T10:00:01Z',
          repository: 'crossref', result_count: 0,
          zero_reason: 'upstream_failure', zero_message: OUTAGE_SENTENCE,
        },
        {
          type: 'repo_skipped_missing_key', timestamp: '2026-09-04T10:00:02Z',
          repository: 'springer', credential_name: 'springer_api_key',
        },
      ] as any}
    />,
  );

  expect(
    screen.getByText(`crossref: 0 results — ${OUTAGE_SENTENCE}`),
  ).toBeInTheDocument();
  // This event has been emitted since 1.3 with no case in the renderer, so
  // the log printed the literal event name at the user.
  expect(screen.queryByText(/repo_skipped_missing_key/)).not.toBeInTheDocument();
  expect(
    screen.getByText(/springer: not queried — the API key it requires/),
  ).toBeInTheDocument();
});

/* ------------------------------------------------------------------ */
/* The results row                                                     */
/* ------------------------------------------------------------------ */

const ROW = {
  id: 9, execution_type: 'deep_sweep', status: 'completed',
  start_time: '2026-09-04T10:00:00', total_results: 0, new_results: 0,
  keywords: ['perovskite'], repositories: ['arxiv', 'crossref', 'eric'],
};

function renderRow(outcomes: any, onOpenSearchRecord = jest.fn()) {
  render(
    <ResultsList
      executions={[{ ...ROW, source_outcomes: outcomes }] as any}
      selected={new Set<number>()}
      onToggle={jest.fn()}
      onToggleAll={jest.fn()}
      onRowClick={jest.fn()}
      onOpenSearchRecord={onOpenSearchRecord}
      typeFilter=""
      statusFilter=""
      onTypeFilterChange={jest.fn()}
      onStatusFilterChange={jest.fn()}
    />,
  );
  return onOpenSearchRecord;
}

test('a row whose sources could not answer says so, and links to the record', () => {
  const onOpen = renderRow({
    selected: 3, answered: 1, could_not_answer: 2, not_recorded: 0,
    sources_that_could_not_answer: ['crossref', 'eric'],
  });

  expect(
    screen.getByText(/2 of 3 sources could not answer/),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /see the search record/i }));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test('an unrecorded zero is named as unrecorded, not as a failure to answer', () => {
  renderRow({
    selected: 3, answered: 0, could_not_answer: 0, not_recorded: 3,
    sources_that_could_not_answer: [],
  });

  expect(
    screen.getByText(/3 returned nothing for a reason resmon did not record/),
  ).toBeInTheDocument();
  expect(screen.queryByText(/could not answer/)).not.toBeInTheDocument();
});

test('a run where every source answered carries no coverage note', () => {
  renderRow({
    selected: 3, answered: 3, could_not_answer: 0, not_recorded: 0,
    sources_that_could_not_answer: [],
  });

  expect(screen.queryByText(/could not answer/)).not.toBeInTheDocument();
  expect(screen.queryByText(/did not record/)).not.toBeInTheDocument();
});

test('a run from before the reason existed carries no source_outcomes at all', () => {
  renderRow(null);
  expect(screen.queryByText(/sources could not answer/)).not.toBeInTheDocument();
});

/* ------------------------------------------------------------------ */
/* The search record                                                   */
/* ------------------------------------------------------------------ */

const RECORD = {
  generated_at: '2026-09-04T12:00:00Z',
  software: { name: 'resmon', version: '1.8.6', citation: 'resmon 1.8.6' },
  search: {
    execution_id: 9, run_at: '2026-09-04T10:00:00Z',
    completed_at: '2026-09-04T10:04:00Z', status: 'completed',
    keywords: ['perovskite'], query_as_sent: 'perovskite',
    date_from: '2026-01-01', date_to: '2026-01-14',
    max_results_per_source: 100, routine_name: null,
    routine_schedule: null, configuration_name: null,
  },
  sources: [
    {
      source: 'arxiv', records_identified: 12, status: 'ok',
      zero_reason: null, answered: true, note: null,
    },
    {
      source: 'crossref', records_identified: 0, status: 'ok',
      zero_reason: 'upstream_failure', answered: false,
      note: OUTAGE_SENTENCE,
    },
    {
      source: 'dblp', records_identified: 0, status: 'ok',
      zero_reason: 'not_recorded', answered: false,
      note: 'resmon did not record whether DBLP answered on this run.',
    },
  ],
  identification: {
    records_identified: 12, sources_searched: 3, sources_that_answered: 1,
    prisma: 'Records identified from databases',
  },
  deduplication: {
    records_processed: 12,
    cross_source_duplicates: {
      count: 0, recorded: true, prisma: 'Duplicate records removed before screening',
      meaning: 'm', not_recorded_reason: null,
    },
    already_held: { count: 0, prisma: null, meaning: 'm' },
    discarded_unusable: { count: 0, prisma: 'a', meaning: 'm' },
    records_added: { count: 12, prisma: 'Records screened', meaning: 'm' },
  },
  caveats: [
    '1 of the 3 sources selected returned zero because they could not answer, '
    + 'not because there was nothing to find (crossref).',
  ],
};

async function renderRecord() {
  (global as any).fetch = jest.fn(async () => ({
    ok: true, status: 200, json: async () => RECORD,
  }));
  await act(async () => { render(<SearchRecord executionId={9} />); });
}

test('the record does not call a source that 503d "answered"', async () => {
  await renderRecord();

  expect(screen.getByText('did not answer')).toBeInTheDocument();
  expect(screen.getByText('zero, reason not recorded')).toBeInTheDocument();
  // One "answered", for arXiv, which did.
  expect(screen.getAllByText('answered')).toHaveLength(1);
  // The note renders inside a list item alongside the source name, so the
  // sentence is a text node rather than an element's whole content.
  expect(
    screen.getByText((_, el) => el?.textContent === `crossref — ${OUTAGE_SENTENCE}`,
      { selector: 'li' }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/did not record whether DBLP answered/),
  ).toBeInTheDocument();
  expect(screen.getByText(/1 of 3 sources answered/)).toBeInTheDocument();
});

/* ------------------------------------------------------------------ */
/* The reducer that feeds all of it                                    */
/* ------------------------------------------------------------------ */
/*
 * Driven through the real polling path rather than by calling the reducer
 * directly: the reducer is not exported, and exporting it for a test would
 * mean the test observes a seam the app does not use.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { ExecutionProvider, useExecution } from '../context/ExecutionContext';

function progressFetch(events: any[]) {
  (global as any).fetch = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (
      String(url).includes('/progress/events') ? events
        : String(url).includes('/executions/active') ? { active_ids: [] }
        : {}
    ),
    text: async () => '{}',
  }));
}

const providerWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ExecutionProvider>{children}</ExecutionProvider>
);

test('repo_done carries the reason into the per-source status and sentence', async () => {
  progressFetch([
    {
      type: 'repo_done', timestamp: '2026-09-04T10:00:01Z',
      repository: 'crossref', result_count: 0,
      zero_reason: 'upstream_failure', zero_message: OUTAGE_SENTENCE,
    },
    {
      type: 'repo_done', timestamp: '2026-09-04T10:00:02Z',
      repository: 'core', result_count: 0,
      zero_reason: 'answered_empty',
      zero_message: 'CORE answered (HTTP 200) and resmon found no records in the reply.',
    },
    {
      type: 'repo_skipped_missing_key', timestamp: '2026-09-04T10:00:03Z',
      repository: 'springer', credential_name: 'springer_api_key',
    },
  ]);

  const { result } = renderHook(() => useExecution(), { wrapper: providerWrapper });
  await act(async () => {
    result.current.startExecution(5, 'deep_sweep', ['crossref', 'core', 'springer']);
  });

  // The progress poller runs on a 1 s interval, and this drives the real one
  // rather than reaching past it into the reducer.
  await waitFor(() => {
    expect(result.current.activeExecutions[5]?.repoStatuses.crossref)
      .toBe('no_answer');
  }, { timeout: 5000 });

  const exec = result.current.activeExecutions[5]!;
  // A source that answered and had nothing is still done. Only the ones that
  // never answered are separated out.
  expect(exec.repoStatuses.core).toBe('done');
  expect(exec.repoStatuses.springer).toBe('skipped');
  expect(exec.repoZeroReasons.crossref.message).toBe(OUTAGE_SENTENCE);
});

/* ------------------------------------------------------------------ */
/* The catalog's date granularity                                      */
/* ------------------------------------------------------------------ */

import RepoDetailsPanel from '../components/Repositories/RepoDetailsPanel';

const ENTRY = {
  slug: 'eric', name: 'ERIC', description: 'Education research.',
  subject_coverage: 'Education', endpoint: 'https://api.ies.ed.gov/eric/',
  query_method: 'GET', rate_limit: '0.5 req/s', client_module: 'api_eric',
  api_key_requirement: 'none' as const, credential_name: null,
  website: 'https://eric.ed.gov', registration_url: null, placeholder: '',
  keyword_combination: 'Implicit OR',
};

test('a year-granular source says so on its details panel', () => {
  render(
    <RepoDetailsPanel
      entry={{ ...ENTRY, date_granularity: 'year' } as any}
    />,
  );
  expect(screen.getByText('Date Filtering')).toBeInTheDocument();
  expect(screen.getByText('Whole years only')).toBeInTheDocument();
});

test('a day-granular source says so too, rather than saying nothing', () => {
  // A field that renders only for the awkward cases teaches the reader that
  // its absence means "fine", which is an inference. Every source states it.
  render(
    <RepoDetailsPanel
      entry={{ ...ENTRY, slug: 'arxiv', name: 'arXiv', date_granularity: 'day' } as any}
    />,
  );
  expect(
    screen.getByText('Exact dates — resmon can ask for any window'),
  ).toBeInTheDocument();
});
