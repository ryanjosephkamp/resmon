import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import { apiClient } from '../api/client';
import { useExecution } from '../context/ExecutionContext';
import PageHelp from '../components/Help/PageHelp';
import RoutineEditModal from '../components/Routines/RoutineEditModal';
import SaveConfigButton from '../components/SaveConfig/SaveConfigButton';
import { useRoutinesVersion } from '../lib/routinesBus';
import { useConfigurationsVersion } from '../lib/configurationsBus';

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
  // Update 3 / 4_27_26: surfaced from the backend LEFT JOIN so the
  // popover can render a "Saved as <name>" indicator above the Save
  // Config button on manual-execution events.
  saved_configuration_id?: number | null;
  saved_configuration_name?: string | null;
}

interface Routine {
  id: number;
  name: string;
  is_active: number | boolean;
  schedule_cron?: string;
  // Extra fields needed to hydrate the shared edit modal when the user
  // clicks ``Edit Routine`` from the calendar popover. They are present
  // on every row returned by ``GET /api/routines`` but optional here so
  // that any consumer that constructs a ``Routine`` ad-hoc still type-
  // checks.
  email_enabled?: number | boolean;
  email_ai_summary_enabled?: number | boolean;
  ai_enabled?: number | boolean;
  notify_on_complete?: number | boolean;
  parameters?: string | Record<string, any>;
  ai_settings?: string | Record<string, any> | null;
  execution_location?: 'local' | 'cloud';
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
  const [pastHorizon, setPastHorizon] = useState(false);
  // Edit Routine popover button → opens the shared RoutineEditModal so
  // the user can edit a routine without leaving the calendar. Saves
  // broadcast on both the routines and configurations buses, so the
  // Routines page and Configurations page refetch automatically.
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Routine | null>(null);
  const routinesVersion = useRoutinesVersion();
  // Update 3 / 4_27_26 follow-up: refetch when any SaveConfigButton (or other
  // mutation site) broadcasts on the configurations bus, so the popover's
  // "Saved as <name>" badge updates without a manual refresh.
  const configurationsVersion = useConfigurationsVersion();
  const calendarRef = useRef<FullCalendar>(null);
  // Update 3 / 4_27_26 follow-up: clamp the popover within the viewport so
  // events near the bottom or right edge of the calendar don't render off-
  // screen (the page's body region clips them and the popover is fixed-
  // positioned, so the user can't scroll to reach it).
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [evts, rts] = await Promise.all([
        apiClient.get<CalendarEvent[]>('/api/calendar/events'),
        apiClient.get<Routine[]>('/api/routines'),
      ]);
      setEvents(evts);
      setRoutines(rts);
      // Only active routines are eligible for the visibility dropdown:
      // inactive routines do not contribute scheduled events to the
      // calendar, so listing them in ``Routines: x of y`` would be
      // misleading. Deactivating a routine via the popover triggers a
      // re-fetch which removes it from the dropdown automatically.
      const activeIds = rts.filter((r) => !!r.is_active).map((r) => r.id);
      setVisibleRoutines(new Set(activeIds));
    } catch {
      /* calendar renders empty on error */
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData, routinesVersion, configurationsVersion]);

  // Update 3 / 4_27_26 follow-up: when events refetch (e.g., after a
  // SaveConfigButton broadcast), re-sync the open popover's event copy
  // from the refreshed events list so the "Saved as <name>" badge and
  // "Save Again" relabel appear without closing the popover.
  useEffect(() => {
    if (!popover) return;
    const fresh = events.find((e) => String(e.id) === String(popover.event.id));
    if (!fresh) return;
    if (
      fresh.saved_configuration_id === popover.event.saved_configuration_id &&
      fresh.saved_configuration_name === popover.event.saved_configuration_name
    ) {
      return;
    }
    setPopover({ ...popover, event: { ...popover.event, ...fresh } });
  }, [events, popover]);

  // Update 3 / 4_27_26 follow-up: after the popover renders (or its
  // contents change), measure it and clamp its position so it stays
  // inside the viewport. The popover is ``position: fixed`` with
  // ``transform: translateX(-50%)``, so ``left`` is the horizontal
  // center and ``top`` is the popover's top edge in viewport coords.
  useLayoutEffect(() => {
    if (!popover) return;
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nextX = popover.x;
    let nextY = popover.y;
    // Horizontal: clamp the centered popover so neither edge spills.
    const halfWidth = rect.width / 2;
    if (nextX - halfWidth < margin) nextX = margin + halfWidth;
    if (nextX + halfWidth > vw - margin) nextX = vw - margin - halfWidth;
    // Vertical: if the popover would overflow the bottom, flip it above
    // the event (or, if there's no room above either, pin it to the top
    // of the viewport).
    if (nextY + rect.height > vh - margin) {
      const flippedTop = nextY - rect.height - 8 - 24; // 24 ≈ event row height
      nextY = flippedTop >= margin ? flippedTop : Math.max(margin, vh - margin - rect.height);
    }
    if (Math.abs(nextX - popover.x) > 0.5 || Math.abs(nextY - popover.y) > 0.5) {
      setPopover({ ...popover, x: nextX, y: nextY });
    }
  }, [popover]);

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

  const activeRoutines = routines.filter((r) => !!r.is_active);
  const selectAllRoutines = () => setVisibleRoutines(new Set(activeRoutines.map((r) => r.id)));
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
        // Update 3 / 4_27_26 follow-up: forward the saved-config link
        // through FullCalendar's extendedProps so the popover renders
        // the "Saved as <name>" badge for manual executions.
        saved_configuration_id: extProps.saved_configuration_id,
        saved_configuration_name: extProps.saved_configuration_name,
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
        <TutorialLinkButton anchor="calendar" />
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
                <li><strong>Upcoming routine fires</strong> appear in the scheduled-orange palette, projected up to <strong>12 months</strong> ahead. If you navigate the calendar past that horizon, an inline notice appears explaining that scheduled fires beyond 12 months are not projected.</li>
                <li>Scheduled fire times are computed in your local timezone and match the times APScheduler will actually fire each routine (Update 3 fix).</li>
              </ul>
            ),
          },
          {
            heading: 'How to use it',
            body: (
              <ul>
                <li>Click any event to open a popover with its details, result counts, and a link to the full report. The popover stays open while you act on it.</li>
                <li>For routine events, the popover surfaces the routine's <strong>Name</strong> and <strong>Cron Schedule</strong>, and exposes an <strong>Edit Routine</strong> button that opens the same modal used on the Routines page — saves propagate everywhere automatically.</li>
                <li>For manual executions launched from a saved configuration (or saved as one after the fact), the popover renders a <strong>Saved as &lt;name&gt;</strong> indicator above the Save Config button.</li>
                <li>Use the <strong>Type</strong> and <strong>Status</strong> filters to narrow the view. The <strong>Routines</strong> dropdown lists active routines only.</li>
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
              Routines: {visibleRoutines.size} of {activeRoutines.length} ▾
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
                {activeRoutines.length === 0 && (
                  <div className="text-muted" style={{ fontSize: '0.85em', padding: '4px 2px' }}>
                    No active routines.
                  </div>
                )}
                {activeRoutines.map((r) => (
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
        {pastHorizon && (
          <div
            className="calendar-horizon-notice"
            role="status"
            style={{
              padding: '8px 12px',
              marginBottom: '8px',
              borderRadius: '6px',
              background: 'rgba(245, 158, 11, 0.12)',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              color: '#f59e0b',
              fontSize: '0.9em',
            }}
          >
            The Calendar projects upcoming routine fires up to 12 months ahead of today;
            scheduled events beyond that horizon are not shown here.
          </div>
        )}
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,dayGridWeek,dayGridDay',
          }}
          views={{
            dayGridWeek: { dayMaxEvents: false, displayEventTime: true, displayEventEnd: false },
            dayGridDay: { dayMaxEvents: false, displayEventTime: true, displayEventEnd: false },
          }}
          // A 1-minute default duration prevents FullCalendar from
          // expanding zero/short-duration events to 1 hour, which used
          // to cause late-night fires (e.g. an 11 PM routine) to spill
          // across the midnight boundary and render as multi-day bars
          // in dayGrid views (Bug 2).
          defaultTimedEventDuration="00:01:00"
          forceEventDuration={false}
          datesSet={(arg) => {
            // Show the 12-month horizon notice once the user has
            // navigated the visible window past one year from today.
            const horizon = new Date();
            horizon.setFullYear(horizon.getFullYear() + 1);
            setPastHorizon(arg.start.getTime() > horizon.getTime());
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
              allDay: false,
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
          eventDidMount={(arg) => {
            // Expose the event's status color (set by FullCalendar as
            // ``backgroundColor``) as a CSS custom property so the
            // CSS overrides for ``.fc-timegrid-event`` can paint a
            // type-neutral left-border accent without inline-styling
            // the element from this callback. Using a CSS variable
            // also keeps the original inline ``background-color`` in
            // place for the month-view default renderer (which uses
            // it for the leading dot).
            const color = arg.event.backgroundColor || '#6b7280';
            (arg.el as HTMLElement).style.setProperty('--event-color', color);
          }}
          height="auto"
          editable={false}
          selectable={false}
        />
      </div>

      {popover && (
        <div
          ref={popoverRef}
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
            {/* Update 3 / 4_27_26 follow-up: surface the execution's name
                ("Execution #<id>") on manual-execution popovers, mirroring
                the new ``Name`` column on the Results & Logs and Dashboard
                tables. Routine-fired events get their own ``Name`` line
                from the routines metadata block below. */}
            {!popover.event.routine_id && popover.event.execution_id && (
              <div><span className="text-muted">Name:</span> Execution #{popover.event.execution_id}</div>
            )}
            {popover.event.routine_id && (() => {
              // Routine-only metadata: surface the routine's user-given
              // name and the saved 5-field cron expression so the popover
              // is unambiguous about which routine fired (or will fire).
              // Shown for every status (scheduled / running / completed /
              // cancelled / failed). The cron string matches the
              // ``Schedule`` column on the Routines page exactly.
              const r = routines.find((rt) => rt.id === popover.event.routine_id);
              if (!r) return null;
              return (
                <>
                  <div><span className="text-muted">Name:</span> {r.name}</div>
                  {r.schedule_cron && (
                    <div><span className="text-muted">Cron Schedule:</span> {r.schedule_cron}</div>
                  )}
                </>
              );
            })()}
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
            {popover.event.execution_id &&
              !popover.event.routine_id &&
              (popover.event.type === 'deep_dive' ||
                popover.event.type === 'dive' ||
                popover.event.type === 'deep_sweep' ||
                popover.event.type === 'sweep') && (
                <SaveConfigButton
                  execution={{
                    id: Number(popover.event.execution_id),
                    execution_type: popover.event.type || '',
                    saved_configuration_id: popover.event.saved_configuration_id,
                    saved_configuration_name: popover.event.saved_configuration_name,
                  }}
                />
              )}
            {popover.event.routine_id && (
              <>
                <button className="btn btn-sm" onClick={handleToggleActive}>
                  {routines.find((r) => r.id === popover.event.routine_id)?.is_active ? 'Deactivate Routine' : 'Activate Routine'}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    const r = routines.find((rt) => rt.id === popover.event.routine_id);
                    if (r) {
                      setEditTarget(r);
                      setEditOpen(true);
                    }
                  }}
                >
                  Edit Routine
                </button>
                <a className="btn btn-sm" href={`#/routines`} onClick={closePopover}>View Routine</a>
              </>
            )}
          </div>
        </div>
      )}
      <RoutineEditModal
        open={editOpen}
        target={editTarget}
        onClose={() => setEditOpen(false)}
        onSaved={() => { fetchData(); }}
      />
    </div>
  );
};

export default CalendarPage;
