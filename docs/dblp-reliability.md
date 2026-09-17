# DBLP reliability contract

Resmon uses two documented DBLP routes for two distinct questions:

- General keyword searches use `https://dblp.org/search/publ/api`. The caller's
  query remains the REST `q` value and pagination uses `f` and `h`.
- Person searches use `https://sparql.dblp.org/sparql`. The query resolves an
  exact escaped `rdfs:label` and selects publications linked with
  `dblp:authoredBy`. It does not treat editor-only works as authored works and
  does not switch to SPARQL because REST returned a challenge.

Both routes share one 0.5 request/second limiter, a truthful Resmon User-Agent,
one cooperative 45-second operation budget, and at most one retry per request.
A valid `Retry-After` wait is used only when it fits inside that budget. HTML
challenge pages are failures and are neither retried nor bypassed.

## Author meaning and pagination

Exact labels can identify several DBLP people, while aliases can be missed.
Resmon therefore retains DBLP person IDs on returned authors and does not claim
that a name uniquely identifies one human.

The inner SPARQL page contains distinct publication/title/year tuples and omits
the matching person from its projection. This prevents two same-label people
linked to one publication from consuming two page slots. The outer query joins
all authors. Resmon groups those rows by the existing DBLP record key, removes
duplicate author rows, and advances the page from the count of distinct raw
publication IRIs rather than the number of normalized survivors.

## Identity, fields, and dates

Publication and author identifiers must be URI bindings. Titles, author names,
and optional venues must be literal bindings. Years must be `xsd:gYear`
literals. An optional DOI must be an RDF URI under `https://doi.org/`, matching
the public SPARQL service's observed JSON binding shape and DBLP's KG tutorial.
Malformed rows are recorded as parse failures; valid records from the same page
remain available.

The existing DBLP key such as `conf/...` is the stable `external_id`. The full
`https://dblp.org/rec/...` IRI is the URL. DOI and venue remain optional and no
missing value is manufactured.

DBLP provides year precision. `YYYY-01-01` is a storage encoding, not evidence
of a known month or day. A partial boundary year is excluded. If a requested
window contains no complete calendar year, Resmon makes no DBLP request and
records that the window cannot be answered at DBLP's precision.

## Evidence limit

A bounded diagnostic on 2026-09-17 observed HTML challenge pages from both REST
search endpoints and useful JSON bindings from the public SPARQL service. A
second one-request diagnostic using the candidate projection observed ten DOI
URI bindings, ten DBLP publication and author URI bindings, literal venue/name/
title fields, and ten `xsd:gYear` values. Those observations support the adapter
choice and parser contract. They do not establish the cause of the REST
challenge, guarantee future hosted availability, or prove every name and
publication shape.
