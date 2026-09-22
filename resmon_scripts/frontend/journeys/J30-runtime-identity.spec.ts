/**
 * J30 Runtime identity — the header names the backend this window is actually
 * talking to, and it is this window's own.
 *
 * The register's invariant is narrow on purpose: runtime only, and a wrong
 * instance is never silently accepted. So the two things asserted are the two
 * that are checkable — the identifier on screen is the identifier the backend
 * reports for itself, and the process answering is a child of this window's own
 * Electron process rather than some other resmon that happened to be listening.
 *
 * That second half is the one B3 cares about. Port 8742 carries a live launchd
 * daemon over a real corpus, and "the port is the app's own" is the difference
 * between a suite that is isolated and a suite that is isolated by luck.
 */
import { expect, journey } from './driver';

journey.describe('J30 Runtime identity', () => {
  journey('the header identity is the backend’s own, and the backend is this window’s own', async ({ resmon }) => {
    const health = await resmon.backend.health();
    const runtimeId = String(health.identity?.runtime_id ?? '');
    expect(runtimeId.length, 'the backend reports no runtime identity').toBeGreaterThan(0);

    const header = await resmon.readConnectedIdentity();
    expect(header.status, `the header says "${header.status}"`).toContain('Connected');
    expect(
      header.details,
      'the header shows an identity the backend does not claim',
    ).toContain(runtimeId);

    // Runtime only: the register says corpus and build are not claimed, and the
    // header must not have quietly grown a claim about either.
    expect(header.status).not.toContain('stale');

    const port = await resmon.backend.port();
    expect(port, 'the window attached to the live daemon').not.toBe('8742');
    expect(port).toMatch(/^\d+$/);

    const owned = await resmon.backend.ownedByThisApp();
    if (owned === null) {
      console.log('[J30] NOT VERIFIED: this machine could not be asked who owns the backend process.');
    } else {
      expect(owned, `the backend on port ${port} is not this window’s own child process`).toBe(true);
    }
    console.log(`[J30] runtime ${runtimeId} on port ${port}; owned by this window: ${owned}`);

    await resmon.takePicture('J30-runtime-identity');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
