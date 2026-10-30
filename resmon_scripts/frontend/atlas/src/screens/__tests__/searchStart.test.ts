import { ASK_PATH, KINDS, startSearch } from '../searchStart';

describe('a new Deep Dive or Deep Sweep goes to Ask the sources', () => {
  test('from another screen, as a new page with that kind asked for', () => {
    expect(startSearch('dive', { pathname: '/today', state: { saved: { id: 3 } } })).toEqual({
      to: ASK_PATH, options: { replace: false, state: { start: 'dive' } },
    });
  });

  test('on Ask the sources, the same page replaced, keeping the saved search the form was opened from', () => {
    const saved = { id: 3, name: 'Films' };
    expect(startSearch('sweep', { pathname: ASK_PATH, state: { saved, start: 'dive' } })).toEqual({
      to: ASK_PATH, options: { replace: true, state: { saved, start: 'sweep' } },
    });
    expect(startSearch('sweep', { pathname: ASK_PATH, state: null }).options.state).toEqual({ start: 'sweep' });
  });

  test('the two kinds, each with its shortcut', () => {
    expect(KINDS.map((k) => [k.kind, k.name, k.shortcut])).toEqual([
      ['dive', 'Deep Dive', 'new-dive'], ['sweep', 'Deep Sweep', 'new-sweep'],
    ]);
  });
});
