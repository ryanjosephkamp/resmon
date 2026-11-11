/**
 * The run log: every run that has started, newest first, a page at a time,
 * narrowed to searches, watches' runs, or failed runs, and found by its
 * words. The engine counts what matches (`X-Resmon-Total`), so the log says
 * how many there are without reading them all.
 *
 * It is not read on a timer. It is read when it is opened, when the window
 * comes back to the front, and when a run starts, ends, or joins or leaves
 * the queue (`activeSignature`), which the shared active-runs read notices
 * every two seconds while anything runs. Reading every loaded page every two
 * seconds while a run went, as the log once did, read a thousand runs to
 * learn that one had ended.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { dayWord, number } from '../today/format';
import { againAt, RATE_LIMITED, storedInstant, type RunRow } from './model';

/** Under the runs key, so whatever invalidates the runs reads the log again too. */
export const HISTORY_KEY = ['runs', 'history'] as const;

/** How many runs the log reads at a time. */
export const HISTORY_PAGE = 50;

/** How long a page of the log read is taken as current when nothing has said it changed. */
const HISTORY_FRESH_MS = 30_000;

export type RunFilter = 'all' | 'searches' | 'watches' | 'failed';

export const FILTERS: readonly { id: RunFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'searches', label: 'Searches' },
  { id: 'watches', label: 'Watches' },
  { id: 'failed', label: 'Failed' },
];

/** The engine's filter for each: a search is a Deep Dive, a Deep Sweep, or a find, asked by hand. */
export function filterQuery(filter: RunFilter): { type?: string; status?: string } {
  switch (filter) {
    case 'searches': return { type: 'deep_dive,deep_sweep,find_paper' };
    case 'watches': return { type: 'automated_sweep' };
    case 'failed': return { status: 'failed' };
    default: return {};
  }
}

/** One page of the log, and how many runs match in all. */
export interface HistoryPage {
  runs: RunRow[];
  total: number | null;
}

/** A page of runs, with the engine's count of how many match. */
export async function readHistory(
  query: { type?: string; status?: string; q?: string },
  offset: number,
  limit = HISTORY_PAGE,
): Promise<HistoryPage> {
  const call = engine().GET('/api/executions', {
    params: { query: { limit, offset, omit_events: true, ...query } },
  });
  const runs = await answer(call);
  const said = (await call).response.headers.get('X-Resmon-Total');
  const total = said !== null && /^\d+$/.test(said) ? Number(said) : null;
  return { runs, total };
}

export function useRunHistory(filter: RunFilter, words: string) {
  const query = { ...filterQuery(filter), ...(words ? { q: words } : {}) };
  return useInfiniteQuery({
    queryKey: [...HISTORY_KEY, filter, words],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => readHistory(query, pageParam),
    getNextPageParam: (last, all) => {
      const read = all.reduce((n, page) => n + page.runs.length, 0);
      if (last.total !== null) return read < last.total ? read : undefined;
      return last.runs.length === HISTORY_PAGE ? read : undefined;
    },
    // Fresh until something says otherwise: a filter chosen again within half a minute shows what it
    // read, rather than reading every page it holds once more. A run starting or ending invalidates it.
    staleTime: HISTORY_FRESH_MS,
    refetchOnWindowFocus: true,
  });
}

/** The runs a log's pages hold, each once: a run that started between two reads can sit at the edge of two. */
export function listedRuns(pages: readonly HistoryPage[] | undefined): RunRow[] {
  const seen = new Set<number>();
  return (pages ?? []).flatMap((page) => page.runs).filter((run) => !seen.has(run.id) && seen.add(run.id) !== undefined);
}

/** The runs in groups by the day they started, in the reader's zone, against a clock that turns at midnight. */
export function byDay(runs: readonly RunRow[], now: Date): { day: string; runs: RunRow[] }[] {
  const out: { day: string; runs: RunRow[] }[] = [];
  for (const run of runs) {
    const at = storedInstant(run.start_time);
    const day = at ? dayWord(at, now) : 'Date not recorded';
    const last = out[out.length - 1];
    if (last && last.day === day) last.runs.push(run);
    else out.push({ day, runs: [run] });
  }
  return out;
}

/**
 * How many of a run's sources answered, and how many of the rest refused on
 * rate, with when to try again where a source said and it is still ahead:
 * "2 of 4 sources answered, 1 rate-limited (try again after about 3:40 PM)".
 * A rate-limited source is up and asked resmon to wait, which is not the
 * failure a bare count of answers would leave it as.
 */
export function answeredWords(coverage: RunRow['coverage'], now: Date = new Date()): string {
  const { answered, in_part: inPart } = coverage.counts;
  const total = coverage.total;
  if (!total) return 'no source outcome recorded';
  const limited = (coverage.sources ?? []).filter((s) => s.category === 'non_answer' && s.rate_limited);
  const latest = limited.map((s) => s.cooldown_until_utc ?? '').sort().pop();
  const at = againAt(latest || null, now);
  const rate = limited.length ? `, ${limited.length} ${RATE_LIMITED}${at ? ` (try again after about ${at})` : ''}` : '';
  return `${answered} of ${total} ${total === 1 ? 'source' : 'sources'} answered${inPart ? ` (${inPart} in part)` : ''}${rate}`;
}

/** A run's one line of what happened, from what the engine recorded. */
export function runSummary(run: RunRow, now: Date = new Date()): string {
  const { non_answer: nonAnswer } = run.coverage.counts;
  const asked = answeredWords(run.coverage, now);
  switch (run.status) {
    case 'running':
      return 'running';
    case 'completed': {
      const found = run.total_results ?? run.result_count;
      const fresh = run.new_results ?? run.new_result_count;
      const papers = found === null || found === undefined ? 'papers not recorded'
        : `${number(found)} found${fresh === null || fresh === undefined ? '' : `, ${number(fresh)} new`}`;
      return `${asked} · ${papers}`;
    }
    case 'failed':
      return nonAnswer ? `failed · ${asked}` : `failed · ${run.error_message || asked}`;
    default:
      return `${run.status === 'cancelled' ? 'canceled' : run.status} · ${asked}`;
  }
}

/** "1,024 runs", "1 run", or nothing while the count is not known. */
export function totalWords(total: number | null | undefined): string {
  if (total === null || total === undefined) return '';
  return `${number(total)} ${total === 1 ? 'run' : 'runs'}`;
}
