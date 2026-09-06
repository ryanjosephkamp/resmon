# Adding a source to resmon

resmon queries scholarly sources and keeps what it finds. Adding another one is the most
common contribution, and the most templated: `AGENTS.md` lists the files, and a suite of
tests pins every part of the contract. This document is the long form — what the template
does not say on its own, and what four delegated source batches taught by getting it wrong.

It is written to be usable by a person **or by an agent**. If you point your own harness at
this repository and ask it to add a source, this is the document it should read.

---

## Before you write any code: does its license let us?

**This is the first question, not the last one.** It was the last one twice, and both times
that cost real work.

resmon is not a search box that forgets. It **stores** what it retrieves, indefinitely, in a
local database the user can back up to their own cloud storage. That is a materially
different act from displaying a result, and a source's terms may permit one and not the
other. Four questions decide it:

1. May the record be kept **indefinitely** in a local database?
2. May that database be copied to **user-controlled cloud storage**?
3. May a **freely installable MIT-licensed** application do this, redistributing nothing?
4. May the first-retrieved record be **kept without re-fetching** it?

Answer all four against the provider's own words, and cite the clause. `docs/source-landscape.md`
has 22 shipped sources and 27 candidates already assessed this way; check there first.

Three outcomes matter:

- **Compatible.** Proceed.
- **Compatible with an obligation** — attribution, a notice, a contact. Proceed *and record
  the obligation* (see below).
- **Incompatible.** Stop and say so. This is a real answer and a valuable one.

> **Silence is not prohibition.** A source whose terms simply do not address durable local
> storage has not forbidden it. Grading every silence as a refusal eventually rejects
> everything, including public-domain government data. Say what the terms do and do not
> establish, and let a maintainer decide.

### What has actually happened here

| Source | What happened |
|---|---|
| **J-STAGE** | Refused during implementation. Its terms forbid machine-readable retention beyond 24 hours on a server or cloud — irreconcilable with an app that persists a corpus. |
| **IEEE Xplore** | Shipped, then **withdrawn** in v1.8.1. §4(c) forbids using a retrieval application against the content at all, so no gate fixes it. Because each user brings their own key, the integration put *the account holder* in breach. |
| **INSPIRE-HEP** | Fixed rather than withdrawn — see the next section. |

The IEEE case is the one to internalise: the client worked perfectly. Nothing was broken.
It still had to go.

---

## Store only the fields the terms permit

The rule that came out of INSPIRE-HEP, and it now applies to every client:

> **Where a source's terms condition a field on provenance, license, or an access flag, the
> client reads that field and honours it.**

INSPIRE's Terms §5(ii) permit reuse of an abstract only where that abstract's own `source`
is `arXiv` or `CERN`. The client took `abstracts[0]` and stored whichever came first. The
reference implementation is `_licensed_abstract` in `implementation_scripts/api_inspire_hep.py`;
read it before writing a client for any source whose terms distinguish fields.

Two consequences worth stating plainly:

- **A record with no storable abstract is still indexed, without one.** An absent abstract
  says resmon has nothing it may keep. That is different from the paper not existing, and
  dropping the record instead would hide it from the user entirely.
- **Measure the cost, do not estimate it.** The INSPIRE gate drops about a fifth of
  abstracts — established by sampling 100 live records, not guessed — and that figure is in
  the catalog note because the user is entitled to it.

---

## Recording an attribution obligation

Some sources make a credit a **condition of reuse**; others merely ask. The catalog holds
all three states, and the difference is not cosmetic:

```python
attribution="Data Provided by PLOS",
attribution_requirement="required",   # none | requested | required
attribution_source="https://api.plos.org/api-display-policy/",
```

- `required` — a license condition. OpenAIRE's metadata is CC BY; using it without the
  credit is using it without a license. Required credits render on the Repositories page
  **unconditionally**, because a credit the user must go looking for is not displayed.
- `requested` — a courtesy the upstream would like. arXiv publishes an acknowledgement
  sentence. Rendering it as required would overstate arXiv's terms.
- `none` — the default. **Do not invent a credit.** Silence is the correct value.

Record the wording **verbatim** where the upstream specifies exact wording — PLOS's display
policy names a phrase, and paraphrasing it misses the obligation — and always record the URL
of the clause, so the grading can be re-checked rather than trusted.

