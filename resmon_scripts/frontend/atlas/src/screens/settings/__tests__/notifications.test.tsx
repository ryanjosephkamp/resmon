import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { Notifications } from '../Notifications';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

test.each([[1, 'Field A'], [2, 'Field A and Field B'], [3, 'Field A, Field B, and Field C']])('a %i-watch notification list has sentence punctuation', async (n, words) => {
  const names = ['Field A', 'Field B', 'Field C'].slice(0, Number(n));
  (engine as jest.Mock).mockReturnValue({ GET: (route: string) => Promise.resolve({ data: route === '/api/routines'
    ? names.map((name, id) => ({ id, name, notify_on_complete: true })) : { notify_manual: true, notify_automatic_mode: 'selected' }, response: {} }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Notifications /></MemoryRouter></QueryClientProvider>);
  await screen.findByRole('link', { name: 'Field A' });
  expect(document.querySelector('[data-notify="set-to-notify"]')).toHaveTextContent(`Set to notify, whichever you choose: ${words}.`);
  expect(screen.getAllByRole('link')).toHaveLength(Number(n));
});
