/**
 * J21 Saved configurations — no secret leaves in an export, and an imported
 * routine arrives deactivated.
 *
 * The second half is the one that matters most and it had no behavioural test
 * at the base commit. "Import never starts anything firing" is a promise about
 * a file somebody else may have written, so the file this journey imports
 * *says* the routine is active. If the import trusted the file, the routine
 * would come back armed on somebody else's schedule — which is the whole reason
 * the invariant is written down.
 *
 * The export half is read out of the members of the file the app wrote, not out
 * of its compressed bytes: a search for a secret in a deflate stream is a check
 * that passes for the wrong reason.
 */
import { expect, journey } from './driver';

journey.describe('J21 Saved configurations', () => {
  journey('an export carries no key, and an imported routine arrives inactive', async ({ resmon }) => {
    await resmon.saveConfiguration('journey sweep J21', {
      // A key-required source on purpose: if a credential were ever going to
      // ride along in a saved configuration, this is the configuration it would
      // ride in.
      sources: ['arxiv', 'springer'],
      query: 'perovskite',
    });

    const members = await resmon.exportConfigurations();
    expect(Object.keys(members).length, 'the export contains nothing').toBeGreaterThan(0);
    const text = Object.values(members).join('\n');
    expect(text, 'the export does not contain the configuration it was asked for').toContain('springer');
    for (const forbidden of ['api_key', 'apiKey', 'credential', 'secret', 'token', 'Bearer']) {
      expect(
        text.toLowerCase(),
        `the exported configuration carries a "${forbidden}" field`,
      ).not.toContain(forbidden.toLowerCase());
    }
    console.log(`[J21] exported ${Object.keys(members).length} members: ${Object.keys(members).join(', ')}`);

    // A file that claims the routine is running. It is not this app's file and
    // nothing about it may be believed.
    const before = await resmon.backend.routines();
    const arrived = await resmon.importConfigurations(JSON.stringify({
      config_type: 'routine',
      name: 'journey imported routine J21',
      schedule_cron: '*/5 * * * *',
      is_active: true,
      email_enabled: true,
      execution_location: 'cloud',
      parameters: { repositories: ['arxiv'], keywords: ['perovskite'], query: 'perovskite', max_results: 10 },
    }, null, 2));
    expect(
      arrived,
      'the import created no configuration — the file was read and refused',
    ).toBeGreaterThan(0);

    const after = await resmon.backend.routines();
    const created = after.filter((r) => !before.some((b) => b.id === r.id));
    expect(created.length, 'importing a routine configuration created no routine').toBe(1);
    expect(
      Boolean(created[0].is_active),
      'an imported routine arrived active, on a schedule its file chose',
    ).toBe(false);
    expect(await resmon.listRoutineNames()).toContain(String(created[0].name));

    await resmon.takePicture('J21-saved-configurations-import');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
