import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { clock, when } from '../today/format';
import { CALENDAR_KEY, type CalendarEvent, type RoutineRow } from './model';

/** Five weeks, from the Sunday of this one. */
const WEEKS = 5;
/** Marks drawn in one day before the rest are counted instead. */
const PER_DAY = 8;

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

/**
 * The month ahead: every promised fire as a mark on its day, in this
 * computer's time, which is the zone the scheduler fires in. The watch under
 * the pointer lights its own marks. Past days of this week are drawn quiet,
 * with no fires: the calendar promises only fires still to come.
 */
export function MonthAhead({ now, events, routines, lit }: {
  now: Date; events: readonly CalendarEvent[] | null; routines: readonly RoutineRow[]; lit: number | null;
}) {
  const names = useMemo(() => new Map(routines.map((r) => [r.id, r.name])), [routines]);
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

  return (
    <section className="month-ahead" aria-label="The month ahead" data-state={events === null ? 'reading' : 'read'}>
      <h2 className="ahead-title">The month ahead</h2>
      <p className="ahead-lede">
        When each watch will run, in this computer&rsquo;s time. A paused watch runs only when you ask it to.
      </p>
      {events === null && <p className="index-cap">Reading the calendar.</p>}
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
                {list.slice(0, PER_DAY).map((fire) => (
                  <i
                    key={String(fire.id)}
                    className="fire"
                    data-routine={fire.routine_id ?? undefined}
                    data-at={fire.start}
                    data-lit={fire.routine_id === lit ? 'true' : undefined}
                    title={`${nameOf(fire)} at ${clock(fire.start)}`}
                    aria-label={`${nameOf(fire)} at ${clock(fire.start)}`}
                  />
                ))}
                {list.length > PER_DAY && <span className="fire-more num">+{list.length - PER_DAY}</span>}
              </span>
            </div>
          );
        })}
      </div>
      <h3 className="ahead-sub">Next</h3>
      {events !== null && !fires.length && (
        <p className="index-empty">No fires are promised: every watch is paused, or there are none.</p>
      )}
      <ol className="next-fires">
        {fires.slice(0, 6).map((fire) => (
          <li key={String(fire.id)} data-routine={fire.routine_id ?? undefined}>
            <span className="next-when">{when(fire.start, now)}</span>
            <Link to={`/watches/${fire.routine_id}`} className="it">{nameOf(fire)}</Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
