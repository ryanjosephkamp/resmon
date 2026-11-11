import { fireEvent, render, screen, within } from '@testing-library/react';
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

function card(fullText: FullTextStatus, narrow: boolean, vault: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PaperCard entry={ENTRY} atlas={null} vault={vault} sourceName={() => 'OpenAlex'} narrow={narrow}
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

test('a saved paper offers the project picker without first opening its page', () => {
  card(status(null), false);
  fireEvent.click(screen.getByRole('button', { name: 'Paper Actions for “An authored paper”' }));
  fireEvent(screen.getByRole('dialog'), Object.assign(new Event('toggle'), { newState: 'open', oldState: 'closed' }));
  expect(screen.getByRole('button', { name: 'Add to a Project for “An authored paper”' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Saved for “An authored paper”' })).toHaveAttribute('aria-pressed', 'true');
});

test('a Library paper card links its title back to the collection record', () => {
  card(status(null), false);
  expect(within(screen.getByRole('heading', { name: 'An authored paper' })).getByRole('link')).toHaveAttribute('href', '/papers/7');
});

test.each([false, true])('a card has one Read action, and every action names its paper (narrow: %s)', (narrow) => {
  card({ ...status(null), in_library: { file_id: 'pdf', vault_id: 'vault', version_id: 'v', byte_size: 10 } }, narrow);
  const read = screen.getByRole('link', { name: /Read/ });
  expect(read).toHaveAccessibleName('Read “An authored paper”');
  expect(screen.getByRole('button', { name: 'Mark Read for “An authored paper”' })).toHaveAttribute('aria-pressed', 'false');
  if (!narrow) expect(screen.getByRole('button', { name: /Remove from To Read for “An authored paper”/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Paper Actions for “An authored paper”' }));
  fireEvent(screen.getByRole('dialog'), Object.assign(new Event('toggle'), { newState: 'open', oldState: 'closed' }));
  expect(screen.getAllByRole('link', { name: /Read/ })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /^Remove from Read$|^Remove from To Read$/ })).not.toBeInTheDocument();
});

test('a card opens its held copy even while the queue’s PDF cover is being refreshed', () => {
  card({ ...status(null), in_library: { file_id: 'pdf', vault_id: 'vault', version_id: 'v', byte_size: 10 } }, false, 'vault');
  expect(screen.getByRole('link', { name: /^Read/ })).toHaveAttribute('href', '/library/files/pdf?paper=7');
});
