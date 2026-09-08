/**
 * The reading queue in the renderer: the Papers tab of a run, and the page.
 *
 * Boundary: jsdom with a routed `fetch` double. That double is the limit of
 * what these tests can see — it cannot fail the way SQLite fails, and it
 * cannot tell you that the backend really keeps a saved paper's state. What it
 * *can* prove, and what all three shipped defects of 1.8 were about, is that
 * the interface only claims what a response actually said: no optimistic row
 * flip, no success banner over a 500, and no selection surviving a page change
 * into an export.
 *
 * The out-of-process half is `verification_scripts/test_reading_queue.py`
 * (real backend, real socket) and `e2e/reading-queue.spec.ts` (real Electron).
 */

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import ReadingQueuePage from '../pages/ReadingQueuePage';
import ExecutionPapers from '../components/Results/ExecutionPapers';
import { callsTo, mockRoutedFetch, renderWithProviders } from './testUtils';

function paper(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source_repository: 'arxiv',
    external_id: `synthetic-${id}`,
    doi: null,
    title: `Paper ${id}`,
    authors: 'Ada Lovelace',
    abstract: 'A synthetic abstract.',
    publication_date: '2026-09-01',
    url: 'https://example.invalid/p',
    categories: 'fixture',
    queue_status: null,
    ...overrides,
  };
}

function entry(id: number, status: 'to_read' | 'read' = 'to_read') {
  return {
    document_id: id,
    status,
    saved_at: '2026-09-08 10:00:00',
    updated_at: '2026-09-08 10:00:00',
    read_at: status === 'read' ? '2026-09-09 11:00:00' : null,
    document: paper(id),
  };
}

function queuePage(entries: ReturnType<typeof entry>[], overrides: Record<string, unknown> = {}) {
  const read = entries.filter((e) => e.status === 'read').length;
  return {
    entries,
    total: entries.length,
    limit: 50,
    offset: 0,
    status: null,
    counts: { to_read: entries.length - read, read, all: entries.length },
    ...overrides,
  };
}

/**
 * `WhyThisPaper` fetches only when a user opens it, so these routes exist for
 * the two tests that open one. The shape is the real endpoint's.
 */
function whyPayload(id: number) {
  return {
    document: { id, title: `Paper ${id}`, source_repository: 'arxiv' },
    source: {
      slug: 'arxiv', name: 'arXiv', keyword_combination: 'Implicit AND',
      keyword_combination_notes: 'arXiv combines terms with AND.',
      resmon_filtered_locally: false,
    },
    runs: [],
    keywords: [{
      keyword: 'synthetic', matched: true, fields: ['title'],
      where: 'the title', contains_operators: false,
    }],
    matched_count: 1,
    keyword_count: 1,
    verdict: 'local_evidence' as const,
    headline: '“synthetic” appears in this paper.',
    what_resmon_cannot_see: ['resmon stores no full text.'],
    fields_checked: ['title', 'abstract', 'categories', 'authors'],
  };
}

const WHY = {
  '/api/documents/1/why': whyPayload(1),
  '/api/documents/2/why': whyPayload(2),
  '/api/documents/3/why': whyPayload(3),
};

