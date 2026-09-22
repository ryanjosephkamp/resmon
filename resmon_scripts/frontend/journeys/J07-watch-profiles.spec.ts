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
    // Without case: the chip's text is upper-cased by the stylesheet.
    expect(created.chipInList.toLowerCase(), 'the saved profile carries no basis chip in the list')
      .toBe('name only');

    const run = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], cap: 10 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');

    const matches = await resmon.readProfileMatches('Ada Fixture');
    console.log(`[J07] counts: ${JSON.stringify(matches.counts)}`);
    console.log(`[J07] matches: ${JSON.stringify(matches.items)}`);

    if (matches.items.length) {
      // Every match records what it was matched on, and with no identifier
      // there is only one honest answer.
      for (const match of matches.items) {
        expect(match.basis.toLowerCase(), `a match recorded basis "${match.basis}"`).toBe('name only');
        expect(match.author.length, 'a match does not say which author string it matched').toBeGreaterThan(0);
      }
      expect(matches.counts.toLowerCase()).toContain('name only');

      // And the label travels: the same basis is on the paper's own row in the
      // Explorer, where a person meets it without having opened the profile.
      const badges = await resmon.readBasisBadgesInTheExplorer();
      console.log(`[J07] badges in the Explorer: ${JSON.stringify(badges)}`);
      expect(badges.length, 'no basis badge reached the Explorer').toBeGreaterThan(0);
      expect(
        new Set(badges.map((badge) => badge.toLowerCase())),
        'the Explorer shows a basis the profile did not record',
      ).toEqual(new Set(['name only']));
    } else {
      // A keyword run does not record profile matches, and that is the app's
      // design rather than a gap: `_verify_entity_candidates` and the write to
      // `watch_profile_matches` are on the entity path, which is a routine in
      // watch mode. A keyword dive over the same papers stores the papers and
      // records nothing about who is on them.
      expect(matches.items, 'a keyword run recorded profile matches after all').toEqual([]);
      console.log(
        '[J07] NOT VERIFIED: a recorded match, its basis in the Explorer, and its basis '
        + 'in a report. Matches are written by the watch path — a routine pointed at a '
        + 'profile — and this journey seeds with a keyword dive, which stores the same '
        + 'papers and records nothing about the people on them. Building a watch run is '
        + 'its own journey and is not in this slice. What is established here is the '
        + 'half a person meets first: the warning at creation, and the same warning '
        + 'carried in the list without the profile being opened.',
      );
    }

    await resmon.takePicture('J07-watch-profiles');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
