---
title: "Sources and their terms"
summary: "The 25 sources: pace, keys, how each combines terms and dates papers, and what resmon does about their terms."
order: 14
---
resmon asks 25 open scholarly sources. Every statement on this page comes from the catalog that **Settings › Sources** and **Search › Ask the sources** read, so the app and this page cannot disagree about someone else's service. Some of what follows is what a provider publishes about itself. Where resmon does not know, the catalog says so.

## The sources

"API key" says whether resmon can ask the source without one. A key is yours: you register for it, resmon stores it in your operating system's keychain, and sends it only to that source. A source that requires a key and has none is recorded as not asked, never as an answer with nothing in it. "resmon's pace" is the rate resmon sets for its own requests. It is not always the provider's published limit, which **Settings › Sources** shows beside it in the source's details. Where a provider states none, resmon picked a conservative number.

| Source | Coverage | API key | resmon's pace |
|---|---|---|---|
| arXiv | Physics / Math / CS / Quant-bio / Stats / EE / Econ | Not required | 0.33 req/s (1 per 3 s) |
| bioRxiv | Life sciences preprints | Not required | 2.0 req/s (conservative; no published API limit) |
| CORE | Multi-disciplinary OA | Required | 0.167 req/s (1 per 6 s) |
| CrossRef | All disciplines (DOI-indexed) | Not required | 10.0 req/s (polite pool recommended) |
| DataCite | All disciplines / Data / Software / Dissertations / Other DOI outputs | Not required | 1.5 req/s (below 500 requests/5 min unidentified) |
| DBLP | Computer science | Not required | 0.5 req/s (shared; at least 2 seconds between requests) |
| DOAJ | All disciplines (OA journals) | Not required | 5.0 req/s |
| Dryad | Multi-disciplinary research data | Not required | 1.0 req/s (conservative; no published API limit) |
| ERIC | Education research / Policy / Practice | Not required | 0.5 req/s (conservative; no published API limit) |
| EuropePMC | Biomedicine / Life sciences | Not required | 5.0 req/s |
| GovInfo | Legislation / Regulation / Courts / Government reports | Required | 1.0 req/s (below default key quotas) |
| HAL | All disciplines (French-leaning) | Not required | 2.0 req/s |
| INSPIRE-HEP | High-energy physics / Accelerators / Astroparticle physics | Not required | 2.0 req/s (below the 15 requests/5 s anonymous ceiling) |
| medRxiv | Medicine / Clinical research / Health sciences preprints | Not required | 2.0 req/s (conservative; no published API limit) |
| NASA ADS | Astronomy / Astrophysics / Planetary science | Required | 1.0 req/s (per-key daily cap ~5000/day) |
| NDL Search | Japanese national bibliography / Books / Articles / Cultural heritage metadata | Not required | 0.5 req/s (conservative; no published numeric API limit) |
| OpenAIRE | Multi-disciplinary publications / Research outputs | Not required | 0.0167 req/s (60/hour unauthenticated) |
| OpenAlex | All disciplines | Not required | 10.0 req/s (100k/day provider ceiling) |
| Open Library | Books / Humanities / General bibliography | Not required | 1.0 req/s (unidentified-client ceiling) |
| OSTI.GOV | Energy / Physical sciences / DOE-funded research / Technical reports | Not required | 0.5 req/s (conservative; no published API limit) |
| PLOS | Biology / Medicine / Natural sciences (PLOS journals only) | Not required | 5.0 req/s |
| PubMed | Biomedicine | Optional | 3.0 req/s (matches keyless; 10/s with key) |
| Semantic Scholar | All disciplines (strong CS and biomed) | Recommended | 0.33 req/s (1 per 3 s) |
| Springer Nature | STM / Humanities / Social sciences | Required | 5.0 req/s (per-key daily cap ~5000/day on free tier) |
| Zenodo | Multi-disciplinary publications / Data / Software / Other outputs | Not required | 0.5 req/s (30 search requests/min) |

## How each source combines terms, dates, and order

The terms you type go to every source together, and each source combines them its own way. A source that ranks by relevance may return papers that contain none of your words. A paper that matches no keyword is expected there, not a fault, and **Why it is here** on the paper's page says so.

