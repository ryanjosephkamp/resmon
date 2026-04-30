import React, { useState } from 'react';
import { apiClient } from '../../api/client';
import RoutineEditModal, { RoutineEditTarget } from './RoutineEditModal';

/**
 * Update 3 — `Edit Routine` button.
 *
 * Mirrors the popover-button pattern from the Calendar page so the
 * Dashboard's Recent Activity row and the Results & Logs row-detail
 * box (`ReportViewer`) can launch the same shared `RoutineEditModal`
 * for any routine-driven execution.
 *
 * The ``routine_id`` column on the ``executions`` table is wired with
 * ``ON DELETE SET NULL``, so historical automated executions whose
 * originating routine has been deleted carry ``routine_id = NULL``.
 * Rendering the button only when ``routineId`` was truthy left those
 * rows looking inconsistent (some routine executions had the button,
 * some did not). The button now renders for every routine-driven
 * execution and degrades to a disabled state with an explanatory
 * ``title`` tooltip when the originating routine is gone.
 */
interface Props {
  /** ``null`` / ``undefined`` → render disabled with explanatory tooltip. */
  routineId: number | null | undefined;
  buttonClassName?: string;
  onSaved?: () => void;
}

const EditRoutineButton: React.FC<Props> = ({
  routineId,
  buttonClassName = 'btn btn-sm',
  onSaved,
}) => {
  const [target, setTarget] = useState<RoutineEditTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const missing = routineId == null;

  const handleClick = async () => {
    if (busy || missing) return;
    setBusy(true);
    try {
      const r = await apiClient.get<RoutineEditTarget>(`/api/routines/${routineId}`);
      setTarget(r);
      setOpen(true);
    } catch {
      // silent — the originating routine may have been deleted between
      // the table fetch and the click; the button just stays unopened.
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={buttonClassName}
        onClick={handleClick}
        disabled={busy || missing}
        title={missing ? 'Originating routine no longer exists' : undefined}
      >
        Edit Routine
      </button>
      <RoutineEditModal
        open={open}
        target={target}
        onClose={() => setOpen(false)}
        onSaved={() => {
          if (onSaved) onSaved();
        }}
      />
    </>
  );
};

export default EditRoutineButton;
