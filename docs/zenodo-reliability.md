# Zenodo search timing and outcomes

Zenodo uses one **45-second cooperative search budget**, shared by every page,
rate-limiter wait, request and retry. Each HTTP request uses **10-second phase
timeouts** and permits **one retry**. These values opt into the existing shared
request helper; other clients and shared defaults are unchanged. A phase timeout
alone does not stop a response that keeps sending small amounts of data.

The helper cancels the async HTTP operation, closes its client and joins its
request thread before returning a deadline failure. This is cooperative I/O
cancellation, not a hard real-time guarantee: DNS executor shutdown, OS scheduling,
CPU-bound parsing and other non-cooperative work can delay return. There is no
claim that every search returns within exactly 45 seconds on every platform.

A transport failure remains a transport failure in the existing search-outcome
channel. A successful HTTP response with invalid JSON or a missing/wrong-shaped
hits envelope is a parse failure, not an answered-empty search. An actual empty
hits list remains an empty answer. Successfully parsed records from earlier pages
are retained if a later page fails, alongside the later failure outcome. The list
alone is not a completeness guarantee. Existing individual malformed-record
skipping and normalization remain unchanged.

Queries and requested publication-date bounds retain their existing API syntax.
Pagination keeps the anonymous page size fixed at at most 25, uses the existing
total/short-page termination rules and returns at most the requested number of
normalized records. The deadline is created once per search, never per page.

## Verification boundary

`test_zenodo_reliability.py` covers request options and shared deadlines, field
queries/date bounds, normalization, zero/negative maximums, pagination, valid empty
responses, malformed envelopes/JSON, partial results, retry exhaustion/recovery,
limiter/backoff expiry, and owned-loopback success, failure, stalls and trickles.
The loopback tests use real HTTPX sockets with scaled timing, observe the server
end of transport closure and verify fixture/thread cleanup. Transport doubles
establish deterministic options/outcomes; they do not reproduce DNS or TLS stalls.

The existing live test still requires nonempty normalized records within its date
window and additionally requires an actual request attempt and a successful final
outcome. Hermetic tests do not establish that this live test passes, that Zenodo is
currently available, or what caused the historical hosted timeout. Live execution
remains a separate verification step. The 120-second test watchdog, workflows,
test selection, rate limit, dependencies and record-retention rules are unchanged.

These tests do not exhaust every record field/HTML input, every pagination total
shape, simultaneous caller contention, real DNS/TLS behavior or every OS/runtime.
No HAL live success follows from this Zenodo repair.
