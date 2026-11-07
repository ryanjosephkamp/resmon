import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLanded } from '../GetPdf';
import type { FullTextStatus } from '../fullText';

type Download = NonNullable<FullTextStatus['download']>;

function status(download: Partial<Download> | null, inLibrary: boolean): FullTextStatus {
  return {
    document_id: 7, downloadable: true, why_not: null, why_not_words: null, best: null, copies: [],
    in_library: inLibrary ? { file_id: 'f', version_id: 'v', vault_id: 'x', byte_size: 10 } : null,
    download: download === null ? null : {
      id: 3, document_id: 7, execution_id: null, requested_by: 'person', state: 'waiting', reason: null, words: null,
      url: 'https://repo.example.edu/7.pdf', final_url: null, host: 'repo.example.edu', license: 'cc-by',
      license_words: 'CC BY', version: 'published', reported_by: 'openalex', file_id: null, byte_size: null,
      requested_at_utc: '2026-11-05T10:00:00+00:00', finished_at_utc: null, ...download,
    },
  } as FullTextStatus;
}

function watch(first: FullTextStatus) {
  const client = new QueryClient();
  const invalidated = jest.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(({ statuses }: { statuses: ReadonlyMap<number, FullTextStatus> }) => useLanded(statuses), {
    wrapper, initialProps: { statuses: new Map([[7, first]]) },
  });
  const keys = () => invalidated.mock.calls.map(([filters]) => (filters as { queryKey: unknown[] }).queryKey[0]);
  return { hook, keys };
}

describe('the Library is read again when a PDF lands', () => {
  test('a download quicker than a read, never seen going, is seen arriving in the Library', () => {
    // Before Get the PDF: no request, and the Library does not hold the paper.
    const { hook, keys } = watch(status(null, false));
    expect(keys()).toEqual([]);
    // The next read: already stored, and the Library holds it.
    hook.rerender({ statuses: new Map([[7, status({ state: 'stored', file_id: 'f' }, true)]]) });
    expect(keys()).toEqual(expect.arrayContaining(['reading-queue', 'library-files', 'library']));
  });

  test('a download read while it went is seen when it ends', () => {
    const { hook, keys } = watch(status({ state: 'downloading' }, false));
    hook.rerender({ statuses: new Map([[7, status({ state: 'failed', reason: 'http_status' }, false)]]) });
    expect(keys()).toContain('reading-queue');
  });

  test('a paper the Library held from the start reads nothing again', () => {
    const { hook, keys } = watch(status({ state: 'stored', file_id: 'f' }, true));
    hook.rerender({ statuses: new Map([[7, status({ state: 'stored', file_id: 'f' }, true)]]) });
    expect(keys()).toEqual([]);
  });
});
