# resmon_scripts/implementation_scripts/repo_catalog.py
"""Static repository catalog.

Single source of truth (in code) mirroring the ``Active`` rows of
``.ai/prep/repos.csv``. Registration URLs are drawn from
``.ai/prep/repos.md``. Nothing in this module references or returns raw
credential values.
"""

from dataclasses import dataclass, asdict
from typing import Literal

ApiKeyRequirement = Literal["none", "required", "optional", "recommended"]


@dataclass(frozen=True)
class RepoCatalogEntry:
    """Public, non-secret metadata for a single active repository."""
    slug: str
    name: str
    description: str
    subject_coverage: str
    endpoint: str
    query_method: str
    rate_limit: str
    client_module: str
    api_key_requirement: ApiKeyRequirement
    credential_name: str | None
    website: str
    registration_url: str | None
    placeholder: str
    upstream_policy: str
    parallel_safe: str
    notes: str
    keyword_combination: str
    keyword_combination_notes: str

    def to_dict(self) -> dict:
        return asdict(self)


def _placeholder_for(requirement: ApiKeyRequirement) -> str:
    if requirement == "required":
        return "Enter API key here (REQUIRED)"
    if requirement == "optional":
        return "Enter API key here (OPTIONAL)"
    if requirement == "recommended":
        return "Enter API key here (RECOMMENDED)"
    return ""


def _entry(
    *,
    slug: str,
    name: str,
    description: str,
    subject_coverage: str,
    endpoint: str,
    query_method: str,
    rate_limit: str,
    client_module: str,
    requirement: ApiKeyRequirement,
    credential_name: str | None,
    website: str,
    registration_url: str | None,
    upstream_policy: str = "",
    parallel_safe: str = "",
    notes: str = "",
    keyword_combination: str = "",
    keyword_combination_notes: str = "",
) -> RepoCatalogEntry:
    return RepoCatalogEntry(
        slug=slug,
        name=name,
        description=description,
        subject_coverage=subject_coverage,
        endpoint=endpoint,
        query_method=query_method,
        rate_limit=rate_limit,
        client_module=client_module,
        api_key_requirement=requirement,
        credential_name=credential_name,
        website=website,
        registration_url=registration_url,
        placeholder=_placeholder_for(requirement),
        upstream_policy=upstream_policy,
        parallel_safe=parallel_safe,
        notes=notes,
        keyword_combination=keyword_combination,
        keyword_combination_notes=keyword_combination_notes,
    )


# ---------------------------------------------------------------------------
# Catalog — 20 active repositories.
# Field values mirror `.ai/prep/repos.csv` rows with Status=Active and the
# registration-URL annotations in `.ai/prep/repos.md`.
# ---------------------------------------------------------------------------

