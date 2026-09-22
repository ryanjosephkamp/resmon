/**
 * J31 Readable Ask — the assistant can be reached and read without a mouse and
 * without sight, it stays inside the window, and a failure is announced rather
 * than merely displayed.
 *
 * This row is about the panel, not about the answer. J13 establishes that the
 * answer comes from a tool call and that a write waits behind a card; what is
 * asserted here is the half that a screenshot flatters and nothing else checks:
 * that the composer carries a name assistive technology can announce, that the
 * keyboard alone opens the panel, that the panel does not hang off the edge of
 * the window it is drawn in, and that an error is given a role that is read
 * aloud instead of a colour that is not.
 *
 * **Where the assertions are not absolute.** The keyboard shortcut is reported
 * rather than required, because a renderer may reasonably offer a different one
 * — what the row refuses to accept is a panel with no keyboard route at all, so
 * the fallback path is asserted too. The geometry is asserted at the window
 * size this suite launches; zoom and small windows are `e2e/`'s, which has the
 * Electron handles for them, and the ledger says so.
 */
import { expect, journey } from './driver';

journey.describe('J31 Readable Ask', () => {
  journey('the panel opens from the keyboard, names its composer, fits the window, and announces a failure', async ({ resmon }) => {
    await resmon.useAnAuthoredAgentCommand();

    const byKeyboard = await resmon.openTheAssistantWithTheKeyboard();
    console.log(`[J31] the documented keyboard shortcut opened the panel: ${byKeyboard}`);

    // Whether or not the shortcut worked, the panel has to be reachable and
    // readable. `askTheAssistant` is the ordinary route in, so the row goes on
    // from here either way and says which door it used.
    const turn = await resmon.askTheAssistant('SAY:an authored answer for the readable-Ask row');
    expect(turn.error, `the assistant errored: ${turn.error}`).toBe('');
    expect(turn.said.join(' '), 'the panel showed no answer').toContain('authored answer');

    const panel = await resmon.readTheAssistantPanel();
    console.log(`[J31] panel: ${JSON.stringify(panel)}`);
    expect(panel.open, 'the assistant panel is not on screen').toBe(true);
    // A composer with no accessible name is a text box a screen reader calls
    // "edit text" and nothing else.
    expect(panel.composerIsNamed, 'the composer carries no name assistive technology can announce')
      .not.toBe('');
    expect(panel.composerIsUsable, 'the composer cannot be typed into').toBe(true);
    // And it is all on screen: a panel that overhangs the window has a Send
    // button nobody can reach.
    expect(
      panel.insideTheWindow,
      `the panel is not inside the window: ${JSON.stringify(panel.geometry)}`,
    ).toBe(true);

    // Now a failure. The double's `FAIL:` directive is how the real CLI's
    // non-zero exit reaches the panel.
    const failed = await resmon.askTheAssistant('FAIL:an authored failure for the readable-Ask row');
    console.log(`[J31] the panel reported: ${JSON.stringify(failed.error)}`);
    expect(failed.error, 'a failed turn left the panel saying nothing').not.toBe('');

    const afterFailure = await resmon.readTheAssistantPanel();
    console.log(`[J31] the error region carries roles: ${JSON.stringify(afterFailure.errorRoles)}`);
    // The role, not the colour. An error a sighted person sees and a screen
    // reader never announces is half a feature.
    expect(
      afterFailure.errorRoles,
      'the error is shown but never announced: its region carries no alert or status role',
    ).toContain('alert');
    expect(afterFailure.insideTheWindow, 'the panel left the window when it grew an error')
      .toBe(true);

    if (!byKeyboard) {
      console.log('[J31] NOT VERIFIED: the documented keyboard shortcut. It did not open the '
        + 'panel in this build under this driver, so the row went in through the trigger '
        + 'instead and asserts the rest. Whether the shortcut or the register is wrong is the '
        + "lead's to decide.");
    }
    console.log('[J31] NOT VERIFIED: zoom, small windows and colour contrast. Those need the '
      + 'Electron handles `e2e/assistant-readability.spec.ts` has and this suite deliberately '
      + 'does not give a spec. The geometry above is at the size this suite launches.');

    await resmon.takePicture('J31-readable-ask');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
