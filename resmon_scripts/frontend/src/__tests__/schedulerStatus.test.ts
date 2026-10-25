/**
 * The sentence the Routines page says about scheduling, state by state.
 *
 * The defect this exists for: an Active routine that nothing will fire looked
 * exactly like one that will. So the cases that matter most are the ones where
 * the page must speak, and the one where it must not.
 */
import {
  routineFiringNote,
  schedulerNotice,
  type RoutineFiring,
  type SchedulerState,
  type SchedulerStatus,
} from '../lib/schedulerStatus';

const NO: RoutineFiring = { id: 1, will_fire: false, reason: 'no_scheduler_running' };
const MAYBE: RoutineFiring = { id: 2, will_fire: null, reason: 'unconfirmed' };
const YES: RoutineFiring = { id: 3, will_fire: true, reason: 'scheduled' };

function status(state: SchedulerState, routines: RoutineFiring[], service_version: string | null = null): SchedulerStatus {
  return { state, app_version: '2.3.0', service_installed: true, service_version, routines };
}

describe('schedulerNotice', () => {
  test('says nothing when every active routine will fire, or there are none', () => {
    expect(schedulerNotice(status('fires_here', [YES]))).toBeNull();
    expect(schedulerNotice(status('no_service', []))).toBeNull();
  });

  test("the owner's case: a service of another version, routines with no job here", () => {
    const notice = schedulerNotice(status('service_other_version', [NO, { ...NO, id: 4 }], '1.2.1'));
    expect(notice).not.toBeNull();
    expect(notice!.text).toMatch(/^Nothing will run these 2 routines\./);
    expect(notice!.text).toContain('resmon 1.2.1');
    expect(notice!.text).toContain('this app is 2.3.0');
    expect(notice!.text).toContain('off and on again to replace that service');
    expect(notice!.text).toContain('Whatever the old service was running stops.');
    expect(notice!.advanced).toBe(true);
  });

  test('one unconfirmed routine weakens the sentence for the group', () => {
    const notice = schedulerNotice(status('service_other_version', [NO, MAYBE], '1.2.1'));
    expect(notice!.text).toMatch(/^resmon cannot confirm anything will run these 2 routines\./);
    expect(notice!.text).not.toContain('Nothing will run');
  });

  test('only the routines in doubt are counted', () => {
    expect(schedulerNotice(status('no_service', [NO, YES]))!.text)
      .toMatch(/^Nothing will run this routine\./);
  });

  test.each<[SchedulerState, RegExp, boolean]>([
    ['no_service', /no background service is installed\. In Settings → Advanced, turn Run resmon in the background on\./, true],
    ['service_stopped', /installed but not running\. .* off and on again to restart it\./, true],
    ['service_elsewhere', /this window is not connected to it\./, true],
    ['service_unreachable', /did not answer\. Settings → Advanced shows what it found\./, true],
    ['scheduler_off', /started with its scheduler turned off\./, false],
  ])('%s names its reason and its lever', (state, reason, advanced) => {
    const notice = schedulerNotice(status(state, [NO]));
    expect(notice!.text).toMatch(reason);
    expect(notice!.advanced).toBe(advanced);
  });

  test('a scheduler that holds no job for a routine points at re-registering it', () => {
    const notice = schedulerNotice(status('fires_here', [{ id: 5, will_fire: false, reason: 'not_scheduled' }]));
    expect(notice!.text).toContain('no schedule registered with the scheduler');
    expect(notice!.text).toContain('Deactivate and activate it');
    expect(notice!.advanced).toBe(false);
  });

  test('a service that reported no version is not given one', () => {
    expect(schedulerNotice(status('service_other_version', [NO]))!.text)
      .toContain('resmon of a version it did not report');
  });
});

describe('routineFiringNote', () => {
  test('three verdicts, three answers', () => {
    expect(routineFiringNote(YES)).toBeNull();
    expect(routineFiringNote(NO)).toBe('Will not run');
    expect(routineFiringNote(MAYBE)).toBe('Not confirmed to run');
    expect(routineFiringNote(undefined)).toBeNull();
  });
});