REPOSITORY_CATALOG: list[RepoCatalogEntry] = [
    _entry(
        slug="arxiv",
        name="arXiv",
        description="Open-access preprints across physics math CS quant-bio stats EE and economics",
        subject_coverage="Physics / Math / CS / Quant-bio / Stats / EE / Econ",
        endpoint="https://export.arxiv.org/api/query",
        query_method="GET Atom XML with all:{query} and submittedDate filter",
        rate_limit="0.33 req/s (1 per 3 s)",
        client_module="api_arxiv.py",
        requirement="none",
        credential_name=None,
        website="https://arxiv.org",
        registration_url=None,
        upstream_policy="\u22653 s between calls; bulk access via OAI-PMH",
        parallel_safe="Yes",
        notes="Conservative by design. Do not drop the delay.",
        keyword_combination="Implicit AND",
        keyword_combination_notes="arXiv treats space-separated terms in the all: field as implicit AND across title, abstract, and author.",
    ),
    _entry(
        slug="biorxiv",
        name="bioRxiv",
        description="Preprints across the life sciences",
        subject_coverage="Life sciences preprints",
        endpoint="https://api.biorxiv.org/details/biorxiv/{from}/{to}/{cursor}",
        query_method="GET date-range JSON; keywords filtered client-side by resmon",
        rate_limit="2.0 req/s (conservative; no published API limit)",
        client_module="api_biorxiv.py",
        requirement="none",
        credential_name=None,
        website="https://www.biorxiv.org",
        registration_url=None,
        upstream_policy="No published API rate limit; resmon uses a conservative ceiling",
        parallel_safe="Yes",
        notes="The /details endpoint has reported upstream outages; resmon surfaces those failures.",
        keyword_combination="Explicit OR",
        keyword_combination_notes="The documented /details API retrieves by date range or DOI rather than keyword; resmon filters the returned records and matches when any space-separated term appears in the title or abstract.",
    ),
    _entry(
        slug="core",
        name="CORE",
        description="Aggregator of open-access research outputs from institutional and subject repositories",
        subject_coverage="Multi-disciplinary OA",
        endpoint="https://api.core.ac.uk/v3/search/works",
        query_method="GET with Authorization: Bearer {key}",
        rate_limit="5.0 req/s (subject to per-key daily quota)",
        client_module="api_core.py",
        requirement="required",
        credential_name="core_api_key",
        website="https://core.ac.uk",
        registration_url="https://core.ac.uk/services/api",
        upstream_policy="Registered key ~10 req/s; ~10k/day. Respect Retry-After on 429",
        parallel_safe="Yes",
        notes="Must register for an API key before use.",
        keyword_combination="Relevance-ranked (Lucene OR default)",
        keyword_combination_notes="CORE's Solr/Lucene backend defaults to OR between terms; documents matching more terms rank higher but single-term matches still appear.",
    ),
    _entry(
        slug="crossref",
        name="CrossRef",
        description="DOI registration agency metadata across all scholarly works",
        subject_coverage="All disciplines (DOI-indexed)",
        endpoint="https://api.crossref.org/works",
        query_method="GET /works?query={q} with optional date filters",
        rate_limit="10.0 req/s (polite pool recommended)",
        client_module="api_crossref.py",
        requirement="none",
        credential_name=None,
        website="https://www.crossref.org",
        registration_url=None,
        upstream_policy="Polite pool when User-Agent contains mailto:; shared pool otherwise (~50 req/s soft cap)",
        parallel_safe="Yes",
        notes="Set a contact email in the UA for priority.",
        keyword_combination="Relevance-ranked",
        keyword_combination_notes="CrossRef ranks by relevance, not strict boolean; documents containing more of the words rank higher but single-term matches can still surface.",
    ),
    _entry(
        slug="datacite",
        name="DataCite",
        description="DOI metadata with strong coverage of datasets, software, dissertations, and other research outputs",
        subject_coverage="All disciplines / Data / Software / Dissertations / Other DOI outputs",
        endpoint="https://api.datacite.org/dois",
        query_method="GET JSON:API query with upstream publication-year filtering and precise Issued-date checks where available",
        rate_limit="1.5 req/s (below 500 requests/5 min unidentified)",
        client_module="api_datacite.py",
        requirement="none",
        credential_name=None,
        website="https://datacite.org",
        registration_url=None,
        upstream_policy="Unidentified requests: 500 per 5 minutes per IP; CC0 metadata; attribution requested; linked resources excluded",
        parallel_safe="Yes",
        notes="Public API returns Findable DOI metadata only. Publication filtering is year-granular upstream; resmon preserves partial date precision and applies exact bounds only when Issued metadata supports them.",
        keyword_combination="Implicit OR",
        keyword_combination_notes="DataCite documents every unfielded term as optional so long as at least one matches. Unfielded search covers common metadata fields; explicit AND, OR, and NOT remain available in the forwarded query.",
    ),
    _entry(
        slug="dblp",
        name="DBLP",
        description="Computer-science bibliography maintained by Schloss Dagstuhl",
        subject_coverage="Computer science",
        endpoint="https://dblp.org/search/publ/api",
        query_method="GET with q={query} paginated by f and h",
        rate_limit="2.0 req/s",
        client_module="api_dblp.py",
        requirement="none",
        credential_name=None,
        website="https://dblp.org",
        registration_url=None,
        upstream_policy="No published rate; keep request volume low",
        parallel_safe="Yes",
        notes="",
        keyword_combination="Relevance-ranked (upstream-default, unverified)",
        keyword_combination_notes="DBLP forwards the space-separated query string verbatim; the upstream search box's exact combination semantics are not authoritatively documented.",
    ),
    _entry(
        slug="doaj",
        name="DOAJ",
        description="Community-curated index of peer-reviewed open-access journals",
        subject_coverage="All disciplines (OA journals)",
        endpoint="https://doaj.org/api/search/articles",
        query_method="GET article-search with URL-encoded query",
        rate_limit="5.0 req/s",
        client_module="api_doaj.py",
        requirement="none",
        credential_name=None,
        website="https://doaj.org",
        registration_url=None,
        upstream_policy="No strict rate; courtesy use expected",
        parallel_safe="Yes",
        notes="",
        keyword_combination="Relevance-ranked (Lucene OR default)",
        keyword_combination_notes="DOAJ uses a Lucene-style URL path whose default operator is OR; results are returned in relevance-scored order.",
    ),
    _entry(
        slug="europepmc",
        name="EuropePMC",
        description="Biomedical and life-sciences literature index (EMBL-EBI)",
        subject_coverage="Biomedicine / Life sciences",
        endpoint="https://www.ebi.ac.uk/europepmc/webservices/rest/search",
        query_method="GET with query={q} and cursorMark pagination",
        rate_limit="5.0 req/s",
        client_module="api_europepmc.py",
        requirement="none",
        credential_name=None,
        website="https://europepmc.org",
        registration_url=None,
        upstream_policy="No hard published rate; 'reasonable use' \u2014 5/s is polite",
        parallel_safe="Yes",
        notes="",
        keyword_combination="Relevance-ranked (Lucene OR default)",
        keyword_combination_notes="EuropePMC's Lucene backend defaults to OR between terms; you can place explicit AND/OR/quoted phrases inside a single keyword chip and they will be forwarded verbatim.",
    ),
    _entry(
        slug="hal",
        name="HAL",
        description="French national open-access archive (CCSD)",
        subject_coverage="All disciplines (French-leaning)",
        endpoint="https://api.archives-ouvertes.fr/search/",
        query_method="GET Solr endpoint with q={query} wt=json",
        rate_limit="2.0 req/s",
        client_module="api_hal.py",
        requirement="none",
        credential_name=None,
        website="https://hal.science",
        registration_url=None,
        upstream_policy="No published rate; courtesy use expected",
        parallel_safe="Yes",
        notes="",
        keyword_combination="Relevance-ranked (Solr OR default)",
        keyword_combination_notes="HAL's Solr endpoint defaults to OR between terms unless the query parses as a phrase; results are returned in relevance-scored order.",
    ),
    _entry(
        slug="ieee",
        name="IEEE Xplore",
        description="IEEE/IET digital library; EE / CS / electronics",
        subject_coverage="Electrical engineering / CS / Electronics",
        endpoint="https://ieeexploreapi.ieee.org/api/v1/search/articles",
        query_method="GET with querytext and apikey; robots.txt checked",
        rate_limit="0.2 req/s (1 per 5 s); per-key plan limits",
        client_module="api_ieee.py",
        requirement="required",
        credential_name="ieee_api_key",
        website="https://ieeexplore.ieee.org",
        registration_url="https://developer.ieee.org",
        upstream_policy="200 calls/day free tier",
        parallel_safe="Yes",
        notes="Very low daily quota \u2014 parallel sweeps exhaust it quickly.",
        keyword_combination="Relevance-ranked (upstream-default, unverified)",
        keyword_combination_notes="IEEE Xplore's querytext field is forwarded verbatim; the upstream API's exact combination semantics are not authoritatively documented.",
    ),
    _entry(
        slug="inspire_hep",
        name="INSPIRE-HEP",
        description="Curated literature database for high-energy physics and related fields",
        subject_coverage="High-energy physics / Accelerators / Astroparticle physics",
        endpoint="https://inspirehep.net/api/literature",
        query_method="GET with INSPIRE q syntax, mostrecent sort, projected fields, and page/size pagination",
        rate_limit="2.0 req/s (below the 15 requests/5 s anonymous ceiling)",
        client_module="api_inspire_hep.py",
        requirement="none",
        credential_name=None,
        website="https://inspirehep.net",
        registration_url=None,
        upstream_policy="Anonymous per-IP limit: 15 requests per 5-second window",
        parallel_safe="Yes",
        notes="Author names remain in the upstream Surname, Given form.",
        keyword_combination="Implicit AND",
        keyword_combination_notes="Adjacent free-form terms currently return the same total as explicit AND in the live API; explicit OR broadens the result set. INSPIRE's help page documents the operators but not this default.",
    ),
    _entry(
        slug="medrxiv",
        name="medRxiv",
        description="Preprints across medicine, clinical research, and related health sciences",
        subject_coverage="Medicine / Clinical research / Health sciences preprints",
        endpoint="https://api.biorxiv.org/details/medrxiv/{from}/{to}/{cursor}",
        query_method="GET date-range JSON; keywords filtered client-side by resmon",
        rate_limit="2.0 req/s (conservative; no published API limit)",
        client_module="api_biorxiv.py",
        requirement="none",
        credential_name=None,
        website="https://www.medrxiv.org",
        registration_url=None,
        upstream_policy="No published API rate limit; resmon uses a conservative ceiling",
        parallel_safe="Yes",
        notes="Shares the /details client implementation with bioRxiv while remaining a distinct selectable source.",
        keyword_combination="Explicit OR",
        keyword_combination_notes="The documented /details API retrieves by date range or DOI rather than keyword; resmon filters the returned records and matches when any space-separated term appears in the title or abstract.",
    ),
    _entry(
        slug="nasa_ads",
        name="NASA ADS",
        description="Digital library for astronomy astrophysics and planetary science",
        subject_coverage="Astronomy / Astrophysics / Planetary science",
        endpoint="https://api.adsabs.harvard.edu/v1/search/query",
        query_method="GET with Authorization: Bearer {key} Solr-style q",
        rate_limit="1.0 req/s (per-key daily cap ~5000/day)",
        client_module="api_nasa_ads.py",
        requirement="required",
        credential_name="nasa_ads_api_key",
        website="https://ui.adsabs.harvard.edu",
        registration_url="https://ui.adsabs.harvard.edu/user/settings/token",
        upstream_policy="5000 calls/day per token; no strict req/s",
        parallel_safe="Yes",
        notes="Daily quota (not per-second) is the binding limit.",
        keyword_combination="Relevance-ranked (Solr OR default)",
        keyword_combination_notes="NASA ADS uses Solr-style q parsing; the default operator is OR and results are returned in relevance-scored order.",
    ),
    _entry(
        slug="openaire",
        name="OpenAIRE",
        description="Open scholarly graph aggregating research outputs and relationships",
        subject_coverage="Multi-disciplinary publications / Research outputs",
        endpoint="https://api.openaire.eu/search/publications",
        query_method="GET legacy Search API with keywords, date filters, and XML-derived JSON pagination",
        rate_limit="0.0167 req/s (60/hour unauthenticated)",
        client_module="api_openaire.py",
        requirement="none",
        credential_name=None,
        website="https://explore.openaire.eu",
        registration_url=None,
        upstream_policy="Unauthenticated limit: 60 requests/hour in a one-hour sliding window",
        parallel_safe="Yes",
        notes="OpenAIRE announced this legacy Search API discontinued on May 31, 2026. It still responded on August 30, 2026, but continued availability is not guaranteed.",
        keyword_combination="Combination semantics undocumented",
        keyword_combination_notes="OpenAIRE documents keywords only as a whitespace-separated list and lists its behavior as N/A. resmon forwards the query and does not infer Boolean semantics or perform local filtering.",
    ),
    _entry(
        slug="openalex",
        name="OpenAlex",
        description="Open scholarly index (successor to MAG) operated by OurResearch",
        subject_coverage="All disciplines",
        endpoint="https://api.openalex.org/works",
        query_method="GET /works?search={q} with cursor pagination",
        rate_limit="10.0 req/s (100k/day provider ceiling)",
        client_module="api_openalex.py",
        requirement="none",
        credential_name=None,
        website="https://openalex.org",
        registration_url=None,
        upstream_policy="10 req/s; 100k/day. Polite pool via mailto= query param or UA",
        parallel_safe="Yes",
        notes="Set mailto for stable performance.",
        keyword_combination="Relevance-ranked",
        keyword_combination_notes="OpenAlex's search ranks by relevance across title/abstract/fulltext; not a strict boolean.",
    ),
    _entry(
        slug="plos",
        name="PLOS",
        description="Public Library of Science journal articles (Solr)",
        subject_coverage="Biology / Medicine / Natural sciences (PLOS journals only)",
        endpoint="https://api.plos.org/search",
        query_method="GET Solr with q wt=json start rows",
        rate_limit="5.0 req/s",
        client_module="api_plos.py",
        requirement="none",
        credential_name=None,
        website="https://plos.org",
        registration_url=None,
        upstream_policy="10 req/min soft guidance (resmon is faster)",
        parallel_safe="Yes",
        notes="If you see 429s lower the limiter to 0.2 req/s.",
        keyword_combination="Relevance-ranked (upstream-default, unverified)",
        keyword_combination_notes="PLOS uses a Solr backend; the default operator is typically OR with relevance scoring, but the upstream's exact configuration is not authoritatively documented.",
    ),
    _entry(
        slug="pubmed",
        name="PubMed",
        description="NCBI biomedical literature via E-utilities",
        subject_coverage="Biomedicine",
        endpoint="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/{esearch|efetch}.fcgi",
        query_method="Two-stage: esearch for PMIDs then efetch for abstracts",
        rate_limit="3.0 req/s (matches keyless; 10/s with key)",
        client_module="api_pubmed.py",
        requirement="optional",
        credential_name="pubmed_api_key",
        website="https://pubmed.ncbi.nlm.nih.gov",
        registration_url="https://www.ncbi.nlm.nih.gov/account/",
        upstream_policy="3 req/s keyless; 10 req/s with NCBI API key",
        parallel_safe="Yes",
        notes="Add an API key to raise the ceiling.",
        keyword_combination="Implicit AND",
        keyword_combination_notes="NCBI E-utilities default operator is AND; space-separated terms are joined with AND before submission to PubMed's search index.",
    ),
    _entry(
        slug="semantic_scholar",
        name="Semantic Scholar",
        description="Allen Institute for AI multi-disciplinary scholarly index",
        subject_coverage="All disciplines (strong CS and biomed)",
        endpoint="https://api.semanticscholar.org/graph/v1/paper/search",
        query_method="GET with query and fields; x-api-key header when keyed",
        rate_limit="0.33 req/s (1 per 3 s)",
        client_module="api_semantic_scholar.py",
        requirement="recommended",
        credential_name="semantic_scholar_api_key",
        website="https://www.semanticscholar.org",
        registration_url=None,
        upstream_policy="Unauthenticated: 1 req/s shared, heavily throttled. Partner API key \u2192 1 req/s guaranteed",
        parallel_safe="Yes",
        notes="Expect 429s without a key in bursts.",
        keyword_combination="Relevance-ranked",
        keyword_combination_notes="Semantic Scholar's paper search ranks by relevance across multiple fields; not a strict boolean.",
    ),
    _entry(
        slug="springer",
        name="Springer Nature",
        description="Springer Nature Meta API across Springer Nature BMC Palgrave imprints",
        subject_coverage="STM / Humanities / Social sciences",
        endpoint="https://api.springernature.com/meta/v2/json",
        query_method="GET with q={q} and api_key={key}",
        rate_limit="5.0 req/s (per-key daily cap ~5000/day on free tier)",
        client_module="api_springer.py",
        requirement="required",
        credential_name="springer_api_key",
        website="https://www.springernature.com",
        registration_url="https://dev.springernature.com",
        upstream_policy="5000 calls/day free tier",
        parallel_safe="Yes",
        notes="Daily quota is the binding limit.",
        keyword_combination="Relevance-ranked (Solr OR default)",
        keyword_combination_notes="Springer Nature's Meta API ranks by relevance with an OR-based default; documents matching more terms rank higher.",
    ),
    _entry(
        slug="zenodo",
        name="Zenodo",
        description="General-purpose open repository for published research outputs",
        subject_coverage="Multi-disciplinary publications / Data / Software / Other outputs",
        endpoint="https://zenodo.org/api/records",
        query_method="GET with Elasticsearch query-string q, best-match sort, and page/size pagination",
        rate_limit="0.5 req/s (30 search requests/min)",
        client_module="api_zenodo.py",
        requirement="none",
        credential_name=None,
        website="https://zenodo.org",
        registration_url=None,
        upstream_policy="Search REST API: 30 req/min; anonymous pages contain at most 25 records",
        parallel_safe="Yes",
        notes="Date bounds are expressed as a publication_date range inside the q query.",
        keyword_combination="Relevance-ranked (implicit OR)",
        keyword_combination_notes="Zenodo's search guide says space-separated terms match with OR by default and results are ranked against the query; explicit AND requires both terms.",
    ),
]


def catalog_as_dicts() -> list[dict]:
    """Return the catalog as a list of plain dicts (safe for JSON responses)."""
    return [entry.to_dict() for entry in REPOSITORY_CATALOG]


def credential_names() -> set[str]:
    """Return the set of credential names referenced by the catalog."""
    return {e.credential_name for e in REPOSITORY_CATALOG if e.credential_name}


def required_credential_for(slug: str) -> str | None:
    """Return the credential name for a repo if it is strictly required, else None."""
    for e in REPOSITORY_CATALOG:
        if e.slug == slug and e.api_key_requirement == "required":
            return e.credential_name
    return None
