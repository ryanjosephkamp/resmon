/**
 * J33 Composer choices — the model a person picks for one conversation is the
 * model that conversation keeps, on the command line, on reopen and in the
 * export, whatever the app's defaults do afterwards.
 *
 * The runtime is the repository's own agent-CLI double, the same one J13 and
 * J31 drive. What it replaces is the model. The argv, the spawn, the stored
 * choices, the transcript and the export are the app's own.
 *
 * Four claims, and each is asserted where its evidence actually is.
 *
 * **What was asked for is what was sent.** The transcript can only report what
 * the app believes it sent, so the row reads the command line instead: a
 * recording shim in front of the same double keeps every argument list, and the
 * model on it has to be the one that was typed into the composer.
 *
 * **Fixed means fixed.** After the first turn the composer stops taking input
 * for that conversation, and changing the app-wide default on Settings → AI
 * afterwards does not reach back into it — not in the next turn's argv, not in
 * what the transcript says was requested.
 *
 * **Requested and reported are two claims, not one.** The app keeps them apart:
 * what the person chose, and what the runtime announced about itself. A row
 * that read only one could not tell a pinned choice from a substitution, so
 * this reads both and requires the disclosure to carry both.
 *
 * **It survives the window closing.** Reopened, found on the Chats page and
 * exported, the conversation still names the chosen model and never the
 * default that replaced it.
 *
 * **What this row does not establish**, printed below: that a *real* `claude`
 * would honour `--model`. The double echoes the flag it is given, which is what
 * makes "no substitution by resmon" measurable and says nothing about what a
 * runtime does with a model it does not have. That half is the live suite's.
 */
import { expect, journey } from './driver';

/** The conversation's own model. Not one of the app's offered defaults. */
const CHOSEN_MODEL = 'journey-chosen-model';
const CHOSEN_EFFORT = 'high';

/** What the app-wide default is moved to afterwards, from `MODEL_CHOICES`. */
const LATER_DEFAULT_MODEL = 'haiku';
const LATER_DEFAULT_EFFORT = 'low';

