import { readOrder, withOrder } from '../order';
import { withJump } from '../jump';

describe("Search's order in the address", () => {
  test('a ranking by meaning is held as order=similarity beside the words and the filters', () => {
    const ranked = withOrder(new URLSearchParams('q=perovskite&source=arxiv'), 'similarity');
    expect(ranked.toString()).toBe('q=perovskite&source=arxiv&order=similarity');
    expect(readOrder(ranked)).toBe('similarity');
  });

  test('the newest order, which is the default, is the address without the parameter', () => {
    const ranked = new URLSearchParams('q=perovskite&order=similarity');
    expect(withOrder(ranked, 'newest').toString()).toBe('q=perovskite');
    expect(readOrder(new URLSearchParams('q=perovskite'))).toBe('newest');
  });

  test('a name that is not an order falls back to the newest', () => {
    expect(readOrder(new URLSearchParams('order=oldest'))).toBe('newest');
    expect(readOrder(new URLSearchParams('order='))).toBe('newest');
  });

  test('a jump keeps the order, and the order keeps the jump', () => {
    const jumped = withJump(new URLSearchParams('q=a&order=similarity'), '2026-03');
    expect(readOrder(jumped)).toBe('similarity');
    expect(withOrder(jumped, 'newest').get('at')).toBe('2026-03');
  });
});
