/**
 * A routine whose window moves with each run (`parameters.date_window`, set in
 * Atlas's watch editor) keeps it through a save in this editor.
 *
 * This editor builds `parameters` from its own fields and has no control for
 * the window, so before it held the key a save here quietly turned a watch
 * asking for papers since its previous run into one with no date limit. The
 * property: the key goes back as stored while both date fields are empty, and
 * typing a date chooses fixed dates instead, which the engine refuses beside a
 * window.
 */

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import RoutineEditModal from '../components/Routines/RoutineEditModal';
import { callsTo, mockRoutedFetch, renderWithProviders } from './testUtils';

const ROUTES = {
  '/api/repositories/catalog': [],
  '/api/credentials': {},
  '/api/configurations': [],
  '/api/routines/7': {},
};

const TARGET = {
  id: 7,
  name: 'Graphs since the last run',
  schedule_cron: '0 8 * * *',
  ai_enabled: 0, email_enabled: 0, email_ai_summary_enabled: 0, notify_on_complete: 0,
  parameters: JSON.stringify({
    keywords: ['graph'], repositories: ['arxiv'], date_from: '', date_to: '',
    date_window: { since: 'previous_run' },
  }),
};

function putBody(mock: jest.Mock): { parameters?: Record<string, unknown> } | undefined {
  const call = callsTo(mock, '/api/routines/7').find((c) => (c.init?.method || 'GET').toUpperCase() === 'PUT');
  return call ? JSON.parse(String(call.init?.body)) as { parameters?: Record<string, unknown> } : undefined;
}

test('a save with no dates typed keeps the window, and the form says what it is', async () => {
  const mock = mockRoutedFetch(ROUTES);
  await renderWithProviders(<RoutineEditModal open target={TARGET} onClose={() => {}} />);
  expect(screen.getByTestId('kept-date-window').textContent)
    .toBe('Each run asks for papers published since the previous run. Typing dates here replaces that with fixed dates.');
  fireEvent.click(screen.getByText('Update'));
  await waitFor(() => {
    expect(putBody(mock)?.parameters).toMatchObject({ date_window: { since: 'previous_run' }, date_from: '', date_to: '' });
  });
});

test('a date typed here chooses fixed dates, and the window is not sent beside it', async () => {
  const mock = mockRoutedFetch(ROUTES);
  await renderWithProviders(<RoutineEditModal open target={TARGET} onClose={() => {}} />);
  const from = document.querySelector('input[type="date"]') as HTMLInputElement;
  fireEvent.change(from, { target: { value: '2026-10-01' } });
  expect(screen.queryByTestId('kept-date-window')).toBeNull();
  fireEvent.click(screen.getByText('Update'));
  await waitFor(() => {
    expect(putBody(mock)?.parameters).toMatchObject({ date_from: '2026-10-01' });
  });
  expect(putBody(mock)?.parameters).not.toHaveProperty('date_window');
});

test('a routine with no window is sent without one', async () => {
  const mock = mockRoutedFetch(ROUTES);
  const plain = { ...TARGET, parameters: JSON.stringify({ keywords: ['graph'], repositories: ['arxiv'] }) };
  await renderWithProviders(<RoutineEditModal open target={plain} onClose={() => {}} />);
  expect(screen.queryByTestId('kept-date-window')).toBeNull();
  fireEvent.click(screen.getByText('Update'));
  await waitFor(() => { expect(putBody(mock)).toBeDefined(); });
  expect(putBody(mock)?.parameters).not.toHaveProperty('date_window');
});
