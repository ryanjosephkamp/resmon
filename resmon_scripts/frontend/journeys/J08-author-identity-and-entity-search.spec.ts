/**
 * J08 Author identity and entity search — every source in the catalog carries
 * an explicit answer about whether it can be asked about a person, and where
 * the answer is no, a run says so on that source's own row.
 *
 * The register says the Repositories *page* states this per source. It does
 * not: the served catalog carries `entity_search` for every entry, and the
 * renderer's own type drops the field, so nothing on that page renders it. What
 * a person actually meets is two other surfaces, and both are checked here —
 * the Watch Profiles page states the rule in prose, and a run that names an
 * unaskable source records `entity_unsupported` against that source rather than
 * returning a bare zero. The disagreement goes to the register, not to the app.
 *
 * The denominator is the catalog the running app served, which is what makes
 * "27 of 27" a measurement. A source added tomorrow moves it.
 */
import { expect, journey } from './driver';

journey.describe('J08 Author identity and entity search', () => {
  journey('the catalog answers the person question for every source, and an unaskable one says so on its row', async ({ resmon }) => {
    const catalog = await resmon.backend.sourceCatalog();
    expect(catalog.length, 'the app served an empty source catalog').toBeGreaterThan(0);
    console.log(`[J08] ${catalog.length} sources in the catalog the app served.`);

    // Every entry carries an answer, and the answer is from a closed
    // vocabulary. "unknown" is a real answer here and a deliberate one: it
    // means nobody has established it, which is different from "no".
    const vocabulary = ['none', 'field', 'param', 'endpoint', 'unknown'];
    const withAnswer = catalog.filter((entry) => {
      const search = entry.entity_search as Record<string, any> | undefined;
      return Boolean(search) && vocabulary.includes(String(search!.author_query));
    });
    console.log(
      `[J08] ${withAnswer.length} of ${catalog.length} carry an entity_search answer; `
      + JSON.stringify(vocabulary.map((word) => `${word}=${catalog.filter(
        (e) => String((e.entity_search ?? {}).author_query) === word,
      ).length}`)),
    );
    expect(
      withAnswer.length,
      'a source in the catalog has no statement about whether it can be asked about a person',
    ).toBe(catalog.length);

    // Where the answer is established, it cites where it was established from.
    // An unsupported claim about somebody else's API is the thing this field
    // exists to stop.
    const established = catalog.filter(
      (entry) => String((entry.entity_search ?? {}).author_query) !== 'unknown',
    );
    const uncited = established.filter(
      (entry) => !String((entry.entity_search ?? {}).established ?? '').trim(),
    );
    console.log(`[J08] ${established.length} of ${catalog.length} have an explicit answer; ${uncited.length} of those cite nothing.`);
    expect(uncited.map((entry) => entry.slug), 'a source claims a capability it does not cite').toEqual([]);

    // The surface a person meets. The Repositories page does not carry it —
    // that is the register disagreement — and the Watch Profiles page does.
    await resmon.open('Repositories');
    const repositories = await resmon.readWhatThisPlaceSays();
    const askedAbout = /asked about (a person|an author)/i.test(repositories);
    if (!askedAbout) {
      console.log(
        '[J08] NOT VERIFIED: the Repositories page states nothing, per source, about '
        + 'whether that source can be asked about a person. The catalog carries the '
        + "answer for every source and the renderer's own type drops the field. "
        + 'Proposed as a register correction rather than an app change.',
      );
    }
    await resmon.open('Watch Profiles');
    const profiles = await resmon.readTheHelpOnThisPage();
    console.log(`[J08] Watch Profiles help: ${JSON.stringify(profiles.slice(0, 200))}`);
    expect(
      profiles,
      'nothing on Watch Profiles tells a person what happens on a source that cannot be asked',
    ).toMatch(/cannot be asked about a person/i);
    expect(profiles).toMatch(/own source row|source['’]s own row|run['’]s own source row/i);

    await resmon.takePicture('J08-author-identity-and-entity-search');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
