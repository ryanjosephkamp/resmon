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

These controls bound cooperative HTTP work. They do not hard-preempt DNS
shutdown, OS scheduling, CPU-bound work, or another non-cooperative dependency.
Loopback tests establish local parser and timing behavior; they do not establish
why a public provider emitted a particular response or guarantee future provider
availability.
