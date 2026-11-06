import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  askedWords, differencesWords, differenceWords, findLeadWords, hostWords, licenseWords, matchedWords, orWords, outcomeWords, pending,
  requestWords, sentenceCase, storedWords, type FindSourceResult, type FullTextRequest,
} from '../fullText';

function request(fields: Partial<FullTextRequest>): FullTextRequest {
  return {
    id: 1, document_id: 7, execution_id: null, requested_by: 'person', state: 'waiting', reason: null, words: null,
    url: 'https://repo.example.edu/7.pdf', final_url: null, host: 'www.repo.example.edu', license: 'cc-by',
    license_words: 'CC BY', version: 'published', reported_by: 'openalex', file_id: null, byte_size: null,
    requested_at_utc: '2026-11-05T10:00:00+00:00', finished_at_utc: null, ...fields,
  };
}

function source(fields: Partial<FindSourceResult>): FindSourceResult {
  return {
    source: 'openalex', name: 'OpenAlex', outcome: 'found', matched_by: 'doi', title_similarity: null, document_id: 3,
    candidates: 1, differences: [], reference: false, why_not_asked: null, open_copy: null, ...fields,
  };
}

describe('a request, in words', () => {
  test('waiting and downloading are going; the rest are not', () => {
    expect(pending(request({ state: 'waiting' }))).toBe(true);
    expect(pending(request({ state: 'downloading' }))).toBe(true);
    for (const state of ['stored', 'skipped', 'failed']) expect(pending(request({ state }))).toBe(false);
    expect(pending(null)).toBe(false);
  });

  test('each state says what is happening, and a refusal says why in the engine’s words', () => {
    expect(requestWords(request({ state: 'waiting' }))).toBe('Waiting its turn to get the PDF from repo.example.edu.');
    expect(requestWords(request({ state: 'downloading' }))).toBe('Getting the PDF from repo.example.edu.');
    expect(requestWords(request({ state: 'stored' }))).toBe('The PDF is in the Library.');
    expect(requestWords(request({ state: 'stored', reason: 'already_in_library' }))).toBe('The PDF is already in the Library.');
    expect(requestWords(request({ state: 'failed', reason: 'http_status', words: 'arxiv.org answered HTTP 404.' })))
      .toBe('arxiv.org answered HTTP 404.');
  });

  test('a stored PDF says it is in the Library only while the Library holds it', () => {
    expect(storedWords(request({ state: 'stored', file_held: true }))).toBe('In the Library, from repo.example.edu, CC BY');
    expect(storedWords(request({ state: 'stored', file_held: false })))
      .toBe('Got from repo.example.edu, CC BY, and removed from the Library since');
  });

  test('a host reads without www, and a copy says its license or that arXiv states it', () => {
    expect(hostWords('www.example.org')).toBe('example.org');
    expect(hostWords(null)).toBe('the source');
    expect(licenseWords({ license_words: 'CC BY-NC', license_to_be_read: false })).toBe('CC BY-NC');
    expect(licenseWords({ license_words: null, license_to_be_read: true })).toBe('license read from arXiv when you ask');
    expect(licenseWords({ license_words: null, license_to_be_read: false })).toBe('no license stated');
  });
});

describe('a find, in words', () => {
  test('what was asked', () => {
    expect(askedWords({ kind: 'doi', value: '10.5555/x' })).toBe('the DOI 10.5555/x');
    expect(askedWords({ kind: 'arxiv', value: '2601.00001' })).toBe('the arXiv id 2601.00001');
    expect(askedWords({ kind: 'pmid', value: '1' })).toBe('the PMID 1');
    expect(askedWords({ kind: 'title', value: 'A paper' })).toBe('the title “A paper”');
  });

  test('how a copy matched, and each outcome', () => {
    expect(matchedWords({ matched_by: 'exact_title', title_similarity: 1 })).toBe('by its exact title');
    expect(matchedWords({ matched_by: 'close_title', title_similarity: 0.917 })).toBe('by a close title (92% of its words)');
    expect(outcomeWords(source({}))).toBe('Found by its DOI');
    expect(outcomeWords(source({ outcome: 'not_found', matched_by: null, candidates: 5 })))
      .toBe('Not found: none of the 5 records it sent is this paper');
    expect(outcomeWords(source({ outcome: 'not_found', matched_by: null, candidates: 0 }))).toBe('Not found: it answered with nothing');
    expect(outcomeWords(source({ outcome: 'did_not_answer', matched_by: null }))).toBe('Did not answer');
    expect(outcomeWords(source({ outcome: 'not_asked', matched_by: null }))).toBe('Not asked');
  });

  test('what differs from the reference copy, in a list with the Oxford comma', () => {
    expect(differenceWords({ field: 'year', this: '2025', reference: '2026' })).toBe('year 2025, not 2026');
    expect(differenceWords({ field: 'doi', this: null, reference: '10.5555/x' })).toBe('no DOI');
    expect(differenceWords({ field: 'author_count', this: 3, reference: 4 })).toBe('3 authors, not 4');
    expect(differencesWords(source({ differences: [
      { field: 'title', this: 'A preprint', reference: 'A paper' },
      { field: 'year', this: '2025', reference: '2026' },
      { field: 'doi', this: null, reference: '10.5555/x' },
    ] }))).toBe('title “A preprint”, year 2025, not 2026, and no DOI');
    expect(differencesWords(source({ differences: [
      { field: 'year', this: '2025', reference: '2026' },
      { field: 'doi', this: null, reference: '10.5555/x' },
    ] }))).toBe('year 2025, not 2026 and no DOI');
    expect(differencesWords(source({}))).toBeNull();
    expect(differencesWords(source({ reference: true }))).toBe('The copy the others are compared with');
    expect(differenceWords({ field: 'year', this: '2026', reference: null })).toBe('year 2026, where the reference copy gives none');
  });
});

