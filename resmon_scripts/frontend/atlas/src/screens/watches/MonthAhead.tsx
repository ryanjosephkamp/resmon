import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { useChartTip, type TipContent } from '../../charts/ChartTip';
import { joined } from '../../charts/roving';
import { breakable } from '../../shell/breakable';
import { clock, listWords, when } from '../today/format';
import { firingOf, firingState, monthAheadLede, type Firing, type SchedulerStatus } from './firing';
import { CALENDAR_KEY, type CalendarEvent, type RoutineRow } from './model';

/** Five weeks, from the Sunday of this one. */
const WEEKS = 5;
/** Fires named in one day before the rest are counted instead. */
const PER_DAY = 5;
/** Fires listed under the month, soonest first. */
const LISTED = 8;

/**
 * The engine's calendar for the weeks the month ahead draws: the runs that
 * happened and the fires each active watch's schedule promises. The window is
 * asked for, so a watch firing every five minutes expands to five weeks of
 * fires rather than a year of them.
 */
export function useCalendar(now: Date) {
  const start = startOfWeek(now);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + WEEKS * 7);
  return useQuery({
    queryKey: [...CALENDAR_KEY, start.toISOString()],
    queryFn: () => answer(engine().GET('/api/calendar/events', {
      params: { query: { start: now.toISOString(), end: end.toISOString() } },
    })),
  });
}

function startOfWeek(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() - at.getDay());
}

