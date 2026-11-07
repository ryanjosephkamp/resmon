import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PaperCard } from '../Cards';
import type { FullTextStatus } from '../../fulltext/fullText';
import type { QueueEntry } from '../galleryModel';

const ENTRY = {
  document_id: 7, status: 'to_read', saved_at: '2026-11-05T10:00:00+00:00', found_by: null, pdf: null,
  document: {
    id: 7, title: 'An authored paper', authors: 'Ada Fixture', source_repository: 'openalex',
    publication_date: '2026-10-01', categories: null, url: 'https://journal.example.org/7', doi: '10.5555/x',
  },
} as unknown as QueueEntry;

function status(request: Partial<NonNullable<FullTextStatus['download']>> | null): FullTextStatus {
  return {
    document_id: 7, downloadable: true, why_not: null, why_not_words: null, copies: [], in_library: null,
    best: { reported_by: 'openalex', pdf_url: 'https://repo.example.edu/7.pdf', landing_url: null, host: 'repo.example.edu',
      license: 'cc-by', license_words: 'CC BY', license_basis: 'source_record', version: 'published', license_to_be_read: false },
    download: request === null ? null : {
      id: 3, document_id: 7, execution_id: null, requested_by: 'person', state: 'waiting', reason: null, words: null,
      url: 'https://repo.example.edu/7.pdf', final_url: null, host: 'repo.example.edu', license: 'cc-by',
      license_words: 'CC BY', version: 'published', reported_by: 'openalex', file_id: null, byte_size: null,
      requested_at_utc: '2026-11-05T10:00:00+00:00', finished_at_utc: '2026-11-05T10:00:01+00:00', ...request,
    },
  } as FullTextStatus;
}

function card(fullText: FullTextStatus, narrow: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PaperCard entry={ENTRY} atlas={null} vault={null} sourceName={() => 'OpenAlex'} narrow={narrow}
          picking={{ on: false, picked: false, onPick: () => undefined }} onRemove={() => undefined}
          onChanged={() => undefined} fullText={fullText} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('a paper card after Get the PDF', () => {
  const daily = 'resmon downloads at most 100 PDFs in any 24 hours, and that many have been asked for.';

  test.each([false, true])('a skipped request says why on the card (narrow: %s)', (narrow) => {
    const { container } = card(status({ state: 'skipped', reason: 'daily_cap', words: daily }), narrow);
    expect(screen.getByText(daily)).toBeTruthy();
    expect(container.querySelector('[data-fulltext="skipped"][data-reason="daily_cap"]')).toBeTruthy();
  });

  test.each([false, true])('a failed request says why on the card (narrow: %s)', (narrow) => {
    card(status({ state: 'failed', reason: 'http_status', words: 'repo.example.edu answered HTTP 404.' }), narrow);
    expect(screen.getByText('repo.example.edu answered HTTP 404.')).toBeTruthy();
  });

  test('with no request, the card keeps its label', () => {
    card(status(null), false);
    expect(screen.getByText(/Saved/)).toBeTruthy();
  });
});