| Source | How it combines your terms | Dates | Result order |
|---|---|---|---|
| arXiv | Implicit AND (added by resmon) | Exact dates | Newest first |
| bioRxiv | Explicit OR | Exact dates | Newest first |
| CORE | Relevance-ranked (Lucene OR default) | Exact dates | Relevance |
| CrossRef | Relevance-ranked | Exact dates | Relevance |
| DataCite | Implicit AND | Whole years | Relevance |
| DBLP | Relevance-ranked (upstream-default, unverified) | Whole years | Not stated |
| DOAJ | Implicit AND | Whole years | Relevance |
| Dryad | Implicit AND | Exact dates | Not stated |
| ERIC | Implicit OR | Whole years | Not stated |
| EuropePMC | Implicit AND | Exact dates | Relevance |
| GovInfo | Implicit AND | Exact dates | Relevance |
| HAL | Implicit AND | Exact dates | Newest first |
| INSPIRE-HEP | Implicit AND | Exact dates | Newest first |
| medRxiv | Explicit OR | Exact dates | Newest first |
| NASA ADS | Implicit OR (Solr default) | Whole months | Newest first |
| NDL Search | Implicit AND (documented for anywhere) | Exact dates | Not stated |
| OpenAIRE | Combination semantics undocumented | Exact dates | Not stated |
| OpenAlex | Implicit AND | Exact dates | Relevance |
| Open Library | Implicit AND | Whole years | Not stated |
| OSTI.GOV | Implicit AND | Exact dates | Not stated |
| PLOS | Implicit AND | Exact dates | Newest first |
| PubMed | Implicit AND | Exact dates | Newest first |
| Semantic Scholar | Relevance-ranked | Whole years | Relevance |
| Springer Nature | Relevance-ranked (Solr OR default) | Exact dates | Relevance |
| Zenodo | Relevance-ranked (implicit OR) | Exact dates | Relevance |

- **Dates.** The finest date a query to the source can express. A source that takes only whole months or years cannot be asked for a shorter window exactly. What resmon does about that differs by source, and both are stated before you ask:
  - **DataCite** is asked for the whole calendar years your window touches, and resmon then drops anything outside your exact dates once it arrives. A record dated to a year alone is kept only when your window covers that whole year.
  - **DOAJ**, **Semantic Scholar**, and **NASA ADS** are searched by year (NASA ADS by month). A window inside one year or month widens to the whole of it, so results can fall outside the dates you set.
  - **DBLP**, **ERIC**, and **Open Library** hold a year and nothing finer. resmon searches the whole calendar years inside your window, and refuses a window containing none rather than returning records whose position in it cannot be known. That search comes back empty by construction, and the run says why.
- **Result order.** With **No date limit**, a source that ranks by relevance returns the same top papers every time. A watch editor says which of your sources do that.

### bioRxiv and medRxiv

bioRxiv and medRxiv cannot be asked for words. resmon reads the preprints each lists for a date range, newest first, for up to 45 seconds a search, and keeps a preprint when any one of your terms appears in its title or abstract, even as part of a word. A search that runs out of that time, or reaches the run's cap, has read the newest part of the range and is **answered in part**: its record says which preprints were read and that the older ones were not. That is not an answer for the whole window, and it is not a failure of the source. A run whose only shortfalls are these completes, the Source wall draws them with a mark of their own, and the Watchdog raises no alarm for them (after three such runs in a row it offers advice).

So neither is asked without a start date. Ask the sources fills one in while either is chosen, and a watch on either is not saved without one. A run that sets none (the command line, the HTTP API, or MCP) asks them for the 3 days before it starts, or before its end date when that is earlier, and its log and record say so. A window longer than 3 days may not be read back to its start.

### NDL Search, HAL, and others with their own limits

- **NDL Search** is asked only for open-provider records, and resmon keeps only those carrying a single Public Domain Mark 1.0, CC0 1.0, or CC BY 4.0 metadata-rights statement. Anything else is dropped and counted, not stored. For more than 500 records a request, resmon splits your date range into smaller ones, earliest first, which needs a start date.
- **HAL** searches share a 45-second budget across pages, retries, and waits. Running out is recorded as an upstream failure, which is distinct from an empty successful response. Already normalized records are kept. See [HAL request reliability](docs/hal-reliability.md).
- **arXiv** is asked with an `all:` term per word joined by AND, and a submission-date filter.

### Asking about a person

