import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { Evidence } from '../Evidence';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../../bridge', () => ({ isMac: () => true }));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><Evidence /></MemoryRouter></QueryClientProvider>);
}

test('each side folds, both fold by shortcut, and the choice survives leaving the page in this window', async () => {
  (engine as jest.Mock).mockReturnValue({ GET: () => Promise.resolve({ data: { status: 'unconfigured' }, response: {} }) });
  const first = mount();
  const files = await screen.findByRole('button', { name: 'Hide Files' });
  fireEvent.click(files);
  expect(first.container.querySelector('.evidence-page')).toHaveAttribute('data-files-folded', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Hide Notes' }));
  expect(first.container.querySelector('.evidence-page')).toHaveAttribute('data-notes-folded', 'true');
  first.unmount();
  const second = mount();
  expect(screen.getByRole('button', { name: 'Show Files' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show Notes' })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: '\\', code: 'Backslash', metaKey: true, shiftKey: true });
  expect(screen.getByRole('button', { name: 'Hide Files' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Hide Notes' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Fold Side Columns/ }));
  expect(second.container.querySelector('.evidence-page')).toHaveAttribute('data-files-folded', 'true');
  fireEvent.keyDown(document, { key: '\\', code: 'Backslash', metaKey: true, shiftKey: true });
});
