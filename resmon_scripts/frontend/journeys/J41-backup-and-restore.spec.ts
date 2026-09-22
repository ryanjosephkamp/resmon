/**
 * J41 Backup and restore — a bundle restored into an empty state directory
 * through the real startup path brings the corpus back, and the app says what
 * it could not bring with it.
 *
 * This row had no Electron journey at the base commit: the backend test drives
 * the restore drill over every app table, and the Storage card had nothing at
 * all. The restore here is the user's, end to end — Back up now from the card,
 * a genuinely empty state directory, and then a *real start*, because
 * `/api/restore` deliberately moves nothing: it writes a pointer and the next
 * startup does the work. A journey that called the endpoint and stopped would
 * be testing the pointer.
 *
 * The invariant that matters most is the last one. A backup never contains a
 * credential value, so a restored resmon is missing things the person has to
 * re-enter, and it has to say which — a restore that came back quietly missing
 * its keys would look like a success and monitor nothing.
 */
import { expect, journey } from './driver';

journey.describe('J41 Backup and restore', () => {
  journey('a bundle restored into an empty state brings the counts back and names what it did not', async ({ resmon }) => {
    // Something worth backing up: a run, its papers, and a routine.
    const run = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], days: 30, cap: 20 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');
    await resmon.createRoutine({
      name: 'journey routine J41', cron: '0 9 * * *', sources: ['arxiv'], keywords: ['perovskite'],
    });

    const before = await resmon.backend.corpusCounts();
    expect(before.documents).toBeGreaterThan(0);
    expect(before.executions).toBeGreaterThan(0);
    expect(before.routines).toBeGreaterThan(0);

    const backup = await resmon.backUpNow({ reports: true });
    expect(backup.directory.length).toBeGreaterThan(0);
    expect(backup.manifest.includes_reports, 'reports were asked for and not included').toBe(true);

    // The manifest says what it left out, by name and never by value.
    const excluded = backup.manifest.excluded as { credentials: string[]; note: string };
    expect(Array.isArray(excluded.credentials)).toBe(true);
    expect(excluded.note).toContain('Credential values are never written into a backup');
    console.log(`[J41] manifest excludes ${excluded.credentials.length} credential names`);

    await resmon.restoreIntoFreshState(backup);

    const after = await resmon.backend.corpusCounts();
    expect(after, 'the restored corpus does not hold what the backup held').toEqual(before);

    const card = await resmon.readRestoreCard();
    expect(card.text).toContain('A backup was restored on this start.');
    // Either it names the entries, or it says there were none — never silence.
    if (excluded.credentials.length > 0) {
      expect(card.keyringEntries.sort()).toEqual([...excluded.credentials].sort());
    } else {
      expect(
        card.text,
        'the card neither named a credential nor said there were none',
      ).toContain('nothing to re-enter');
    }
    console.log(`[J41] counts before ${JSON.stringify(before)} / after ${JSON.stringify(after)}; `
      + `card names ${JSON.stringify(card.keyringEntries)}`);

    await resmon.takePicture('J41-restore-card');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
