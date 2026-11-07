/**
 * Settings › Sources: the contact address for Crossref and OpenAlex. Nothing
 * is set at first, so nothing is sent; Save stores what is typed, Remove
 * clears it, and what the engine stored is what the page then says.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { Sources } from '../Sources';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../../bridge', () => ({ bridge: () => null, platform: () => 'darwin' }));

const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

test('an address is sent only once it is saved, and Remove takes it back', async () => {
  let stored: string | null = null;
  const GET = jest.fn((path: string) => reply(
    path === '/api/settings/sources' ? { contact_email: stored, sent_to: ['crossref', 'openalex'] }
      : path === '/api/credentials' ? { credentials: {}, keyring_responsive: true } : []));
  const PUT = jest.fn((_path: string, init: { body: { contact_email: string | null } }) => {
    stored = init.body.contact_email;
    return reply({ contact_email: stored, sent_to: ['crossref', 'openalex'] });
  });
  (engine as jest.Mock).mockReturnValue({ GET, PUT, DELETE: jest.fn() });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><Sources /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/with none, nothing is sent/)).toBeInTheDocument();
  const field = screen.getByLabelText('Your email address') as HTMLInputElement;
  await waitFor(() => expect(field).toBeEnabled());
  expect(field.value).toBe('');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

  fireEvent.change(field, { target: { value: ' ada@example.org ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(PUT).toHaveBeenCalledWith('/api/settings/sources', { body: { contact_email: 'ada@example.org' } }));
  expect(await screen.findByText('Saved. Crossref and OpenAlex are sent ada@example.org.')).toBeInTheDocument();
  expect(field.value).toBe('ada@example.org');

  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(PUT).toHaveBeenLastCalledWith('/api/settings/sources', { body: { contact_email: null } }));
  expect(await screen.findByText('Removed. No address is sent.')).toBeInTheDocument();
  expect(field.value).toBe('');
});
