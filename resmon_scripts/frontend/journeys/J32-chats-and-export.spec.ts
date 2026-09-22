/**
 * J32 Chats and export — a conversation that happened is still there on its own
 * page, it says what it does not know about itself, and it leaves as a file
 * whose contents are the conversation.
 *
 * The three halves are separate claims and each is asserted where its evidence
 * is. That the chat is listed is the Chats page. That the transcript is the
 * conversation is the bubbles, compared against what was actually said. That
 * the export is real is the bytes on disk, from a real Electron download with
 * only the destination picker replaced — the request, the serializer and the
 * bytes are the app's own.
 *
 * **The sentence this row exists to protect.** An open transcript says
 * `Historical completion unknown.` resmon stores what was persisted, and it
 * cannot know whether a conversation ended or was interrupted; a page that
 * quietly presented the saved messages as the whole conversation would be
 * claiming something it never observed. That sentence is asserted literally.
 *
 * **The runtime is the repository's own agent-CLI double**, as J13's is: it
 * speaks the real protocol over real HTTP against this app's backend, and what
 * it replaces is the model. What no double can see is a real CLI's own
 * behaviour, and the ledger says so.
 */
import { expect, journey } from './driver';

/** What the assistant is made to say, and therefore what must survive to disk. */
const SAID = 'the authored assistant answer this journey exports';

journey.describe('J32 Chats and export', () => {
  journey('a conversation is listed, reads back as itself, and exports as a file that carries it', async ({ resmon }) => {
    await resmon.useAnAuthoredAgentCommand();
    const turn = await resmon.askTheAssistant(`SAY:${SAID}`);
    expect(turn.error, `the assistant errored: ${turn.error}`).toBe('');
    expect(turn.said.join(' '), 'the assistant did not say what it was asked to')
      .toContain(SAID);

    // It is on the Chats page, not only in the assistant's own drawer.
    const listed = await resmon.readTheChatsPage();
    console.log(`[J32] the Chats page lists ${listed.length}: ${JSON.stringify(listed)}`);
    expect(listed.length, 'a conversation that happened is not on the Chats page')
      .toBeGreaterThan(0);

    const open = await resmon.openTheSavedChat(listed[0]);
    console.log(`[J32] transcript bubbles: ${JSON.stringify(open.said)}`);
    expect(open.title, 'the open chat is not the one that was clicked').toBe(listed[0]);
    expect(open.said.join(' '), 'the transcript is not the conversation that happened')
      .toContain(SAID);
    // The honesty sentence, literally. This is the claim resmon refuses to make.
    expect(open.text, 'the transcript presents saved messages as a finished conversation')
      .toContain('Historical completion unknown.');

    // Out as a file, twice, in both formats the page offers.
    const markdown = await resmon.exportTheOpenChat('markdown');
    console.log(`[J32] the Markdown export is ${markdown.length} bytes`);
    expect(markdown, 'the exported Markdown does not carry what was said').toContain(SAID);

    const json = await resmon.exportTheOpenChat('json');
    console.log(`[J32] the JSON export is ${json.length} bytes`);
    const parsed = JSON.parse(json) as { messages?: unknown[] };
    expect(
      Array.isArray(parsed.messages) && parsed.messages.length,
      'the exported JSON carries no messages',
    ).toBeTruthy();
    expect(json, 'the exported JSON does not carry what was said').toContain(SAID);

    // And the conversation is still the same conversation after the window has
    // been closed and opened again — which is the whole point of saving it.
    await resmon.reopenTheApp();
    const afterwards = await resmon.readTheChatsPage();
    console.log(`[J32] after a relaunch the Chats page lists ${JSON.stringify(afterwards)}`);
    expect(afterwards, 'the saved chats changed across a relaunch').toEqual(listed);

    console.log('[J32] NOT VERIFIED: a real agent CLI\'s own behaviour. The runtime here is the '
      + 'repository\'s double; what it replaces is the model. A version change or a lapsed '
      + 'sign-in in the real command is invisible to this row.');

    await resmon.takePicture('J32-chats-and-export');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
