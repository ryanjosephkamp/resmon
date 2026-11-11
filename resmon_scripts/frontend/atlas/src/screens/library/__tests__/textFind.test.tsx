import { useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { FilePage } from '../FilePage';
import { TextFind } from '../TextFind';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../../bridge', () => ({ bridge: () => undefined, isMac: () => true, systemName: () => 'macOS' }));

for (const media of ['text/markdown', 'text/x-tex', 'text/plain']) {
  test(`${media}: Find opens in both views, steps, wraps, and returns focus`, async () => {
    const file = { file_id: 'file', version_id: 'version', original_name: 'notes', media_type: media,
      paper_links: [], project_count: 0, byte_size: 32, sha256: 'a'.repeat(64), created_at_utc: '2026-01-01T00:00:00Z' };
    (engine as jest.Mock).mockReturnValue({ GET: (route: string) => Promise.resolve({ data:
      route === '/api/library' ? { status: 'ready', vault: { vault_id: 'vault' } }
        : route.endsWith('/text') ? { text: 'wombat first\nwombat last', line_count: 2 }
          : route === '/api/library/files/{file_id}' ? { file } : { entries: [] }, response: {} }) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><FilePage /></MemoryRouter></QueryClientProvider>);
    const reader = await screen.findByRole('region', { name: 'The text of notes' });
    await waitFor(() => expect(reader).toHaveTextContent('wombat'));
    const views = media === 'text/plain' ? ['plain'] : ['rich', 'plain'];
    for (const view of views) {
      const opener = view === 'plain' && media !== 'text/plain'
        ? screen.getByRole('button', { name: 'Plain Text' }) : screen.getByRole('link', { name: 'Library' });
      if (view === 'plain' && media !== 'text/plain') fireEvent.click(opener);
      opener.focus();
      fireEvent.keyDown(document, { key: 'f', metaKey: true });
      const input = screen.getByRole('textbox', { name: 'Find in the File' });
      expect(input).toHaveFocus();
      fireEvent.change(input, { target: { value: 'wombat' } });
      await waitFor(() => expect(screen.getByRole('status', { name: 'Find matches' })).toHaveTextContent('1 of 2'));
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getByRole('status', { name: 'Find matches' })).toHaveTextContent('2 of 2');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getByRole('status', { name: 'Find matches' })).toHaveTextContent('1 of 2');
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
      expect(screen.getByRole('status', { name: 'Find matches' })).toHaveTextContent('2 of 2');
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.queryByRole('textbox', { name: 'Find in the File' })).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    }
  });
}

test('Find highlights every match at the file size limit without a constructor argument overflow', async () => {
  // jsdom has no Custom Highlight API. Retain its real ranges in a set with
  // the browser API's constructor and add method, so the test reads what is painted.
  class TestHighlight extends Set<Range> {
    constructor(...ranges: Range[]) { super(ranges); }
  }
  const highlights = new Map<string, TestHighlight>();
  const beforeHighlight = Object.getOwnPropertyDescriptor(globalThis, 'Highlight');
  const beforeRegistry = Object.getOwnPropertyDescriptor(CSS, 'highlights');
  Object.defineProperty(globalThis, 'Highlight', { value: TestHighlight, configurable: true });
  Object.defineProperty(CSS, 'highlights', { value: highlights, configurable: true });
  function FileText() {
    const content = useRef<HTMLDivElement>(null);
    return <><TextFind content={content} onClose={() => undefined} /><div ref={content}>{'a'.repeat(256 * 1024)}</div></>;
  }
  try {
    const rendered = render(<FileText />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in the File' }), { target: { value: 'a' } });
    await waitFor(() => expect(screen.getByRole('status', { name: 'Find matches' })).toHaveTextContent('1 of 262144'));
    expect(highlights.get('ev-find')?.size).toBe(262143);
    expect([...highlights.get('ev-find-current')!].map((range) => range.toString())).toEqual(['a']);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    expect(screen.getByRole('status', { name: 'Find matches' })).toHaveTextContent('262144 of 262144');
    expect([...highlights.get('ev-find-current')!][0]?.endOffset).toBe(262144);
    rendered.unmount();
    expect(highlights.size).toBe(0);
  } finally {
    if (beforeHighlight) Object.defineProperty(globalThis, 'Highlight', beforeHighlight);
    else Reflect.deleteProperty(globalThis, 'Highlight');
    if (beforeRegistry) Object.defineProperty(CSS, 'highlights', beforeRegistry);
    else Reflect.deleteProperty(CSS, 'highlights');
  }
});

test('a reader still loading does not count its status message as file text', async () => {
  const file = { file_id: 'pending', version_id: 'version', original_name: 'pending.txt', media_type: 'text/plain',
    paper_links: [], project_count: 0, byte_size: 32, sha256: 'a'.repeat(64), created_at_utc: '2026-01-01T00:00:00Z' };
  (engine as jest.Mock).mockReturnValue({ GET: (route: string) => route.endsWith('/text') ? new Promise(() => undefined)
    : Promise.resolve({ data: route === '/api/library' ? { status: 'ready', vault: { vault_id: 'vault' } }
      : route === '/api/library/files/{file_id}' ? { file } : { entries: [] }, response: {} }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter><FilePage /></MemoryRouter></QueryClientProvider>);
  await screen.findByText('Reading the text.');
  fireEvent.click(screen.getByRole('button', { name: 'Find in the File' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Find in the File' }), { target: { value: 'Reading' } });
  expect(screen.getByRole('status', { name: 'Find matches' })).toHaveTextContent('File text is not available yet');
  view.unmount();
  client.clear();
});
