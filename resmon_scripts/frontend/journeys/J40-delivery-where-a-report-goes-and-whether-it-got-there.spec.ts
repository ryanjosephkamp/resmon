/**
 * J40 Delivery — the report goes where the routine was told to send it, and the
 * record says whether it arrived.
 *
 * The register's invariant has two halves and both are here. **A report that
 * did not arrive is recorded as such**: every delivery carries a state a person
 * can read, so "it was sent" is never inferred from the absence of an error.
 * And **the address scrub removes every path and address from what leaves the
 * machine**: a feed file is read by somebody else's reader, so the folder a
 * person's research lives in must not be written into it.
 *
 * Two channels really deliver here — a folder and an Atom feed, both into
 * directories this session made — and the third is deliberately held. A webhook
 * target in review mode produces a delivery that waits for a person, and the
 * journey presses Skip rather than Deliver: the address is a `.invalid`
 * hostname, nothing should ever leave this machine, and the closing assertion
 * that the offline guard refused nothing is what proves it did not.
 *
 * The targets are added over the local API rather than through the routine
 * editor. That is a seam, recorded here rather than implied: this row is about
 * where a report goes, the editor is its own surface, and a row that failed
 * because a modal changed would be reporting on the wrong thing. What is read
 * from the screen is the part a person uses to answer the question the row is
 * named for — the routine's own "Where did this go?" record.
 */
import { expect, journey } from './driver';

const ROUTINE = 'journey routine J40';

