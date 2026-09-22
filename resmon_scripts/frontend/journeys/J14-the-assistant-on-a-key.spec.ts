/**
 * J14 The assistant on a key — the person brings their own endpoint and their
 * own key, the answer comes back through it, and the key itself goes exactly
 * one place.
 *
 * J13 is the other lane: a CLI the person already signed into. This one is the
 * lane where resmon is holding a secret, and that is what makes the row worth
 * a journey rather than a unit test. Three claims, and the third is the one
 * that matters:
 *
 *   1. the lane runs at all — an answer arrives, through the endpoint the
 *      person named rather than through anything resmon chose;
 *   2. the request is the one the provider's own protocol expects, carrying the
 *      model the person asked for;
 *   3. **the key reaches the provider and nothing else.** It is not in the
 *      settings the app serves back, it is not on the screen, and it is not in
 *      the conversation resmon saved.
 *
 * **What is authored.** A model provider on loopback that speaks the openai
 * family, which is the family the catalog gives the `custom` provider — and
 * `custom` is the only provider whose base URL a person can set, so it is also
 * the only one a journey can point anywhere. What it replaces is the model. The
 * settings are written through the app's own routes, the credential through the
 * app's own credential route into the same in-memory store every journey uses,
 * and it is the app's own code that reads the key back out when it builds the
 * request. What no authored provider can see is a real provider's behaviour —
 * a rate limit, a model that was withdrawn — and the ledger says so.
 */
import { expect, journey } from './driver';

/** Never a real key, and long and odd enough that finding it anywhere is proof. */
const KEY = 'journey-authored-key-8f31a6-never-real';
const MODEL = 'authored-journey-model';
const ANSWER = 'the authored provider answered this journey on a key';

journey.describe('J14 The assistant on a key', () => {
  journey('the answer comes back through the endpoint the person named, and the key goes only there', async ({ resmon }) => {
    await resmon.useAnAuthoredProviderOnAKey({ answer: ANSWER, key: KEY, model: MODEL });

    const turn = await resmon.askTheAssistant('a question for the key lane');
    console.log(`[J14] said: ${JSON.stringify(turn.said)}`);
    expect(turn.error, `the key lane errored: ${turn.error}`).toBe('');
    expect(turn.said.join(' '), 'the answer did not come from the authored provider')
      .toContain(ANSWER);

    // The request the provider actually received.
    const calls = await resmon.readWhatTheProviderReceived();
    console.log(`[J14] the provider received ${calls.length} request(s); `
      + `paths ${JSON.stringify(calls.map((c) => c.path))}, `
      + `models ${JSON.stringify(calls.map((c) => c.model))}`);
    expect(calls.length, 'the authored provider was never asked anything').toBeGreaterThan(0);
    const first = calls[0];
    expect(first.path, 'the app did not use the provider protocol it said it would')
      .toContain('/chat/completions');
    expect(first.model, 'the app asked for a different model than the person chose')
      .toBe(MODEL);
    // The key went to the provider, as the provider's own protocol carries it.
    expect(first.authorization, 'the request carried no credential at all').not.toBeNull();
    expect(first.authorization, 'the key did not reach the provider it was stored for')
      .toContain(KEY);

    // And nowhere else. The settings the app serves back are what the AI tab
    // renders from, so a key present here is a key on somebody's screen.
    const settings = await resmon.readAssistantSettings();
    console.log(`[J14] the assistant settings the app serves: ${JSON.stringify(settings)}`);
    expect(JSON.stringify(settings), 'the key came back in the settings the app serves')
      .not.toContain(KEY);

    const onScreen = await resmon.readWhatThisPlaceSays();
    expect(onScreen, 'the key is on screen').not.toContain(KEY);
    await resmon.open('AI settings');
    const aiTab = await resmon.readWhatThisPlaceSays();
    expect(aiTab, 'the key is printed on the AI settings tab').not.toContain(KEY);

    // Nor in what resmon kept of the conversation. A transcript that carried
    // the key would put it in every export.
    const chats = await resmon.readTheChatsPage();
    expect(chats.length, 'the conversation was not saved at all').toBeGreaterThan(0);
    const saved = await resmon.openTheSavedChat(chats[0]);
    expect(saved.text, 'the key is in the saved conversation').not.toContain(KEY);
    const exported = await resmon.exportTheOpenChat('json');
    expect(exported, 'the key is in the exported conversation').not.toContain(KEY);
    console.log(`[J14] the saved conversation and its ${exported.length}-byte export carry no key`);

    console.log('[J14] NOT VERIFIED: a real provider\'s own behaviour — a rate limit, a model '
      + 'that was withdrawn, an account whose billing lapsed. What this row replaces is the '
      + 'model; that stays with the live suite.');

    await resmon.takePicture('J14-the-assistant-on-a-key');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
