import React from 'react';
import { ActiveExecution } from '../../context/ExecutionContext';

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface StatsCountersProps {
  exec: ActiveExecution;
}

const StatsCounters: React.FC<StatsCountersProps> = ({ exec }) => {
  /* Derive duplicate and invalid counts from dedup_stats events */
  let duplicates = 0;
  let invalid = 0;
  for (let i = exec.events.length - 1; i >= 0; i--) {
    const ev = exec.events[i];
    if (ev.type === 'dedup_stats') {
      duplicates = ev.duplicates ?? 0;
      invalid = ev.invalid ?? 0;
      break;
    }
  }

  const counters = [
    { label: 'Total', value: exec.resultCount, cls: 'mon-counter--total' },
    { label: 'New', value: exec.newCount, cls: 'mon-counter--new' },
    { label: 'Duplicates', value: duplicates, cls: 'mon-counter--dupes' },
    { label: 'Invalid', value: invalid, cls: 'mon-counter--invalid' },
  ];

  return (
    <div className="mon-stats">
      <h3 className="mon-section-title">Results Summary</h3>
      <div className="mon-counters">
        {counters.map((c) => (
          <div key={c.label} className={`mon-counter ${c.cls}`}>
            <span className="mon-counter-value">{c.value}</span>
            <span className="mon-counter-label">{c.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default StatsCounters;
