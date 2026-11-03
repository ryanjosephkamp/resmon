# Zenodo search timing and outcomes

Zenodo uses one **45-second cooperative search budget**, shared by every page,
rate-limiter wait, request and retry. Each HTTP request uses **10-second phase
timeouts** and permits **one retry**. Zenodo opts into the shared request helper
with these values; other clients use the helper's defaults. A phase timeout
alone does not stop a response that keeps sending small amounts of data.

The helper cancels the async HTTP operation, closes its client and joins its
request thread before returning a deadline failure. This is cooperative I/O
cancellation, not a hard real-time guarantee: DNS executor shutdown, OS scheduling,
CPU-bound parsing and other non-cooperative work can delay return. There is no
claim that every search returns within exactly 45 seconds on every platform.

A transport failure is a transport failure in the search-outcome channel. A
successful HTTP response with invalid JSON or a missing/wrong-shaped
hits envelope is a parse failure, not an answered-empty search. An actual empty
hits list remains an empty answer. Successfully parsed records from earlier pages
are retained if a later page fails, alongside the later failure outcome. The list
alone is not a completeness guarantee. A malformed individual record is skipped and
the rest are normalized.

Queries and requested publication-date bounds use Zenodo's API syntax. Pagination
keeps the anonymous page size fixed at 25 at most, ends on the total or a short
page, and returns at most the requested number of
normalized records. The deadline is created once per search, never per page.

## Verification boundary

`test_zenodo_reliability.py` covers request options and shared deadlines, field
queries/date bounds, normalization, zero/negative maximums, pagination, valid empty
responses, malformed envelopes/JSON, partial results, retry exhaustion/recovery,
limiter/backoff expiry, and owned-loopback success, failure, stalls and trickles.
The loopback tests use real HTTPX sockets with scaled timing, observe the server
end of transport closure and verify fixture/thread cleanup. Transport doubles
establish deterministic options/outcomes; they do not reproduce DNS or TLS stalls.

The live test requires nonempty normalized records within its date window, an actual
request attempt, and a successful final outcome. Hermetic tests do not establish
that this live test passes, that Zenodo is currently available, or what causes a
hosted timeout. Live execution is a separate verification step.

These tests do not exhaust every record field/HTML input, every pagination total
shape, simultaneous caller contention, real DNS/TLS behavior or every OS/runtime.