A watch on a person asks each source for papers by that person. Of the 25 sources, 19 can be asked about an author: arXiv, Crossref, DataCite, DBLP, DOAJ, Dryad, ERIC, Europe PMC, HAL, INSPIRE-HEP, NDL Search, OpenAIRE, OpenAlex, Open Library, OSTI.GOV, PLOS, PubMed, Semantic Scholar, and Zenodo. Each uses a syntax established against a live record and cited in the catalog. bioRxiv and medRxiv cannot be asked. For CORE, GovInfo, NASA ADS, and Springer Nature, resmon has not established whether they can, so it does not ask them; the run records each as could not be asked, with the reason, not as a bare zero. A source's answer is a candidate, never a verdict: every record that comes back is checked against the person locally.

## Terms of use

resmon queries third-party scholarly APIs. **When a source runs on your key, the provider's terms bind you, not resmon.** resmon can decline to include an integration it believes puts you in breach, and has; it cannot accept a license on your behalf, and it does not monitor whether your use stays within one.

What resmon does:

- **Checks terms before adopting a source,** against the provider's own words, and records the reasoning in [`docs/source-landscape.md`](docs/source-landscape.md) so you can read it. The question for each is whether resmon may keep a retrieved record indefinitely in a local database, copy that database to storage you control, do so in a freely installable MIT-licensed application that redistributes no records, and keep the first-retrieved record without a provider-mandated refresh.
- **Honors field-level conditions.** Where a source permits storing a field only under conditions, resmon checks them. INSPIRE-HEP's terms permit reusing an abstract only where INSPIRE reports that abstract's own source as arXiv or CERN, so resmon stores an abstract only in that case. A record with only a publisher-supplied abstract is still indexed, without one.
- **Shows required credits, unconditionally.** **Settings › Sources** lists the credits a provider's license requires at the top, for every source that requires one, not behind a card you have to expand.
- **Says when it does not know.** Several sources publish terms that neither clearly grant nor forbid what resmon does. They are active, and that assessment is recorded in the landscape review, not dressed up as a clearance.

What it does not do, and you should assume for yourself:

- It does not give legal advice, and the assessments in this repository are not legal advice.
- It does not verify that your use of a keyed source complies with the agreement you accepted when you registered for the key.
- It does not re-check a provider's terms after adopting a source. Terms change, and the review records the date it was made.
- Under the MIT license resmon is provided **as is, without warranty of any kind**. That covers the software, not the third-party services you point it at.

If you add a source yourself, directly or with your own tools, that source's terms are yours to read. [`docs/adding-a-source.md`](docs/adding-a-source.md) opens with the four questions to ask.

### Credits

A credit is a **condition of reuse** for five sources: CORE, NDL Search, OpenAIRE, PLOS, and Semantic Scholar. resmon shows those credits unconditionally. Six more only **ask** for one, and are labeled as requested: arXiv, DataCite, DBLP, Europe PMC, HAL, and OSTI.GOV. The distinction is deliberate. OpenAIRE's Graph metadata is CC BY, so attribution is a license condition, while arXiv publishes an acknowledgment sentence it would like you to use. Rendering both the same way would overstate one and understate the other. Each credit records the clause that imposes it, so it can be re-checked.

### Sources resmon does not ask

- **IEEE Xplore.** Its API Terms of Use limit the grant to non-commercial activity within the licensee's own institution, forbid using a search or retrieval application against the content (clause 4(c)), forbid retaining it in bulk (4(f)), and require deleting it on termination (12). resmon is a retrieval application that keeps a corpus indefinitely, and each user registers for their own key, so shipping the integration would put the account holder in breach of terms they accepted personally. The client is kept in the source tree, so a written license from IEEE would restore the source unchanged.
- **OAPEN Library.** Its metadata is CC0 and nothing was found wrong with the client, but its search API answers resmon's requests with HTTP 403 and a message saying the caller's address is not allowed to access the API, from both places that were tried, a workstation and GitHub's hosted runners. The source can return if OAPEN lifts the block.
- **NIST Resource Metadata Management.** Its terms permit what resmon does, with a credit to NIST, but its papers API has answered HTTP 500 to every search since the source was added in August 2026, last checked November 4, 2026. The client is kept in the source tree, so the source can return if NIST's API answers again.
- **SSRN** answers programmatic requests with a bot challenge, and **RePEc/IDEAS** has a search that is no longer publicly reachable.

A watch, an imported file, or a request over the API that names one of these records it as **could not be asked**, with the reason, and the rest of the run goes on.
