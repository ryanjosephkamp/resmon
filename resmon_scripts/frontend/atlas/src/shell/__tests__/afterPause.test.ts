import { afterPause } from '../history';

describe('a pause that ends by writing the address', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    window.history.replaceState(null, '', '/index.html#/search?q=graph');
  });
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    jest.useRealTimers();
  });

  test('settles once its time has passed on the same page, whatever the search became', () => {
    const settle = jest.fn();
    afterPause(350, settle);
    window.history.replaceState(null, '', '/index.html#/search?q=graph&source=arxiv');
    jest.advanceTimersByTime(349);
    expect(settle).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  test('does not settle once the window has gone to another page', () => {
    const settle = jest.fn();
    afterPause(350, settle);
    window.history.pushState(null, '', '/index.html#/papers/7');
    jest.advanceTimersByTime(350);
    expect(settle).not.toHaveBeenCalled();
  });

  test('does not settle once it is cancelled', () => {
    const settle = jest.fn();
    afterPause(350, settle)();
    jest.advanceTimersByTime(350);
    expect(settle).not.toHaveBeenCalled();
  });
});
