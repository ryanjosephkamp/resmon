import { render, screen } from '@testing-library/react';
import { CoverageSummary } from '../CoverageSummary';

const lead = '25 selected sources: 17 answered (2 in part), 8 recorded non-answers (could not answer), 0 unknown.';
const first = 'bioRxiv answered in part: resmon read the newest 660 of the 1,824 records bioRxiv lists for the window, posted between October 29, 2026 and October 31, 2026, and stopped when its own time budget for the search ran out; the older ones were not read.';
const second = 'PubMed answered in part: resmon read 500 records, and stopped at the run’s cap; the older ones were not read.';

test('keeps every word, with one lead and a separate paragraph per source, setting off figures and dates', () => {
  const summary = `${lead} ${first} ${second} 1 answered with retained partial results.`;
  const { container } = render(<CoverageSummary summary={summary} names={['bioRxiv', 'PubMed']} />);
  const paragraphs = [...container.querySelectorAll('p')];
  expect(paragraphs.map((p) => p.textContent)).toEqual([lead, first, second, '1 answered with retained partial results.']);
  expect(paragraphs.map((p) => p.textContent).join(' ')).toBe(summary);
  expect(screen.getByText('660', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getByText('1,824', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getByText('October 29, 2026', { selector: 'strong' })).toBeInTheDocument();
  expect(container.querySelector('table, ul, ol')).toBeNull();
});

test('an unfamiliar summary is kept whole', () => {
  const summary = 'No source outcomes were recorded; the full selected set is unknown.';
  const { container } = render(<CoverageSummary summary={summary} names={[]} />);
  expect(container.querySelectorAll('p')).toHaveLength(1);
  expect(container).toHaveTextContent(summary);
});

test('a stopped source has its own paragraph with the engine’s counts', () => {
  const summary = '2 selected sources: 1 answered, 1 recorded non-answer (1 stopped by you), 0 unknown. PLOS was stopped by you; 12 records kept, 3 requests sent, and 0 retries. It did not finish answering.';
  const { container } = render(<CoverageSummary summary={summary} names={['PLOS']} />);
  const paragraphs = container.querySelectorAll('p');
  expect(paragraphs).toHaveLength(2);
  expect(paragraphs[1]).toHaveTextContent('PLOS was stopped by you; 12 records kept, 3 requests sent, and 0 retries.');
});
