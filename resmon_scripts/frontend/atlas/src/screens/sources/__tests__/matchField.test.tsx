import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TermsField, useTerms } from '../SourceCatalog';
import type { Match } from '../terms';

jest.mock('../../../collections/current', () => ({ ...jest.requireActual('../../../collections/current'), useCollection: () => ({ id: null }) }));

function Field({ initial }: { initial: string[] }) {
  const state = useTerms(initial);
  const [match, setMatch] = useState<Match>('any');
  return <><TermsField id="terms" label="Search terms" state={state} match={{ value: match, onChange: setMatch }} /><p data-testid="match">{match}</p></>;
}

function mount(initial: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Field initial={initial} /></QueryClientProvider>);
}

test('Match sits under the terms: Any Term is pressed first, and All Terms takes over when pressed', () => {
  mount(['splats', 'gaussian splatting']);
  const group = screen.getByRole('group', { name: 'Match' });
  const any = within(group).getByRole('button', { name: 'Any Term' });
  const all = within(group).getByRole('button', { name: 'All Terms' });
  expect(any).toHaveAttribute('aria-pressed', 'true');
  expect(all).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByText('A paper with any one of the terms is kept.')).toBeInTheDocument();
  fireEvent.click(all);
  expect(screen.getByTestId('match')).toHaveTextContent('all');
  expect(all).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('A paper must have every term.')).toBeInTheDocument();
  // The switch follows the box, before anything the field draws under it.
  expect(screen.getByRole('textbox', { name: 'Search terms' }).compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('with one term the switch says the two ask the same', () => {
  mount(['splats']);
  expect(screen.getByText('With one term, Any and All ask the same.')).toBeInTheDocument();
});
