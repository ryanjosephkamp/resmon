/**
 * J13 The assistant (CLI lane) — the answer comes from a tool call, a write is
 * held behind a card showing the exact call, Deny changes nothing, and the
 * conversation is still there after the window closes.
 *
 * The card is the whole row. An assistant that can write to somebody's corpus
 * has to show them the call it is about to make, in the call's own words, and
 * then wait. "Showing the exact call" is asserted literally — the card's `pre`
 * is compared against the arguments this journey sent, formatted the way the
 * card formats them — because a card that paraphrased would be a card a person
 * could not check.
 *
 * And Deny is asserted over the API, not over the screen. A panel that removes
 * the card and a backend that ran the tool anyway would look identical from the
 * renderer, so the assertion is the routine list before and after.
 *
 * **The runtime is the repository's own agent-CLI double.** It speaks the real
 * protocol, asks for permission over real HTTP against this app's own backend,
 * and makes its tool call through the real MCP server. What it replaces is the
 * model. What no double can see is a real CLI's own behaviour — a version
 * change, a sign-in that has lapsed — and the ledger says so.
 */
import { expect, journey } from './driver';

const ROUTINE = {
  name: 'Journey assistant routine',
  schedule: '0 7 * * 1',
  repositories: ['arxiv'],
  keywords: ['perovskite'],
};

journey.describe('J13 The assistant (CLI lane)', () => {
  journey('the answer comes from a tool call, the write waits behind its own call, and Deny leaves the backend alone', async ({ resmon }) => {
    await resmon.useAnAuthoredAgentCommand();

    // A read first: the answer has to come from a tool call rather than from
    // the model's recollection, and the panel has to show which tool ran.
    const read = await resmon.askTheAssistant('SAY:the corpus is empty\nCALL:list_sources {}');
    console.log(`[J13] said: ${JSON.stringify(read.said)}`);
    console.log(`[J13] tool calls: ${JSON.stringify(read.toolCalls)}`);
    expect(read.error, `the assistant errored: ${read.error}`).toBe('');
    expect(read.toolCalls, 'the answer arrived without a tool call').toContain('list_sources');
    // The tool row is the property: the panel shows which tool ran, by name,
    // rather than presenting an answer with no account of where it came from.
    // What the runtime *said* alongside it is the double's script, and this row
    // does not turn the double's script into a claim about the app.

    // Now a write. The card must appear, and it must carry the call.
    const before = await resmon.backend.routines();
    const held = await resmon.askTheAssistant(
      `CALL:create_routine ${JSON.stringify(ROUTINE)}`,
    );
    console.log(`[J13] card title: ${JSON.stringify(held.approvalTitle)}`);
    console.log(`[J13] card call: ${JSON.stringify(held.approvalCall)}`);
    expect(held.approvalCall, 'a write was not held behind an approval card').not.toBe('');
    // The exact call, formatted as the card formats it. Not a paraphrase.
    expect(held.approvalCall).toBe(`create_routine(${JSON.stringify(ROUTINE, null, 2)})`);
    expect(held.approvalTitle, 'the card does not say what the call would do')
      .toContain(ROUTINE.name);

    // Deny. The screen dropping the card proves nothing; the backend does.
    const denied = await resmon.answerTheApprovalCard(false);
    const after = await resmon.backend.routines();
    console.log(`[J13] routines before ${before.length}, after ${after.length}`);
    expect(after, 'Deny left the backend changed').toEqual(before);
    expect(
      after.map((routine) => routine.name),
      'the routine the assistant was denied was created anyway',
    ).not.toContain(ROUTINE.name);
    expect(denied.approvalCall, 'the card is still being held after an answer').toBe('');

    // And the conversation survives the window closing. Two turns went through
    // it, so a drawer that came back empty would be a lost conversation rather
    // than an empty one.
    const titlesBefore = await resmon.readSavedConversations();
    await resmon.reopenTheApp();
    const titlesAfter = await resmon.readSavedConversations();
    console.log(`[J13] conversations before ${JSON.stringify(titlesBefore)}, after ${JSON.stringify(titlesAfter)}`);
    expect(titlesAfter.length, 'no conversation survived the relaunch').toBeGreaterThan(0);
    expect(titlesAfter, 'the conversation changed across a relaunch').toEqual(titlesBefore);

    await resmon.takePicture('J13-the-assistant-cli-lane');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
