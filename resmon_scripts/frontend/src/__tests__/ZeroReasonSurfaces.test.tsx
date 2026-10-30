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
import ReportViewer from '../components/Results/ReportViewer';

/* ------------------------------------------------------------------ */
/* The live monitor                                                    */
/* ------------------------------------------------------------------ */

const OUTAGE_SENTENCE =
  'CrossRef could not be queried: HTTP 503 after 3 attempts. This is not a '
  + 'zero — the source did not answer.';
const PARTIAL_SENTENCE =
  'CrossRef returned 2 usable records before a later HTTP 503 request failed. '
  + 'The retained set may be incomplete.';

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

test('the activity log renders a positive partial result as a warning', () => {
  const { container } = render(
    <LiveActivityLog events={[{
      type: 'repo_done', timestamp: '2026-09-04T10:00:01Z',
      repository: 'crossref', result_count: 2,
      zero_reason: 'upstream_failure', zero_message: PARTIAL_SENTENCE,
    }] as any} />,
  );
  expect(screen.getByText(`crossref: 2 results — ${PARTIAL_SENTENCE}`)).toBeInTheDocument();
  expect(container.querySelector('.log-warning')).not.toBeNull();
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

test('a run with a partial answer keeps its coverage note', () => {
  render(
    <ResultsList
      executions={[{ ...ROW, coverage: {
        execution_id: 9, basis: 'selected', basis_label: 'selected sources',
        selection_known: true, total: 1,
        counts: { answered: 1, non_answer: 0, unknown: 0, genuine_empty: 0, partial: 1 },
        summary: '1 selected source: 1 answered. 1 answered with retained partial results.',
        notes: ['Saved selection'], additional_sources: [], sources: [{
          source: 'crossref', category: 'answered', label: 'answered, partial',
          note: PARTIAL_SENTENCE, result_count: 2, recorded_at: '2026-09-04',
          outcome_recorded: true, genuine_empty: false, partial: true,
        }],
      } }] as any}
      selected={new Set<number>()} onToggle={jest.fn()} onToggleAll={jest.fn()}
      onRowClick={jest.fn()} onOpenSearchRecord={jest.fn()}
      typeFilter="" statusFilter="" onTypeFilterChange={jest.fn()}
      onStatusFilterChange={jest.fn()}
    />,
  );
  expect(screen.getByText(/retained partial results/)).toBeInTheDocument();
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
    '1 of the 3 recorded sources did not answer, so there is nothing to count (crossref). '
    + 'Its note below says why. It did not contribute to this search.',
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

test('positive partial repo_done remains done and keeps its warning sentence', async () => {
  progressFetch([{
    type: 'repo_done', timestamp: '2026-09-04T10:00:01Z',
    repository: 'crossref', result_count: 2,
    zero_reason: 'upstream_failure', zero_message: PARTIAL_SENTENCE,
  }]);
  const { result } = renderHook(() => useExecution(), { wrapper: providerWrapper });
  await act(async () => {
    result.current.startExecution(6, 'deep_sweep', ['crossref']);
  });
  await waitFor(() => {
    expect(result.current.activeExecutions[6]?.repoStatuses.crossref).toBe('done');
  }, { timeout: 5000 });
  expect(result.current.activeExecutions[6]?.repoZeroReasons.crossref.message)
    .toBe(PARTIAL_SENTENCE);
});

test('the saved progress timeline shows a partial result as a warning', async () => {
  progressFetch([{
    type: 'repo_done', timestamp: '2026-09-04T10:00:01Z',
    repository: 'crossref', result_count: 2,
    zero_reason: 'upstream_failure', zero_message: PARTIAL_SENTENCE,
  }]);
  const { container } = render(
    <ExecutionProvider>
      <ReportViewer executionId={77} onClose={jest.fn()} initialTab="progress" />
    </ExecutionProvider>,
  );
  await waitFor(() => {
    expect(screen.getByText(`crossref: 2 results — ${PARTIAL_SENTENCE}`))
      .toBeInTheDocument();
  });
  expect(container.querySelector('.pv-warning .pv-icon')?.textContent).toBe('⚠');
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

/* ------------------------------------------------------------------ */
/* Every reason, on every surface                                      */
/* ------------------------------------------------------------------ */
/*
 * The tests above exercise `upstream_failure`, `answered_empty`,
 * `not_recorded` and `window_unanswerable`. That is four of the backend's
 * ten, and the six they left uncovered are where this file failed:
 * `entity_unsupported` was added to
 * `zero_reason.DID_NOT_ANSWER` in 2.1 and never reached the renderer, which
 * ticked ✓ — *answered and found nothing* — on every source that has no
 * author query, beside the backend's own sentence saying it could not be
 * asked.
 *
 * So the denominator below is read from the code rather than written here. A
 * reason added to `ZERO_REASONS` lands in `cases` on the next run, and the
 * surface that has no behaviour for it fails instead of quietly rendering the
 * wrong mark. That is the same device `e2e/zero-reasons.spec.ts` (P13d) uses
 * for the real-browser coverage list.
 */

import * as fs from 'fs';
import * as pathlib from 'path';

import {
  DID_NOT_ANSWER, ZERO_REASONS, outcomeCategory, repoDoneStatus,
} from '../api/zeroReason';

// `require`, not `import`: the generator is the CommonJS script `npm run
// gen:zero-reason` runs, and the test calls the same code rather than a
// second transcription of the parse.
const generator = require('../../scripts/generate-zero-reason.js');

/** One sentence per reason. The wording is the backend's; these stand in for it. */
const SENTENCE: Record<string, string> = Object.fromEntries(
  ZERO_REASONS.map((reason) => [reason, `A backend sentence about ${reason}.`]),
);

/** What each reason means, derived from the generated set rather than listed. */
const cases = ZERO_REASONS.map((reason) => ({
  reason,
  category: outcomeCategory('ok', 0, reason),
  didNotAnswer: DID_NOT_ANSWER.has(reason),
}));

test('the renderer vocabulary is still the backend vocabulary', () => {
  // The guard that makes one source of truth true: the committed module is
  // regenerated from the live `zero_reason.py` and compared byte for byte, so
  // adding a reason to the backend turns this suite red until the renderer is
  // regenerated with it.
  const committed = fs.readFileSync(
    pathlib.resolve(__dirname, '..', '..', generator.GENERATED_PATH), 'utf8');
  expect(committed).toBe(generator.renderModule());
  // Atlas's copy, the same text, so the two renderers cannot disagree.
  const atlas = fs.readFileSync(
    pathlib.resolve(__dirname, '..', '..', generator.ATLAS_GENERATED_PATH), 'utf8');
  expect(atlas).toBe(generator.renderModule());

  const { zeroReasons, didNotAnswer } = generator.pythonVocabulary();
  expect([...ZERO_REASONS]).toEqual(zeroReasons);
  expect([...DID_NOT_ANSWER].sort()).toEqual([...didNotAnswer].sort());
  // The one that was missing, named so a regression reads as itself.
  expect(DID_NOT_ANSWER.has('entity_unsupported')).toBe(true);
});

test('a reason the generator cannot parse throws rather than vanishing', () => {
  // The guard above regenerates through the same parser it checks, so a
  // value the parser silently skips is a value the comparison cannot see.
  // The first parser scanned for /"([a-z_]+)"/g: a reason in single quotes,
  // or one holding a digit, dropped out of both sides and agreed.
  const parse = (zero: string, did: string): { zeroReasons: string[] } => (
    generator.pythonVocabulary(
      `ZERO_REASONS = (\n${zero}\n)\n\nDID_NOT_ANSWER = frozenset({\n${did}\n})\n`,
    )
  );

  // Both spellings, and a digit, survive.
  expect(parse("  'quota_exhausted',\n  \"http_503\",", "  'quota_exhausted',").zeroReasons)
    .toEqual(['quota_exhausted', 'http_503']);

  // Anything else names itself and stops the run. A dropped entry here is
  // how a reason the renderer has never heard of reaches the grid as a tick.
  //
  // A comma inside a literal is in this list rather than beside it: the
  // split leaves two fragments and neither is a quoted slug, so the
  // per-entry check rejects it and the quote count is never reached. The
  // assertion names that one message rather than offering an alternative,
  // so it asserts what happens instead of what might.
  const malformed = [
    '  Upstream_Failure,', '  "upstream-failure",', '  *OTHER,',
    '  "missing_key,retired",',
  ];
  for (const bad of malformed) {
    expect(() => parse(`  "missing_key",\n${bad}`, '  "missing_key",'))
      .toThrow(/does not understand/);
  }
});

test('an outcome the renderer does not recognize is unknown, never answered', () => {
  // `source_coverage.outcome` gates on validity before it classifies, and
  // sends anything it does not recognize to `unknown`. Transcribing the
  // classification without the gate points the failure the wrong way: a slug
  // from a newer backend would fall through to `answered` and draw a tick.
  expect(outcomeCategory('ok', 0, 'http_503')).toBe('unknown');
  expect(outcomeCategory('ok', 7, 'http_503')).toBe('unknown');
  expect(outcomeCategory('teleported', 0, 'answered_empty')).toBe('unknown');
  expect(outcomeCategory('ok', -1, 'answered_empty')).toBe('unknown');
  expect(outcomeCategory(undefined, 3, null)).toBe('unknown');
  // A count that was never recorded is not a count of zero. This was the
  // last input on which this function reached `answered` by defaulting --
  // `?? 0` ran before the integrity check, so "no count" became "zero
  // records returned" and an ok row with a known reason read as an answer.
  expect(outcomeCategory('ok', null, 'rights_filtered')).toBe('unknown');
  expect(outcomeCategory('ok', undefined, 'answered_empty')).toBe('unknown');
  expect(outcomeCategory('ok', 1.5, 'answered_empty')).toBe('unknown');
  expect(repoDoneStatus(null, 'rights_filtered')).toBe('not_recorded');
  // And the grid draws it as the one thing it can honestly say.
  expect(repoDoneStatus(0, 'http_503')).toBe('not_recorded');
  expect(repoDoneStatus(7, 'http_503')).toBe('not_recorded');
});

test('the renderer classifies every reason the way the backend does', () => {
  // `zero_reason.answered` and `source_coverage.outcome`, transcribed: a zero
  // whose reason is in DID_NOT_ANSWER is a non-answer, a zero with no reason
  // on record is unknown, and everything else answered.
  expect(cases).toHaveLength(ZERO_REASONS.length);
  for (const { reason, category, didNotAnswer } of cases) {
    if (reason === 'not_recorded') expect(category).toBe('unknown');
    else if (didNotAnswer) expect(category).toBe('non_answer');
    else expect(category).toBe('answered');
  }
  // A positive count is an answer whatever the reason says — a partial page
  // keeps its records and its warning.
  for (const { reason } of cases) {
    expect(outcomeCategory('ok', 2, reason)).toBe('answered');
  }
});

test('the repository grid marks every reason as the backend classifies it', async () => {
  const repositories = ZERO_REASONS.map((reason) => `src-${reason}`);
  progressFetch(ZERO_REASONS.map((reason, i) => ({
    type: 'repo_done',
    timestamp: `2026-10-18T10:00:${String(i).padStart(2, '0')}Z`,
    repository: `src-${reason}`,
    result_count: 0,
    zero_reason: reason,
    zero_message: SENTENCE[reason],
  })));

  const { result } = renderHook(() => useExecution(), { wrapper: providerWrapper });
  await act(async () => {
    result.current.startExecution(11, 'watch_sweep', repositories);
  });
  // `startExecution` seeds every selected source as `pending`, so the wait is
  // for the last one to leave that state rather than for the keys to appear.
  await waitFor(() => {
    expect(Object.values(result.current.activeExecutions[11]?.repoStatuses ?? {})
      .filter((s) => s === 'pending')).toHaveLength(0);
  }, { timeout: 5000 });

  const exec = result.current.activeExecutions[11]!;
  // Compared as whole lists so one failure names every reason that is wrong,
  // rather than stopping at the first.
  expect(cases.map(({ reason }) => [reason, exec.repoStatuses[`src-${reason}`]]))
    .toEqual(cases.map(({ reason }) => [reason, repoDoneStatus(0, reason)]));
  // A tick means the source answered. Nothing else may carry one.
  expect(cases.filter(({ reason }) => exec.repoStatuses[`src-${reason}`] === 'done')
    .map(({ reason }) => reason))
    .toEqual(cases.filter((c) => c.category === 'answered').map((c) => c.reason));

  const { container } = render(<RepoProgressGrid exec={exec} />);
  const marks = Array.from(container.querySelectorAll('.mon-repo-icon'))
    .map((el) => el.textContent);
  expect(marks).toHaveLength(ZERO_REASONS.length);
  expect(marks.filter((m) => m === '✓'))
    .toHaveLength(cases.filter((c) => c.category === 'answered').length);
  // The source that could not be asked about a person is the one this test
  // exists for: ⚠, never ✓, and never the raw slug as its label.
  const entity = Array.from(container.querySelectorAll('.mon-repo-row')).find(
    (row) => row.querySelector('.mon-repo-name')?.textContent === 'src-entity_unsupported',
  );
  expect(entity?.className).toContain('mon-repo-row--no_answer');
  expect(entity?.querySelector('.mon-repo-icon')?.textContent).toBe('⚠');
  expect(entity?.querySelector('.mon-repo-status-text')?.textContent).toBe('no answer');
  expect(screen.getByText(SENTENCE.entity_unsupported)).toBeInTheDocument();
  expect(screen.queryByText(/entity unsupported/i)).not.toBeInTheDocument();
});

test('the activity log agrees with the grid about the same event', () => {
  // The log used to invert the test instead of sharing the set, so the two
  // disagreed about `entity_unsupported` on the same run.
  const { container } = render(
    <LiveActivityLog
      events={ZERO_REASONS.map((reason, i) => ({
        type: 'repo_done',
        timestamp: `2026-10-18T10:00:${String(i).padStart(2, '0')}Z`,
        repository: `src-${reason}`,
        result_count: 0,
        zero_reason: reason,
        zero_message: SENTENCE[reason],
      })) as any}
    />,
  );

  const severity = (reason: string): string | undefined => Array.from(
    container.querySelectorAll('.mon-log-entry'),
  ).find((el) => el.textContent?.includes(`src-${reason}:`))?.className;

  const wanted = ({ category }: typeof cases[number]): string => (
    category === 'answered' ? 'log-success'
      : category === 'unknown' ? 'log-info' : 'log-warning');
  expect(cases.map((c) => [c.reason, severity(c.reason)?.includes(wanted(c))]))
    .toEqual(cases.map((c) => [c.reason, true]));
});

test('the search record names an outcome for every reason, never a raw slug', async () => {
  // Modern payloads carry the backend's own `coverage.label`. This drives the
  // fallback the renderer keeps for a row without one, which used to hold a
  // nine-of-ten copy of the label map and printed "entity unsupported" — the
  // slug with its underscores swapped — for the tenth.
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ...RECORD,
      sources: ZERO_REASONS.map((reason) => ({
        source: `src-${reason}`,
        records_identified: 0,
        status: 'ok',
        zero_reason: reason,
        answered: !DID_NOT_ANSWER.has(reason) && reason !== 'not_recorded',
        note: SENTENCE[reason],
      })),
      identification: { ...RECORD.identification, sources_searched: ZERO_REASONS.length },
    }),
  }));
  await act(async () => { render(<SearchRecord executionId={9} />); });

  const outcomes = Array.from(
    document.querySelectorAll('.search-record .simple-table tbody tr'),
  ).filter((row) => row.querySelector('td')?.textContent?.startsWith('src-'))
    .map((row) => Array.from(row.querySelectorAll('td')).map((c) => c.textContent));
  expect(outcomes).toHaveLength(ZERO_REASONS.length);

  const wanted = ({ category }: typeof cases[number]): string => (
    category === 'answered' ? 'answered'
      : category === 'unknown' ? 'zero, reason not recorded' : 'did not answer');
  expect(cases.map((c) => [
    c.reason, outcomes.find(([name]) => name === `src-${c.reason}`)?.[2],
  ])).toEqual(cases.map((c) => [c.reason, wanted(c)]));
  // No surface may fall through to the slug with its underscores swapped.
  for (const { reason } of cases) {
    expect(outcomes.some(([, , outcome]) => outcome === reason.replace(/_/g, ' ')))
      .toBe(false);
  }
});

/* ------------------------------------------------------------------ */
/* The floating widget's progress count                                */
/* ------------------------------------------------------------------ */

import { MemoryRouter } from 'react-router-dom';
import FloatingWidget from '../components/Monitor/FloatingWidget';

test('the widget counts every settled source, not only the ones that answered', async () => {
  // "N/M repos" is progress, not success. It counted only `done`, so it
  // stalled short of the end on any run holding a source that could not
  // answer -- and this work widened that, because entity_unsupported and an
  // unrecorded zero stopped being miscounted as `done`. A progress bar that
  // never reaches the end on a finished run is the app saying it is still
  // working when it is not.
  progressFetch([
    {
      type: 'repo_done', timestamp: '2026-10-18T10:00:00Z', repository: 'arxiv',
      result_count: 4, zero_reason: null, zero_message: null,
    },
    {
      type: 'repo_done', timestamp: '2026-10-18T10:00:01Z', repository: 'crossref',
      result_count: 0, zero_reason: 'entity_unsupported',
      zero_message: SENTENCE.entity_unsupported,
    },
    {
      type: 'repo_done', timestamp: '2026-10-18T10:00:02Z', repository: 'dblp',
      result_count: 0, zero_reason: 'not_recorded', zero_message: SENTENCE.not_recorded,
    },
    {
      type: 'repo_done', timestamp: '2026-10-18T10:00:03Z', repository: 'springer',
      result_count: 0, zero_reason: 'missing_key', zero_message: SENTENCE.missing_key,
    },
  ]);

  let ctx: ReturnType<typeof useExecution> | null = null;
  const Probe: React.FC = () => { ctx = useExecution(); return null; };
  render(
    <MemoryRouter>
      <ExecutionProvider>
        <Probe />
        <FloatingWidget />
      </ExecutionProvider>
    </MemoryRouter>,
  );
  await act(async () => {
    ctx!.startExecution(12, 'watch_sweep', ['arxiv', 'crossref', 'dblp', 'springer']);
  });

  await waitFor(() => {
    expect(Object.values(ctx!.activeExecutions[12]?.repoStatuses ?? {})
      .filter((s) => s === 'pending')).toHaveLength(0);
  }, { timeout: 5000 });

  // One answered, one could not be asked, one unexplained, one never
  // queried. All four are finished.
  expect(ctx!.activeExecutions[12]!.repoStatuses).toEqual({
    arxiv: 'done', crossref: 'no_answer', dblp: 'not_recorded', springer: 'skipped',
  });
  expect(screen.getByText('4/4 repos')).toBeInTheDocument();
});
