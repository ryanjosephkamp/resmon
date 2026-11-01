---
title: "Sources and their terms"
summary: "The 26 shipped repositories, what each one is asked and how often, which fields its terms permit resmon to keep, and why IEEE Xplore and OAPEN Library were withdrawn."
order: 2
readmeLines:
  - "70-118"
  - "399-476"
---
## Supported Repositories

The table below lists the 26 active sources registered in the repository catalog (`/api/repositories/catalog`). "API key" indicates whether a key is required to query the source from resmon; rate limits are the client-side ceilings enforced by each API client.

| Repository | API Type | API Key | Rate Limit (resmon) | Discipline Coverage |
|---|---|---|---|---|
| arXiv | REST (Atom XML) | Not required | 0.33 req/s (1 per 3 s) | Physics, Math, CS, Quant-bio, Stats, EE, Econ |
| bioRxiv | REST (JSON) | Not required | 2.0 req/s | Life-sciences preprints |
| CORE | REST (JSON) | Required (Bearer) | 0.167 req/s (1 per 6 s) | Multi-disciplinary open access |
| CrossRef | REST (JSON) | Not required | 10.0 req/s (polite pool) | All disciplines (DOI-indexed) |
| DataCite | REST (JSON:API) | Not required | 1.5 req/s | All disciplines, especially data, software, dissertations, and other DOI outputs |
| DBLP | REST (JSON) | Not required | 2.0 req/s | Computer science |
| DOAJ | REST (JSON) | Not required | 5.0 req/s | All disciplines (OA journals) |
| Dryad | REST (JSON) | Not required | 1.0 req/s (conservative; no published API limit) | Multi-disciplinary research data |
| ERIC | REST (JSON served as text/plain) | Not required | 0.5 req/s | Education research, policy, and practice |
| EuropePMC | REST (JSON) | Not required | 5.0 req/s | Biomedicine, Life sciences |
| GovInfo | REST (JSON Search Service) | Required (API.data.gov) | 1.0 req/s | Official government publication metadata; no full text or teasers |
| HAL | REST (Solr JSON) | Not required | 2.0 req/s | All disciplines (French-leaning) |
| INSPIRE-HEP | REST (JSON) | Not required | 2.0 req/s | High-energy physics, Accelerators, Astroparticle physics |
| medRxiv | REST (JSON) | Not required | 2.0 req/s | Medicine, Clinical research, Health sciences preprints |
| NASA ADS | REST (Solr JSON) | Required (Bearer) | 1.0 req/s (≈5000/day cap) | Astronomy, Astrophysics, Planetary science |
| NDL Search | SRU (DC-NDL v3 XML) | Not required | 0.5 req/s (conservative; no published numeric API limit) | Japanese national bibliography, Books, Articles, Cultural heritage metadata |
| NIST Resource Metadata Management | REST (JSON) | Not required | 0.5 req/s (conservative; no published API limit) | Engineering, Government technical publications |
| OpenAIRE | REST (XML-derived JSON) | Not required | 0.0167 req/s (60/hour) | Multi-disciplinary publications, Research outputs |
| OpenAlex | REST (JSON) | Not required | 10.0 req/s (polite pool via mailto) | All disciplines |
| Open Library | REST (JSON) | Not required | 1.0 req/s (unidentified-client ceiling) | Books, Humanities, General bibliography |
| OSTI.GOV | REST (JSON; XML and BibTeX optional) | Not required | 0.5 req/s | Energy, physical sciences, DOE-funded research, technical reports |
| PLOS | REST (Solr JSON) | Not required | 5.0 req/s | Biology, Medicine, Natural sciences (PLOS journals) |
| PubMed / NCBI E-utilities | REST (XML) | Optional (raises limit) | 3.0 req/s keyless, 10.0 req/s with key | Biomedicine |
| Semantic Scholar | REST (JSON) | Optional (recommended) | 0.33 req/s (1 per 3 s) | All disciplines (strong CS, biomed) |
| Springer Nature | REST (JSON Meta API) | Required (query-param key) | 5.0 req/s (≈5000/day cap) | STM, Humanities, Social sciences |
| Zenodo | REST (JSON) | Not required | 0.5 req/s (30/min) | Multi-disciplinary publications, data, software, and other outputs |

HAL searches share a 45-second cooperative I/O budget across pages, retries and
rate-limit waits. Budget exhaustion is recorded as an upstream failure; an empty
successful response remains distinct. Already normalized records are retained.
DNS shutdown and blocking CPU work can exceed this budget; see
[HAL request reliability](docs/hal-reliability.md).

bioRxiv and medRxiv cannot be asked for words: resmon reads the preprints each lists for a date
range, oldest first, for up to 45 seconds a search, and matches your terms itself. So neither is
asked without a start date. Ask the sources fills one in while either is chosen, and a watch on
either is not saved without one. A run that sets none (a watch saved earlier, the command line,
the HTTP API, or MCP) asks them for the 3 days before it starts, or before its end date when that
is earlier, and its log and record say so. Three days is about what that budget reads of bioRxiv:
on October 31, 2026, it listed 79 to 352 preprints a day, and 45 seconds read 420 to 750 of them
that evening and at most 1,230 that afternoon.

Sources previously evaluated but excluded from the active catalog (SSRN, RePEc/IDEAS) are not queried at runtime.

### Sources and their terms