function dayKey(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short' });

/** What a mark says of its watch, beyond its name and time. */
function markWords(firing: Firing): string {
  if (firing === false) return ', due; nothing will run it';
  if (firing === null) return ', due; not confirmed to run';
  return '';
}

const FIRE_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

/** A fire's tip: its watch, its day and time in this computer's time, whether anything will run it, and the way to the watch. */
export function fireTip(name: string, start: string, firing: Firing): TipContent {
  return {
    name,
    value: `${FIRE_DAY.format(new Date(start))} at ${clock(start)}`,
    notes: firing === false ? ['Due, but nothing will run it.'] : firing === null ? ['Due, and not confirmed to run.'] : undefined,
    opens: 'Opens the watch',
  };
}

/** The fires a day has past the ones it names: each one's watch and time, in the tip and for a screen reader. */
export function moreTip(rest: readonly { name: string; start: string }[]): TipContent {
  return {
    value: `${rest.length} more ${rest.length === 1 ? 'fire' : 'fires'} this day`,
    lines: rest.map((fire) => ({ value: clock(fire.start), label: fire.name })),
  };
}

/**
 * The month ahead: every fire a schedule is due, as a mark on its day named
 * with its time and its watch, in this computer's time, which is the zone the
 * scheduler fires in. The watch under the pointer, or under the keyboard's
 * focus, lights its own marks, a mark's tip names its watch, its day, and its
 * time, and a mark opens its watch. Past days of this
 * week are drawn quiet, with no fires: the calendar shows only fires still to
 * come.
 *
 * A mark is a run only where something will run it. The opening sentence
 * says "will run" only when every watching watch will, and a watch nothing
 * will run draws faint marks (`status`, from `firing.ts`).
 *
 * The marks are one stop for the keyboard, as a grid is: Tab reaches the
 * first (or the last one used), the arrow keys move through them in time
 * order, and Enter opens the watch.
 */
export function MonthAhead({ now, events, error, routines, lit, status, onLight }: {
  now: Date; events: readonly CalendarEvent[] | null; error?: Error | null; routines: readonly RoutineRow[]; lit: number | null;
  status?: SchedulerStatus; onLight?: (id: number) => void;
}) {
  const names = useMemo(() => new Map(routines.map((r) => [r.id, r.name])), [routines]);
  const activeIds = useMemo(() => routines.filter((r) => r.is_active).map((r) => r.id), [routines]);
  const fires = useMemo(
    () => (events ?? [])
      .filter((e) => e.status === 'scheduled' && e.routine_id !== null)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()),
    [events],
  );
  const byDay = useMemo(() => {
    const out = new Map<string, CalendarEvent[]>();
    for (const fire of fires) {
      const key = dayKey(new Date(fire.start));
      out.set(key, [...(out.get(key) ?? []), fire]);
    }
    return out;
  }, [fires]);
  const first = startOfWeek(now);
  const days = Array.from({ length: WEEKS * 7 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  const today = dayKey(now);
  const nameOf = (fire: CalendarEvent) => names.get(fire.routine_id ?? -1) ?? `Watch ${fire.routine_id}`;
  const allFire = !!status && activeIds.every((id) => firingOf(status, id) === true);

  // The marks drawn, in time order, for the arrow keys.
  const drawn = days.flatMap((day) => (byDay.get(dayKey(day)) ?? []).slice(0, PER_DAY));
  const order = new Map(drawn.map((fire, index) => [fire, index]));
  const [focusAt, setFocusAt] = useState(0);
  const tip = useChartTip();
  const marks = useRef<(HTMLAnchorElement | null)[]>([]);
  const current = Math.min(focusAt, Math.max(0, drawn.length - 1));
  const move = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    const keys: Record<string, number> = {
      ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: drawn.length - 1,
    };
    const to = keys[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(drawn.length - 1, to));
    setFocusAt(next);
    marks.current[next]?.focus();
  };

  return (
    <section className="month-ahead" aria-label="The month ahead"
      data-state={events !== null ? 'read' : error ? 'failed' : 'reading'}>
      <p className="ahead-lede">{monthAheadLede(status, activeIds)}</p>
      {events === null && !error && <p className="index-cap">Reading the calendar.</p>}
      {events === null && error && <p className="index-cap" role="alert">The calendar could not be read ({error.message}).</p>}
      <div className="ahead-grid" role="grid" aria-label="Fires by day">
        {WEEKDAYS.map((d) => <span key={d} className="ahead-dow" role="columnheader">{d}</span>)}
        {days.map((day) => {
          const key = dayKey(day);
          const list = byDay.get(key) ?? [];
          const past = day.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
          return (
            <div key={key} role="gridcell" className="ahead-day" data-past={past ? 'true' : undefined}
              data-today={key === today ? 'true' : undefined}>
              <span className="ahead-date num">
                {day.getDate() === 1 || day.getTime() === first.getTime() ? `${MONTH.format(day)} ` : ''}{day.getDate()}
              </span>
              <span className="ahead-fires">
                {list.slice(0, PER_DAY).map((fire) => {
                  const index = order.get(fire) ?? 0;
                  const firing = firingOf(status, fire.routine_id ?? -1);
                  const words = `${nameOf(fire)} at ${clock(fire.start)}${markWords(firing)}`;
                  return (
                    <Link
                      key={String(fire.id)}
                      to={`/watches/${fire.routine_id}`}
                      className="fire-mark"
                      ref={(node) => { marks.current[index] = node; }}
                      tabIndex={index === current ? 0 : -1}
                      aria-label={`${words}. Open the watch`}
                      data-firing={firingState(firing)}
                      data-lit={fire.routine_id === lit ? 'true' : undefined}
                      onKeyDown={(event) => move(event, index)}
                      onMouseEnter={() => { if (fire.routine_id !== null) onLight?.(fire.routine_id); }}
                      {...joined({
                        onFocus: () => { setFocusAt(index); if (fire.routine_id !== null) onLight?.(fire.routine_id); },
                      }, tip.mark(fireTip(nameOf(fire), fire.start, firing)))}
                    >
                      <i
                        className="fire"
                        data-routine={fire.routine_id ?? undefined}
                        data-at={fire.start}
                        data-firing={firingState(firing)}
                        data-lit={fire.routine_id === lit ? 'true' : undefined}
                      />
                      <span className="fire-time num" aria-hidden="true">{clock(fire.start)}</span>
                      <span className="fire-name" aria-hidden="true">{breakable(nameOf(fire))}</span>
                    </Link>
                  );
                })}
                {list.length > PER_DAY && (
                  <span className="fire-more num" {...tip.mark(moreTip(list.slice(PER_DAY).map((fire) => ({ name: nameOf(fire), start: fire.start }))))}>
                    {list.length - PER_DAY} more
                    <span className="sr-only">
                      : {listWords(list.slice(PER_DAY).map((fire) => `${nameOf(fire)} at ${clock(fire.start)}`))}
                    </span>
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <h2 className="ahead-sub">{allFire ? 'Next' : 'Next Due'}</h2>
      {events !== null && !fires.length && (
        <p className="index-empty">Nothing is due: every watch is paused, or there are none.</p>
      )}
      {tip.layer}
      <ol className="next-fires">
        {fires.slice(0, LISTED).map((fire) => {
          const firing = firingOf(status, fire.routine_id ?? -1);
          return (
            <li key={String(fire.id)} data-routine={fire.routine_id ?? undefined} data-firing={firingState(firing)}
              onMouseEnter={() => { if (fire.routine_id !== null) onLight?.(fire.routine_id); }}>
              <span className="next-when">{when(fire.start, now)}</span>
              <Link to={`/watches/${fire.routine_id}`} className="it">{breakable(nameOf(fire))}</Link>
              {firing === false && <span className="next-doubt">nothing will run it</span>}
              {firing === null && <span className="next-doubt">not confirmed to run</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
