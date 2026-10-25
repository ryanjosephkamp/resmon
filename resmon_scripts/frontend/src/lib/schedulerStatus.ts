/**
 * Whether the active routines will fire, and the sentence that says so.
 *
 * The Routines page showed **Active** for routines nothing would ever fire, and
 * they looked exactly like routines that would. On the owner's Mac a `*\/5`
 * routine sat Active for six minutes with no run, and a daily one had run once
 * in seven weeks. The packaged app's own backend runs no scheduler; it fires
 * routines only through a background service of its own version, and his was
 * an older one. `GET /api/scheduler/status` says which case this is. This
 * module turns its answer into words, and says nothing where it has nothing
 * to say.
 *
 * Three verdicts, not two. `true` only where the backend answering holds the
 * schedule itself. `false` where nothing can fire the routine as things stand.
 * `null` where a service is running that resmon cannot see into: no version
 * so far reports which database it serves, so "it will run" and "it will not"
 * would both be guesses.
 */

/** Mirrors `response_models.SchedulerState`. */
export type SchedulerState =
  | 'fires_here'
  | 'no_service'
  | 'service_stopped'
  | 'service_other_version'
  | 'service_elsewhere'
  | 'service_unreachable'
  | 'scheduler_off';

/** Mirrors `response_models.RoutineFiringReason`. */
export type RoutineFiringReason =
  | 'scheduled'
  | 'not_scheduled'
  | 'no_scheduler_running'
  | 'unconfirmed';

export interface RoutineFiring {
  id: number;
  will_fire: boolean | null;
  reason: RoutineFiringReason;
}

export interface SchedulerStatus {
  state: SchedulerState;
  app_version: string;
  service_installed: boolean;
  service_version: string | null;
  /** Active routines only. */
  routines: RoutineFiring[];
}

export interface SchedulerNotice {
  text: string;
  /** Whether the fix is in Settings → Advanced, so the page offers the way there. */
  advanced: boolean;
}

const ADVANCED = 'In Settings → Advanced, turn Run resmon in the background';

/**
 * The page's one sentence about scheduling, or `null` when every active
 * routine will fire (or there are none to speak of).
 */
export function schedulerNotice(status: SchedulerStatus): SchedulerNotice | null {
  const doubtful = status.routines.filter((r) => r.will_fire !== true);
  if (doubtful.length === 0) return null;
  const n = doubtful.length;
  const them = n === 1 ? 'this routine' : `these ${n} routines`;
  // "Will not" only where every one of them is a `false`. One `null` among
  // them and the sentence about the group is the weaker one, because the
  // stronger would be untrue of that routine.
  const lead = doubtful.every((r) => r.will_fire === false)
    ? `Nothing will run ${them}.`
    : `resmon cannot confirm anything will run ${them}.`;

  switch (status.state) {
    case 'fires_here':
      // The scheduler is here and holds no job for them: the only case where
      // re-registering is the lever.
      return {
        text: `${n === 1 ? 'An active routine has' : `${n} active routines have`} no schedule `
          + 'registered with the scheduler, so nothing will run '
          + `${n === 1 ? 'it' : 'them'}. Deactivate and activate ${n === 1 ? 'it' : 'each one'} to register it again.`,
        advanced: false,
      };
    case 'no_service':
      return {
        text: `${lead} This window does not run routines itself, and no background service is `
          + `installed. ${ADVANCED} on.`,
        advanced: true,
      };
    case 'service_stopped':
      return {
        text: `${lead} The background service is installed but not running. ${ADVANCED} off and `
          + 'on again to restart it.',
        advanced: true,
      };
    case 'service_other_version':
      return {
        text: `${lead} The background service on this computer is resmon `
          + `${status.service_version ?? 'of a version it did not report'}, and this app is `
          + `${status.app_version}; the app works only with a service of its own version. `
          + `${ADVANCED} off and on again to replace that service. Whatever the old service was `
          + 'running stops.',
        advanced: true,
      };
    case 'service_elsewhere':
      return {
        text: `${lead} A background service of this version is running, but this window is not `
          + 'connected to it.',
        advanced: true,
      };
    case 'service_unreachable':
      return {
        text: `${lead} A background service is recorded on this computer but did not answer. `
          + 'Settings → Advanced shows what it found.',
        advanced: true,
      };
    case 'scheduler_off':
      return {
        text: `${lead} This backend was started with its scheduler turned off.`,
        advanced: false,
      };
    default:
      return null;
  }
}

/** The few words under a row's Active badge, or `null` for a routine that will fire. */
export function routineFiringNote(firing: RoutineFiring | undefined): string | null {
  if (!firing || firing.will_fire === true) return null;
  return firing.will_fire === false ? 'Will not run' : 'Not confirmed to run';
}
