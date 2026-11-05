/**
 * The run monitor's mark, drawn as the approved comp draws it: the plate's
 * ring and core in the accent when nothing runs; an orbit for each running
 * run (up to three), whose arc is the share of that run's sources that have
 * finished and which turns only while the run's heartbeat arrives; a ring that
 * spreads once when a run finishes; and the struck mark in the fixed red when
 * a run has failed. An arc whose run has said nothing for fifteen seconds
 * stops and turns gray. With reduced motion nothing turns or pulses.
 */

/** The orbits' radii, inner first, in the mark's 24-unit box. */
const RADII = [5.5, 8.25, 11] as const;

/** Where each orbit's arc starts, so three arcs do not start together. */
const OFFSET = 110;

export type MarkState = 'idle' | 'finished' | 'failed' | 'running' | 'runfail';

export interface Orbit {
  /** The share of the run's sources that have finished, 0 to 1. */
  share: number;
  /** No word from the run for fifteen seconds. */
  stalled: boolean;
}

export function RunMark({ state, orbits = [], pulse = 0, className }: {
  state: MarkState;
  orbits?: readonly Orbit[];
  /** A number that changes once for each run that finishes; each change plays the ring once. */
  pulse?: number;
  className?: string;
}) {
  const shown = orbits.slice(0, RADII.length);
  return (
    <svg className={`run-mark${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      data-mark-state={state}>
      {(state === 'idle' || state === 'finished') && (
        <>
          {pulse > 0 && <circle key={pulse} className="rm-pulse" cx="12" cy="12" r="6" />}
          <circle className="rm-ring" cx="12" cy="12" r="6" />
          <circle className="rm-core" cx="12" cy="12" r="2" />
        </>
      )}
      {state === 'failed' && (
        <>
          <circle className="rm-fault" cx="12" cy="12" r="6.5" />
          <path className="rm-fault" d="M7.4 16.6 16.6 7.4" />
        </>
      )}
      {(state === 'running' || state === 'runfail') && (
        <>
          {pulse > 0 && <circle key={pulse} className="rm-pulse" cx="12" cy="12" r="6" />}
          {shown.map((orbit, i) => {
            const r = RADII[i] as number;
            const around = 2 * Math.PI * r;
            // Never shorter than a twelfth of the circle, so a run that has just begun is still seen to turn.
            const arc = Math.max(around * Math.min(1, Math.max(0, orbit.share)), around / 12);
            return (
              <g key={i}>
                <circle className="rm-track" cx="12" cy="12" r={r} />
                <g className={`rm-spin s${i}${orbit.stalled ? ' stalled' : ''}`} data-stalled={orbit.stalled ? 'true' : undefined}>
                  <circle className="rm-arc" cx="12" cy="12" r={r} strokeDasharray={`${arc.toFixed(2)} ${around.toFixed(2)}`}
                    transform={`rotate(${-90 + i * OFFSET} 12 12)`} />
                </g>
              </g>
            );
          })}
          {state === 'runfail'
            ? (
              <>
                <circle className="rm-fault thin" cx="12" cy="12" r="2.9" />
                <path className="rm-fault thin" d="M10 14 14 10" />
              </>
            )
            : <circle className="rm-core" cx="12" cy="12" r="2" />}
        </>
      )}
    </svg>
  );
}
