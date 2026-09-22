/**
 * J24 Google Drive backup — the tab says what it uploads, and with nothing
 * linked it reaches nothing.
 *
 * Two halves, and the second is the one that matters most. A backup tab that is
 * not linked to anything must not be quietly talking to Google: the journey
 * opens it, reads it, and then asserts the run's own connection guard refused
 * nothing — which is a statement about every socket the backend opened, not
 * about the two requests this spec happened to watch.
 *
 * **The register and the app disagree about the first half, and the spec
 * asserts the app.** The register says this tab states it backs up the database
 * only and is not the vault backup. It does not: this tab uploads the reports
 * folder, and the sentence about the database and the Library vault being a
 * pair lives on Settings → Storage. Both sentences are read here, each from the
 * tab that actually carries it, and the handback proposes the register wording.
 */
import { expect, journey } from './driver';

journey.describe('J24 Google Drive backup', () => {
  journey('the tab says what it uploads, and nothing leaves the machine while nothing is linked', async ({ resmon }) => {
    await resmon.open('Cloud Storage settings');
    const tabs = await resmon.readTabsHere();
    expect(tabs, 'Settings no longer offers a Cloud Storage tab').toContain('Cloud Storage');

    const help = await resmon.readTheHelpOnThisPage();
    console.log(`[J24] help: ${JSON.stringify(help.slice(0, 200))}`);
    // What this tab is for, in its own words. "Executed reports" is the claim
    // the code actually keeps: the endpoint uploads the reports directory.
    expect(help.toLowerCase()).toContain('report');

    const tab = await resmon.readWhatThisPlaceSays();
    expect(tab, 'the tab does not say whether Drive is connected').toContain('Not connected');
    expect(tab).toContain('Google Drive');
    // It does not claim to hold the corpus. This is the assertion that would
    // catch the tab growing a sentence it cannot keep.
    expect(
      /backs? up your database|Library vault/i.test(tab),
      'the Cloud Storage tab has started claiming it backs up the database or the vault',
    ).toBe(false);

    // The pair sentence, on the tab that does carry it. Read here rather than
    // taken on trust, because "this is not the vault backup" is only honest
    // while something else says what the vault backup is.
    await resmon.open('Storage settings');
    const storage = await resmon.readWhatThisPlaceSays();
    expect(storage, 'no tab states what a backup actually holds').toMatch(/Library vault/i);
    expect(storage).toMatch(/Credentials are never written into a backup/i);

    // Nothing linked, nothing reached. The guard is the whole run's, and it
    // refuses any socket that is not loopback — so this covers the startup, the
    // status poll and anything else the backend did while the tab was open.
    const status = await resmon.backend.routeInventory();
    expect(status).toContain('/api/cloud/status');
    expect(
      resmon.refusedConnections(),
      'something tried to leave the machine while no cloud account was linked',
    ).toEqual([]);

    await resmon.takePicture('J24-google-drive-backup');
  });
});
