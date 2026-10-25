/**
 * J21 Saved configurations — what a person saves comes back out of the file the
 * app wrote, that file carries no secret, and a routine imported from it
 * arrives inactive whatever the file says.
 *
 * **This row was green for as long as its journey was broken.** It saved a
 * configuration with a POST, exported, read the members out of the archive
 * itself, and then imported a JSON string the spec had built — for a different
 * configuration. So the step that failed a real person, handing the exported
 * file back to Import, never happened here, and the row passed while Import
 * refused every archive Export Selected had ever written. #199 fixed Import;
 * this is the journey that would have caught it.
 *
 * So each step is the person's, and each step's input is the step before's
 * output. The configuration is saved with Deep Sweep's own Save Configuration
 * button, exported with Export Selected, and the archive the app wrote — that
 * path, those bytes — is what Import is handed. The driver will not take
 * anything else: its import takes an export, not text, and a spec in this
 * directory cannot write a file of its own. What comes back is compared with
 * what the app stored when the button was pressed, field by field.
 *
 * Two invariants ride on the round trip. The export is searched member by
 * member for anything shaped like a credential, because the compressed bytes
 * on disk would hide one. And a routine that is active here is exported, so
 * the file says `"is_active": true` — an import that believed the file would
 * bring the copy back armed, on a schedule nobody chose on this machine. It
 * must arrive inactive, and the original must be left as it was.
 *
 * **What is not the person's is printed where it happens.** The routine is
 * created over the API, as every routine in this suite is; and the native file
 * dialog is answered with the file rather than operated, because nothing
 * automated can operate one. What that dialog would have offered is still
 * read — the page's own `accept` list — and must admit the archive, because a
 * dialog that greys the file out is a round trip nobody can make.
 *
 * **The classic leg.** This spec also runs against the frozen `classic`
 * build, v2.3.0, whose Import refuses this archive: the defect #199 fixed. That
 * build cannot change, so failing on it would turn its leg red on every pull
 * request that touches this suite and say nothing new. Where the build under
 * test is *not* this checkout and the refusal is that build's own, word for
 * word, the spec prints it as NOT VERIFIED and stops before the round trip.
 * This checkout is never given that: here a refusal of any kind fails the row,
 * which is how the row's red was produced — against this checkout with #199's
 * import side reverted.
 */
import { buildUnderTest, expect, journey } from './driver';

const SWEEP = 'journey sweep J21';
const ROUTINE = 'journey routine J21';

/**
 * v2.3.0's refusal of the archive its own Export Selected wrote, in that
 * build's words: `Invalid file type: <name>.zip. Only .json files accepted.`
 */
const V2_3_0_REFUSES_THE_ARCHIVE = /Only \.json files accepted\./;

/** Field names a credential would travel under. None belongs in an export. */
const CREDENTIAL_SHAPED = ['api_key', 'apikey', 'credential', 'secret', 'token', 'bearer'];

/** A record field the API may hand back either parsed or as JSON text. */
function asObject(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * Whether a chooser told to offer `accepts` would offer this file.
 *
 * An empty list filters nothing. Otherwise an entry is an extension or a
 * media type, and either may admit the archive.
 */
function theChooserOffers(accepts: string, file: string): boolean {
  const entries = accepts.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) return true;
  const name = file.toLowerCase();
  return entries.some((entry) => (entry.startsWith('.') && name.endsWith(entry))
    || ['*', '*/*', 'application/*', 'application/zip', 'application/x-zip-compressed'].includes(entry));
}

function expectNoCredentialIn(members: Record<string, string>, what: string): void {
  const text = Object.values(members).join('\n').toLowerCase();
  for (const field of CREDENTIAL_SHAPED) {
    expect(text, `the ${what} export carries a "${field}" field`).not.toContain(field);
  }
}

