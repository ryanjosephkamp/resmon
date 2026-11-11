/**
 * The Danger Zone names what each action erases in the app's own words: a
 * saved search, a source's API key, a watch, a run. Its routes keep their names.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { DangerZone } from '../DangerZone';

test('each action is named as the app names what it erases, never by the engine\'s identifiers', () => {
  const { container } = render(<QueryClientProvider client={new QueryClient()}><DangerZone /></QueryClientProvider>);
  expect(screen.getByText('Erase All Source API Keys')).toBeInTheDocument();
  expect(screen.getByText('Erase All Saved Searches')).toBeInTheDocument();
  expect(screen.getByText('Erase Run History')).toBeInTheDocument();
  expect(screen.getByText('Erase All Run Data')).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/\b(configs?|repo|routines?|executions?)\b/i);
});

test.each([
  'Erase All Saved Searches', 'Erase Run History', 'Erase the Paper Corpus', 'Erase All Run Data',
  'Erase All App Data', 'Reset All Settings', 'Factory Reset',
])('%s warns before confirmation that the database copy is deleted with the data', (name) => {
  render(<QueryClientProvider client={new QueryClient()}><DangerZone /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name }));
  const confirmation = screen.getByRole('group', { name: `Confirm: ${name}` });
  expect(confirmation.textContent).toMatch(/copy[^.]*before (?:its last|an) update[^.]*deleted[^.]*\./i);
  expect(confirmation.textContent).not.toMatch(/copy[^.]*stays/i);
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
});

test.each(['Erase All AI API Keys', 'Erase All Source API Keys'])(
  '%s explains that the database copy stays because keys are in the keychain', (name) => {
    render(<QueryClientProvider client={new QueryClient()}><DangerZone /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name }));
    const confirmation = screen.getByRole('group', { name: `Confirm: ${name}` });
    expect(confirmation.textContent).toMatch(/copy[^.]*before an update[^.]*stays[^.]*keychain[^.]*\./i);
    expect(confirmation.textContent).not.toMatch(/copy[^.]*deleted/i);
  },
);
