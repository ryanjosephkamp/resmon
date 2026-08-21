/**
 * "Why am I seeing this?" — the panel must not over-claim.
 *
 * The backend refuses to say it knows why a relevance-ranked source returned a
 * paper. The interface is where that restraint is most easily lost: a confident
 * green tick over a list of matches, with the caveat tucked behind a tooltip,
 * would undo the whole feature without changing a line of Python.
 *
 * So these tests hold the panel to three things: the limits are always rendered
 * and never collapsed, a miss is shown as a miss rather than omitted, and no
 * request is made until the user actually asks.
 */

import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import WhyThisPaper from '../components/Explain/WhyThisPaper';

const LOCAL_EVIDENCE = {
  document: { id: 7, title: 'Cardiac imaging', source_repository: 'openalex' },
  source: {
    slug: 'openalex',
    name: 'OpenAlex',
    keyword_combination: 'Relevance-ranked',
    keyword_combination_notes: "OpenAlex's search ranks by relevance.",
    resmon_filtered_locally: false,
  },
  runs: [
    {
      execution_id: 3,
      execution_type: 'automated_sweep',
      start_time: '2026-08-01T02:00:00Z',
      routine_name: 'Nightly cardiac',
      keywords: ['cardiac', 'quantum'],
    },
  ],
  keywords: [
    {
      keyword: 'cardiac', matched: true, fields: ['title'],
      where: 'the title', contains_operators: false,
    },
    {
      keyword: 'quantum', matched: false, fields: [],
      where: 'nowhere resmon can check', contains_operators: false,
    },
  ],
  matched_count: 1,
  keyword_count: 2,
  verdict: 'local_evidence' as const,
  headline:
    '“cardiac” appears in this paper. That makes it a plausible match — but '
    + 'OpenAlex chose to return it for its own reasons, which resmon cannot see.',
  what_resmon_cannot_see: [
    "resmon stores each paper's title, abstract, authors and categories — not its full text.",
    'OpenAlex is relevance-ranked, not a strict keyword filter.',
  ],
  fields_checked: ['title', 'abstract', 'categories', 'authors'],
};

const RESMON_FILTERED = {
  ...LOCAL_EVIDENCE,
  source: {
    slug: 'biorxiv',
    name: 'bioRxiv / medRxiv',
    keyword_combination: 'Explicit OR',
    keyword_combination_notes: 'resmon filters client-side.',
    resmon_filtered_locally: true,
  },
  verdict: 'resmon_filtered' as const,
  headline:
    'bioRxiv / medRxiv has no keyword search of its own, so resmon did the '
    + 'matching. That is the complete reason, not a partial one.',
};

function mockFetch(payload: unknown) {
  const mock = jest.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
  (global as any).fetch = mock;
  return mock;
}

async function open() {
  await act(async () => {
    fireEvent.click(screen.getByText('Why am I seeing this?'));
  });
}

describe('WhyThisPaper', () => {
  test('asks for nothing until the user opens it', async () => {
    // It renders once per result row. Fifty requests to fill panels nobody
    // opened would be indefensible.
    const mock = mockFetch(LOCAL_EVIDENCE);
    await act(async () => { render(<WhyThisPaper documentId={7} />); });

    expect(mock).not.toHaveBeenCalled();

    await open();
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    expect(String(mock.mock.calls[0][0])).toContain('/api/documents/7/why');
  });

  test('scopes to one run when given an execution', async () => {
    const mock = mockFetch(LOCAL_EVIDENCE);
    await act(async () => {
      render(<WhyThisPaper documentId={7} executionId={3} />);
    });
    await open();

    await waitFor(() =>
      expect(String(mock.mock.calls[0][0])).toContain('execution_id=3'));
  });

  test('the limits of the evidence are always rendered, never collapsed', async () => {
    mockFetch(LOCAL_EVIDENCE);
    await act(async () => { render(<WhyThisPaper documentId={7} />); });
    await open();

    expect(screen.getByText('What resmon cannot see')).toBeInTheDocument();
    expect(screen.getByText(/not its full text/)).toBeInTheDocument();
    expect(screen.getByText(/relevance-ranked, not a strict keyword filter/))
      .toBeInTheDocument();
  });

  test('a keyword that did not match is shown, not omitted', async () => {
    // Dropping the misses would turn an honest report into a highlight reel.
    mockFetch(LOCAL_EVIDENCE);
    await act(async () => { render(<WhyThisPaper documentId={7} />); });
    await open();

    expect(screen.getByText('quantum')).toBeInTheDocument();
    expect(screen.getByText('nowhere resmon can check')).toBeInTheDocument();
  });

  test('a match is presented as plausible, not as the reason', async () => {
    mockFetch(LOCAL_EVIDENCE);
    await act(async () => { render(<WhyThisPaper documentId={7} />); });
    await open();

    expect(screen.getByText(/plausible match/)).toBeInTheDocument();
    expect(screen.getByText(/which resmon cannot see/)).toBeInTheDocument();
    expect(screen.getByText('Matched locally')).toBeInTheDocument();
  });

  test('the one source resmon filters itself is labelled differently', async () => {
    mockFetch(RESMON_FILTERED);
    await act(async () => { render(<WhyThisPaper documentId={7} />); });
    await open();

    expect(screen.getByText('resmon matched this itself')).toBeInTheDocument();
    expect(screen.getByText(/complete reason, not a partial one/)).toBeInTheDocument();
  });

  test('a keyword carrying boolean operators is flagged in the panel', async () => {
    mockFetch({
      ...LOCAL_EVIDENCE,
      keywords: [{
        keyword: 'neural OR "deep learning"',
        matched: true,
        fields: ['abstract'],
        where: 'the abstract',
        contains_operators: true,
      }],
    });
    await act(async () => { render(<WhyThisPaper documentId={7} />); });
    await open();

    expect(screen.getByText(/resmon checked the literal text/)).toBeInTheDocument();
  });

  test('a paper found by several runs is not attributed to one of them', async () => {
    mockFetch({
      ...LOCAL_EVIDENCE,
      runs: [
        { ...LOCAL_EVIDENCE.runs[0] },
        {
          execution_id: 9, execution_type: 'deep_sweep',
          start_time: '2026-07-01T00:00:00Z', routine_name: null,
          keywords: ['quantum'],
        },
      ],
    });
    await act(async () => { render(<WhyThisPaper documentId={7} />); });
    await open();

    expect(screen.getByText(/Returned by 2 runs/)).toBeInTheDocument();
    expect(screen.getByText(/union of all of them/)).toBeInTheDocument();
  });

  test('a failed lookup says so instead of rendering an empty verdict', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ detail: 'No document with id 7' }),
      json: async () => ({ detail: 'No document with id 7' }),
    }));
    await act(async () => { render(<WhyThisPaper documentId={7} />); });
    await open();

    expect(screen.getByText(/No document with id 7/)).toBeInTheDocument();
  });
});
