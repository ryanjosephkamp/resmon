# HAL request reliability

HAL searches use one 45-second cooperative I/O budget for the entire search,
including pagination, rate-limit admission, request setup, retry delays and
response reading. Each HTTPX request also has a 10-second phase timeout and at
most one retry. The existing module-level rate limiter still applies.

HTTPX's numeric timeout applies to individual network operations, including
waiting for the next response chunk. It does not by itself limit a search that
retries or keeps receiving small chunks. HAL therefore opts into a cancellable
async request scope. Its synchronous API joins the owned request thread and
finishes transport cleanup before returning. Other source clients retain the
existing synchronous request path and defaults.

This is not a universal 45-second wall-clock guarantee. Blocking CPU work,
platform scheduling and DNS executor shutdown can exceed a cooperative asyncio
deadline. The historical remote TCP-connect timeout does not identify which
network, resolver or platform condition caused it.

## What the result means

- A valid HAL response with no documents is an answered empty result.
- A transport failure or exhausted operation budget is an upstream failure,
  even when the budget expires before the first HTTPX request begins. Attempt
  counts reflect entries into HTTPX's request method, not retries that never
  start; they do not count individual sockets or redirect hops.
- A malformed HAL response is a parse failure.
- If a later page fails, records already normalized from earlier pages remain
  available. A large search may therefore return fewer records than requested.

The source outcome records operation-budget exhaustion separately from an
individual request timeout. The zero-result explanation, stored search record,
task log and report retain that distinction. Existing search query, date window,
field selection, normalization and abstract-retention behavior are unchanged.

## Verification boundaries

`test_hal_reliability.py` exercises synthetic HAL responses, query/date/page
contracts, limiter and retry budgets, attempt accounting, and real HTTPX against
owned loopback fixtures. The loopback fixtures include a stalled response and
a response that continues sending chunks. These tests do not reproduce a remote
DNS or TCP outage.

The separately marked live HAL check requires one to three normalized records
with source, identifier, title and URL, plus a non-failed outcome. Returning an
empty list cannot satisfy it. A live observation applies only to that request;
it does not establish ongoing provider availability or reverify the weekly suite.

References: [HTTPX timeouts](https://www.python-httpx.org/advanced/timeouts/),
[HTTPX transports](https://www.python-httpx.org/advanced/transports/),
and [HAL search API](https://api.archives-ouvertes.fr/docs/search).