describe('ExecutionPapers — the Papers tab of a run', () => {
  test('lists the run’s stored papers by their corpus id and pages them', async () => {
    const mock = mockRoutedFetch({
      ...WHY,
      '/api/executions/7/documents': {
        papers: [paper(1), paper(2)], total: 51, limit: 50, offset: 0, only_new: false,
      },
    });
    await renderWithProviders(<ExecutionPapers executionId={7} />);

    expect(screen.getByTestId('papers-range')).toHaveTextContent('Papers 1–2 of 51');
    expect(screen.getByTestId('paper-1')).toBeInTheDocument();
    const calls = callsTo(mock, '/api/executions/7/documents');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('limit=50&offset=0');
    // Next is live because the total exceeds what this page holds.
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  test('an empty run says so instead of rendering an empty list', async () => {
    mockRoutedFetch({
      '/api/executions/7/documents': {
        papers: [], total: 0, limit: 50, offset: 0, only_new: false,
      },
    });
    await renderWithProviders(<ExecutionPapers executionId={7} />);
    expect(screen.getByTestId('papers-empty')).toBeInTheDocument();
  });

  test('a failed load is an error, not an empty run', async () => {
    const mock = mockRoutedFetch({});
    mock.mockImplementation(async () => ({
      ok: false, status: 500, statusText: 'Server Error',
      text: async () => JSON.stringify({ detail: 'database is locked' }),
    }));
    await renderWithProviders(<ExecutionPapers executionId={7} />);
    await waitFor(() => expect(screen.getByTestId('papers-error')).toBeInTheDocument());
    expect(screen.queryByTestId('papers-empty')).not.toBeInTheDocument();
  });

  test('a paper already in the queue shows its state and no Save button', async () => {
    mockRoutedFetch({
      ...WHY,
      '/api/executions/7/documents': {
        papers: [paper(1, { queue_status: 'read' }), paper(2)],
        total: 2, limit: 50, offset: 0, only_new: false,
      },
    });
    await renderWithProviders(<ExecutionPapers executionId={7} />);
    expect(screen.getByTestId('saved-1')).toHaveTextContent('In queue · Read');
    expect(screen.queryByTestId('save-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('save-2')).toBeInTheDocument();
  });

  test('Save shows the state the backend returned, not the one it asked for', async () => {
    // The backend answers `read`, because this paper was read before a later
    // run rediscovered it. The row must say Read, not To read.
    const mock = mockRoutedFetch({
      ...WHY,
      '/api/executions/7/documents': {
        papers: [paper(1)], total: 1, limit: 50, offset: 0, only_new: false,
      },
      '/api/reading-queue': {
        document_id: 1, status: 'read', saved_at: '2026-09-01 08:00:00',
        updated_at: '2026-09-02 08:00:00', read_at: '2026-09-02 08:00:00',
      },
    });
    await renderWithProviders(<ExecutionPapers executionId={7} />);
    await act(async () => { fireEvent.click(screen.getByTestId('save-1')); });

    expect(screen.getByTestId('saved-1')).toHaveTextContent('In queue · Read');
    const posts = callsTo(mock, '/api/reading-queue');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0].init?.body))).toEqual({ document_id: 1 });
  });

  test('the evidence panel is scoped to the run the paper is being read from', async () => {
    const mock = mockRoutedFetch({
      '/api/documents/1/why?execution_id=7': whyPayload(1),
      '/api/executions/7/documents': {
        papers: [paper(1)], total: 1, limit: 50, offset: 0, only_new: false,
      },
    });
    await renderWithProviders(<ExecutionPapers executionId={7} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Why am I seeing this?' }));
    });
    // The document id, with the run as a qualifier — never the execution id in
    // the document's place.
    const why = callsTo(mock, '/api/documents/1/why');
    expect(why).toHaveLength(1);
    expect(why[0].url).toContain('execution_id=7');
  });

  test('a failed Save leaves the row unsaved and says why', async () => {
    const mock = mockRoutedFetch({
      ...WHY,
      '/api/executions/7/documents': {
        papers: [paper(1)], total: 1, limit: 50, offset: 0, only_new: false,
      },
    });
    const routed = mock.getMockImplementation()!;
    mock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/reading-queue')) {
        return {
          ok: false, status: 404, statusText: 'Not Found',
          text: async () => JSON.stringify({ detail: 'No document with id 1' }),
        };
      }
      return routed(input, init);
    });
    await renderWithProviders(<ExecutionPapers executionId={7} />);
    await act(async () => { fireEvent.click(screen.getByTestId('save-1')); });

    expect(screen.getByTestId('papers-save-error')).toHaveTextContent('No document with id 1');
    expect(screen.getByTestId('save-1')).toBeInTheDocument();
    expect(screen.queryByTestId('saved-1')).not.toBeInTheDocument();
  });
});

