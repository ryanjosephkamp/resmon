/**
 * Whether anything will run a watch on its schedule, in words.
 *
 * A window's own engine runs no scheduler: watches fire only in the background
 * service, and only a service of this version that this window is using.
 * `GET /api/scheduler/status` says which case this is, with a verdict for each
 * watch that is watching: `true` where the engine answering holds the schedule
 * itself, `false` where nothing can fire it as things stand, and `null` where
 * a service is running that resmon cannot see into. A schedule's next time is
 * called the watch's next run only where the verdict is `true`; anywhere else
 * it is when the watch is due, and the words say what stands in the way.
 */
import type { components } from '../../api/schema';

export type SchedulerStatus = components['schemas']['SchedulerStatus'];

/** One watch's verdict; `undefined` where the status has not been read or does not list it. */
export type Firing = boolean | null | undefined;

/** Today reads the same status under the same key, so the two share one answer. */
export const SCHEDULER_KEY = ['scheduler-status'] as const;

export const BACKGROUND_PATH = '/settings/background';
/** Where the switch is, as the sentences name it; the screen links these words. */
export const BACKGROUND_WORDS = 'Settings › In the background';

/** The verdict on one watch. The status lists watching watches only. */
export function firingOf(status: SchedulerStatus | undefined, id: number): Firing {
  if (!status) return undefined;
  const found = status.routines.find((r) => r.id === id);
  return found ? found.will_fire : undefined;
}

/** `data-firing` on a watch: what a reader of the markup, or a test, reads. */
export function firingState(firing: Firing): 'will-run' | 'will-not-run' | 'unconfirmed' | 'unread' {
  if (firing === true) return 'will-run';
  if (firing === false) return 'will-not-run';
  return firing === null ? 'unconfirmed' : 'unread';
}

/**
 * A watching watch's next time, in the words its verdict allows: `next` only
 * where something will run it. `when` is the time already in words, or null
 * where the calendar has none.
 */
export function nextWords(firing: Firing, when: string | null): string | null {
  if (firing === true) return when ? `next ${when}` : null;
  if (firing === false) return when ? `due ${when}, but nothing will run it` : 'nothing will run it on schedule';
  if (firing === null) return when ? `due ${when}, not confirmed to run` : 'not confirmed to run on schedule';
  return when ? `due ${when}` : null;
}

export interface FiringNotice {
  text: string;
  /** Whether Settings › In the background is where it is put right, so the screen offers the way there. */
  background: boolean;
}

const SWITCH = 'Run resmon in the background';
const THERE = BACKGROUND_WORDS;

/**
 * One sentence on why some watching watches will not run, or `null` when
 * every one will (or none is watching). `only` narrows it to one watch, for
 * that watch's own page.
 */
export function firingNotice(status: SchedulerStatus, only?: number): FiringNotice | null {
  const watching = only === undefined ? status.routines : status.routines.filter((r) => r.id === only);
  const doubtful = watching.filter((r) => r.will_fire !== true);
  const n = doubtful.length;
  if (n === 0) return null;
  const them = only !== undefined ? 'this watch'
    : n === watching.length ? (n === 1 ? 'your watch' : 'your watches')
      : n === 1 ? 'one of your watches' : `${n} of your watches`;
  // "Will not" only where every one of them is a `false`: one `null` among
  // them and the sentence about the group is the weaker one, because the
  // stronger would be untrue of that watch.
  const lead = doubtful.every((r) => r.will_fire === false)
    ? `Nothing will run ${them} on schedule.`
    : `resmon cannot confirm that anything will run ${them} on schedule.`;

  switch (status.state) {
    case 'fires_here': {
      // The scheduler is here and holds no job for them: the one case where
      // pausing and resuming, which registers the schedule again, is the lever.
      const one = n === 1;
      const who = only !== undefined ? 'This watch has' : one ? 'A watch that is watching has' : `${n} watches that are watching have`;
      return {
        text: `${who} no schedule registered with the scheduler, so nothing will run ${one ? 'it' : 'them'} on schedule. `
          + `Pause and resume ${one ? 'it' : 'each one'} to register it again.`,
        background: false,
      };
    }
    case 'no_service':
      return {
        text: `${lead} This window does not run watches itself, and no background service is set up. `
          + `Turn on ${SWITCH} in ${THERE}.`,
        background: true,
      };
    case 'service_stopped':
      return {
        text: `${lead} The background service is installed but not running. `
          + `In ${THERE}, turn ${SWITCH} off and on again to restart it.`,
        background: true,
      };
    case 'service_other_version':
      return {
        text: `${lead} The background service on this computer is resmon `
          + `${status.service_version ?? 'of a version it did not report'}, and this app is ${status.app_version}; `
          + `the app works only with a service of its own version. In ${THERE}, turn ${SWITCH} off and on again `
          + 'to replace that service. Whatever the old service was running stops.',
        background: true,
      };
    case 'service_elsewhere':
      return {
        text: `${lead} A background service of this version is running, but this window is not using it. `
          + `${THERE} shows which engine this window uses.`,
        background: true,
      };
    case 'service_unreachable':
      return {
        text: `${lead} A background service is recorded on this computer but did not answer. ${THERE} shows what it found.`,
        background: true,
      };
    case 'scheduler_off':
      return { text: `${lead} This engine was started with its scheduler turned off.`, background: false };
    default:
      return null;
  }
}

/**
 * The month ahead's opening sentence. "Will run" only where every watching
 * watch will; otherwise the marks are when each is due, and the sentence says
 * which marks nothing will run.
 */
export function monthAheadLede(status: SchedulerStatus | undefined, activeIds: readonly number[]): string {
  const paused = 'A paused watch runs only when you ask it to.';
  if (!status) return `When each watch is due, in this computer’s time. ${paused}`;
  const doubtful = activeIds.map((id) => firingOf(status, id)).filter((f) => f !== true);
  if (!doubtful.length) return `When each watch will run, in this computer’s time. ${paused}`;
  const none = doubtful.every((f) => f === false);
  if (doubtful.length === activeIds.length) {
    return `When each watch is due by its schedule, in this computer’s time. ${none
      ? 'As things stand nothing will run them' : 'resmon cannot confirm that anything will run them'}; the note at the top says why. ${paused}`;
  }
  return `When each watch is due, in this computer’s time. A faint mark is a watch ${none
    ? 'nothing will run' : 'nothing is confirmed to run'} as things stand; the note at the top says why. ${paused}`;
}
