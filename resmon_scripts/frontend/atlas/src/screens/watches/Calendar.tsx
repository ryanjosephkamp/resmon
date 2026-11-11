import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { firingNotice } from './firing';
import { MonthAhead, useCalendar } from './MonthAhead';
import { FiringNote, useSchedulerStatus } from './Watches';
import { WatchTabs } from './WatchTabs';
import { WATCHES_KEY } from './model';

/**
 * Watches › Calendar: the month ahead, given the page. Every fire a watching
 * watch's schedule promises over five weeks from the start of this one, each
 * named with its time, and the next few listed after.
 *
 * Whether anything will run them is the scheduler status's answer, as on the
 * list: the note at the top says why some will not, and their marks are faint.
 */
export function Calendar() {
  const [now] = useState(() => new Date());
  const routines = useQuery({ queryKey: WATCHES_KEY, queryFn: () => answer(engine().GET('/api/routines')) });
  const calendar = useCalendar(now);
  const status = useSchedulerStatus();
  const list = useMemo(() => routines.data ?? [], [routines.data]);
  const [lit, setLit] = useState<number | null>(null);
  const notice = status.data ? firingNotice(status.data) : null;

  return (
    <div className="page watch-calendar" aria-busy={routines.isFetching || calendar.isFetching}>
      <WatchTabs />
      <h1 className="page-title">Calendar</h1>
      {notice && <FiringNote notice={notice} />}
      {routines.isError && <p className="index-cap">Your watches could not be read ({routines.error.message}).</p>}
      <MonthAhead now={now} events={calendar.data ?? null} error={calendar.error} routines={list} lit={lit}
        status={status.data} onLight={setLit} />
    </div>
  );
}
