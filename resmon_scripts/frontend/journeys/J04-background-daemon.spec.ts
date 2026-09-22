/**
 * J04 Background daemon — Advanced says what is actually installed and what is
 * actually running, and never claims an instance.
 *
 * The register's invariant is honesty rather than absence: a person looking at
 * Advanced must be able to tell whether anything is running in the background,
 * and an app that claimed an instance it does not have would be the worst
 * version of this screen. So the assertions are relationships — the screen and
 * the service record agree, and the screen and the daemon probe agree — rather
 * than a fixed sentence.
 *
 * **The launch agent is isolated, and that took finding.** `RESMON_STATE_DIR`
 * covers the database, the reports and the daemon lock; it does not cover the
 * unit file, which `service_manager.unit_path()` puts in the machine's own
 * LaunchAgents or systemd directory. A journey in a brand-new state directory
 * on a developer's Mac therefore read `Status: Installed` — true about the
 * machine, useless about the app. `unit_path()` already honours
 * `RESMON_SERVICE_UNIT_DIR`, and the session now points it inside its own temp
 * state, so the register's sentence holds on every machine with no branch.
 *
 * **Nothing is installed or removed by this test.** Installing a launch agent
 * would write outside the state directory, would survive the run, and would put
 * a second resmon on the machine beside the one on port 8742. The control's
 * presence is asserted; it is never used.
 */
import { expect, journey } from './driver';

journey.describe('J04 Background daemon', () => {
  journey('the panel agrees with the service record and the daemon probe, and claims no instance', async ({ resmon }) => {
    const panel = await resmon.readDaemonPanel();
    const service = await resmon.backend.serviceStatus();
    console.log(`[J04] status line: ${JSON.stringify(panel.status)}`);
    console.log(`[J04] service record: ${JSON.stringify(service)}`);

    // The screen says what the record says, and what it says is "not
    // installed" — because the unit directory this app was launched with is
    // this session's own and has nothing in it.
    expect(panel.status).toContain('Not installed');
    expect(service.installed, 'a fresh unit directory already holds a service').toBe(false);
    expect(String(service.unit_path ?? '').length, 'the record names no unit path').toBeGreaterThan(0);
    expect(panel.text, 'the panel does not show the unit path it was given')
      .toContain(String(service.unit_path));

    // The half that is isolated, and the half B3 cares about. This state
    // directory has no daemon lock, so nothing is running for this app to
    // attach to, and the panel says exactly that rather than inferring a
    // running daemon from an installed unit.
    const daemon = await resmon.backend.daemonStatus();
    console.log(`[J04] daemon probe: ${JSON.stringify(daemon)}`);
    expect(daemon.lock_present, 'a fresh state directory already holds a daemon lock').toBe(false);
    expect(daemon.running, 'the probe found a daemon this app should not be able to see').toBe(false);
    expect(daemon.pid ?? null, 'the probe claimed a process id for a daemon that is not running').toBe(null);
    expect(panel.text, 'the panel does not say whether a daemon is running').toContain('no daemon running');

    // And the window is talking to its own backend, not to anybody's daemon.
    const port = await resmon.backend.port();
    expect(port, 'the window attached to the live daemon').not.toBe('8742');
    expect(panel.text, 'the panel does not identify the backend this window is using')
      .toMatch(/this window →/);

    // The control that installs and removes the service is on screen, and it
    // reflects the record. There is one control rather than two buttons: the
    // checkbox does both, behind a confirmation. This journey never ticks it.
    expect(panel.controlPresent, 'Advanced offers no way to install or remove the service').toBe(true);
    expect(panel.controlOn, 'the control claims a service that is not installed').toBe(false);

    await resmon.takePicture('J04-background-daemon');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
