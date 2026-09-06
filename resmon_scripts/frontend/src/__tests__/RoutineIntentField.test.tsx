/**
 * The routine editor's *intent* field — R1's renderer half.
 *
 * `routines.intent` shipped as a column in 1.9a and the coverage audit has read
 * it since 1.9b, but nothing could write one, so every audit in the field fell
 * back to the routine's keywords and compared a query against results that query
 * produced. The panel said so honestly and the reading was still circular.
 *
 * **The property: what is typed here is what the request body carries.** jsdom is
 * the wrong boundary to establish that it reaches the column — `test_routine_intent.py`
 * does that over HTTP against a real database, and `e2e/routine-intent.spec.ts`
 * does the whole path in a real window. What jsdom is the right boundary for is
 * this: the field exists, it hydrates from an existing routine, and its value is
 * in the body of both the create and the update call.
 *
 * The copy is asserted too, and deliberately: it is the sentence that tells a
 * user what leaving the box empty costs them, and it is the first thing a tidy-up
 * would delete.
 */

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import RoutineEditModal from '../components/Routines/RoutineEditModal';
import { callsTo, mockRoutedFetch, renderWithProviders } from './testUtils';

const ROUTES = {
  '/api/repositories/catalog': [],
  '/api/credentials': {},
  '/api/configurations': [],
  '/api/routines': { id: 9, name: 'n' },
  '/api/routines/7': {},
};

const TARGET = {
  id: 7,
  name: 'Morning arXiv sweep',
  schedule_cron: '0 8 * * *',
  intent: 'methods for irregular time series in astronomy',
  ai_enabled: 0,
  email_enabled: 0,
  email_ai_summary_enabled: 0,
  notify_on_complete: 0,
  parameters: JSON.stringify({ keywords: ['diffusion'], repositories: ['arxiv'] }),
};

function bodyOf(mock: jest.Mock, path: string, method: string): any {
  const call = callsTo(mock, path).find(
    (c) => (c.init?.method || 'GET').toUpperCase() === method,
  );
  return call ? JSON.parse(String(call.init?.body)) : undefined;
}

test('the editor offers an intent field, and says what leaving it blank costs',
  async () => {
    mockRoutedFetch(ROUTES);
    await renderWithProviders(
      <RoutineEditModal open target={null} onClose={() => {}} />,
    );

    expect(screen.getByLabelText(/What this routine is really looking for/i))
      .toBeInTheDocument();
    const hint = screen.getByTestId('routine-intent-hint').textContent || '';
    expect(hint).toContain('coverage audit');
    // The fallback is named as a fallback, not presented as equivalent.
    expect(hint).toContain('falls back to the keywords');
    expect(hint).toContain('circular');
  });

test('an existing routine hydrates its stored intent into the field', async () => {
  mockRoutedFetch(ROUTES);
  await renderWithProviders(
    <RoutineEditModal open target={TARGET} onClose={() => {}} />,
  );
  expect((screen.getByLabelText(/What this routine is really looking for/i) as
    HTMLTextAreaElement).value).toBe('methods for irregular time series in astronomy');
});

test('what is typed is what the create request carries', async () => {
  const mock = mockRoutedFetch(ROUTES);
  await renderWithProviders(
    <RoutineEditModal open target={null} onClose={() => {}} />,
  );

  // The name input has no `htmlFor` on its label, so it is reached through the
  // label's own field wrapper rather than by accessible name.
  const nameInput = screen.getByText('Routine Name')
    .parentElement!.querySelector('input') as HTMLInputElement;
  fireEvent.change(nameInput, { target: { value: 'New routine' } });
  fireEvent.change(screen.getByLabelText(/What this routine is really looking for/i), {
    target: { value: '  cardiac regeneration in adult mammals  ' },
  });
  fireEvent.click(screen.getByText('Create'));

  await waitFor(() => {
    expect(bodyOf(mock, '/api/routines', 'POST')?.intent)
      .toBe('cardiac regeneration in adult mammals');
  });
});

test('an edited intent is what the update request carries', async () => {
  const mock = mockRoutedFetch(ROUTES);
  await renderWithProviders(
    <RoutineEditModal open target={TARGET} onClose={() => {}} />,
  );

  fireEvent.change(screen.getByLabelText(/What this routine is really looking for/i), {
    target: { value: 'something else entirely' },
  });
  fireEvent.click(screen.getByText('Update'));

  await waitFor(() => {
    expect(bodyOf(mock, '/api/routines/7', 'PUT')?.intent).toBe('something else entirely');
  });
});

test('clearing the field sends a clear rather than omitting the key', async () => {
  /**
   * The backend distinguishes "not sent" from "sent empty" — an inline toggle
   * PUTs one flag and must not erase an intent it never knew about. So an editor
   * that dropped the key on a cleared box would leave the old sentence in place
   * and show an empty field beside an audit still comparing against it.
   */
  const mock = mockRoutedFetch(ROUTES);
  await renderWithProviders(
    <RoutineEditModal open target={TARGET} onClose={() => {}} />,
  );

  fireEvent.change(screen.getByLabelText(/What this routine is really looking for/i), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByText('Update'));

  await waitFor(() => {
    const body = bodyOf(mock, '/api/routines/7', 'PUT');
    expect(body).toBeDefined();
    expect('intent' in body).toBe(true);
    expect(body.intent).toBe('');
  });
});
