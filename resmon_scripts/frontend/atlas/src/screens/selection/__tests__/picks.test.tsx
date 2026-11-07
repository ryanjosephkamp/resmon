import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { PickBox, SelectBar, useRowKeys } from '../SelectBar';
import { every, flip, has, isEmpty, none, pickedIn, selectedWords, sizeOf, spread, usePicks } from '../picks';
import { saveLabel, saveQuestion, saveRefusal, savedWords, undoneWords, SAVE_MOST } from '../../library/saveToRead';

describe('what a selection holds', () => {
  test('rows picked one by one, and let go', () => {
    let picks = none<number>();
    picks = flip(picks, 3);
    picks = flip(picks, 5);
    expect(has(picks, 3) && has(picks, 5) && !has(picks, 4)).toBe(true);
    picks = flip(picks, 3);
    expect(sizeOf(picks, 100)).toBe(1);
    expect(pickedIn(picks, [9, 5, 3])).toEqual([5]);
  });

  test('Select all is every row of the list, read or not, less the ones taken out again', () => {
    let picks = every<number>();
    expect(sizeOf(picks, 12_000)).toBe(12_000);
    expect(has(picks, 11_999)).toBe(true);
    picks = flip(picks, 7);
    expect(has(picks, 7)).toBe(false);
    expect(sizeOf(picks, 12_000)).toBe(11_999);
    expect(sizeOf(picks, null)).toBeNull();
    picks = flip(picks, 7);
    expect(sizeOf(picks, 12_000)).toBe(12_000);
    expect(isEmpty(none<number>(), 10)).toBe(true);
    expect(isEmpty(every<number>(), 0)).toBe(true);
  });

  test('a Shift-pick picks every row from the last one picked to this one, either way, and leaves the rest', () => {
    const order = [10, 11, 12, 13, 14, 15];
    let picks = flip(none<number>(), 15);
    picks = spread(picks, order, 11, 13);
    expect(pickedIn(picks, order)).toEqual([11, 12, 13, 15]);
    picks = spread(none<number>(), order, 14, 12);
    expect(pickedIn(picks, order)).toEqual([12, 13, 14]);
    // With no row to spread from, the row alone.
    expect(pickedIn(spread(none<number>(), order, null, 12), order)).toEqual([12]);
    // Over every row, a range puts back the rows taken out.
    let all = flip(flip(every<number>(), 12), 13);
    all = spread(all, order, 11, 14);
    expect(sizeOf(all, 6)).toBe(6);
  });

  test('the bar says how many of how many', () => {
    expect(selectedWords(3, 1204)).toBe('3 of 1,204 selected');
    expect(selectedWords(1204, 1204)).toBe('All 1,204 selected');
    expect(selectedWords(2, null)).toBe('2 selected');
    expect(selectedWords(0, 12)).toBe('0 of 12 selected');
  });
});

/** A list as the screens draw one in select mode: a box per row, the arrows over them, and the bar. */
function List({ ids, total }: { ids: number[]; total: number }) {
  const picks = usePicks<number>(ids, 'list');
  const [done, setDone] = useState(false);
  const { attach, onKeyDown: rowKeys } = useRowKeys({
    count: ids.length, onAll: picks.selectAll,
    onRange: (to, from) => picks.pick(ids[to]!, true, ids[from]),
  });
  const n = sizeOf(picks.picks, total);
  return (
    <>
      {!done && (
        <SelectBar label="The selected papers" said={selectedWords(n, total)} tick="part"
          allLabel={`Select all ${total} papers`} onAll={picks.selectAll} onDone={() => setDone(true)}>
          <span data-testid="picked">{pickedIn(picks.picks, ids).join(',')}</span>
        </SelectBar>
      )}
      <ol ref={attach} onKeyDown={rowKeys}>
        {ids.map((id, index) => (
          <li key={id}>
            <PickBox picked={has(picks.picks, id)} label={`Select paper ${id}`} index={index} onPick={(range) => picks.pick(id, range)} />
          </li>
        ))}
      </ol>
    </>
  );
}

