import { number } from '../today/format';

/**
 * Jump to: the newest order started at a month of publication. The month is
 * held in the address as `at=YYYY-MM`, beside the words and the filters, so
 * Back finds the list where it was left. It is not a filter: the count above
 * the list is still every match, and the engine says how many were published
 * after the month (`newer_count`), which the list starts below.
 */
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTH_WORDS = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The month jumped to, from the address, or null when there is none or it is not a month. */
export function readJump(params: URLSearchParams): string | null {
  const at = params.get('at');
  return at && MONTH.test(at) ? at : null;
}

/** The address with the month set, or taken off for an empty or unreadable one. */
export function withJump(params: URLSearchParams, month: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (MONTH.test(month)) next.set('at', month); else next.delete('at');
  return next;
}

/**
 * The last day of a month, as the engine compares dates: the jump starts at
 * the newest paper published on or before it, so a paper of any day of the
 * month, or one dated only by the month, is in.
 */
export function monthEnd(month: string): string {
  const [, year, mm] = MONTH.exec(month) ?? [];
  const days = new Date(Date.UTC(Number(year), Number(mm), 0)).getUTCDate();
  return `${year}-${mm}-${String(days).padStart(2, '0')}`;
}

/** "March 2024", for a `YYYY-MM` or a `YYYY-MM-DD`. */
export function monthWords(at: string): string {
  const [year, mm] = at.split('-');
  return MONTH_WORDS.format(new Date(Date.UTC(Number(year), Number(mm) - 1, 1)));
}

/** Said above a list that starts at a month: where it starts, and how many matches come before it. */
export function jumpWords(page: { newer_count?: number | null; newer_count_is_exact?: boolean | null }, at: string): string {
  const newer = page.newer_count ?? 0;
  const from = `Listed from ${monthWords(at)} back.`;
  if (newer === 0 && page.newer_count_is_exact !== false) return `${from} No match was published after it.`;
  const counted = page.newer_count_is_exact === false ? `At least ${number(newer)}` : number(newer);
  return `${from} ${counted} newer ${newer === 1 ? 'match comes' : 'matches come'} before it in the newest order.`;
}
