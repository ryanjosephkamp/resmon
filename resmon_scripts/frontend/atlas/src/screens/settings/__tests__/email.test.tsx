/**
 * Settings › Email: a provider fills in its server and port and says the one
 * step it asks for, the port says how it is encrypted, and a refused test
 * shows the engine's reason. The engine is a stand-in.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { engine, EngineError } from '../../../api/client';
import { Email } from '../Email';
import { PROVIDERS, providerOf, securityWords } from '../emailProviders';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../../bridge', () => ({ platform: () => 'darwin', isMac: () => true }));

/** A field by its id: each label also holds the field's hint, so its text is not the label alone. */
const field = (id: string) => document.getElementById(id) as HTMLInputElement;

const EMPTY = { smtp_server: '', smtp_port: '', smtp_username: '', smtp_from: '', smtp_to: '' };

function mount(stored = EMPTY, test: () => Promise<unknown> = () => Promise.resolve({ data: { success: true, recipient: 'a@b.org' }, response: {} })) {
  const saved: unknown[] = [];
  (engine as jest.Mock).mockReturnValue({
    GET: (path: string) => Promise.resolve({
      data: path === '/api/settings/email' ? stored
        : path === '/api/routines' ? []
          : { credentials: { smtp_password: { status: 'present' } } },
      response: {},
    }),
    PUT: (_path: string, init: { body: unknown }) => { saved.push(init.body); return Promise.resolve({ data: { success: true }, response: {} }); },
    POST: test,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Email /></MemoryRouter></QueryClientProvider>);
  return saved;
}

test('Gmail fills its server and port and says where its app password is made', async () => {
  const saved = mount();
  const choice = await screen.findByRole('group', { name: 'Provider' });
  expect(within(choice).getAllByRole('button').map((b) => b.textContent)).toEqual(['Gmail', 'iCloud Mail', 'Other']);
  fireEvent.click(within(choice).getByRole('button', { name: 'Gmail' }));
  expect(field('smtp-server')).toHaveValue('smtp.gmail.com');
  expect(field('smtp-port')).toHaveValue(587);
  const step = document.querySelector('[data-email="provider-step"]')!;
  expect(step).toHaveTextContent('Turn on 2-Step Verification');
  expect(within(step as HTMLElement).getByRole('link', { name: 'Make an app password' }))
    .toHaveAttribute('href', 'https://myaccount.google.com/apppasswords');
  expect(screen.getByText('Your full Gmail address')).toBeInTheDocument();
  expect(screen.getByText('Port 587 starts plain and is encrypted with STARTTLS before anything is sent.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toEqual({ settings: { ...EMPTY, smtp_server: 'smtp.gmail.com', smtp_port: '587' } });
});

test('a stored server shows its provider, and Other clears a provider’s server', async () => {
  mount({ ...EMPTY, smtp_server: 'smtp.mail.me.com', smtp_port: '587' });
  const choice = await screen.findByRole('group', { name: 'Provider' });
  expect(within(choice).getByRole('button', { name: 'iCloud Mail' })).toHaveAttribute('aria-pressed', 'true');
  expect(document.querySelector('[data-email="provider-step"]')).toHaveTextContent('Sign-In and Security, then App-Specific Passwords');
  fireEvent.click(within(choice).getByRole('button', { name: 'Other' }));
  expect(field('smtp-server')).toHaveValue('');
  fireEvent.change(field('smtp-server'), { target: { value: 'mail.example.org' } });
  fireEvent.change(field('smtp-port'), { target: { value: '465' } });
  expect(within(choice).getByRole('button', { name: 'Other' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('Port 465 is encrypted from the start (TLS).')).toBeInTheDocument();
  // Typing a provider's server is choosing it.
  fireEvent.change(field('smtp-server'), { target: { value: 'smtp.gmail.com' } });
  expect(within(choice).getByRole('button', { name: 'Gmail' })).toHaveAttribute('aria-pressed', 'true');
});

test('a refused test shows the engine’s reason', async () => {
  const reason = 'The test email was not sent. The server refused the sign-in (535 5.7.8 Username and Password not accepted).';
  mount({ ...EMPTY, smtp_server: 'smtp.gmail.com', smtp_port: '587' }, () => Promise.reject(new EngineError(400, 'HTTP 400', reason)));
  fireEvent.click(await screen.findByRole('button', { name: 'Send a Test Email' }));
  expect(await screen.findByText(reason)).toBeInTheDocument();
});

test('providers are told apart by their server, and every port is described', () => {
  expect(providerOf('')).toBeNull();
  expect(providerOf(' SMTP.Gmail.com ')).toBe('gmail');
  expect(providerOf('smtp.mail.me.com')).toBe('icloud');
  expect(providerOf('smtp-mail.outlook.com')).toBe('other');
  expect(PROVIDERS.map((p) => p.id)).toEqual(['gmail', 'icloud', 'other']);
  expect(securityWords('')).toBe('Port 587 starts plain and is encrypted with STARTTLS before anything is sent.');
  expect(securityWords('70000')).toBe('A port is a whole number from 1 to 65,535.');
});