describe('picking in a list', () => {
  const box = (id: number) => screen.getByRole('checkbox', { name: `Select paper ${id}` });
  const said = () => screen.getByRole('group', { name: 'The selected papers' }).textContent;

  test('a click picks a row, and Shift-click every row back to the last one picked', () => {
    render(<List ids={[1, 2, 3, 4, 5, 6]} total={6} />);
    fireEvent.click(box(2));
    expect(box(2)).toBeChecked();
    fireEvent.click(box(5), { shiftKey: true });
    expect(screen.getByTestId('picked')).toHaveTextContent('2,3,4,5');
    expect(said()).toContain('4 of 6 selected');
    fireEvent.click(box(3));
    expect(screen.getByTestId('picked')).toHaveTextContent('2,4,5');
  });

  test('Space picks, Shift+Space picks a range, the arrows move, and Shift with an arrow picks as it goes', () => {
    render(<List ids={[1, 2, 3, 4, 5, 6]} total={6} />);
    box(1).focus();
    fireEvent.keyDown(box(1), { key: ' ' });
    expect(box(1)).toBeChecked();
    fireEvent.keyDown(box(1), { key: 'ArrowDown' });
    expect(box(2)).toHaveFocus();
    fireEvent.keyDown(box(2), { key: 'ArrowDown' });
    fireEvent.keyDown(box(3), { key: ' ', shiftKey: true });
    expect(screen.getByTestId('picked')).toHaveTextContent('1,2,3');
    fireEvent.keyDown(box(3), { key: 'ArrowDown', shiftKey: true });
    expect(box(4)).toHaveFocus();
    expect(screen.getByTestId('picked')).toHaveTextContent('1,2,3,4');
    fireEvent.keyDown(box(4), { key: 'End' });
    expect(box(6)).toHaveFocus();
    fireEvent.keyDown(box(6), { key: 'ArrowDown' });
    expect(box(6)).toHaveFocus();
    fireEvent.keyDown(box(6), { key: 'Home' });
    expect(box(1)).toHaveFocus();
    fireEvent.keyDown(box(1), { key: 'ArrowUp' });
    expect(box(1)).toHaveFocus();
  });

  test('Shift and an arrow from a row with nothing picked yet picks both rows', () => {
    render(<List ids={[1, 2, 3, 4]} total={4} />);
    box(2).focus();
    fireEvent.keyDown(box(2), { key: 'ArrowDown', shiftKey: true });
    expect(screen.getByTestId('picked')).toHaveTextContent('2,3');
  });

  test('Select all, from the bar or ⌘A, is every row the list counts, not the rows drawn', () => {
    render(<List ids={[1, 2, 3]} total={12_000} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all 12000 papers' }));
    expect(said()).toContain('All 12,000 selected');
    fireEvent.click(box(2));
    expect(said()).toContain('11,999 of 12,000 selected');
    expect(screen.getByTestId('picked')).toHaveTextContent('1,3');
    box(1).focus();
    fireEvent.keyDown(box(1), { key: 'a', metaKey: true });
    expect(said()).toContain('All 12,000 selected');
  });

  test('Esc is Done, unless something else took the key', () => {
    render(<List ids={[1, 2]} total={2} />);
    const taken = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    taken.preventDefault();
    act(() => { document.dispatchEvent(taken); });
    expect(screen.queryByRole('group', { name: 'The selected papers' })).toBeInTheDocument();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(screen.queryByRole('group', { name: 'The selected papers' })).not.toBeInTheDocument();
  });

  test('a new list lets go of what was picked', () => {
    function Scoped({ scope }: { scope: string }) {
      const picks = usePicks<number>([1, 2], scope);
      return (
        <>
          <button type="button" onClick={() => picks.pick(1, false)}>pick</button>
          <span data-testid="n">{sizeOf(picks.picks, 2)}</span>
        </>
      );
    }
    const { rerender } = render(<Scoped scope="a" />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    expect(screen.getByTestId('n')).toHaveTextContent('1');
    rerender(<Scoped scope="b" />);
    expect(screen.getByTestId('n')).toHaveTextContent('0');
  });
});

describe('what a save of many says', () => {
  test('the notice, in the voice of the Library’s import line', () => {
    expect(savedWords({ saved: 12, already: 3, missing: 0 })).toBe('12 papers saved to read. 3 were already in your reading queue.');
    expect(savedWords({ saved: 1, already: 0, missing: 0 })).toBe('1 paper saved to read. None was already in your reading queue.');
    expect(savedWords({ saved: 0, already: 1, missing: 0 })).toBe('No papers saved to read. 1 was already in your reading queue.');
    expect(savedWords({ saved: 2, already: 0, missing: 1 }))
      .toBe('2 papers saved to read. None was already in your reading queue. 1 is no longer in your collection.');
  });

  test('an Undo that left some says so, and one that took back all says nothing more', () => {
    expect(undoneWords({ removed: 12, kept: 3 }, 12)).toBeNull();
    expect(undoneWords({ removed: 11, kept: 4 }, 12))
      .toBe('Took 11 papers back out. 1 stays: it was marked read or saved again after this save.');
  });

  test('the button, its limit, and the question past 200', () => {
    expect(saveLabel(3, false)).toBe('Save 3 to read');
    expect(saveLabel(12_000, true)).toBe('Save all 12,000 to read');
    expect(saveRefusal(3)).toBeNull();
    expect(saveRefusal(SAVE_MOST + 1)).toContain('at most 20,000 papers at once');
    expect(saveRefusal(null)).toContain('not all counted');
    expect(saveQuestion('all 12,000 matches')).toMatch(/^Save all 12,000 matches to read\? .*stays as it is, read or not\. For 10 seconds after, Undo takes back the ones this adds\.$/);
  });
});
