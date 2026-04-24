import React from 'react';
import { ActiveExecution } from '../../context/ExecutionContext';

/* ------------------------------------------------------------------ */
/* Stage definitions                                                   */
/* ------------------------------------------------------------------ */

const ALL_STAGES = [
  { key: 'init', label: 'Init' },
  { key: 'querying', label: 'Query' },
  { key: 'normalizing', label: 'Normalize' },
  { key: 'dedup', label: 'Dedup' },
  { key: 'linking', label: 'Link' },
  { key: 'reporting', label: 'Report' },
  { key: 'summarizing', label: 'AI Summary' },
  { key: 'finalizing', label: 'Finalize' },
];

const STAGE_ORDER: Record<string, number> = {};
ALL_STAGES.forEach((s, i) => {
  STAGE_ORDER[s.key] = i;
});

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface PipelineStagesProps {
  exec: ActiveExecution;
  aiEnabled?: boolean;
}

const PipelineStages: React.FC<PipelineStagesProps> = ({
  exec,
  aiEnabled = true,
}) => {
  const currentIdx = exec.currentStage
    ? (STAGE_ORDER[exec.currentStage] ?? -1)
    : -1;
  const isTerminal = exec.status !== 'running';

  return (
    <div className="mon-pipeline">
      {ALL_STAGES.map((stage, idx) => {
        /* Skip AI stage visually if disabled */
        const isAI = stage.key === 'summarizing';
        const skipped = isAI && !aiEnabled;

        let stateClass = 'mon-stage--future';
        if (isTerminal) {
          /* All stages count as completed (or skipped) once execution finishes */
          stateClass = skipped ? 'mon-stage--skipped' : 'mon-stage--done';
        } else if (idx < currentIdx) {
          stateClass = skipped ? 'mon-stage--skipped' : 'mon-stage--done';
        } else if (idx === currentIdx) {
          stateClass = 'mon-stage--active';
        }

        return (
          <React.Fragment key={stage.key}>
            {idx > 0 && <span className="mon-stage-connector" />}
            <div className={`mon-stage ${stateClass}`}>
              <span className="mon-stage-icon">
                {stateClass === 'mon-stage--done' && '✓'}
                {stateClass === 'mon-stage--active' && '●'}
                {stateClass === 'mon-stage--skipped' && '–'}
                {stateClass === 'mon-stage--future' && '○'}
              </span>
              <span className="mon-stage-label">
                {skipped ? 'Skipped' : stage.label}
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default PipelineStages;