---

## The client contract

Every part of this is pinned by an existing test. Break one and the suite tells you.

- `search()` returns `list[NormalizedResult]`, honours `date_from` / `date_to` /
  `max_results`, and returns **`[]` on upstream failure** — logged, never raised. A source
  being down degrades a sweep; it does not fail it.
- Every HTTP call goes through `safe_request()` with a **module-level** `RateLimiter`, shared
  by every instance of that client, so concurrent sweeps contend on one object.
- The rate limit is whatever the upstream publishes, **or slower**. Where none is published,
  pick a conservative number and record the reasoning in a comment. Cite the published
  figure; do not carry over a number from another source.
- `source_repository` is the slug, lowercase, matching the catalog entry.
- `external_id` is **stable across runs**. Deduplication and the lifecycle checks key on it.
- A malformed record is skipped and logged, never allowed to abort the batch.

### Fields the user reads as claims

`rate_limit`, `upstream_policy` and `keyword_combination` are rendered on the Repositories
page and are read as statements of fact about someone else's service.

`keyword_combination` in particular describes how the **upstream** combines space-separated
terms — implicit AND, explicit OR, relevance-ranked. Getting it wrong makes resmon lie about
another organization's search engine.

> Where the upstream does not document it, the value is **"Undocumented"**. That is a
> correct answer, not a gap. A previous brief instructed a contributor to label OpenAIRE's
> semantics anyway; refusing that instruction was the right call.

Where a live observation and the documentation differ, say which is which. INSPIRE's entry
records `Implicit AND` *and* notes that this rests on a live comparison because the help page
does not document the default.

### Date granularity has a consequence — say it

Several sources filter only by publication **year**. Preserving that precision is correct,
and it is not the whole story: a date window narrower than one year cannot be satisfied, so
the source returns nothing. Say so in the catalog note. ERIC's entry is the model:

> A date window narrower than one whole year therefore returns nothing from ERIC — there is
> no field to filter on, so resmon reports zero results rather than widening the window you
> asked for.

Where the upstream can only filter one end of a range — NIST's API takes a lower bound and no
upper — the client applies the other end **locally**, and the catalog entry says so rather
than implying the upstream filtered something it did not.

`date_granularity` on the catalog entry carries the same fact in a form the app can read:
`"day"` (the default), `"month"`, or `"year"`. It says the finest precision **resmon's own
query to this source can express**, read from your client's date-filter code — not a claim
about the upstream's index. It is rendered on the Repositories page, and the
`window_unanswerable` sentence is derived from it rather than from the free-text note.

The field deliberately does not say what your client *does* about a window it cannot express,
because those are two different facts. ERIC and Open Library **refuse**; DataCite, DBLP, NASA
ADS and Semantic Scholar answer the coarser window. Both are honest. Only the first calls
`note_unanswerable`.

### Saying why a search came back empty

A client returning `[]` is the normal way a source fails, and by the time the engine sees it a
503 and a genuinely empty result field are identical. `safe_request` records the HTTP side for
you — **you do not need to write anything for an outage to be captured** — but three things
only your client can know. All three live in `api_base` and all three are one line at the site
that already returns `[]`:

| Call | When |
|---|---|
| `note_unanswerable(why)` | The source cannot answer this window at all and you are **not** sending a request. ERIC and Open Library, at their `return []`. Without this the zero reads *not recorded*, because nothing observed it. |
| `note_parse_failure()` | You got a 200 and could not read the body. arXiv's `ET.ParseError`, PubMed's, NDL's malformed SRU. |
| `note_filtered(matched, kept, why)` | The source answered with records you are not allowed to keep. NDL's rights gate. Count the drop reasons **separately** — attributing an incomplete record to a rights statement is a false claim about somebody else's licensing. |

If your request and your `response.json()` share one `try`, use
`note_parse_failure_unless_transport(exc)` rather than `note_parse_failure()`: the same
`except` catches "the source never answered", and calling that an unreadable reply tells the
user the source answered when it did not.

**Never invent a reason.** A zero is a recorded fact with a named source of truth, or it is
`not_recorded`. There is no third state, and there is no backfill.

### Local filtering, and what it licenses you to claim

