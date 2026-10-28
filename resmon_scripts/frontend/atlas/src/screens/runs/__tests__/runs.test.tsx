import { render } from '@testing-library/react';
import { Markdown } from '../markdown';
import { interruptedSentence, liveSources, outcomeOf, runTitle, type ProgressEvent } from '../model';

describe("a source's outcome from its count and reason", () => {
  test.each([
    [12, null, 'answered'],
    [0, 'answered_empty', 'answered'],
    [0, 'rights_filtered', 'answered'],
    [0, 'upstream_failure', 'non_answer'],
    [0, 'missing_key', 'non_answer'],
    [0, null, 'unknown'],
    [0, 'not_recorded', 'unknown'],
    // A count that is not a count, or a reason this build does not know, is
    // unknown rather than a guess either way.
    [null, null, 'unknown'],
    [-1, null, 'unknown'],
    [3, 'a_reason_from_the_future', 'unknown'],
    [0, '', 'unknown'],
  ] as const)('%p and %p read as %s', (count, reason, expected) => {
    expect(outcomeOf(count, reason)).toBe(expected);
  });
});

describe('the live panel, folded from the run\'s events', () => {
  const events: ProgressEvent[] = [
    { type: 'execution_start' },
    { type: 'repo_start', repository: 'arxiv' },
    { type: 'repo_done', repository: 'arxiv', result_count: 4, zero_reason: null },
    { type: 'repo_start', repository: 'dblp' },
    { type: 'repo_done', repository: 'dblp', result_count: 0, zero_reason: 'parse_failure', zero_message: 'DBLP answered and resmon could not read the reply.' },
    { type: 'repo_done', repository: 'springer', result_count: 0, zero_reason: 'missing_key', zero_message: 'No API key is configured for Springer Nature.' },
    { type: 'repo_start', repository: 'zenodo' },
  ];

  test('each selected source in its order, at the state its last event left it', () => {
    const live = liveSources(['arxiv', 'dblp', 'springer', 'zenodo', 'core'], events);
    expect(live.map((s) => [s.slug, s.state, s.count])).toEqual([
      ['arxiv', 'answered', 4],
      ['dblp', 'no_answer', 0],
      ['springer', 'not_queried', 0],
      ['zenodo', 'asking', null],
      ['core', 'pending', null],
    ]);
    expect(live[1]?.note).toBe('DBLP answered and resmon could not read the reply.');
    expect(live[2]?.note).toContain('API key');
    expect(live[0]?.note).toBe('');
  });

  test('a source the events name but the selection did not is kept, after the selection', () => {
    const live = liveSources(['arxiv'], [{ type: 'repo_start', repository: 'hal' }]);
    expect(live.map((s) => s.slug)).toEqual(['arxiv', 'hal']);
  });
});

describe('words for a run', () => {
  test('a watch run is called by its watch, a search by its terms', () => {
    expect(runTitle({ query: 'a b', keywords: ['a', 'b'] }, 'Protein structure')).toBe('Protein structure');
    expect(runTitle({ query: 'a b', keywords: ['a', 'b'] })).toBe('a, b');
    expect(runTitle({ query: null, keywords: null })).toBe('A search with no terms recorded');
  });

  test('an interrupted run says why in words, never the stored token', () => {
    const sentence = interruptedSentence({ interrupted_reason: 'owner_dead', last_seen_at_utc: '2026-10-28T09:14:03Z' });
    expect(sentence).toBe('Interrupted: the process running it stopped; last seen working 2026-10-28 09:14 UTC.');
    expect(interruptedSentence({ interrupted_reason: null, last_seen_at_utc: null }))
      .toBe('Interrupted: the reason was not recorded.');
  });
});

describe('the report, as Markdown', () => {
  test('headings, bold, lists, rules and line breaks become elements', () => {
    const { container } = render(<Markdown text={'# resmon Literature Report\n**Generated:** today  \n**Query:** graph\n\n---\n## 2026-10-28\n- **Authors:** Ada\n- **Abstract:** text'} />);
    expect(container.querySelector('h2')?.textContent).toBe('resmon Literature Report');
    expect(container.querySelector('h3')?.textContent).toBe('2026-10-28');
    expect([...container.querySelectorAll('strong')].map((s) => s.textContent)).toEqual(['Generated:', 'Query:', 'Authors:', 'Abstract:']);
    expect(container.querySelectorAll('br')).toHaveLength(1);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('hr')).not.toBeNull();
  });

  test('markup in a title is shown as the characters it is, and only http(s) links are links', () => {
    const { container } = render(<Markdown text={'### <img src=x onerror=alert(1)> [click](javascript:alert(1)) [paper](https://example.org/p)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.org/p']);
    expect(container.textContent).toContain('[click](javascript:alert(1))');
  });
});
