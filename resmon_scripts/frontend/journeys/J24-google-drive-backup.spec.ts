/**
 * J24 Google Drive backup — a backup written into the folder Google Drive for
 * desktop keeps, chosen on the screen that says where backups go, with
 * nothing signed in to Google.
 *
 * This row was resmon's own Google sign-in, uploading the reports folder to
 * Drive. That was retired (RK, 2026-10-30): resmon writes a backup into a
 * folder the person chooses, and Drive's own folder on this computer is the
 * one a person who wants a copy in Drive chooses. So the journey is the
 * screen telling them which folder that is, the folder chosen through it, a
 * backup written into it, and nothing leaving the machine.
 *
 * **What resmon establishes ends at the folder.** Google Drive for desktop
 * carries what is written there to Drive; this suite can see neither the
 * client nor Drive, and the app does not claim to. A folder of the session's,
 * laid out as that client lays out its own, stands in for it, and the run
 * says plainly that the sync itself is not verified.
 */
import { expect, journey } from './driver';

journey.describe('J24 Google Drive backup', () => {
  journey('a backup goes into Google Drive for desktop\'s folder, chosen on the screen, and nothing signs in to Google', async ({ resmon }) => {
    // Where backups go says how to keep a copy in Drive, and that resmon
    // does not sign in to Google to do it.
    await resmon.open('Storage settings');
    const place = await resmon.readWhatThisPlaceSays();
    expect(place, 'the screen where backups go does not say how to keep one in Google Drive')
      .toContain('Google Drive for desktop');
    expect(place).toContain('does not sign in to Google');
    expect(await resmon.readTabsHere(), 'Settings still offers the Google sign-in').not.toContain('Cloud Storage');

    const drive = await resmon.chooseGoogleDrivesFolderForBackups();
    const backup = await resmon.backUpNow({ reports: true });
    expect(backup.directory.startsWith(`${drive}/`) || backup.directory.startsWith(`${drive}\\`),
      `the backup was written to ${backup.directory}, not into ${drive}`).toBe(true);
    // The database, which the old upload never sent, and the reports with it.
    const files = (backup.manifest.files as { path: string }[]).map((f) => f.path);
    expect(files, 'the backup holds no database').toContain('resmon.db');
    expect(backup.manifest.includes_reports, 'reports were asked for and not included').toBe(true);
    console.log(`[J24] backup written into the stand-in Drive folder: ${files.length} files`);

    // Gone from the engine as well as the screens.
    const routes = await resmon.backend.routeInventory();
    expect(routes.filter((route) => route.includes('/api/cloud/')), 'the engine still serves the Google sign-in')
      .toEqual([]);
    expect(resmon.refusedConnections(), 'something tried to leave the machine').toEqual([]);
    console.log('[J24] NOT VERIFIED: that Google Drive for desktop syncs the folder. resmon writes into it; '
      + 'the sync client and Drive are outside what this suite can see.');

    await resmon.takePicture('J24-google-drive-backup');
  });
});