journey.describe('J21 Saved configurations', () => {
  journey('save, export, and hand that exact file to Import: the same configuration comes back, and a routine comes back inactive', async ({ resmon }) => {
    // — saved from the form ---------------------------------------------------
    const savedId = await resmon.saveConfiguration(SWEEP, {
      // A key-required source on purpose: if a credential were ever going to
      // ride along in a saved configuration, this is the one it would ride in.
      sources: ['arxiv', 'springer'],
      query: 'perovskite',
    });
    const saved = (await resmon.backend.configurations()).find((c) => Number(c.id) === savedId);
    expect(saved, 'the configuration the form saved is not in the app').toBeTruthy();
    expect(saved!.config_type).toBe('manual_sweep');
    expect(saved!.parameters.repositories, 'the form saved other sources than the ones ticked')
      .toEqual(['arxiv', 'springer']);
    console.log(`[J21] Save Configuration stored #${savedId}: ${JSON.stringify(saved!.parameters)}`);

    // — exported ----------------------------------------------------------------
    const manual = await resmon.exportConfigurations('manual');
    const memberNames = Object.keys(manual.members);
    console.log(`[J21] Export Selected wrote ${manual.path}, holding ${memberNames.join(', ')}`);
    expect(memberNames, 'the export holds something other than the one configuration saved')
      .toHaveLength(1);
    expect(JSON.parse(manual.members[memberNames[0]]).name).toBe(SWEEP);
    expectNoCredentialIn(manual.members, 'manual');

    // — that file, handed back -------------------------------------------------
    const back = await resmon.importConfigurations(manual);
    console.log(`[J21] Import was handed ${manual.path}. The chooser offered `
      + `${JSON.stringify(back.chooserAccepts)}; the page said ${JSON.stringify(back.said)} `
      + `and refused ${JSON.stringify(back.refusal)}; ${back.arrived} configuration(s) arrived.`);

    const build = buildUnderTest();
    if (back.refusal && !build.thisCheckout && V2_3_0_REFUSES_THE_ARCHIVE.test(back.refusal)) {
      console.log(
        '[J21] NOT VERIFIED (importConfigurations): the round trip, on this build. The build under '
        + `test is ${build.frontend}, which is not this checkout, and its Import refused the archive `
        + `its own Export Selected wrote: ${JSON.stringify(back.refusal)}. That is the refusal v2.3.0 `
        + `gives and #199 fixed; the chooser was told to offer ${JSON.stringify(back.chooserAccepts)}. `
        + 'Nothing after the import — the configuration coming back, the routine arriving inactive — '
        + 'was measured on this build.',
      );
      expect(back.arrived, 'a refused import still created configurations').toBe(0);
      expect(resmon.refusedConnections()).toEqual([]);
      return;
    }

    expect(back.refusal, 'Import refused the archive Export Selected wrote').toBe('');
    expect(back.said, 'Import did not say what it imported').toMatch(/^Imported 1 configuration/);
    expect(back.arrived, 'not every configuration in the archive arrived').toBe(memberNames.length);
    expect(
      theChooserOffers(back.chooserAccepts, manual.path),
      `the chooser was told to offer ${JSON.stringify(back.chooserAccepts)}, which leaves out the archive `
      + 'Export Selected writes — a person could not have picked it',
    ).toBe(true);

    const returned = (await resmon.backend.configurations())
      .filter((c) => c.name === SWEEP && Number(c.id) !== savedId);
    expect(returned, 'the import did not bring the saved configuration back as a row of its own')
      .toHaveLength(1);
    expect(returned[0].config_type).toBe(saved!.config_type);
    expect(returned[0].parameters, 'the configuration that came back is not the one that was saved')
      .toEqual(saved!.parameters);

    // — a routine, active here, through the same round trip ------------------------
    await resmon.createRoutine({
      name: ROUTINE, cron: '0 9 * * *', sources: ['arxiv'], keywords: ['perovskite'],
    });
    await resmon.activateRoutine(ROUTINE);
    const original = (await resmon.backend.routines()).find((r) => r.name === ROUTINE);
    expect(original, 'the routine this row activated is not in the app').toBeTruthy();

    const routines = await resmon.exportConfigurations('routine');
    const routineMembers = Object.keys(routines.members);
    console.log(`[J21] Export Selected wrote ${routines.path}, holding ${routineMembers.join(', ')}`);
    expectNoCredentialIn(routines.members, 'routine');
    const claim = Object.values(routines.members).map((m) => JSON.parse(m))
      .find((m) => m.name === ROUTINE);
    expect(claim, 'the routine export does not carry the routine').toBeTruthy();
    // The file has to say "active", or an inactive arrival proves nothing about
    // whether the import believed it.
    expect(claim.is_active, 'the export does not say the routine is active').toBe(true);

    const routinesBefore = await resmon.backend.routines();
    const routineBack = await resmon.importConfigurations(routines);
    console.log(`[J21] Import was handed ${routines.path}; the page said `
      + `${JSON.stringify(routineBack.said)} and refused ${JSON.stringify(routineBack.refusal)}.`);
    expect(routineBack.refusal, 'Import refused the archive Export Selected wrote').toBe('');
    expect(routineBack.arrived, 'not every configuration in the archive arrived')
      .toBe(routineMembers.length);

    const routinesAfter = await resmon.backend.routines();
    const created = routinesAfter.filter((r) => !routinesBefore.some((b) => b.id === r.id));
    expect(created, 'importing a routine configuration created no routine of its own').toHaveLength(1);
    expect(
      Boolean(created[0].is_active),
      'an imported routine arrived active, on a schedule its file chose',
    ).toBe(false);
    expect(created[0].name).toBe(ROUTINE);
    expect(created[0].schedule_cron, 'the imported routine fires on another schedule')
      .toBe(original!.schedule_cron);
    expect(asObject(created[0].parameters), 'the imported routine searches for something else')
      .toEqual(asObject(original!.parameters));
    expect(
      Boolean(routinesAfter.find((r) => r.id === original!.id)?.is_active),
      'importing a copy changed the routine it was exported from',
    ).toBe(true);
    expect(
      (await resmon.listRoutineNames()).filter((name) => name === ROUTINE),
      'the Routines page does not list the imported routine beside the original',
    ).toHaveLength(2);

    console.log(
      '[J21] NOT VERIFIED (importConfigurations): a person picking the archive in the native file '
      + 'dialog. Nothing automated can operate one, so both times the chooser was answered with the '
      + 'file the export wrote. What the dialog would have been told to offer was read instead — '
      + `${JSON.stringify(back.chooserAccepts)}, which admits the archive — and how any one `
      + "platform's dialog draws that list is not observed here.",
    );
    console.log(
      '[J21] NOT VERIFIED (createRoutine): building the routine in the Routines editor. It was '
      + 'created over the API, as every routine in this suite is — the driver has no other verb '
      + "that makes one — and then activated with its own row's button, which is what put "
      + '"is_active": true into the file.',
    );

    await resmon.takePicture('J21-saved-configurations-round-trip');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
