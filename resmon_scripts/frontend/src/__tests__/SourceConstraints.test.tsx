/**
 * The per-source constraint notice: what the selected sources will do to this
 * query, said before the query is submitted.
 *
 * Two properties are worth more than the rest. The panel is **quiet** — a
 * selection of sources that constrain nothing produces no panel at all, which
 * is what stops it becoming furniture. And where a window will be reshaped,
 * the sentence names the dates it will become, because "DBLP will search all
 * of 2025 and 2026" is actionable and "year granularity" is a label.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import SourceConstraintNotice from '../components/Forms/SourceConstraintNotice';
import { RepoCatalogEntry, SourceConstraints } from '../api/repositories';
import {
  advisoriesFor,
  windowSentence,
  wholeYearsInside,
  wholeYearsTouched,
} from '../lib/sourceConstraints';

function constraints(over: Partial<SourceConstraints> = {}): SourceConstraints {
  return {
    window_effect: 'as_asked',
    window_rounding: 'none',
    window_refiltered_locally: false,
    keyword_search: 'upstream',
    notices: [],
    established: 'fixture',
    ...over,
  };
}

function entry(slug: string, name: string, over: Partial<SourceConstraints> = {}): RepoCatalogEntry {
  return {
    slug,
    name,
    description: '',
    subject_coverage: '',
    endpoint: '',
    query_method: '',
    rate_limit: '',
    client_module: '',
    api_key_requirement: 'none',
    credential_name: null,
    website: 'https://example.org',
    registration_url: null,
    placeholder: '',
    date_granularity: 'day',
    constraints: constraints(over),
  };
}

const ARXIV = entry('arxiv', 'arXiv');
const DBLP = entry('dblp', 'DBLP', {
  window_effect: 'whole_years',
  window_rounding: 'inward',
});
const DATACITE = entry('datacite', 'DataCite', {
  window_effect: 'whole_years',
  window_rounding: 'outward',
  window_refiltered_locally: true,
});
const SEMANTIC = entry('semantic_scholar', 'Semantic Scholar', {
  window_effect: 'whole_years',
  window_rounding: 'outward',
});
const ADS = entry('nasa_ads', 'NASA ADS', {
  window_effect: 'whole_months',
  window_rounding: 'outward',
});
const BIORXIV = entry('biorxiv', 'bioRxiv', {
  keyword_search: 'client_side',
  notices: [
    {
      kind: 'keyword_search',
      effect: 'bioRxiv cannot be asked for keywords.',
      established: 'fixture',
      applies_when: 'always',
    },
    {
      kind: 'applied_default',
      effect: 'With no start date, resmon asks bioRxiv from January 1, 2020.',
      established: 'fixture',
      applies_when: 'always',
    },
  ],
});

// arXiv honors the window exactly and still has one thing to say about it:
// the window is its submission date. That sentence is about nothing until a
// date is set, which is the case `applies_when` exists for.
const ARXIV_DATED = entry('arxiv', 'arXiv', {
  notices: [
    {
      kind: 'date_window',
      effect: "arXiv's date window is its submission date.",
      established: 'fixture',
      applies_when: 'with_date_window',
    },
  ],
});

describe('whole-calendar-year arithmetic', () => {
  // The rule the client modules implement: a window contains a calendar year
  // only when it covers that year from its first day to its last.
  test.each([
    ['2025-01-01', '2026-12-31', { from: 2025, to: 2026 }],
    ['2025-06-01', '2026-12-31', { from: 2026, to: 2026 }],
    ['2025-01-01', '2025-12-30', null],
    ['2025-03-01', '2025-09-30', null],
    ['2025-01-01', '', { from: 2025, to: null }],
    ['', '2025-12-31', { from: null, to: 2025 }],
  ])('inside(%s, %s)', (from, to, expected) => {
    expect(wholeYearsInside(from, to)).toEqual(expected);
  });

  test('the years a window touches are a different set from the ones it contains', () => {
    expect(wholeYearsTouched('2025-06-01', '2025-06-30')).toEqual({ from: 2025, to: 2025 });
    expect(wholeYearsInside('2025-06-01', '2025-06-30')).toBeNull();
  });
});

describe('the sentence a user reads', () => {
  test('an inward source names the complete years it will actually search', () => {
    expect(windowSentence(DBLP, '2025-01-01', '2026-12-31')).toBe(
      'DBLP will search all of 2025 and 2026 — only the complete calendar years inside your dates.',
    );
    expect(windowSentence(DBLP, '2025-06-01', '2026-12-31')).toBe(
      'DBLP will search the whole of 2026 — only the complete calendar years inside your dates.',
    );
  });

  test('an inward source with no complete year says it will not be searched at all', () => {
    // The journey this whole feature exists for: today the user finds this
    // out by waiting for the sweep and reading a zero.
    expect(windowSentence(DBLP, '2025-03-01', '2025-09-30')).toBe(
      'DBLP will not be searched at all: your dates contain no complete calendar year, ' +
        'and DBLP can only be asked for whole years.',
    );
  });

  test('an outward source warns that results can fall outside the dates', () => {
    expect(windowSentence(SEMANTIC, '2025-06-01', '2025-06-30')).toBe(
      'Semantic Scholar will search the whole of 2025, so results can fall outside your exact dates.',
    );
  });

  test('an outward source that filters again locally says so instead', () => {
    // DataCite widens the *request* and narrows the *answer*. Telling a user
    // their results may fall outside their dates would be wrong about it.
    expect(windowSentence(DATACITE, '2025-06-01', '2025-06-30')).toBe(
      'DataCite will search the whole of 2025, and resmon will drop anything outside your exact dates once it arrives.',
    );
  });

  test('a month-granular source names the months', () => {
    expect(windowSentence(ADS, '2025-03-04', '2025-03-20')).toBe(
      'NASA ADS will search the whole of March 2025, so results can fall outside your exact dates.',
    );
  });

  test('a source that honors the window exactly says nothing about dates', () => {
    expect(windowSentence(ARXIV, '2025-03-01', '2025-03-31')).toBeNull();
  });

  test('with no dates set there is nothing specific to promise', () => {
    expect(windowSentence(DBLP, '', '')).toBeNull();
  });

  test('a date it cannot read produces silence, not "will not be searched"', () => {
    // A saved configuration can carry a date in some other shape. Reporting
    // that as "your dates contain no complete calendar year" would be a
    // confident statement about something that never happened.
    expect(windowSentence(DBLP, '2025', '2026')).toBeNull();
    expect(windowSentence(DBLP, 'last tuesday', '2026-12-31')).toBeNull();
    expect(windowSentence(DBLP, '2025-01-01', 'soon')).toBeNull();
  });

  test('a one-sided window still names what will be searched', () => {
    expect(windowSentence(DBLP, '2025-06-01', '')).toBe(
      'DBLP will search 2026 onwards — only the complete calendar years inside your dates.',
    );
    expect(windowSentence(SEMANTIC, '2025-06-01', '')).toBe(
      'Semantic Scholar will search 2025 onwards, so results can fall outside your exact dates.',
    );
  });
});

describe('SourceConstraintNotice', () => {
  test('a selection of unconstrained sources renders nothing at all', () => {
    // A panel that appears for every selection is a panel nobody reads.
    const { container } = render(
      <SourceConstraintNotice entries={[ARXIV]} dateFrom="2025-01-01" dateTo="2025-06-30" />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('source-constraint-notice')).not.toBeInTheDocument();
  });

  test('selecting DBLP with a sub-year window explains it before submission', () => {
    render(
      <SourceConstraintNotice
        entries={[ARXIV, DBLP]}
        dateFrom="2025-03-01"
        dateTo="2025-09-30"
      />,
    );
    expect(screen.getByTestId('source-constraint-notice')).toBeInTheDocument();
    expect(screen.getByTestId('constraint-window-dblp')).toHaveTextContent(
      'DBLP will not be searched at all',
    );
    // arXiv constrains nothing and is not given a row saying so.
    expect(screen.queryByTestId('constraint-arxiv')).not.toBeInTheDocument();
  });

  test('the sentence follows the dates, so changing them changes what it says', () => {
    const { rerender } = render(
      <SourceConstraintNotice entries={[DBLP]} dateFrom="2025-03-01" dateTo="2025-09-30" />,
    );
    expect(screen.getByTestId('constraint-window-dblp')).toHaveTextContent(
      'will not be searched at all',
    );
    rerender(
      <SourceConstraintNotice entries={[DBLP]} dateFrom="2025-01-01" dateTo="2026-12-31" />,
    );
    expect(screen.getByTestId('constraint-window-dblp')).toHaveTextContent(
      'DBLP will search all of 2025 and 2026',
    );
  });

  test("a source whose keyword search is resmon's own says so with no dates set", () => {
    render(<SourceConstraintNotice entries={[BIORXIV]} />);
    expect(screen.getByText('bioRxiv cannot be asked for keywords.')).toBeInTheDocument();
    expect(
      screen.getByText('With no start date, resmon asks bioRxiv from January 1, 2020.'),
    ).toBeInTheDocument();
  });

  test('a form that sends no keywords does not promise anything about them', () => {
    // A watch routine follows a person; "resmon matches your terms" would be
    // a sentence about something that is not going to happen. The applied
    // default still is, and still shows.
    render(<SourceConstraintNotice entries={[BIORXIV]} keywordsApply={false} />);
    expect(screen.queryByText('bioRxiv cannot be asked for keywords.')).not.toBeInTheDocument();
    expect(
      screen.getByText('With no start date, resmon asks bioRxiv from January 1, 2020.'),
    ).toBeInTheDocument();
  });

  test('an unloaded catalog entry is skipped rather than crashing the form', () => {
    const { container } = render(
      <SourceConstraintNotice entries={[undefined]} dateFrom="2025-01-01" dateTo="2025-12-31" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('advisoriesFor', () => {
  test('only sources with something to say are returned', () => {
    const rows = advisoriesFor([ARXIV, DBLP, BIORXIV], '2025-01-01', '2025-12-31');
    expect(rows.map((r) => r.slug)).toEqual(['dblp', 'biorxiv']);
  });

  test('a notice that is about a window stays hidden until there is one', () => {
    // arXiv is on most people's selection every time. Telling them on every
    // keyword-only search that its window is a submission date is noise about
    // a window they did not set.
    expect(advisoriesFor([ARXIV_DATED], '', '')).toEqual([]);
    const dated = advisoriesFor([ARXIV_DATED], '2025-01-01', '2025-06-30');
    expect(dated).toHaveLength(1);
    expect(dated[0].notices[0].effect).toBe("arXiv's date window is its submission date.");
  });

  test('a notice that is not about a window shows with no dates at all', () => {
    const rows = advisoriesFor([BIORXIV], '', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].notices).toHaveLength(2);
  });

  test('a notice about the blank start date disappears once one is typed', () => {
    // bioRxiv's January 1, 2020 floor is a fact about the empty field, not
    // about the one you filled in. Telling somebody who set a start date
    // what would have happened if they had not is noise about a case that
    // is no longer theirs.
    const BIORXIV_SCOPED = entry('biorxiv', 'bioRxiv', {
      keyword_search: 'client_side',
      notices: [
        {
          kind: 'keyword_search',
          effect: 'bioRxiv cannot be asked for keywords.',
          established: 'fixture',
          applies_when: 'always',
        },
        {
          kind: 'applied_default',
          effect: 'With no start date, resmon asks bioRxiv from January 1, 2020.',
          established: 'fixture',
          applies_when: 'without_start_date',
        },
      ],
    });
    expect(advisoriesFor([BIORXIV_SCOPED], '', '')[0].notices).toHaveLength(2);
    const withStart = advisoriesFor([BIORXIV_SCOPED], '2025-03-01', '2025-09-30');
    expect(withStart[0].notices.map((n) => n.kind)).toEqual(['keyword_search']);
    // An end date alone leaves the start date blank, so it still applies.
    const endOnly = advisoriesFor([BIORXIV_SCOPED], '', '2025-09-30');
    expect(endOnly[0].notices).toHaveLength(2);
  });

  test('the general date notice gives way to the sentence about these dates', () => {
    // A rounding source's stored notice is the abstract form of what
    // windowSentence has just said with the user's own dates in it. Saying
    // both is saying it twice.
    const DBLP_WITH_NOTICE = entry('dblp', 'DBLP', {
      window_effect: 'whole_years',
      window_rounding: 'inward',
      notices: [
        {
          kind: 'date_window',
          effect: 'DBLP records only a year.',
          established: 'fixture',
          applies_when: 'with_date_window',
        },
        {
          kind: 'record_filter',
          effect: 'A DBLP record with no year is dropped.',
          established: 'fixture',
          applies_when: 'with_date_window',
        },
      ],
    });
    const [row] = advisoriesFor([DBLP_WITH_NOTICE], '2025-01-01', '2026-12-31');
    expect(row.window).toContain('DBLP will search all of 2025 and 2026');
    expect(row.notices.map((n) => n.kind)).toEqual(['record_filter']);
  });

  test('a source with no computed sentence keeps its date notice', () => {
    // arXiv honors the window exactly, so there is nothing concrete to say
    // and the general sentence is the only one there is.
    const [row] = advisoriesFor([ARXIV_DATED], '2025-01-01', '2025-06-30');
    expect(row.window).toBeNull();
    expect(row.notices).toHaveLength(1);
  });
});
