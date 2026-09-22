/**
 * J22 Repositories and keys — a stored key reads back as a mask and never as
 * itself, a source's date precision is stated rather than implied, a required
 * credit renders unconditionally, and a withdrawn source stays withdrawn.
 *
 * Four properties on one page, and they are the same property four times: this
 * page is where resmon tells the truth about somebody else's service and about
 * the person's own secret.
 *
 * The mask assertion is written against the *field*, not against a screenshot,
 * because the mask is the field's placeholder and its value is empty — a field
 * that showed the key itself would still look masked in a picture.
 *
 * The withdrawal is checked where it is enforced. IEEE Xplore is not a row on
 * this page and has not been one since it was withdrawn; what the page carries
 * is the sentence about having withdrawn one, and what the registry carries is
 * the refusal to register the client at all.
 */
import { expect, journey } from './driver';

journey.describe('J22 Repositories and keys', () => {
  journey('a stored key reads back as a mask, dates and credits are stated, and the withdrawn source stays out', async ({ resmon }) => {
    const secret = 'journey-authored-not-a-real-key-8f2a';
    await resmon.saveKeyFor('Springer Nature', secret);

    // Did it actually store? A journey launches with an in-memory keyring —
    // never the person's own — and on a machine where even that cannot be
    // reached the app says so rather than pretending, which is a legitimate
    // answer and not one to assert a mask over.
    const credentials = await resmon.backend.credentials();
    const springer = Object.entries(credentials.credentials ?? {})
      .find(([name]) => /springer/i.test(name));
    expect(springer, 'the credentials answer does not mention the source a key was saved for').toBeTruthy();
    const stored = Boolean((springer![1] as Record<string, unknown>).present);
    console.log(`[J22] keyring responsive: ${credentials.keyring_responsive}; springer stored: ${stored}`);

    const fields = await resmon.readKeyFields();
    const saved = fields.find((field) => field.source === 'Springer Nature');
    console.log(`[J22] ${fields.length} key fields; Springer shows ${JSON.stringify(saved?.shown)}`);
    expect(saved, 'the source the key was saved for has no field').toBeTruthy();
    if (stored) {
      // A fixed-length mask: fixed, so its length says nothing about the key.
      expect(saved!.shown, 'a stored key does not read back as a mask').toBe('*'.repeat(12));
      expect(saved!.value, 'a stored key is sitting in the field it was typed into').toBe('');
    } else {
      console.log(
        '[J22] NOT VERIFIED: the twelve-character mask. The key did not reach a store '
        + 'on this machine, so no field had a stored key to mask. The page states the '
        + 'rule in prose and that sentence is asserted below; the mask itself is '
        + 'covered by the renderer suite.',
      );
      const page = await resmon.readWhatThisPlaceSays();
      expect(page, 'the page no longer states what a saved key looks like')
        .toMatch(/fixed 12-character mask/i);
    }

    // Whatever happened to the store, the key is in no surface. This is the
    // assertion that has to hold either way.
    for (const field of fields) {
      expect(field.shown, `${field.source} shows the key itself`).not.toContain(secret);
      expect(field.value, `${field.source} holds the key itself`).not.toContain(secret);
    }
    // And no API answer carries it either. `/api/credentials` is the route the
    // page reads key state from, and it answers presence, never value.
    expect(JSON.stringify(credentials), 'a credentials answer carried the key itself')
      .not.toContain(secret);

    // ERIC's date precision. The catalog says year-only and the page has to say
    // so, because a person who asks for a month and gets nothing is owed the
    // reason rather than a bare zero.
    const catalog = await resmon.backend.sourceCatalog();
    const eric = catalog.find((entry) => entry.slug === 'eric');
    expect(eric, 'ERIC is no longer in the catalog').toBeTruthy();
    expect(eric!.date_granularity).toBe('year');
    const details = await resmon.readSourceDetails('ERIC');
    // Looked up without case: the stylesheet upper-cases the labels in this
    // list, so the keys a person reads are "DATE FILTERING", not the JSX's own.
    const stated = (label: string): string => Object.entries(details)
      .find(([term]) => term.toLowerCase() === label.toLowerCase())?.[1] ?? '';
    console.log(`[J22] ERIC details: ${JSON.stringify(Object.keys(details))}`);
    console.log(`[J22] ERIC date filtering: ${JSON.stringify(stated('Date Filtering'))}`);
    expect(stated('Date Filtering'), 'ERIC does not state its date precision').toBe('Whole years only');
    expect(stated('Notes'), 'ERIC does not say what a narrow window will do').toMatch(/year/i);

    // A required credit renders unconditionally — not behind an expander, not
    // only for the sources somebody happens to open.
    const attributions = await resmon.readRequiredAttributions();
    const required = catalog.filter((entry) => entry.attribution_requirement === 'required');
    console.log(`[J22] ${attributions.length} credits rendered; ${required.length} sources require one.`);
    expect(attributions.length, 'no required credit is rendered').toBeGreaterThan(0);
    expect(attributions.length, 'a source that requires a credit is not credited').toBe(required.length);
    for (const source of required) {
      expect(
        attributions.some((credit) => credit.includes(String(source.attribution))),
        `${source.slug} requires a credit that is not on the page`,
      ).toBe(true);
    }

    // The withdrawn source. Not a row on this page, and the page says why there
    // is one fewer than there used to be.
    expect(
      catalog.map((entry) => entry.slug),
      'a source withdrawn on its own terms is back in the catalog',
    ).not.toContain('ieee');
    const page = await resmon.readWhatThisPlaceSays();
    expect(page, 'the page no longer says a source was withdrawn').toMatch(/withdraw/i);
    console.log(
      '[J22] NOT VERIFIED: the "withdrawn" label on a run. It renders on a search '
      + "record for a routine that named the source before it was withdrawn, which "
      + 'this journey has no way to author without writing a stale routine into the '
      + 'database. The registry refusal is covered by the backend suite.',
    );

    await resmon.takePicture('J22-repositories-and-keys');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
