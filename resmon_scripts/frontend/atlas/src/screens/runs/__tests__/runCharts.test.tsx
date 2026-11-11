/**
 * The run screens' marks in the charts' tip: a running run's source marks
 * (the Runs tab and the run monitor's panel), which open the run and are one
 * keyboard stop; a finished run's recorded outcome; the bar of sources
 * finished; a running run's orbit; the run monitor's mark; and the embedding
 * backfill's bar. A mark on the run's own page opens nothing, and its tip
 * offers nothing.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { meterTip } from '../../settings/embeddingWords';
import { SourceMarks } from '../ActiveList';
import { LivePanel } from '../LivePanel';
import type { LiveSource } from '../model';
import { finishedTip, liveTip, monitorTip, orbitTip, recordedTip } from '../runTips';

if (!('PointerEvent' in window)) {
  class PointerEventShim extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventShim, configurable: true });
}

const source = (slug: string, state: LiveSource['state'], count: number | null = null, note = ''): LiveSource =>
  ({ slug, state, count, reason: null, note });
const SOURCES = [source('arxiv', 'answered', 1204), source('crossref', 'asking'), source('core', 'pending')];
const nameOf = (slug: string) => ({ arxiv: 'arXiv', crossref: 'Crossref', core: 'CORE' } as Record<string, string>)[slug] ?? slug;

describe('what each run mark says', () => {
  test('a source in a running run: its state as the run reports it, and the way to the run', () => {
    expect(liveTip(SOURCES[0]!, 'arXiv', 41)).toEqual({ name: 'arXiv', value: '1,204 found', notes: undefined, opens: 'Opens run 41' });
    // On the run's own page the mark opens nothing, and says nothing of opening.
    expect(liveTip(SOURCES[1]!, 'Crossref').opens).toBeNull();
  });

  test('a finished run\'s recorded outcome, its count whole, or said not recorded', () => {
    expect(recordedTip({ label: 'answered', result_count: 12408, note: 'arXiv returned 12,408 records.' }, 'arXiv')).toEqual({
      name: 'arXiv', value: 'answered', lines: [{ value: '12,408', label: 'records returned' }],
      notes: ['arXiv returned 12,408 records.'],
    });
    expect(recordedTip({ label: 'failed', result_count: null, note: '' }, 'CORE').lines).toEqual([
      { value: 'Not recorded', label: 'records returned' },
    ]);
  });

  test('the bar of sources finished names the ones being asked and the ones not asked yet', () => {
    expect(finishedTip(SOURCES, nameOf)).toEqual({
      name: 'Sources finished', value: '1 of 3 sources',
      lines: [
        { value: '1', label: 'being asked: Crossref', key: 'accent' },
        { value: '1', label: 'not asked yet: CORE' },
      ],
      notes: ['Finished is asked and done, whatever each answered.'],
    });
  });

  test('an orbit, and the monitor\'s mark: each running run\'s sources finished, and the panel it opens', () => {
    expect(orbitTip('Perovskite films', SOURCES, true)).toEqual({
      name: 'Perovskite films', value: '1 of 3 sources finished', notes: ['No word from this run for 15 seconds or more.'],
    });
    const tip = monitorTip([{ title: 'Perovskite films', sources: SOURCES, stalled: false }], 2, 1);
    expect(tip).toEqual({
      name: 'Runs', value: '1 running',
      lines: [{ value: '1 of 3', label: 'Perovskite films', key: 'accent' }],
      notes: ['Sources finished in each running run.', '2 runs waiting.', '1 run failed since the panel was last opened.'],
      opens: 'Opens the Runs panel',
    });
    expect(monitorTip([], 0, 0)).toMatchObject({ value: 'Nothing running', lines: [], notes: [] });
  });

  test('the embedding backfill\'s bar: the papers embedded so far, whole, and with what', () => {
    const run = { running: true, processed: 1204, total: 5000, model: 'nomic-embed-text', skipped_no_text: 3 } as Parameters<typeof meterTip>[0];
    expect(meterTip(run)).toEqual({
      name: 'Embedding with nomic-embed-text', value: '1,204 of 5,000 papers',
      notes: ['The papers that had no vector when the backfill started.', '3 papers so far had no title or abstract to embed.'],
    });
  });
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

test('a running run\'s source marks open the run, are one keyboard stop, and say each source\'s state', () => {
  render(
    <MemoryRouter initialEntries={['/runs']}>
      <Routes>
        <Route path="/runs" element={<SourceMarks runId={41} sources={SOURCES} nameOf={nameOf} />} />
        <Route path="/runs/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  const marks = within(screen.getByRole('list', { name: 'Its sources' })).getAllByRole('link');
  expect(marks.map((m) => m.getAttribute('href'))).toEqual(['/runs/41', '/runs/41', '/runs/41']);
  expect(marks.map((m) => m.tabIndex)).toEqual([0, -1, -1]);
  expect(marks[0]).toHaveAccessibleName('arXiv: 1,204 found. Opens run 41.');
  act(() => marks[0]!.focus());
  fireEvent.keyDown(marks[0]!, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(marks[1]);
  expect(screen.getByRole('tooltip').querySelector('.chart-tip-value')?.textContent).toBe('asking');
  fireEvent.click(marks[1]!);
  expect(screen.getByTestId('where')).toHaveTextContent('/runs/41');
});

test('on the run\'s own page a source\'s mark shows its tip to the pointer and opens nothing', () => {
  render(<LivePanel sources={SOURCES} names={new Map([['arxiv', 'arXiv']])} now={0} />);
  const mark = document.querySelector<HTMLElement>('li[data-source="arxiv"] .live-mark')!;
  expect(mark.closest('a')).toBeNull();
  fireEvent.pointerEnter(mark, { clientX: 20, clientY: 20 });
  const tip = screen.getByRole('tooltip');
  expect(tip.querySelector('.chart-tip-value')?.textContent).toBe('1,204 found');
  expect(tip.querySelector('.chart-tip-opens')).toBeNull();
});

test.each(['asking', 'pending'] as const)('a %s source list in a chart tip names its final source with and', (state) => {
  const tip = finishedTip(['arxiv', 'crossref', 'core'].map((slug) => source(slug, state)), nameOf);
  expect(tip.lines?.[0]?.label).toBe(`${state === 'asking' ? 'being asked' : 'not asked yet'}: arXiv, Crossref, and CORE`);
});