describe('ReadingQueuePage', () => {
  test('opens on To read and asks the backend for that filter', async () => {
    const mock = mockRoutedFetch({
      ...WHY,
      '/api/reading-queue': queuePage([entry(1), entry(2)]),
    });
    await renderWithProviders(<ReadingQueuePage />);

    expect(screen.getByTestId('filter-to_read')).toHaveAttribute('aria-pressed', 'true');
    const calls = callsTo(mock, '/api/reading-queue');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('status=to_read');
    expect(screen.getByTestId('queue-range')).toHaveTextContent('Showing 1–2 of 2');
  });

  test('an empty queue explains where papers come from', async () => {
    mockRoutedFetch({ '/api/reading-queue': queuePage([]) });
    await renderWithProviders(<ReadingQueuePage />);
    expect(screen.getByTestId('queue-empty')).toHaveTextContent('Nothing saved yet');
  });

  test('an empty filter over a non-empty queue is not the empty-queue message', async () => {
    mockRoutedFetch({
      '/api/reading-queue': queuePage([], { counts: { to_read: 0, read: 4, all: 4 } }),
    });
    await renderWithProviders(<ReadingQueuePage />);
    expect(screen.getByTestId('queue-empty')).toHaveTextContent('Everything you saved has been read');
    expect(screen.queryByText('Nothing saved yet')).not.toBeInTheDocument();
  });

  test('a failed load is an error and not an empty queue', async () => {
    const mock = mockRoutedFetch({});
    mock.mockImplementation(async () => ({
      ok: false, status: 500, statusText: 'Server Error',
      text: async () => 'boom',
    }));
    await renderWithProviders(<ReadingQueuePage />);
    await waitFor(() => expect(screen.getByTestId('queue-error')).toBeInTheDocument());
    expect(screen.queryByTestId('queue-empty')).not.toBeInTheDocument();
  });

  test('Mark read sends the change and re-reads the list rather than editing it locally', async () => {
    let served = queuePage([entry(1)]);
    const mock = mockRoutedFetch({
      ...WHY,
      '/api/reading-queue': () => served,
      '/api/reading-queue/1': () => {
        served = queuePage([entry(1, 'read')]);
        return { document_id: 1, status: 'read', saved_at: '', updated_at: '', read_at: '' };
      },
    });
    await renderWithProviders(<ReadingQueuePage />);
    await act(async () => { fireEvent.click(screen.getByTestId('toggle-1')); });

    const put = callsTo(mock, '/api/reading-queue/1')[0];
    expect(put.init?.method).toBe('PUT');
    expect(JSON.parse(String(put.init?.body))).toEqual({ status: 'read' });
    await waitFor(() => expect(screen.getByTestId('state-1')).toHaveTextContent('Read'));
    // Two GETs: the mount, and the re-read after the change.
    expect(callsTo(mock, '/api/reading-queue?')).toHaveLength(2);
  });

  test('a failed state change leaves the row alone and says so', async () => {
    const mock = mockRoutedFetch({ ...WHY, '/api/reading-queue': queuePage([entry(1)]) });
    const routed = mock.getMockImplementation()!;
    mock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/reading-queue/1')) {
        return {
          ok: false, status: 404, statusText: 'Not Found',
          text: async () => JSON.stringify({ detail: 'Document 1 is not in the reading queue' }),
        };
      }
      return routed(input, init);
    });
    await renderWithProviders(<ReadingQueuePage />);
    await act(async () => { fireEvent.click(screen.getByTestId('toggle-1')); });

    expect(screen.getByTestId('queue-action-error')).toHaveTextContent('not in the reading queue');
    expect(screen.getByTestId('state-1')).toHaveTextContent('To read');
  });

  test('Remove sends a DELETE for the entry and never for the document', async () => {
    let served = queuePage([entry(1)]);
    const mock = mockRoutedFetch({
      ...WHY,
      '/api/reading-queue': () => served,
      '/api/reading-queue/1': () => { served = queuePage([]); return { removed: true, document_id: 1 }; },
    });
    await renderWithProviders(<ReadingQueuePage />);
    await act(async () => { fireEvent.click(screen.getByTestId('remove-1')); });

    const del = callsTo(mock, '/api/reading-queue/1')[0];
    expect(del.init?.method).toBe('DELETE');
    expect(callsTo(mock, '/api/documents')).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId('queue-empty')).toBeInTheDocument());
  });

  test('export sends the ticked document ids to the shared export route', async () => {
    const mock = mockRoutedFetch({
      ...WHY,
      '/api/reading-queue': queuePage([entry(1), entry(2)]),
      '/api/export/references': 'references',
    });
    URL.createObjectURL = jest.fn(() => 'blob:queue');
    URL.revokeObjectURL = jest.fn();
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      await renderWithProviders(<ReadingQueuePage />);
      fireEvent.click(screen.getByTestId('select-2'));
      fireEvent.click(screen.getByRole('button', { name: 'BibTeX' }));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));

      const calls = callsTo(mock, '/api/export/references');
      expect(calls).toHaveLength(1);
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({
        document_ids: [2], format: 'bibtex',
      });
      // Never execution_ids from this page: the queue selects papers.
      expect(String(calls[0].init?.body)).not.toContain('execution_ids');
    } finally {
      click.mockRestore();
    }
  });

  test('changing the filter clears the selection, so nothing invisible is exported', async () => {
    mockRoutedFetch({
      ...WHY,
      '/api/reading-queue': queuePage([entry(1), entry(2)]),
      '/api/export/references': 'references',
    });
    await renderWithProviders(<ReadingQueuePage />);
    fireEvent.click(screen.getByTestId('select-1'));
    expect(screen.getByRole('button', { name: 'BibTeX' })).not.toBeDisabled();

    await act(async () => { fireEvent.click(screen.getByTestId('filter-read')); });

    expect(screen.getByTestId('select-1')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'BibTeX' })).toBeDisabled();
  });

  test('a failed export is reported and nothing is saved', async () => {
    const mock = mockRoutedFetch({ ...WHY, '/api/reading-queue': queuePage([entry(1)]) });
    const routed = mock.getMockImplementation()!;
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/export/references')) {
        return {
          ok: false, status: 400,
          json: async () => ({ detail: "Unknown export format 'endnote'" }),
        };
      }
      return routed(input, init);
    });
    try {
      await renderWithProviders(<ReadingQueuePage />);
      fireEvent.click(screen.getByTestId('select-1'));
      fireEvent.click(screen.getByRole('button', { name: 'RIS' }));
      await waitFor(() => expect(screen.getByTestId('queue-export-error'))
        .toHaveTextContent("Unknown export format 'endnote'"));
      expect(click).not.toHaveBeenCalled();
    } finally {
      click.mockRestore();
    }
  });

  test('the evidence panel asks about the paper, by its corpus id', async () => {
    // `WhyThisPaper` fetches on first open rather than on mount, so the click
    // is the point: it is what proves the queue handed it a document id.
    const mock = mockRoutedFetch({ ...WHY, '/api/reading-queue': queuePage([entry(3)]) });
    await renderWithProviders(<ReadingQueuePage />);
    expect(callsTo(mock, '/api/documents/3/why')).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Why am I seeing this?' }));
    });

    const why = callsTo(mock, '/api/documents/3/why');
    expect(why).toHaveLength(1);
    // From the queue there is no run in view, so the explanation is corpus-wide.
    expect(why[0].url).not.toContain('execution_id');
  });
});
