import { SWIPE, feed, type Direction, type Gesture, type Page, type Sample, type Step } from '../swipe';

const open: Page = { canGo: () => true, claimed: () => false };

/** Feeds samples 16 ms apart from `start`, as a trackpad sends them, and returns every step. */
function run(samples: Omit<Sample, 't'>[], page: Page = open, start = 1000, from: Gesture | null = null): Step[] {
  const steps: Step[] = [];
  let gesture = from;
  samples.forEach((sample, index) => {
    const step = feed(gesture, { ...sample, t: start + index * 16 }, page);
    gesture = step.gesture;
    steps.push(step);
  });
  return steps;
}

const sideways = (dx: number, n: number, dy = 0) => Array.from({ length: n }, () => ({ dx, dy }));
const last = (steps: Step[]): Step => steps[steps.length - 1] as Step;
const went = (steps: Step[]) => steps.map((s) => s.go).filter((g): g is Direction => g !== null);

describe('a two-finger swipe goes back or forward once it has travelled far enough', () => {
  test('fingers moving right scroll toward the start, and that is back', () => {
    const steps = run(sideways(-20, 10));
    expect(went(steps)).toEqual(['back']);
    // It goes on the sample that crosses the threshold, not before.
    const at = steps.findIndex((s) => s.go);
    expect(at).toBe(Math.ceil(SWIPE.threshold / 20) - 1);
  });

  test('fingers moving left go forward', () => {
    expect(went(run(sideways(25, 10)))).toEqual(['forward']);
  });

  test('the arrow grows with the travel, at the edge it goes toward', () => {
    const steps = run(sideways(-30, 4));
    expect(steps.map((s) => s.toward)).toEqual(['back', 'back', 'back', 'back']);
    const progress = steps.map((s) => s.progress);
    expect(progress[0]).toBeCloseTo(30 / SWIPE.threshold);
    expect(progress[3]).toBeCloseTo(120 / SWIPE.threshold);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  test('a swipe that turns back before the threshold changes edge, and goes nowhere if it stops there', () => {
    const steps = run([...sideways(-30, 3), ...sideways(30, 4)]);
    expect(went(steps)).toEqual([]);
    expect(last(steps).toward).toBe('forward');
  });
});

describe('one swipe moves one page', () => {
  test('the momentum tail after a swipe goes is spent, however long it runs', () => {
    const tail = Array.from({ length: 60 }, (_, i) => ({ dx: -Math.max(1, 40 - i), dy: 0 }));
    expect(went(run([...sideways(-40, 5), ...tail]))).toEqual(['back']);
  });

  test('a pause ends the gesture, and the next swipe goes again', () => {
    const first = run(sideways(-40, 5));
    const ended = last(first).gesture;
    const second = run(sideways(-40, 5), open, ended.last + SWIPE.quietMs + 1, ended);
    expect(went(first)).toEqual(['back']);
    expect(went(second)).toEqual(['back']);
  });

  test('a short gap inside the tail does not start a new gesture', () => {
    const first = run(sideways(-40, 5));
    const ended = last(first).gesture;
    expect(went(run(sideways(-40, 5), open, ended.last + SWIPE.quietMs - 20, ended))).toEqual([]);
  });
});

describe('slow and irregular delivery', () => {
  test('uneven gaps, and a burst a busy page merged into one sample, still go once', () => {
    // The clock is the event's own, so a page slow to deliver stretches nothing; what varies is the spacing and the size.
    const timed = [[0, -10], [5, -15], [180, -60], [190, -5], [370, -40], [380, -30], [560, -25], [575, -60], [760, -30], [940, -12]];
    let gesture: Gesture | null = null;
    const gone: Direction[] = [];
    for (const [t, dx] of timed) {
      const step = feed(gesture, { dx: dx as number, dy: 0, t: t as number }, open);
      gesture = step.gesture;
      if (step.go) gone.push(step.go);
    }
    expect(gone).toEqual(['back']);
  });

  test('one sample past the threshold on its own goes at once', () => {
    expect(went(run([{ dx: -12, dy: 0 }, { dx: -200, dy: 0 }]))).toEqual(['back']);
  });
});

describe('a swipe that is not the page\'s goes nowhere', () => {
  test('mostly up or down is scrolling', () => {
    expect(went(run(sideways(-12, 30, 20)))).toEqual([]);
    expect(last(run(sideways(-12, 3, 20))).gesture.phase).toBe('ignored');
  });

  test('a scroll that turns sideways after it is judged stays a scroll', () => {
    expect(went(run([...sideways(0, 3, 15), ...sideways(-40, 10)]))).toEqual([]);
  });

  test('a pinch, or a mouse wheel counting lines, is not a swipe', () => {
    expect(went(run(sideways(-40, 10).map((s) => ({ ...s, ctrl: true }))))).toEqual([]);
    expect(went(run(sideways(-40, 10).map((s) => ({ ...s, coarse: true }))))).toEqual([]);
  });

  test('what is under the pointer takes it when it can scroll that way, pans, or is a text field', () => {
    const claimed = jest.fn((direction: Direction) => direction === 'back');
    expect(went(run(sideways(-40, 10), { canGo: () => true, claimed }))).toEqual([]);
    expect(claimed).toHaveBeenCalledWith('back');
    // Asked once, when the swipe is judged; not on every sample.
    expect(claimed).toHaveBeenCalledTimes(1);
    expect(went(run(sideways(40, 10), { canGo: () => true, claimed }))).toEqual(['forward']);
  });

  test('with no page that way, nothing is drawn and nothing happens', () => {
    const steps = run(sideways(-40, 10), { canGo: (d) => d === 'forward', claimed: () => false });
    expect(went(steps)).toEqual([]);
    expect(steps.every((s) => s.progress === 0 && s.toward === null)).toBe(true);
  });

  test('travel too small to judge draws nothing yet', () => {
    const steps = run(sideways(-3, 3));
    expect(steps.every((s) => s.gesture.phase === 'judging' && s.toward === null)).toBe(true);
  });
});
