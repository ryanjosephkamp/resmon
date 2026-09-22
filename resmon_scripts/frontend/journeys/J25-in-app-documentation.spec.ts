/**
 * J25 In-app documentation — the tutorials embed nothing, each walk-through is
 * a link out, and a page's own help names the page.
 *
 * The register's invariant here is a privacy one that is easy to lose by
 * accident: the tutorials used to be seventeen embedded players, and an embed
 * is a request to a third party made by opening a tab. So the first assertion
 * is a count of frames, which is zero, and the second is that the walk-throughs
 * are ordinary links a person chooses to follow.
 *
 * The third is the help block. "Its text names the page" is the difference
 * between help that was written for this screen and help that was pasted.
 */
import { expect, journey } from './driver';

journey.describe('J25 In-app documentation', () => {
  journey('the tutorials embed nothing, the walk-throughs are links out, and a page help names its page', async ({ resmon }) => {
    await resmon.open('Tutorials');
    const tabs = await resmon.readTabsHere();
    expect(tabs, 'About resmon no longer offers a Tutorials tab').toContain('Tutorials');

    // Zero, not "few". An embed is a request to somebody else's server made by
    // the act of opening this tab.
    const frames = await resmon.framesHere();
    console.log(`[J25] frames embedded in the tutorials tab: ${frames}`);
    expect(frames, 'the tutorials tab embeds a third-party frame').toBe(0);

    const links = await resmon.readExternalLinks();
    const watch = links.filter((link) => link.text === 'Watch on YouTube');
    console.log(`[J25] ${watch.length} of ${links.length} external links are "Watch on YouTube".`);
    expect(watch.length, 'no walk-through is offered as a link').toBeGreaterThan(0);
    for (const link of watch) {
      expect(link.href, `"${link.text}" points somewhere unexpected`).toMatch(/^https:\/\/www\.youtube\.com\//);
    }

    // A page's own help block, on a page that is not this one. Naming the page
    // is what makes it help rather than boilerplate.
    await resmon.open('Repositories');
    const help = await resmon.readTheHelpOnThisPage();
    console.log(`[J25] repositories help opens with: ${JSON.stringify(help.slice(0, 120))}`);
    expect(help.length, 'the Repositories page offers no help block').toBeGreaterThan(80);
    expect(
      help.toLowerCase(),
      'the help block on Repositories does not mention what the page is about',
    ).toMatch(/repositor|api key|source/);

    await resmon.takePicture('J25-in-app-documentation');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
