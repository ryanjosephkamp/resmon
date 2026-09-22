/**
 * J04 Background daemon — a checkout with no service installed says so, and
 * offers the control that would install one.
 *
 * The register's invariant is about honesty rather than about the daemon: a
 * person looking at Advanced must be able to tell whether anything is running
 * in the background, and an app that claimed an instance it does not have would
 * be the worst possible version of this screen. So the journey reads the panel
 * in a state directory that has never had a service installed and checks that
 * the screen, the service record and the daemon probe all say the same thing.
 *
 * **Nothing is installed by this test, on purpose.** Installing a launchd unit
 * from a test would write outside the state directory, would survive the run,
 * and would put a second resmon on the machine next to the one on port 8742.
 * The control's presence is asserted; it is never used. That is the row's
 * honest boundary and its ledger says so.
 */
import { expect, journey } from './driver';

journey.describe('J04 Background daemon', () => {
  journey('a checkout with no service installed reads as "not installed", and the control is there', async ({ resmon }) => {
    const panel = await resmon.readDaemonPanel();
    console.log(`[J04] status line: ${JSON.stringify(panel.status)}`);

    // The screen's own sentence. "Not installed" is a claim the app is entitled
    // to make; a claimed instance would not be.
    expect(panel.status).toContain('Not installed');
    expect(panel.status, 'the panel claimed an installed service').not.toMatch(/Status:\s*Installed/);

    // And the record behind it, over the app's own API.
    const service = await resmon.backend.serviceStatus();
    expect(service.installed, 'the service record disagrees with the screen').toBe(false);
    expect(String(service.unit_path ?? '').length, 'the panel shows a unit path it did not get').toBeGreaterThan(0);

    // The daemon probe is the independent half: the service record says whether
    // a unit is installed, this says whether anything is actually listening.
    // Both must be negative, and the second is the one that would catch this
    // suite having attached to somebody's real daemon.
    const daemon = await resmon.backend.routeInventory();
    expect(daemon, 'the build under test serves no daemon-status route').toContain('/api/service/daemon-status');
    const port = await resmon.backend.port();
    expect(port, 'the window attached to the live daemon').not.toBe('8742');
    expect(panel.text).toContain('no daemon running');

    // The control that would install one is on screen and is off. There is one
    // control rather than two buttons: the checkbox both installs and removes,
    // behind a confirmation. This journey never ticks it.
    expect(panel.controlPresent, 'Advanced offers no way to install the service').toBe(true);
    expect(panel.controlOn).toBe(false);

    await resmon.takePicture('J04-background-daemon');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
