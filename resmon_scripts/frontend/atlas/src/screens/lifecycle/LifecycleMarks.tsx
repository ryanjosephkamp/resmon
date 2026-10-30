import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import {
  LIFECYCLE_FOR, SEVERITY_MEANING, SEVERITY_WORDS, bySeverity, chunks, noticeDay, noticeLabel, paperState,
  provenanceWords, type LifecycleCheckState, type LifecycleEvent,
} from './model';

/**
 * What the engine has recorded against a set of papers, and whether each has
 * been checked: one request for a page of rows, never one a row, and in
 * several only where the list is longer than the engine takes at once.
 */
export function useLifecycleFor(ids: readonly number[]) {
  return useQuery({
    queryKey: [LIFECYCLE_FOR, ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const parts = await Promise.all(chunks(ids).map((part) => answer(
        engine().POST('/api/lifecycle/for-documents', { body: { document_ids: part } }),
      )));
      const events: Record<string, LifecycleEvent[]> = {};
      const checked: Record<string, LifecycleCheckState> = {};
      for (const part of parts) {
        Object.assign(events, part.events);
        Object.assign(checked, part.checked);
      }
      return { events, checked };
    },
  });
}

/**
 * The notices recorded against one paper, most serious first: its severity in
 * words, the notice's own label as the link to it, its date, and who
 * registered it. On a paper's own page (`full`) the service's note too. A
 * paper with nothing recorded draws nothing here; its own page says whether
 * that is because it was checked.
 */
export function LifecycleMarks({ events, full = false }: { events?: readonly LifecycleEvent[]; full?: boolean }) {
  if (!events?.length) return null;
  return (
    <ul className={full ? 'life-marks full' : 'life-marks'} data-lifecycle="marks">
      {bySeverity(events).map((event) => {
        const day = noticeDay(event.notice_date);
        const from = provenanceWords(event);
        return (
          <li key={`${event.kind}:${event.notice_key}`} className="life-mark" data-severity={event.severity} data-kind={event.kind}>
            <span className="life-severity" title={SEVERITY_MEANING[event.severity]}>{SEVERITY_WORDS[event.severity]}</span>
            {/* The label is the service's wording; the engine stores no event without this link. */}
            <a className="life-notice" href={event.notice_url} target="_blank" rel="noreferrer">{noticeLabel(event)}</a>
            {day && <span className="life-day">{day}</span>}
            {from && <span className="life-from">{from}</span>}
            {full && event.detail && <p className="life-detail">{event.detail}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** A list's marks could not be read: said once, so a row without one is not taken for a clean paper. */
export function LifecycleUnread({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p className="rank-note" role="status" data-lifecycle="unread">
      Whether these papers were retracted or changed could not be read ({error.message}).
    </p>
  );
}

/**
 * One paper's record, on its own page: every notice in full, or, with none,
 * whether it was checked and how that check ended, so silence is never left to
 * be read as a clean result.
 */
export function PaperLifecycle({ id }: { id: number }) {
  const ids = useMemo(() => [id], [id]);
  const state = useLifecycleFor(ids);
  const [now] = useState(() => new Date());
  const events = state.data?.events[String(id)] ?? [];
  const check = state.data?.checked[String(id)] ?? null;
  const shown = !state.data ? 'reading' : events.length ? 'events' : check ? check.status : 'unchecked';
  return (
    <section className="paper-section life" aria-label="Retractions and updates" data-lifecycle="paper" data-state={shown}>
      <h2>Retractions and updates</h2>
      {state.isPending && <p className="record-cap">Reading what has been recorded against it.</p>}
      {state.isError && (
        <p className="record-cap">Whether it has been retracted or changed could not be read ({state.error.message}).</p>
      )}
      {state.data && (events.length > 0 ? <LifecycleMarks events={events} full /> : (
        <p className="life-quiet">
          {paperState(events, check, now)}
          {!check && <>{' '}<Link to="/health/watchdog">Check from the Watchdog</Link>.</>}
        </p>
      ))}
    </section>
  );
}