journey.describe('J33 Composer choices', () => {
  journey('the chosen model is pinned to the turn, on the command line and in the export', async ({ resmon }) => {
    await resmon.useAnAuthoredAgentCommandThatRecordsItsArguments();

    const chosen = await resmon.fixTheChoicesForThisConversation({
      model: CHOSEN_MODEL, effort: CHOSEN_EFFORT,
    });
    console.log(`[J33] the composer was set to ${JSON.stringify(chosen)}`);
    expect(chosen.model).toBe(CHOSEN_MODEL);
    expect(chosen.effort).toBe(CHOSEN_EFFORT);
    expect(chosen.stillChangeable, 'a conversation that has not started already fixed its choices')
      .toBe(true);
    expect(chosen.fixedAs, 'the panel claims to have fixed a conversation that has not started')
      .toBe('');

    const first = await resmon.askTheAssistant('SAY:the first turn of J33');
    expect(first.error, 'the authored runtime refused the turn').toBe('');
    expect(first.said.join(' ')).toContain('the first turn of J33');

    // What was actually asked for, on the command line the app built.
    const afterFirst = await resmon.readWhatTheAgentCommandReceived();
    console.log(`[J33] the agent command was run ${afterFirst.length} time(s); `
      + `the first carried ${JSON.stringify(afterFirst[0])}`);
    expect(afterFirst, 'the app never ran the agent command').not.toEqual([]);
    for (const argv of afterFirst) {
      expect(argv[argv.indexOf('--model') + 1], 'a turn was sent with a model nobody chose')
        .toBe(CHOSEN_MODEL);
      expect(argv[argv.indexOf('--effort') + 1], 'a turn was sent with an effort nobody chose')
        .toBe(CHOSEN_EFFORT);
    }

    // The conversation has now fixed them, and says so by refusing the controls.
    const afterStarting = await resmon.readTheComposerChoices();
    console.log(`[J33] once the conversation had started: ${JSON.stringify(afterStarting)}`);
    expect(afterStarting.stillChangeable, 'the composer still took a new model for a started conversation')
      .toBe(false);
    expect(afterStarting.fixedAs, 'the panel does not say what it fixed this conversation to')
      .toContain(CHOSEN_MODEL);
    expect(afterStarting.fixedAs).toContain(CHOSEN_EFFORT);

    // Somebody changes their defaults afterwards. That is a statement about the
    // next conversation, not about this one.
    await resmon.setTheAppWideAssistantDefaults({
      model: LATER_DEFAULT_MODEL, effort: LATER_DEFAULT_EFFORT,
    });
    const second = await resmon.askTheAssistant('SAY:the second turn of J33');
    expect(second.error, 'the authored runtime refused the second turn').toBe('');

    const afterSecond = await resmon.readWhatTheAgentCommandReceived();
    console.log(`[J33] after the app-wide default moved to ${LATER_DEFAULT_MODEL}, `
      + `the agent command had been run ${afterSecond.length} time(s)`);
    expect(afterSecond.length, 'the second turn never reached the runtime')
      .toBeGreaterThan(afterFirst.length);
    for (const argv of afterSecond) {
      expect(argv[argv.indexOf('--model') + 1], 'a turn silently took the new app-wide default')
        .toBe(CHOSEN_MODEL);
      expect(argv[argv.indexOf('--effort') + 1], 'a turn silently took the new app-wide effort')
        .toBe(CHOSEN_EFFORT);
    }

    // Requested and reported, side by side, for every turn the panel shows.
    const live = await resmon.readTheTurnsChoices();
    console.log(`[J33] the panel discloses ${live.length} turn(s): ${JSON.stringify(live)}`);
    expect(live.length, 'the panel discloses nothing about what either turn asked for')
      .toBeGreaterThanOrEqual(1);
    for (const turn of live) {
      expect(turn.requested).toContain(CHOSEN_MODEL);
      expect(turn.requested).toContain(CHOSEN_EFFORT);
      expect(turn.requested, 'the disclosure names the later default as what was requested')
        .not.toContain(LATER_DEFAULT_MODEL);
      // The runtime's own announcement, kept as a separate claim. The double
      // echoes the flag it was handed, so these agree here — and the row's
      // point is that the app shows them as two lines rather than one.
      expect(turn.reported.join(' '), 'the turn reports no runtime model at all')
        .toContain(CHOSEN_MODEL);
      expect(turn.text, 'the disclosure does not separate what was requested from what answered')
        .toMatch(/Runtime-reported model/i);
    }

    // Close the window, open it again, and find the conversation where a person
    // would: the Chats page.
    await resmon.reopenTheApp();
    await resmon.open('Chats');
    const saved = await resmon.readTheChatsPage();
    console.log(`[J33] after a relaunch the Chats page lists: ${JSON.stringify(saved)}`);
    const transcript = await resmon.openTheSavedChat('the first turn of J33');
    expect(transcript.said.join(' ')).toContain('the first turn of J33');

    const reopened = await resmon.readTheTurnsChoices();
    console.log(`[J33] the saved conversation discloses ${reopened.length} turn(s): `
      + JSON.stringify(reopened));
    expect(reopened.length, 'the saved conversation discloses nothing about its choices')
      .toBeGreaterThanOrEqual(1);
    for (const turn of reopened) {
      expect(turn.requested).toContain(CHOSEN_MODEL);
      expect(turn.requested, 'a reopened turn shows the app-wide default as its own choice')
        .not.toContain(LATER_DEFAULT_MODEL);
    }

    const exported = await resmon.exportTheOpenChat('json');
    expect(exported, 'the export does not carry the model the conversation was pinned to')
      .toContain(CHOSEN_MODEL);
    const asJson = JSON.parse(exported) as {
      choices?: { requested_model?: string | null };
      turn_choices?: { requested?: { requested_model?: string | null } }[];
    };
    console.log(`[J33] the export's own choices: ${JSON.stringify(asJson.choices)}`);
    expect(asJson.choices?.requested_model).toBe(CHOSEN_MODEL);
    for (const turn of asJson.turn_choices ?? []) {
      expect(turn.requested?.requested_model,
        'an exported turn carries a model the person never chose for it').toBe(CHOSEN_MODEL);
    }

    console.log('[J33] NOT VERIFIED: that a real `claude` honours `--model`. The runtime here is '
      + 'the repository\'s own double, which echoes the flag it is handed — which is what makes '
      + '"resmon substituted nothing" measurable and says nothing about what a real CLI does with '
      + 'a model an account does not have. That half belongs to the live suite.');
    console.log('[J33] NOT VERIFIED: the API-key connection\'s half of this row. The composer '
      + 'offers a second connection whose adapter has no effort at all, and this row drives the '
      + 'CLI one end to end. The API lane\'s own pinning is `e2e/composer-choices.spec.ts`.');

    await resmon.takePicture('J33-composer-choices');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
