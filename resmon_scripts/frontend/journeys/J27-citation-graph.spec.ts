/**
 * J27 Citation graph — there is no route and no screen that offers one, and
 * this row is waiting on a decision rather than on a test.
 *
 * The register carries J27 because a citation graph was once planned. The app
 * does not have one: no route serves it, no place in the sidebar leads to it,
 * and the only module with the name is an orphan that nothing imports. This
 * row is the not-carried-forward candidate N1 and **it has not been initialled**,
 * so the spec asserts the absence and prints that it is waiting. B4 is the
 * reason it is phrased that way: a row leaves the register when somebody
 * decides it does, not when a test notices it is empty.
 *
 * Asserting an absence is worth doing anyway. If a citation graph appears in
 * the candidate build, this row goes red and somebody has to say which it is:
 * a feature that was added, or a parity register that was never updated.
 */
import { expect, journey } from './driver';

journey.describe('J27 Citation graph', () => {
  journey('no route and no place offers a citation graph, and the decision is still owed', async ({ resmon }) => {
    // The running backend's whole HTTP surface, from its own OpenAPI document
    // rather than from a grep of a checkout: the question is what the person's
    // app offers, not what a file contains.
    const routes = await resmon.backend.routeInventory();
    expect(routes.length, 'the backend described no routes at all').toBeGreaterThan(50);
    const citationRoutes = routes.filter((route) => /citation|citing|cited/i.test(route));
    console.log(`[J27] ${routes.length} routes served; ${citationRoutes.length} mention citations.`);
    expect(citationRoutes, 'a route offering a citation graph has appeared').toEqual([]);

    // And the sidebar, which is where a person would look for it.
    const places = await resmon.readSidebarPlaces();
    console.log(`[J27] ${places.length} places in the sidebar: ${places.join(', ')}`);
    expect(places.length).toBeGreaterThan(10);
    expect(
      places.filter((place) => /citation|graph/i.test(place)),
      'a place offering a citation graph has appeared in the sidebar',
    ).toEqual([]);

    console.log(
      '[J27] NOT VERIFIED: whether J27 leaves the parity register. The app has no '
      + 'citation graph and this test says so, but B4 requires an initialled row '
      + 'for a capability that is not carried forward, and candidate N1 is still '
      + "awaiting Ryan's initials. Until then the register keeps the row as carried.",
    );

    await resmon.takePicture('J27-citation-graph');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
