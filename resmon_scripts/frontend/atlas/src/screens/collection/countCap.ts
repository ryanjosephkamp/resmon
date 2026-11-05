import { number } from '../today/format';

/** What a search page says about its count: every match, or how far counting got in its time. */
export interface Counted { total: number; total_is_exact: boolean; count_budget_ms: number }

/** "1.5 seconds", from the engine's budget in milliseconds. */
function seconds(ms: number): string {
  const s = ms / 1000;
  return `${number(s)} ${s === 1 ? 'second' : 'seconds'}`;
}

/**
 * Said beside a count that ran out of time (`explorer.COUNT_BUDGET_S`): when
 * counting stopped, and that the list and the export are not limited by it,
 * which they are not (the list pages to the last match and the export counts
 * every one). Null when the count is exact.
 */
export function stoppedWords(page: Counted): string | null {
  if (page.total_is_exact) return null;
  return `Counting stopped after ${seconds(page.count_budget_ms)}; the list and the export still hold every match.`;
}
