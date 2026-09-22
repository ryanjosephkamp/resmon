/**
 * J44 Driving resmon from an external harness (MCP) — a harness pointed at a
 * running resmon finds *that* resmon, and gets the frozen tool surface.
 *
 * The register's invariant has three parts and the third is the one with teeth:
 * a wrong or absent app is a refusal, never a silent fallback to the daemon's
 * port. That failure has happened — a v1.2.1 daemon from April answered every
 * tool truthfully about a completely different corpus — and it is why
 * `mcp_server.py` checks a version and reads a token file rather than assuming
 * 8742. So this journey launches the app, hands the harness nothing but that
 * app's state directory, and asks whether the instance that answers is the one
 * on screen.
 *
 * The server really is started as a subprocess and really is spoken to in
 * JSON-RPC over stdio, because "an external harness" is the journey. Nothing
 * here imports `mcp_server` into the test process: a harness cannot do that,
 * and a check that did would be measuring a Python import rather than a
 * protocol.
 *
 * The tool count is asserted twice on purpose. Twenty-five is the number the
 * contract is frozen at and the number `docs/api-contract/mcp.md` publishes, so
 * a literal is right here; and `mcp_server.TOOLS` is the list the server builds
 * its answer from, read out of the build under test. A build that grew a tool
 * would fail the first; a build whose `tools/list` disagreed with its own
 * declaration would fail the second. Either is a contract change, which takes
 * its own pull request.
 */
import { expect, journey } from './driver';

journey.describe('J44 Driving resmon from an external harness (MCP)', () => {
  journey('a harness given only this app’s state directory finds this app, and its 25 tools', async ({ resmon }) => {
    // Something in the corpus, so the instance the harness names is an instance
    // that has actually done work rather than a bare start.
    const run = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], days: 30, cap: 20 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');

    const app = await resmon.backend.health();
    const mcp = await resmon.askTheMcpServer();
    // Printed before it is asserted on: when this row fails, the first question
    // is always "what did the harness actually find", and a failed expectation
    // on one field does not answer it.
    console.log(`[J44] the harness's health answer: ${JSON.stringify(mcp.health)}`);

    // Who answered. The harness was told a state directory and nothing else, so
    // the identity coming back is the one it discovered — and it has to be this
    // window's, not "a resmon".
    expect(
      mcp.health.identity?.runtime_id,
      'the harness found a different resmon from the one this window is talking to',
    ).toBe(app.identity?.runtime_id);
    expect(mcp.health.version, 'the harness reports a version the app does not claim')
      .toBe(app.version);
    expect(String(mcp.health.status ?? ''), 'the app the harness found is not healthy').toBe('ok');
    expect(Number(mcp.health.pid)).toBe(Number(app.pid));
    // B3, from the other side of the boundary: the port the harness discovered
    // is this app's own and never the live daemon's.
    expect(String(await resmon.backend.port())).not.toBe('8742');

    // The surface. 25 of 25, against the contract and against the build's own list.
    expect(mcp.toolNames.length, 'the tool surface is not the 25 the contract freezes').toBe(25);
    expect(
      mcp.toolNames.length,
      'tools/list and mcp_server.TOOLS disagree about how many tools there are',
    ).toBe(mcp.declaredToolCount);
    expect(new Set(mcp.toolNames).size, 'a tool name appears twice').toBe(mcp.toolNames.length);
    expect(mcp.toolNames, 'the health tool is the one a harness reaches for first').toContain('health');

    // The register's invariant: destructive endpoints are not on the surface.
    // Asserted as a property of the whole list rather than by naming the tools
    // that exist — a tool added later with `erase` in its name fails this.
    const destructive = mcp.toolNames.filter((name) => /erase|delete|destroy|wipe|purge/i.test(name));
    expect(destructive, 'a destructive tool is reachable from an external harness').toEqual([]);

    expect(mcp.server.name).toBe('resmon');
    console.log(
      `[J44] ${mcp.server.name} contract ${mcp.server.version}: `
      + `${mcp.toolNames.length} of ${mcp.declaredToolCount} tools published; `
      + `runtime ${mcp.health.identity?.runtime_id} version ${mcp.health.version}.`,
    );
    console.log(
      '[J44] NOT VERIFIED: the refusal path. This row establishes that a harness given a '
      + 'running app finds that app; that a harness given a closed or wrong app refuses rather '
      + 'than falling back to port 8742 is test_mcp_server.py’s, and could not be driven here '
      + 'without a second resmon on this machine.',
    );

    await resmon.takePicture('J44-external-harness');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
