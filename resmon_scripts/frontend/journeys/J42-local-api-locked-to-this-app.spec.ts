/**
 * J42 Local API locked to this app — the backend this window spawned answers
 * this window, and refuses everyone else on the machine.
 *
 * Every other row in this suite reads backend facts through the app's own
 * transport, with the app's own token, because that is the honest way to ask a
 * question about the corpus. This row is the one that must not: its journey is
 * that *somebody who is not this renderer* gets a refusal, and a request made
 * with the app's helper would carry the app's credentials and demonstrate the
 * opposite of the point. So the three refusal cases go over a plain socket from
 * the test process — a different process, on the same machine, exactly like the
 * neighbour whose browser wandered onto 127.0.0.1.
 *
 * Then the other half, which only a launched app can show: the renderer sends
 * the token **itself**. Nothing in the suite arranges that and nothing could —
 * the requests observed here are the ones the page made on its own going to a
 * page a person clicks to. A backend that was guarded and a renderer that could
 * not talk to it would pass the first half and be a broken application.
 *
 * The register's invariant says "no switch turns the guard off". That is a
 * statement about the code and `test_local_api_auth.py` owns it across 238
 * cases. What this adds is that the guard is on in the **shipped launch path**,
 * on whichever build is under test, with no test harness having configured it.
 */
import { expect, journey } from './driver';

journey.describe('J42 Local API locked to this app', () => {
  journey('another process on this machine is refused, and the renderer sends the token itself', async ({ resmon }) => {
    const port = await resmon.backend.port();
    expect(port, 'the window attached to the live daemon').not.toBe('8742');

    // 1. No token at all. The reason is asserted, not only the status: a 401
    //    from a crashed backend and a 401 from the guard are the same number,
    //    and only one of them means the app is protected.
    const bare = await resmon.askOverTheRawSocket({ route: '/api/health', token: 'none' });
    expect(bare.status, `an unauthenticated caller got HTTP ${bare.status}`).toBe(401);
    expect(bare.reason).toBe('token_missing');

    // 2. The right token, the wrong Host. This is the rebound-hostname case:
    //    a name that resolves to 127.0.0.1 from a page the browser trusts. The
    //    token does not save it, which is the whole point of checking Host as
    //    well — so this asks *with* the real token and must still be refused.
    const rebound = await resmon.askOverTheRawSocket({
      route: '/api/health', token: 'this app', host: 'resmon.attacker.example',
    });
    expect(rebound.status, `a rebound hostname got HTTP ${rebound.status}`).toBe(403);
    expect(rebound.reason).toBe('host_refused');

    // 3. The control. The same socket, the same process, the token and a
    //    loopback Host: it answers. Without this the two refusals above would
    //    be satisfied by a backend that refuses everything.
    const allowed = await resmon.askOverTheRawSocket({ route: '/api/health', token: 'this app' });
    expect(allowed.status, `a correctly addressed caller got HTTP ${allowed.status}: ${allowed.body.slice(0, 200)}`).toBe(200);

    // 4. The app's own requests. Observed from outside the page, on a route a
    //    person clicks to, and asserted over every one of them — "some request
    //    carried a token" would be satisfied by a renderer that sent it once.
    //    Three pages rather than one: a single page makes a single request, and
    //    "1 of 1 carried a token" is a denominator that would be satisfied by a
    //    renderer that happens to send it on the one route somebody checked.
    const requests = [
      ...await resmon.observeOwnRequests('Results'),
      ...await resmon.observeOwnRequests('Routines'),
      ...await resmon.observeOwnRequests('Explorer'),
    ];
    expect(requests.length, 'the app made no backend request going to its own pages')
      .toBeGreaterThan(2);
    const unauthenticated = requests.filter((r) => !/^Bearer \S+$/.test(r.authorization ?? ''));
    expect(
      unauthenticated.map((r) => r.url),
      'the renderer made a backend request without the token',
    ).toEqual([]);
    // And never in the URL, where it would land in a log, a screenshot or a
    // referrer. The token itself is not in this spec, so the check is that no
    // request's query string carries anything token-shaped at all.
    const inTheUrl = requests.filter((r) => /[?&](token|api_token|access_token)=/.test(r.url));
    expect(inTheUrl.map((r) => r.url), 'a backend request carried a credential in its URL').toEqual([]);

    console.log(
      `[J42] port ${port}: no token → ${bare.status} ${bare.reason}; `
      + `wrong Host → ${rebound.status} ${rebound.reason}; correct → ${allowed.status}. `
      + `${requests.length} of ${requests.length} renderer requests carried a bearer token.`,
    );
    console.log(
      '[J42] NOT VERIFIED: the Origin arm and the per-route sweep. A foreign Origin and all '
      + '184 routes are test_local_api_auth.py’s; L-105 still stands — the owner’s own '
      + 'processes can read the token file, and Windows ACLs are unmeasured.',
    );

    await resmon.takePicture('J42-local-api-lockdown');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
