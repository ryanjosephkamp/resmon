---
layout: post
title: "resmon Update 25 — September 20, 2026"
date: 2026-09-20 09:00:00 -0400
categories: [updates]
---

# Update 25 — Keep the paper, and lock the door

## Metadata

- **Update number:** 25
- **Version:** 2.1.0 → 2.2.0
- **Theme:** resmon keeps the papers themselves, not just the records — and its local API
  stops answering anything that can reach 127.0.0.1

## The short version

Until now resmon held *records*: titles, authors, DOIs, the provenance of how each one was
found. The file itself lived wherever you left it.

This release adds a **Library** you own — retained PDF, TXT and Markdown originals in a
vault you create explicitly (#120) — and an **Evidence** workspace on top of it (#121):
projects, passages anchored to an exact file version and codepoint range, notes, and a
portable ZIP (#121) or a single offline HTML file (#123) of what you selected. A saved
passage that no longer resolves says so rather than quietly re-anchoring itself somewhere
else.

It also adds the thing you will notice first if you drive resmon from outside the app.
**The local API now requires a per-instance token, a loopback Host and this app's exact
renderer origin** (#130). Before this, any web page open in any browser on your machine
could drive the whole API.

**If you run resmon's MCP server from a separate checkout, update it in the same sitting as
the app.** A 2.1.0 MCP server sends no token, and there are no exempt routes, so a 2.2
backend answers it `401` on every call. This is the one thing in the release that can stop
working on upgrade, and it is deliberate.

## The local API was open, and now it is not

resmon's backend is an HTTP server on `127.0.0.1`. That is how the renderer, the MCP server
and the assistant all talk to it, and it is why a desktop app that never phones home can
still have a clean seam down its middle.

The cost, until this release, was that `127.0.0.1` is not a permission. The backend answered
every origin (`allow_origins=["*"]`), set `Access-Control-Allow-Private-Network: true` on
every response, checked no Host and asked for no credential. A web page open in any browser
on the machine could drive the whole API, and a DNS-rebinding page could read the answers.

Now every request on every route passes one raw-ASGI guard, registered outermost — before
CORS, before any request body is read:

- **Host** must be this backend's own loopback address and port, or `403 host_refused`,
  even with a valid token.
- **Origin**, when there is one, must be this app's renderer origin exactly, or
  `403 origin_refused`, with no `Access-Control-Allow-Origin` on the answer.
- **`Authorization: Bearer <token>`** must carry this backend's secret — 32 bytes from the
  OS CSPRNG, compared in constant time — or `401 token_missing` / `401 token_invalid`.

There are no exempt routes. `/api/health` needs the token too; the exemption list is an
explicit empty constant, and a test fails if it grows. There is no "auth off" switch, in
shipped code or in tests.

The token lives in `api-token-<port>` in the state directory, owner-only, beside the daemon
lock, and is removed on clean shutdown. A token file left behind by a crash never lets
anything in: every start mints a fresh one and accepts only that, so a client reading a
stale file is answered `401 token_invalid`. Electron mints the token, passes it to the
backend in the child's environment rather than in argv, and hands it to the renderer over a
synchronous preload IPC answered only to the main window's top frame. The main window now
refuses to navigate off the renderer origin, which confines the token to resmon's own
document.

What it deliberately does not defend: processes running as your own OS user, which can read
the token file, the backend's environment and the database itself; Windows file
permissions, where `0600` is largely ignored and the file relies on `%LOCALAPPDATA%` being
private to your profile; anything that can run code inside the app's renderer; and loopback
traffic itself, which is plain HTTP. The full model is in
[`docs/local-api-security.md`](https://github.com/ryanjosephkamp/resmon/blob/main/docs/local-api-security.md).

## Keep the paper

- **Library** (#120) — retain the original PDF, TXT or Markdown in a vault you create
  explicitly. Find items past the first page, link them to papers already in the corpus,
  export the whole inventory as JSON. Imports preserve originals and earlier retained
  versions, compare duplicate bytes exactly, and enforce stated quotas. Resetting the
  corpus keeps your Library; deleting a linked paper removes the association and nothing
  else. Small TXT and Markdown files open in a bounded in-app reader with line numbers and
  local find; a PDF or an unsupported text gets an explicit refusal and a separate
  external-open request.
- **Evidence** (#121) — collect Library items into a project, read them in the app, and
  save a passage or a plain note. A passage resolves against its exact file, version,
  canonical text hash and codepoint coordinates. If the file changes or goes missing, the
  passage stays **unresolved** and says so. It is never re-anchored to whatever is nearest.
  Removing a collection member preserves notes, originals, retained files, papers and
  provenance.
- **Answers over what you selected** (#122) — ask a question or request a structured
  briefing about excerpts you chose: file versions, pages or passages, and optional
  individual note bodies. You inspect the exact hash-bound disclosure preview before
  pressing Send. The lane runs tools-off, history-free and retry-free. Matching a quotation
  identifies the text it came from; it does not establish that the quotation supports a
  claim, and the interface says so.
- **Take it with you** (#123, #124) — a saved answer exports as a ZIP or as a single
  self-contained UTF-8 HTML file, capped at 4 MiB, that still reads after the app is
  closed: the validated saved snapshot only, with exact citation and return navigation,
  source and note provenance, coverage, requested and reported settings, and the unknowns.
  Untrusted text is escaped; there is no active content and nothing is fetched at open
  time. Library PDFs get a direct "Read PDF in Evidence" action, and completed exports
  appear in a session Downloads panel with the filename, the actual saved path and "Show in
  folder" — with pending, cancelled and interrupted downloads kept distinct from completed
  files.

## The papers you meant to read

Results & Logs listed *runs*. The papers inside a run were reachable only by reading a
Markdown report, and an execution id is not a paper id.

Now every run has a **Papers** tab, 50 papers to a page with each one's corpus-local
document id, and every paper has **Save to read** (#114). The **Reading queue** page holds
them in *To read*, *Read* and *All*, with the same "why am I seeing this?" evidence panel on
every row and tick-boxes that feed the existing BibTeX / RIS / CSV export.

Three properties it is arranged around: saving is idempotent, so a weekly routine
rediscovering a paper you have already read cannot put it back on the pile; a request that
changes nothing writes nothing; and identity is the stored document id, never a title or a
DOI, because two records that look like the same work are two papers everywhere else in
resmon. Removing an entry removes membership and nothing else.

An upgraded corpus starts the queue empty. resmon never observed which papers you meant to
read before this existed, and inferring it from execution history would be inventing an
intention.

## Coverage before conclusions

Opening a run now shows source coverage **above** its report (#115). A quiet run and a run
where four sources failed look nothing alike, and they should not. Counts use the saved
selected-source set when that selection is established; otherwise the panel says plainly
that the full selection is unknown rather than guessing a denominator. Missing outcomes stay
unknown, and failed requests and unreadable replies never become evidence that no papers
exist. Report ZIPs add a generated search-record JSON and Markdown pair per execution and
identify these companions in the manifest; the original report and log bytes are unchanged.

Alongside it, three export defects are fixed (#113): execution-result reads were returning
null paper IDs because the reference JSON projection omitted them; exporting several
selected runs concatenated their per-run exports, repeating shared papers and letting
distinct papers reuse a BibTeX key, where selected runs are now unioned by document ID and
rendered once; and selected-record retrieval no longer hits SQLite's bind-variable ceiling.

## Chats, and the connection a conversation was started on

Saved conversations were capped at the latest 50 in the Ask history drawer. **Chats** (#118)
browses all of them: title filtering, stable newest-created paging, a literal persisted
transcript, and "Continue in Ask" for the same session. Markdown and JSON downloads preserve
recorded metadata and malformed tool data, state their snapshot limits, and refuse output
above 8 MiB rather than truncating it. Ask keeps one active turn per renderer while other
saved chats stay readable and exportable.

And the connection a conversation was started on stays that conversation's (#119).
Connection, model and effort are chosen explicitly and fixed at conversation creation, so a
saved chat no longer follows a changed global default. Requested choices and the literal
response-model observation are reported separately in Ask, in Chats and in both export
formats. Changing choices starts an empty conversation. Continuing a historical conversation
asks once and discloses what would be replayed: an API chat replays saved user and assistant
text to the chosen provider, while Claude starts fresh native context without sending
earlier local messages.

Two smaller things in the same area: Ask's panel and composer referenced undefined palette
variables and could render transparent, and now use the existing opaque surfaces, readable
text and explicit keyboard focus (#117); and the desktop header shows which backend it last
observed, with keyboard-accessible runtime details and explicit acceptance after a runtime
change (#116).

## Searches that stop, and say why

HAL (#125), Zenodo (#126), bioRxiv/medRxiv, ERIC, DBLP and OAPEN (#127) now share one
45-second cooperative budget across pagination, rate-limiter admission, setup, response
reads and one bounded retry, with 10-second phase timeouts. A later page that fails no
longer discards the rows earlier pages already returned — the partial outcome, "N usable
records before a later request failed", reaches saved coverage, the activity messages, the
report and the exported search record. `Retry-After` is honoured only when it fits the
budget. ERIC requests are spaced at least two seconds apart; OAPEN negotiates JSON and gets
a 20-second per-request timeout, because ten seconds was shorter than the provider's own
replies; DBLP author search uses its documented SPARQL service.

A failed search also keeps the *order* of how it failed (#127). `http_500 -> timeout` used
to be recorded as just `timeout`, because each attempt cleared the last. The history is
fixed vocabulary, at most 8 entries with drops counted, and it never holds a URL, a query
string or a response body.

And the weekly live suite can now quarantine one provider's outage without hiding anything
else (#127). At most two live cases may be quarantined, each with a failure signature, a
first-observed date, an expiry at most 30 days out and the status captured from two vantage
points. A quarantined case still runs and still asserts; its failure becomes an xfail only
when the recorded source outcome shows the search ended on a failed call whose history
contains that signature. A different status, timeouts alone, a wrong answer after a
successful retry, or a crash all still fail the run, and a pass is reported as a recovery so
the quarantine gets lifted. The weekly summary prints its own denominator. Since
2026-09-18 OAPEN has intermittently answered HTTP 500 from its own database layer, observed
both from GitHub runners and from a workstation. resmon cannot fix that; it can refuse to
let it mask everything else.

## Five schema steps in one launch, tested on a real corpus

This release moves an existing corpus from schema **13 to 18** the first time it opens:
reading queue (14, #114), assistant composer choices (15, #119), Library (16, #120),
Evidence (17, #121), selected-evidence answers (18, #122). Every step is additive and
backfills nothing.

Each of those five steps had a green test — but each started from the step before it, and
none from a database a *released* resmon had actually written.

So we made one (#128). Tag v2.1.0 was checked out into a disposable worktree, and its own
`init_db` and its own write functions produced the corpus — not hand-written DDL: 21 tables
plus the full-text index, 116 rows, every value of every CHECK-constrained column that
version has, non-Latin author and title text, non-NFC combining characters, a NULL in every
column v2.1.0 allows one, one paper seen by two sources, one execution with a failed source
and one skipped for a missing credential, an AI lane left running. That file is committed
with the generator that produced it, and today's migrations run against it in the ordinary
hermetic suite on every pull request.

The denominators the run prints itself: 56 of 56 authored `sqlite_master` objects equal to a
fresh install's; 40 of 40 objects v2.1.0 owned still present; 31 of 31 tables' PRAGMAs equal
to fresh; 116 rows across 21 of 21 schema-13 tables compared column by column; 166 schema-13
columns still present with the same type and nullability; 8 of 8 AUTOINCREMENT high-water
marks preserved; 23 enumerated CHECK constraints exercised on the **upgraded** database, 73
allowed values accepted and 23 sentinels rejected; `PRAGMA integrity_check` ok and
`foreign_key_check` empty. Four deliberate mutations to the migration code, each in a
disposable copy, were each confirmed to turn it red. A companion change (#129) makes the
fixture's provenance case run in CI rather than skip there, and that check was itself proven
by being made to fail.

Everything in that fixture is synthetic. No row comes from anybody's corpus.

## What this release does not do

- **It does not keep a 2.1.0 MCP server working.** That is the point of the lock, not an
  oversight. Update both halves together (#130).
- **It does not fix OAPEN.** The longer timeout makes its HTTP 500 visible as an HTTP 500
  instead of a timeout; no client setting changes what a server sends. The quarantine covers
  one live case, and the OAPEN author-query case is not quarantined and can still fail a
  weekly run during the same outage (#127).
- **The request bounds are cooperative.** They do not preempt DNS shutdown, OS scheduling or
  CPU-bound work (#125, #126, #127).
- **An evidence answer is not a verification.** It quotes what you selected. It does not
  judge whether the quote supports the claim (#122).
- **The upgrade proof walks 13 → 18, from a v2.1.0 corpus.** It establishes nothing about a
  database written by any other version, about sqlite-vec, or about the renderer (#128).
- **The token keeps out other principals, not you.** Anything running as your own user
  account can read the token file — and the database (#130).
- **No Windows Library support, no OCR, no background full-text processing, no inferred
  paper or version association, and no silent re-anchor** (#120, #121).
- **macOS builds are still unsigned.** They cannot self-update, which is why no
  `latest-mac.yml` is published for them.
