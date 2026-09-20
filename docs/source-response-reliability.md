# Source response reliability

bioRxiv, medRxiv, ERIC, and DBLP can return a successful transport response
whose body is empty, malformed, or an access-challenge page. Those replies are
not valid empty search results.

Each affected client now uses one cooperative 45-second search budget across
pagination, limiter admission, response reads, and one bounded retry. A second
unreadable reply records a parse failure and returns any results retained from
earlier pages. A later successful retry remains a success. ERIC 504 responses
remain upstream failures; the client-side repair is the shared deadline,
single-retry limit, and truthful malformed-response outcome, not a claim that
the provider is available. DBLP challenge pages are recorded without retry or
challenge bypass. DBLP author searches deliberately use the official SPARQL
service and `dblp:authoredBy`; this route is selected for author search and is
never a fallback from a challenged REST request. REST keyword queries keep the
caller's query unchanged.

DBLP REST and SPARQL requests share a 0.5 request/second limiter, so starts are
at least two seconds apart, and use the same truthful User-Agent. A valid
`Retry-After` is honored only when it fits in the shared 45-second budget.
Author lookup uses an exact escaped name label, may match several people with
that label, and can miss aliases. DBLP dates have year precision: the stored
`YYYY-01-01` value does not claim a known month or day, and partial-year windows
exclude boundary years that cannot be placed honestly.

The bioRxiv `/details` cursor advances by the documented 30-record page size in
the [official bioRxiv API help](https://api.biorxiv.org/details/medrxiv/help).
The ERIC request preserves its documented `search`, `start`, `rows`, `fields`,
and JSON format parameters described in ERIC's
[official API example](https://eric.ed.gov/pdf/Using_ERIC_API_for_Research_Topics.pdf).
The bioRxiv, medRxiv, and ERIC query, author, date-window, and normalized
identity behavior remains unchanged.
DBLP SPARQL results keep the existing `conf/...` or `journals/...` record key as
`external_id`; the full DBLP record IRI remains the URL.

OAPEN uses the same 45-second search budget and one bounded retry. Its
per-request timeout is 20 seconds. Ten seconds was shorter than the provider's
own replies. Under the 30-second default, the dated live case passed in about
1.6 and 23.8 seconds, and OAPEN's HTTP 500 error page takes about 11.7 seconds
to arrive. With two 20-second timeouts plus the one-second backoff, the worst
case is 41 seconds, inside the budget. A longer timeout does not fix an HTTP 500
from the provider. It makes the 500 visible as a 500 instead of a timeout.

## What a failed search records

Each search's outcome keeps an ordered history of its failed attempts, both
retried and terminal, for example `http_500` then `timeout`. Before this, each
new attempt cleared the previous status, and "HTTP 500, then a timeout on the
retry" was recorded as just `timeout`. The history holds at most eight entries,
newest kept, and counts any older entries it dropped. Its words come from a
fixed vocabulary (`http_<status>`, `rate_limited`, `timeout`, `connect`,
`request_error`, `operation_deadline`). No URL, query string or response-body
text is stored in the history. Several sources carry an API key in the query,
and a reply body is the provider's untrusted text. The history is not written
to the database. A search's recorded zero reason still comes from the last
terminal failure alone.

## Provider-outage quarantine in the weekly live suite

A single provider's outage cannot fix or break resmon, so it should not decide
whether the rest of the weekly live suite counts.
`resmon_scripts/verification_scripts/live_quarantine.json` names at most two
live cases. Each entry has a source, a failure signature from the vocabulary
above, a first-observed date, an expiry no more than 30 days later, and the
excused status captured from two vantage points. A quarantined case still runs
and still asserts. Its failure is excused only when it is an assertion and the
case's recorded source outcome shows the search ended on a failed call whose
history contains the signature. A case qualifies for an entry only once it
records exactly one source outcome, because an excuse needs exactly one in
total and exactly one for the entry's source: a case that records none can be
quarantined and never excused, and a case that records two does not say whose
outage the failure was, so neither is excused. Any other failure fails the run:
a different status, timeouts alone, a wrong answer after a successful retry, or
a crash. A pass is reported as a recovery, so the entry can be lifted. An
expired entry is ignored, and the case fails as it would without one. The run
summary always prints the denominator from the collected suite, for example
"91 of 92 asserted; 1 quarantined (oapen, since 2026-09-18, http_500,
expires 2026-10-18)". The first entry is OAPEN's dated search. From 2026-09-18
its server intermittently answered HTTP 500 with a database connection error,
both to GitHub runners and to a workstation.

These controls bound cooperative HTTP work. They do not hard-preempt DNS
shutdown, OS scheduling, CPU-bound work, or another non-cooperative dependency.
Loopback tests establish local parser and timing behavior; they do not establish
why a public provider emitted a particular response or guarantee future provider
availability.
