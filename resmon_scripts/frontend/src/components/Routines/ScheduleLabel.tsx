import React from 'react';
import { scheduleText } from '../../lib/scheduleText';

/**
 * A routine's schedule: the words first, the cron expression beneath them, so
 * the reader gets the meaning at a glance and can still check the exact
 * expression. Where the words cannot be stated exactly, the expression alone.
 */
const ScheduleLabel: React.FC<{ cron: string; parameters?: unknown }> = ({ cron, parameters }) => {
  const words = scheduleText(cron, parameters);
  if (!words) return <code className="schedule-cron-only">{cron}</code>;
  return (
    <span className="schedule-label">
      <span className="schedule-words">{words}</span>
      <code className="schedule-cron">{cron}</code>
    </span>
  );
};

export default ScheduleLabel;
