import { lastPageOffset, pageRange, pageToRead, QUEUE_PAGE, selectedOnPage } from '../queueModel';

const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ document_id: i + 1 }));

test('a page is the most the engine answers in one request', () => {
  // reading_queue.MAX_PAGE_SIZE: a larger limit is refused with a 400.
  expect(QUEUE_PAGE).toBe(200);
});

test('the range says which rows are on screen, and nothing over an empty page', () => {
  expect(pageRange(0, 200, 230)).toBe('Papers 1–200 of 230');
  expect(pageRange(200, 30, 230)).toBe('Papers 201–230 of 230');
  expect(pageRange(1000, 1, 1201)).toBe('Papers 1,001–1,001 of 1,201');
  expect(pageRange(200, 0, 200)).toBeNull();
});

test('where the last page begins', () => {
  expect(lastPageOffset(0)).toBe(0);
  expect(lastPageOffset(200)).toBe(0);
  expect(lastPageOffset(201)).toBe(200);
  expect(lastPageOffset(400)).toBe(200);
  expect(lastPageOffset(401)).toBe(400);
});

describe('a page that stopped existing', () => {
  test('the last paper taken off the last page moves the queue to the page before', () => {
    // 201 papers, the one on page two removed: the engine answers offset 200 with nothing, of 200.
    expect(pageToRead({ offset: 200, total: 200, entries: [] })).toBe(0);
    expect(pageToRead({ offset: 400, total: 250, entries: [] })).toBe(200);
  });

  test('a page with rows, the first page, and an empty queue stay where they are', () => {
    expect(pageToRead({ offset: 200, total: 230, entries: entries(30) })).toBeNull();
    expect(pageToRead({ offset: 0, total: 0, entries: [] })).toBeNull();
    expect(pageToRead({ offset: 0, total: 5, entries: [] })).toBeNull();
  });
});

test('an export takes the ticked papers that are still on the page', () => {
  // Ticked 2 and 9; 9 was marked read and left the To read page.
  expect(selectedOnPage([2, 9], entries(5))).toEqual([2]);
  expect(selectedOnPage([], entries(5))).toEqual([]);
  expect(selectedOnPage([3, 1], entries(5))).toEqual([3, 1]);
});