`match_explain._LOCALLY_FILTERED_SOURCES` lists the sources whose keyword matching **resmon
performs itself**, and can therefore speak about with certainty. A source belongs there only
if resmon does the filtering. For a relevance-ranked upstream it does not, and adding it
would be an overclaim.

---

## The files a new source touches

A new source `<slug>` touches these and no others.

| File | Change |
|---|---|
| `implementation_scripts/api_<slug>.py` | **new** — subclass `BaseAPIClient`, implement `search()` and `get_name()`, call `register_client()` at module scope |
| `implementation_scripts/api_registry.py` | add `"api_<slug>"` to `_CLIENT_MODULES`, alphabetically |
| `implementation_scripts/repo_catalog.py` | add an `_entry(...)`, alphabetically by slug, including `date_granularity` when it is not `"day"` |
| `implementation_scripts/match_explain.py` | `_LOCALLY_FILTERED_SOURCES` — only if resmon does the filtering |
| `verification_scripts/test_repo_catalog.py` | the slug set and the two length assertions |
| `verification_scripts/test_api_repositories_catalog.py` | the catalog-length assertion |
| `verification_scripts/test_api_tier*.py` | registration, instantiation, and a `live_network` search test |
| `verification_scripts/test_source_outcomes.py` | nothing to add — `test_every_client_records_an_attempt` parametrises over the registry, so a new source is covered the moment it registers, and fails if its `search()` makes no recorded HTTP attempt |
| `frontend/src/components/Forms/RepositorySelector.tsx` | the offline fallback slug list |
| `README.md` → *Supported Repositories* | one row, and the count in the intro line |

Do **not** touch `resmon.py`, `implementation_scripts/database.py`,
`implementation_scripts/api_base.py`, `.github/workflows/*`, or `docs/_posts/*`.

---

## Retiring a source

Removing a module from `_CLIENT_MODULES` does **not** retire a source, and discovering that
is why this section exists.

Every `api_*.py` calls `register_client()` at import scope, so anything that imports the
module — a test, a debug session — puts the source straight back into the process-wide
registry. That is exactly what happened to IEEE Xplore: the tier-2/3 tests imported it
directly and **kept passing when they should have failed**.

Retirement therefore has two halves, and both are required:

1. Add the slug to `api_registry.RETIRED_REPOSITORIES` with the reason a user should see.
   `register_client()` refuses a retired slug, and `get_client()` raises with that reason —
   so a routine saved before the retirement reports the actual cause instead of
   `Unknown repository: <slug>`.
2. Remove the module's `_register()` call, leaving it commented with the steps to revive it.

Keep the client on disk. Retirement on *terms* is reversible in a way retirement on
*behavior* is not: a written license would restore IEEE Xplore unchanged.

---

## Verifying

All four, before opening a pull request:

```bash
.venv/bin/python -m pytest -q                    # hermetic suite
.venv/bin/python -m pytest -m live_network -q    # real APIs; a weekly CI job runs these
cd resmon_scripts/frontend && npm run typecheck && npm test && npm run build
```

The hermeticity guard blocks any non-loopback socket from a test that is not marked
`live_network`. A new test that needs the network carries the marker — and a source's
live search test is then run every Monday by `.github/workflows/live-network.yml`,
so a source that stops answering is heard about within a week rather than at the
next time somebody happens to type the command.

**Run the live tests yourself.** CI does not, so an unverified client reaches review with its
central claim untested.

### Tests that bite

A test that passes is not evidence. Break the behavior on purpose and confirm the test
fails: comment out the date filter, return the wrong field, collapse a list to its first
element. If nothing goes red, the test asserts shape rather than behavior.

One caution learned here: a mutation can survive because a **second** layer catches it. When
ERIC's year rounding was mutated, all twelve tests still passed — not a coverage gap, but a
re-filter downstream doing its job. Check the behavior, not only the test result.

---

## Opening the pull request

Say what changed and why, **how it was verified** with the exact commands and their output
counts, what the change deliberately does not do, and any file touched outside the list above
with the reason.

For a source, lead with the terms: which clause permits durable local storage, and any
obligation the catalog entry now records.

If your research **contradicts** the brief or the survey you were working from, say so
prominently. That has happened on every delegated batch so far and has been right every time.
