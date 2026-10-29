import { count, number } from '../today/format';

/**
 * What a capped count does not say, said beside it: where the search stops
 * counting (`explorer.COUNT_CAP`), and, for the whole collection unfiltered,
 * how many papers it holds, which is a plain count of every record and not
 * a search. Null when the count is exact.
 */
export function capWords(page: { total_is_capped: boolean; count_cap: number }, holds: number | null): string | null {
  if (!page.total_is_capped) return null;
  const stops = `Search stops counting at ${number(page.count_cap)}`;
  return holds !== null && holds > page.count_cap
    ? `${stops}; your collection holds ${count(holds, 'paper')} in all.`
    : `${stops}.`;
}