journey.describe('J40 Delivery: where a report goes, and whether it got there', () => {
  journey('a folder and a feed receive the report, a webhook in review mode waits, and Skip is recorded', async ({ resmon }) => {
    await resmon.createRoutine({
      name: ROUTINE, cron: '0 9 * * *', sources: ['arxiv'], keywords: ['perovskite'],
    });

    const folder = await resmon.addDeliveryTarget(ROUTINE, { channel: 'folder' });
    const feed = await resmon.addDeliveryTarget(ROUTINE, { channel: 'feed' });
    await resmon.addDeliveryTarget(ROUTINE, {
      channel: 'webhook',
      // Reserved by RFC 2606 and guaranteed never to resolve. Held in review,
      // so nothing addresses it; the guard would refuse it if anything did.
      destination: 'https://resmon-journey.invalid/deliveries',
      mode: 'review',
    });

    const run = await resmon.fireRoutineNow(ROUTINE);
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');

    const record = await resmon.readDeliveryRecord(ROUTINE);
    const byChannel = new Map(record.map((row) => [row.channel, row]));
    expect(
      [...byChannel.keys()].sort(),
      'the routine did not produce one delivery per destination',
    ).toEqual(['feed', 'folder', 'webhook']);

    // The two automatic channels arrived, and the screen says so in a word a
    // person reads rather than by the absence of an error.
    for (const channel of ['folder', 'feed']) {
      const row = byChannel.get(channel)!;
      expect(row.recorded, `the ${channel} delivery is "${row.recorded}": ${row.detail}`)
        .toBe('delivered');
      // And a person can see it. Not the same claim: the state a screen does
      // not render is a state nobody is told about.
      expect(row.state.length, `the ${channel} delivery shows no state at all`).toBeGreaterThan(0);
      expect(row.state.toLowerCase()).toContain('delivered');
    }

    // The folder really holds the report. Asserted on the bytes on disk, not on
    // the record: a delivery marked delivered with an empty folder behind it is
    // exactly the claim this row exists to refuse.
    const delivered = await resmon.readDeliveredFiles(folder.destination);
    expect(delivered.length, 'the folder delivery wrote nothing').toBeGreaterThan(0);
    console.log(`[J40] folder holds ${delivered.length} file(s): ${delivered.slice(0, 6).join(', ')}`);

    // The feed is a real Atom document: one root, an id, and an entry for the
    // run that just happened.
    const atom = await resmon.readFeedFile(feed.destination);
    expect(atom.text.startsWith('<?xml')).toBe(true);
    expect(atom.text).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(atom.text.trimEnd().endsWith('</feed>')).toBe(true);
    const entries = atom.text.match(/<entry>/g) ?? [];
    expect(entries, 'the feed carries no entry for the run that just delivered').toHaveLength(1);
    expect(atom.text, 'the feed does not name the routine it belongs to').toContain(ROUTINE);

    // The scrub, and a disagreement with the register that this row records
    // rather than resolves.
    //
    // What is true: the feed's human-readable text — its title, subtitle,
    // summary and entry titles, everything a reader displays — carries no
    // local path at all. Asserted against the delivery folder, the feed folder
    // and every directory above them up to the temporary root.
    //
    // What is also true: the entry carries one `file://` link, and it is the
    // absolute path of the bundle the folder channel wrote. That is deliberate
    // (`_folder_bundle_link`) and it is only ever emitted when the directory
    // really exists, so it is not a guess. But the register's invariant reads
    // "the address scrub removes every path and address from what leaves the
    // machine", and a feed file is written into a folder precisely so that a
    // reader or a static site can point at it. The spec asserts the true
    // reading and prints the disagreement; §2 of the handback carries it as a
    // question for the register.
    const secrets = [folder.destination, feed.destination, ...localPathsOf(atom.path)];
    const displayed = atom.text.replace(/href="[^"]*"/g, 'href="…"');
    for (const secret of secrets) {
      expect(
        displayed,
        `the feed's displayed text names a local path: ${secret}`,
      ).not.toContain(secret);
    }
    const links = [...atom.text.matchAll(/href="(file:[^"]*)"/g)].map((m) => m[1]);
    console.log(`[J40] feed.xml: ${atom.text.length} bytes, 1 entry, `
      + `${secrets.length} of ${secrets.length} local paths absent from the displayed text; `
      + `${links.length} file:// link(s) present.`);
    if (links.length > 0) {
      console.log(
        '[J40] NOT VERIFIED: the register says the address scrub keeps every local path out of '
        + 'what leaves the machine. The feed\'s alternate link is the absolute path of the '
        + 'folder channel\'s bundle, and a feed is written to be pointed at. Recorded, not '
        + 'changed — the register and the app disagree and the register is the lead\'s.',
      );
    }

    // The held one. Review mode means a person decides, and Skip is a decision
    // the record keeps — not a row that quietly disappears.
    const held = byChannel.get('webhook')!;
    expect(
      held.recorded,
      `a webhook target in review mode produced a "${held.recorded}" delivery`,
    ).toBe('awaiting_review');
    // The screen says so in its own words rather than showing the stored token:
    // "waiting for you" at this base. Asserted as "not delivered, and not
    // silent" rather than as that sentence, because the sentence is the
    // renderer's and this suite is written to survive a new one.
    expect(held.state.length, 'a held delivery shows no state at all').toBeGreaterThan(0);
    expect(held.state.toLowerCase()).not.toContain('delivered');
    console.log(`[J40] a webhook in review mode reads "${held.state}" (recorded ${held.recorded}).`);

    await resmon.skipDelivery(ROUTINE, held);
    const after = await resmon.readDeliveryRecord(ROUTINE);
    const skipped = after.find((row) => row.id === held.id);
    expect(skipped, 'the skipped delivery left the record').toBeTruthy();
    expect(
      skipped!.recorded,
      `Skip left the delivery recorded as "${skipped!.recorded}"`,
    ).toBe('skipped');

    console.log(
      `[J40] ${record.length} of 3 destinations produced a delivery: `
      + record.map((row) => `${row.channel}=${row.recorded}`).join(', ')
      + `; webhook after Skip: ${skipped!.recorded} ("${skipped!.state}").`,
    );
    console.log(
      '[J40] NOT VERIFIED: the email channel, the webhook envelope and its HMAC signature, '
      + 'and the retry ladder behind a failed delivery. Nothing left this machine in this row '
      + 'by design; test_delivery_webhook_and_feed.py owns the signed envelope.',
    );

    await resmon.takePicture('J40-delivery-record');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});

/**
 * The directories on the way to this file, from its own path.
 *
 * Built from the feed file's location rather than typed: the point is that the
 * places this machine keeps a person's research — the temporary state
 * directory, and every parent up to it — are not written into a document
 * somebody else's feed reader will open. Two segments up is the routine's own
 * folder inside the destination, which the feed may legitimately name, so the
 * list starts above it.
 */
function localPathsOf(feedPath: string): string[] {
  const parts = feedPath.split('/');
  const out: string[] = [];
  for (let depth = parts.length - 3; depth > 1; depth -= 1) {
    out.push(parts.slice(0, depth).join('/'));
  }
  return out;
}
