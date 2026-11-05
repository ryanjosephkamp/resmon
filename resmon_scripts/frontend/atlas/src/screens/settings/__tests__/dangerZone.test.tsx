/**
 * The Danger zone names what each action erases in the app's own words: a
 * saved search, a source's API key, a watch, a run. Its routes keep their names.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { DangerZone } from '../DangerZone';

test('each action is named as the app names what it erases, never by the engine\'s identifiers', () => {
  const { container } = render(<QueryClientProvider client={new QueryClient()}><DangerZone /></QueryClientProvider>);
  expect(screen.getByText('Erase all source API keys')).toBeInTheDocument();
  expect(screen.getByText('Erase all saved searches')).toBeInTheDocument();
  expect(screen.getByText('Erase run history')).toBeInTheDocument();
  expect(screen.getByText('Erase all run data')).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/\b(configs?|repo|routines?|executions?)\b/i);
});

test('every action that erases the papers says the copy kept before an update goes with them, and only those', () => {
  const { container } = render(<QueryClientProvider client={new QueryClient()}><DangerZone /></QueryClientProvider>);
  const says = (id: string) => {
    const row = container.querySelector(`[data-danger="${id}"]`)!;
    fireEvent.click(row.querySelector('button')!);
    return row.querySelector('form')!.textContent ?? '';
  };
  const copy = 'The copy of your database that resmon kept before its last update is deleted too, because it holds these papers.';
  for (const id of ['corpus', 'app_data', 'factory']) expect(says(id)).toContain(copy);
  for (const id of ['ai_keys', 'repo_keys', 'configs', 'executions', 'execution_data', 'reset_settings']) {
    expect(says(id)).not.toContain('kept before its last update');
  }
});
