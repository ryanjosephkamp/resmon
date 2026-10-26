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
  /*
   * Only a run that completed passed every stage. This used to tick them all
   * for any status but 'running' -- 'cancelling' included -- so pressing Cancel
   * during Query showed Normalize, Report, AI Summary and Finalize as done for a
   * run that reached none of them. Found in a walk of the app on October 26,
   * 2026. A run that was cancelled, failed or was interrupted stopped in the
   * stage it was in; the stages before it are done and the rest never ran. A
   * run still cancelling is still in its stage until the cancellation lands.
   */
  const completed = exec.status === 'completed';
  const stopped = exec.status === 'cancelled' || exec.status === 'failed'
    || exec.status === 'interrupted';

  return (
    <div className="mon-pipeline">
      {ALL_STAGES.map((stage, idx) => {
        /* Skip AI stage visually if disabled */
        const isAI = stage.key === 'summarizing';
        const skipped = isAI && !aiEnabled;

        let stateClass = 'mon-stage--future';
        if (completed) {
          stateClass = skipped ? 'mon-stage--skipped' : 'mon-stage--done';
        } else if (idx < currentIdx) {
          stateClass = skipped ? 'mon-stage--skipped' : 'mon-stage--done';
        } else if (idx === currentIdx) {
          stateClass = stopped ? 'mon-stage--stopped' : 'mon-stage--active';
        } else if (stopped) {
          stateClass = 'mon-stage--not-run';
        }

        return (
          <React.Fragment key={stage.key}>
            {idx > 0 && <span className="mon-stage-connector" />}
            <div
              className={`mon-stage ${stateClass}`}
              data-testid={`stage-${stage.key}`}
              data-state={stateClass.replace('mon-stage--', '')}
              title={stateClass === 'mon-stage--stopped' ? `The run stopped here (${exec.status})`
                : stateClass === 'mon-stage--not-run' ? 'Not reached: the run stopped earlier' : undefined}
            >
              <span className="mon-stage-icon">
                {stateClass === 'mon-stage--done' && '✓'}
                {stateClass === 'mon-stage--active' && '●'}
                {stateClass === 'mon-stage--skipped' && '–'}
                {stateClass === 'mon-stage--future' && '○'}
                {stateClass === 'mon-stage--stopped' && '✕'}
                {stateClass === 'mon-stage--not-run' && '○'}
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
