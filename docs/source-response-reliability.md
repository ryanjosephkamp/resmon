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
challenge bypass.

The bioRxiv `/details` cursor advances by the documented 30-record page size in
the [official bioRxiv API help](https://api.biorxiv.org/details/medrxiv/help).
The ERIC request preserves its documented `search`, `start`, `rows`, `fields`,
and JSON format parameters described in ERIC's
[official API example](https://eric.ed.gov/pdf/Using_ERIC_API_for_Research_Topics.pdf).
Query, author, date-window, and normalized identity behavior remain unchanged.

These controls bound cooperative HTTP work. They do not hard-preempt DNS
shutdown, OS scheduling, CPU-bound work, or another non-cooperative dependency.
Loopback tests establish local parser and timing behavior; they do not establish
why a public provider emitted a particular response or guarantee future provider
availability.
