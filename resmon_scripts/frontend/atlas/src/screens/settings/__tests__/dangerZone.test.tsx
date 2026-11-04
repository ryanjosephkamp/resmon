/**
 * The Danger zone names what each action erases in the app's own words: a
 * saved search, a source's API key, a watch, a run. Its routes keep their names.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { DangerZone } from '../DangerZone';

test('each action is named as the app names what it erases, never by the engine\'s identifiers', () => {
  const { container } = render(<QueryClientProvider client={new QueryClient()}><DangerZone /></QueryClientProvider>);
  expect(screen.getByText('Erase all source API keys')).toBeInTheDocument();
  expect(screen.getByText('Erase all saved searches')).toBeInTheDocument();
  expect(screen.getByText('Erase run history')).toBeInTheDocument();
  expect(screen.getByText('Erase all run data')).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/\b(configs?|repo|routines?|executions?)\b/i);
});