resmon queries third-party scholarly APIs. Some are open; some need **your own API key**, which
you register for yourself and which resmon stores in your operating system's keyring and sends
only to that source.

That distinction matters more than it looks. **When a source runs on your key, the provider's
terms bind you, not resmon.** resmon can decline to ship an integration it believes puts users
in breach — and has: IEEE Xplore was withdrawn in v1.8.1 for exactly that reason — but it
cannot accept a license on your behalf, and it does not monitor whether your use stays within
one.

What resmon does do:

- **Checks terms before adopting a source**, against the provider's own words, and records the
  reasoning in [`docs/source-landscape.md`](docs/source-landscape.md) so you can read it.
- **Honours field-level conditions.** Where a source permits storing a field only under
  conditions, resmon checks them — INSPIRE-HEP abstracts are kept only where the abstract's own
  source is arXiv or CERN, which drops about a fifth of them.
- **Displays required attributions**, unconditionally, on the Repositories page.
- **Says when it does not know.** Eleven shipped sources publish terms that neither clearly
  grant nor forbid what resmon does. They are active, and that assessment is recorded rather
  than dressed up as a clearance.

What it does not do, and you should assume for yourself:

- It does not give legal advice, and the assessments in this repository are not legal advice.
- It does not verify that your use of a keyed source complies with the agreement you accepted
  when you registered for that key.
- It does not re-check a provider's terms after adoption. Terms change; the survey records the
  date it was made.
- Under the MIT license resmon is provided **as is, without warranty of any kind**. That covers
  the software. It does not and cannot extend to the third-party services you point it at.

If you add a source yourself — directly, or by pointing your own AI harness at this repository —
that source's terms are yours to read. [`docs/adding-a-source.md`](docs/adding-a-source.md)
opens with the four questions to ask, because asking them last has cost this project real work
twice.

### Date filtering is not the same precision everywhere

Every catalog entry carries a **Date Filtering** row on the Repositories page saying the finest
date precision resmon's own query to that source can express. Most take exact dates. NASA ADS
takes whole months. DataCite, DBLP, ERIC, Open Library and Semantic Scholar take whole years.

Two of those **refuse** rather than widen. ERIC and Open Library expose only a publication year,
so a window shorter than one whole calendar year cannot be answered at all — a record returned
for a two-week window would have unknowable in-window status, and resmon does not widen a window
you did not ask it to widen. Those searches come back empty by construction, and since 1.8.6 the
run says exactly that instead of leaving you to guess.

### Source attributions

Six of the sources resmon queries make a credit a **condition of reuse**, not a courtesy:
CORE, NDL Search, NIST RMM, OpenAIRE, PLOS and Semantic Scholar. resmon shows those credits at the top of the
**Repositories & API Keys** page, unconditionally — a credit that only appears when you expand
a card is not displayed in the sense the obligation means.

Sources that merely *ask* for a credit — arXiv, DataCite, DBLP, Europe PMC, HAL, OSTI — are
listed on their own row instead, labeled as requested rather than required. The distinction is
deliberate: OpenAIRE's Graph metadata is CC BY, so attribution is a license condition, while
arXiv publishes an acknowledgement sentence it would like you to use. Rendering both the same
way would overstate one and understate the other.

Each credit records the clause that imposes it, so any of them can be re-checked later.

### IEEE Xplore was withdrawn in v1.8.1

IEEE Xplore was an active source through v1.8.0 and is no longer queried. The client worked; the reason is the [IEEE Xplore API Terms of Use](https://developer.ieee.org/API_Terms_of_Use2), which limit the grant to non-commercial activity within the licensee's own institution, forbid using a "site search/retrieval application" against the content (4(c)), forbid retaining it in bulk (4(f)), and require deleting it on termination (12).

resmon is a retrieval application that keeps a corpus indefinitely and can back it up into a folder Google Drive syncs, so no setting reconciles it with those clauses — and because each user registers for their own IEEE key, continuing to ship the integration would put the account holder in breach of terms they accepted personally. Withdrawing it was the honest option.

Existing routines that name `ieee` keep running; that source is reported as unavailable with the reason above, and the rest of the routine is unaffected. Any IEEE key you stored is no longer used. The client is retained in the source tree, so a written license from IEEE would restore the source unchanged.

INSPIRE-HEP was affected differently and was fixed rather than withdrawn: its terms permit reuse of an abstract only where INSPIRE reports that abstract's own source as arXiv or CERN, so resmon now stores an abstract only in that case. Records carrying only a publisher-supplied abstract are still indexed, without one — about a fifth of them in a 100-record sample.

The full terms review behind both changes, covering every shipped source, is in [`docs/source-landscape.md`](docs/source-landscape.md).

### OAPEN Library was withdrawn in October 2026

OAPEN Library was an active source from September 2026 and is no longer queried. The reason is not its terms, which put the metadata under CC0, and nothing was found wrong with the client. Its search API refuses the requests: it answers HTTP 403 with a message saying the caller's address is not allowed to access the API. GitHub's hosted runners got that answer in the weekly live run on October 19, 2026, and a workstation got it on October 25, 2026, when the library's own website was still up.

Existing routines that name `oapen` keep running; that source is reported as unavailable with the reason above, and the rest of the routine is unaffected. The client is retained in the source tree, so the source can return if OAPEN lifts the block.