describe('a find’s first sentence', () => {
  const query = { kind: 'doi', value: '10.5555/x', typed: '10.5555/x' };
  const answered = (outcomes: string[]) => ({
    query, counts: { found: outcomes.filter((o) => o === 'found').length },
    sources: outcomes.map((outcome, i) => source({ source: `s${i}`, outcome, matched_by: outcome === 'found' ? 'doi' : null })),
  });

  test('a finished find says how many of the sources asked hold the paper', () => {
    expect(findLeadWords({ status: 'completed' }, answered(['found', 'not_found', 'not_asked'])))
      .toBe('1 of 2 sources asked holds the DOI 10.5555/x.');
    expect(findLeadWords({ status: 'completed' }, answered(['not_found']))).toBe('None of the 1 source asked holds the DOI 10.5555/x.');
    expect(findLeadWords({ status: 'completed' }, answered([]))).toBe('No source was asked.');
  });

  test('a find that failed, was stopped, or was interrupted says so, never "None of the 0 sources"', () => {
    expect(findLeadWords({ status: 'failed' }, answered(['did_not_answer', 'did_not_answer', 'not_asked'])))
      .toBe('The find failed: none of the 2 sources asked answered.');
    expect(findLeadWords({ status: 'failed', error_message: 'The engine could not read the query.' }, answered([])))
      .toBe('The find failed: The engine could not read the query.');
    expect(findLeadWords({ status: 'failed', error_message: null }, answered([]))).toBe('The find failed.');
    expect(findLeadWords({ status: 'cancelled' }, answered([]))).toBe('The find was stopped before every source answered.');
    expect(findLeadWords({ status: 'interrupted' }, answered(['found'])))
      .toBe('The find was interrupted: the engine stopped while it went.');
  });
});

describe('a sentence from the engine’s words', () => {
  test('begins with a capital, but a name written with a small first letter keeps it', () => {
    expect(sentenceCase('left out of this find.')).toBe('Left out of this find.');
    expect(sentenceCase('arXiv can be asked by arXiv id and title, not by DOI.')).toBe('arXiv can be asked by arXiv id and title, not by DOI.');
    expect(sentenceCase("bioRxiv's DOIs all begin 10.1101/, and this one does not.")).toBe("bioRxiv's DOIs all begin 10.1101/, and this one does not.");
    expect(sentenceCase('resmon cannot look a paper up at DBLP.')).toBe('resmon cannot look a paper up at DBLP.');
    expect(sentenceCase('Crossref can be asked by DOI and title.')).toBe('Crossref can be asked by DOI and title.');
  });

  test('the sites a download never comes from, with the Oxford comma and "or"', () => {
    expect(orWords(['CORE'])).toBe('CORE');
    expect(orWords(['BMC', 'nature.com'])).toBe('BMC or nature.com');
    expect(orWords(['NASA ADS', 'Springer', 'CORE', 'BMC', 'nature.com'])).toBe('NASA ADS, Springer, CORE, BMC, or nature.com');
  });
});

describe('the Find a paper page', () => {
  test('draws its form and its tab under Search before the engine has answered', async () => {
    const { FindPaper } = await import('../../collection/FindPaper');
    // Rendered without an engine: the page draws its form and its tabs, and reads nothing.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/search/find']}><FindPaper /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Find a paper' })).toBeTruthy();
    expect(screen.getByRole('search', { name: 'Find a paper' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Find a paper' })).toBeTruthy();
    // Only copies that share a DOI are linked (``paper_find.link_copies``).
    expect(screen.getByText(/Copies that share a DOI are linked as one paper; a copy that does not carry that DOI is not\./))
      .toBeTruthy();
  });
});
