import React, { useState, useEffect, useCallback, useRef } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { apiClient } from '../api/client';
import { useExecution } from '../context/ExecutionContext';
import PageHelp from '../components/Help/PageHelp';

interface CalendarEvent {
  id: string | number;
  title: string;
  start: string;
  end?: string;
  color: string;
  routine_id?: number;
  execution_id?: number;
  type?: string;
  status?: string;
  query?: string;
  total_results?: number | null;
  new_results?: number | null;
}

interface Routine {
  id: number;
  name: string;
  is_active: number | boolean;
}

interface PopoverData {
  event: CalendarEvent;
  x: number;
  y: number;
}

const CalendarPage: React.FC = () => {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [visibleRoutines, setVisibleRoutines] = useState<Set<number>>(new Set());
  const [popover, setPopover] = useState<PopoverData | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [routineDropdownOpen, setRoutineDropdownOpen] = useState(false);
  const calendarRef = useRef<FullCalendar>(null);

  const fetchData = useCallback(async () => {
    try {
      const [evts, rts] = await Promise.all([
        apiClient.get<CalendarEvent[]>('/api/calendar/events'),
        apiClient.get<Routine[]>('/api/routines'),
      ]);
      setEvents(evts);
      setRoutines(rts);
      setVisibleRoutines(new Set(rts.map((r) => r.id)));
    } catch {
      /* calendar renders empty on error */
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Re-fetch the calendar whenever a new execution is dispatched anywhere
  // in the app (manual dive/sweep POSTs, reconnected in-flight runs, and
  // any routine fires the ExecutionContext discovers) so the newly
  // "running" marker appears without a manual refresh. The completion
  // listener covers the other end of the lifecycle so rows flip from
  // ``running`` to ``completed`` / ``failed`` / ``cancelled`` in place.
  useEffect(() => {
    const handler = () => { fetchData(); };
    window.addEventListener('resmon:execution-started', handler);
    window.addEventListener('resmon:execution-completed', handler);
    return () => {
      window.removeEventListener('resmon:execution-started', handler);
      window.removeEventListener('resmon:execution-completed', handler);
    };
  }, [fetchData]);

  // Map a calendar event's type into the same three-bucket taxonomy used by
  // the Type filter. Any event carrying a ``routine_id`` is classified as
  // "routine" regardless of its raw execution_type (routine runs reuse the
  // ``deep_dive``/``deep_sweep`` labels from the sweep engine).
  const bucketOf = (e: CalendarEvent): 'deep_dive' | 'deep_sweep' | 'routine' | 'other' => {
    if (e.routine_id) return 'routine';
    if (e.type === 'deep_dive' || e.type === 'dive') return 'deep_dive';
    if (e.type === 'deep_sweep' || e.type === 'sweep') return 'deep_sweep';
    return 'other';
  };

  const filteredEvents = events.filter((e) => {
    if (e.routine_id && !visibleRoutines.has(e.routine_id)) return false;
    if (typeFilter && bucketOf(e) !== typeFilter) return false;
    if (statusFilter && e.status !== statusFilter) return false;
    return true;
  });

  const toggleRoutineVisibility = (id: number) => {
    setVisibleRoutines((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllRoutines = () => setVisibleRoutines(new Set(routines.map((r) => r.id)));
  const selectNoRoutines = () => setVisibleRoutines(new Set());

  const handleEventClick = (info: any) => {
    // Prevent the parent click handler from immediately closing the popover.
    if (info.jsEvent) info.jsEvent.stopPropagation();
    const rect = info.el.getBoundingClientRect();
    const evt = info.event;
    const extProps = evt.extendedProps || {};
    const newId = evt.id;
    // If clicking the already-open event, toggle it closed.
    if (popover && String(popover.event.id) === String(newId)) {
      setPopover(null);
      return;
    }
    setPopover({
      event: {
        id: evt.id,
        title: evt.title,
        start: evt.startStr,
        color: evt.backgroundColor,
        routine_id: extProps.routine_id,
        execution_id: extProps.execution_id,
        type: extProps.type,
        status: extProps.status,
        query: extProps.query,
        total_results: extProps.total_results,
        new_results: extProps.new_results,
      },
      x: rect.left + rect.width / 2,
      y: rect.bottom + 4,
    });
  };

  const closePopover = () => {
    setPopover(null);
    setRoutineDropdownOpen(false);
  };

  const handleToggleActive = async () => {
    if (!popover?.event.routine_id) return;
    const r = routines.find((rt) => rt.id === popover.event.routine_id);
    if (!r) return;
    const action = r.is_active ? 'deactivate' : 'activate';
    try {
      await apiClient.post(`/api/routines/${r.id}/${action}`);
      fetchData();
      closePopover();
    } catch { /* silent */ }
  };

  return (
    <div className="page-content" onClick={closePopover}>
      <div className="page-header">
        <h1>Calendar</h1>
      </div>

      <PageHelp
        storageKey="calendar"
        title="Calendar"
        summary="Visualize past executions and upcoming routine fires in time."
        sections={[
          {
            heading: 'What you see here',
            body: (
              <ul>
                <li><strong>Past executions</strong> appear on the day they completed, colored by type (Deep Dive, Deep Sweep, Routine).</li>
                <li><strong>Upcoming routine fires</strong> appear in the scheduled-orange palette, up to the configured lookahead window.</li>
              </ul>
            ),
          },
          {
            heading: 'How to use it',
            body: (
              <ul>
                <li>Click any event to open a popover with its details, result counts, and a link to the full report.</li>
                <li>Use the <strong>Type</strong> and <strong>Status</strong> filters to narrow the view.</li>
                <li>Use the <strong>Routines</strong> dropdown to hide or show individual routines' events.</li>
                <li>From the popover you can activate or deactivate the originating routine without leaving the page.</li>
              </ul>
            ),
          },
        ]}
      />

      {routines.length > 0 && (
        <div className="calendar-filters">
          <select
            className="form-select"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="">All Types</option>
            <option value="deep_dive">Deep Dive</option>
            <option value="deep_sweep">Deep Sweep</option>
            <option value="routine">Routine</option>
          </select>
          <select
            className="form-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All Statuses</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="running">Running</option>
            <option value="cancelled">Cancelled</option>
            <option value="scheduled">Scheduled</option>
          </select>

          <div
            className="multiselect"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => setRoutineDropdownOpen((v) => !v)}
            >
              Routines: {visibleRoutines.size} of {routines.length} ▾
            </button>
            {routineDropdownOpen && (
              <div className="multiselect-panel">
                <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={selectAllRoutines}
                  >All</button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={selectNoRoutines}
                  >None</button>
                </div>
                {routines.map((r) => (
                  <label key={r.id} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={visibleRoutines.has(r.id)}
                      onChange={() => toggleRoutineVisibility(r.id)}
                    />
                    <span>{r.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="calendar-wrapper">
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay',
          }}
          events={filteredEvents.map((e) => {
            const bucket = bucketOf(e);
            const classNames =
              bucket === 'deep_dive' ? ['calendar-type-dive'] :
              bucket === 'deep_sweep' ? ['calendar-type-sweep'] :
              bucket === 'routine' ? ['calendar-type-routine'] : [];
            return {
              id: String(e.id),
              title: e.title,
              start: e.start,
              end: e.end,
              color: e.color,
              classNames,
              extendedProps: {
                routine_id: e.routine_id,
                execution_id: e.execution_id,
                type: e.type,
                status: e.status,
                query: e.query,
                total_results: e.total_results,
                new_results: e.new_results,
              },
            };
          })}
          eventClick={handleEventClick}
          height="auto"
          editable={false}
          selectable={false}
        />
      </div>

      {popover && (
        <div
          className="event-popover"
          style={{ left: popover.x, top: popover.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="event-popover-head">
            <h4>{popover.event.title}</h4>
            <button
              type="button"
              className="event-popover-close"
              onClick={closePopover}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="event-popover-meta">
            <div><span className="text-muted">Start:</span> {popover.event.start?.replace('T', ' ').slice(0, 16)}</div>
            {popover.event.status && (
              <div>
                <span className="text-muted">Status:</span>{' '}
                <span className={`badge ${
                  popover.event.status === 'completed' ? 'badge-success' :
                  popover.event.status === 'failed' ? 'badge-error' :
                  popover.event.status === 'cancelled' ? 'badge-cancelled' :
                  popover.event.status === 'scheduled' ? 'badge-scheduled' :
                  popover.event.status === 'running' ? 'badge-info' : 'badge-info'
                }`}>{popover.event.status}</span>
              </div>
            )}
            {popover.event.query && (
              <div className="ellipsis-cell">
                <span className="text-muted">Query:</span> {popover.event.query}
              </div>
            )}
            {(popover.event.total_results != null || popover.event.new_results != null) && (
              <div>
                <span className="text-muted">Results:</span>{' '}
                {popover.event.new_results ?? 0} new / {popover.event.total_results ?? 0} total
              </div>
            )}
          </div>

          <div className="popover-actions">
            {popover.event.execution_id && popover.event.status === 'running' && (
              <a
                className="btn btn-sm btn-primary"
                href={`#/monitor?exec=${popover.event.execution_id}`}
                onClick={closePopover}
              >
                Open Monitor
              </a>
            )}
            {popover.event.execution_id && popover.event.status !== 'running' && (
              <a
                className="btn btn-sm btn-primary"
                href={`#/results?exec=${popover.event.execution_id}`}
                onClick={closePopover}
              >
                View Report
              </a>
            )}
            {popover.event.execution_id && (
              <a
                className="btn btn-sm"
                href={`#/results?exec=${popover.event.execution_id}&tab=log`}
                onClick={closePopover}
              >
                View Log
              </a>
            )}
            {popover.event.execution_id && popover.event.status !== 'running' && (
              <a
                className="btn btn-sm"
                href={`#/results?exec=${popover.event.execution_id}&tab=progress`}
                onClick={closePopover}
              >
                Progress History
              </a>
            )}
            {popover.event.routine_id && (
              <>
                <button className="btn btn-sm" onClick={handleToggleActive}>
                  {routines.find((r) => r.id === popover.event.routine_id)?.is_active ? 'Deactivate Routine' : 'Activate Routine'}
                </button>
                <a className="btn btn-sm" href={`#/routines`} onClick={closePopover}>View Routine</a>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default CalendarPage;
