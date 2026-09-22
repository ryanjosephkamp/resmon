/**
 * J07 Watch profiles — a profile with no identifier is told at creation what
 * its matches will and will not mean, and the match records that basis
 * wherever the paper appears.
 *
 * The register's invariant is about what a name match is *worth*. resmon can
 * tell you a name is on a paper; without an ORCID it cannot tell you it is the
 * same person, and the product's whole differentiator is that it says which of
 * those two it is doing. So the sentence is asserted at the moment it matters —
 * while the person is still typing the profile — and then the basis is followed
 * through to the paper's own row in the Explorer.
 *
 * The profile is created before the run, because matching happens as papers are
 * stored: a profile created afterwards would match nothing and the row would
 * pass for the wrong reason.
 */
import { expect, journey } from './driver';

journey.describe('J07 Watch profiles', () => {
  journey('a profile with no identifier is warned at creation, and the basis travels with the match', async ({ resmon }) => {
    // "Ada Fixture" is the author on one of the authored records. No ORCID, no
    // affiliation: the weakest basis the app supports, which is the one the
    // register cares about.
    const created = await resmon.createWatchProfile({ name: 'Ada Fixture' });
    console.log(`[J07] warned at creation: ${JSON.stringify(created.warningAtCreation)}`);
    expect(
      created.warningAtCreation,
      'a profile with no identifier was not told its matches would be name-only',
    ).toMatch(/name-only|name only/i);
    expect(created.warningAtCreation).toMatch(/nothing more/i);
    // And the list carries the same warning without the profile being opened,
    // so it is visible to somebody who did not create it.
    expect(created.chipInList, 'the saved profile carries no basis chip in the list').toBe('name only');

    const run = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], cap: 10 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');

    const matches = await resmon.readProfileMatches('Ada Fixture');
    console.log(`[J07] counts: ${JSON.stringify(matches.counts)}`);
    console.log(`[J07] matches: ${JSON.stringify(matches.items)}`);
    expect(matches.items.length, 'the profile matched nothing in the seeded corpus').toBeGreaterThan(0);

    // Every match records what it was matched on, and with no identifier there
    // is only one honest answer.
    for (const match of matches.items) {
      expect(match.basis, `a match recorded basis "${match.basis}"`).toBe('name only');
      expect(match.author.length, 'a match does not say which author string it matched').toBeGreaterThan(0);
    }
    expect(matches.counts).toContain('name only');

    // And the label travels: the same basis is on the paper's own row in the
    // Explorer, where a person meets it without having opened the profile.
    const badges = await resmon.readBasisBadgesInTheExplorer();
    console.log(`[J07] badges in the Explorer: ${JSON.stringify(badges)}`);
    expect(badges.length, 'no basis badge reached the Explorer').toBeGreaterThan(0);
    expect(new Set(badges), 'the Explorer shows a basis the profile did not record').toEqual(new Set(['name only']));

    console.log(
      '[J07] NOT VERIFIED: the same label in a generated report. A report carries the '
      + '"Why this paper is in this report" sentence only for a watch run — a routine '
      + 'in entity mode — and building one is a different journey from this one. The '
      + 'sentences themselves are covered by the backend suite.',
    );

    await resmon.takePicture('J07-watch-profiles');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
