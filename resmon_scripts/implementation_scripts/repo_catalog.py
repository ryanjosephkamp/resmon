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

# Whether a source's credit is something resmon *must* show or merely one the
# upstream would like.
#
# The distinction is the whole point of the field and it is not decoration.
# OpenAIRE's metadata is CC BY, so attribution is a license condition and
# reusing it without the credit is simply reuse without a license. arXiv, by
# contrast, *requests* an acknowledgement sentence. Rendering both the same way
# would either overstate arXiv's terms or understate OpenAIRE's, and this
# application does not get to be vague about which obligations are real.
AttributionRequirement = Literal["none", "requested", "required"]

# The finest date precision **resmon's own query to this source can express**,
# read from the client's date-filter code rather than from a description of
# the upstream. That is the quantity that decides whether a window can be
# answered at all, and it is the one a user is entitled to before they read a
# zero: NASA ADS is asked for whole months; DataCite, DBLP, DOAJ, ERIC, Open
# Library and Semantic Scholar for whole years; everything else for exact
# days.
#
# **DOAJ was in that list for three releases without being in this field.**
# ``api_doaj.py`` clips both bounds with ``[:4]`` and sends a ``bibjson.year``
# range, and this said ``day`` -- which the Repositories page renders as
# "Exact dates - resmon can ask for any window". It was a transcription
# error rather than a disagreement about the behaviour, and it survived
# because nothing compared the two. ``SourceConstraints.window_effect``
# records the same quantity in the vocabulary the search forms need, and
# ``test_source_constraints.py`` now requires the two to agree row by row:
# ``day`` with ``as_asked``, ``month`` with ``whole_months``, ``year`` with
# ``whole_years``. Either field alone can be mistyped; both of them wrong in
# the same direction takes effort.
#
# The field says what the query can express, not what each source does about a
# window it cannot express -- those are two different facts and conflating
# them was the temptation here. DBLP, ERIC and Open Library **refuse** a
# window shorter than a calendar year, because a record they returned would
# have unknowable in-window status. DataCite, DOAJ, NASA ADS and Semantic
# Scholar answer the coarser window instead. Both behaviours are honest; only
# the first produces a ``window_unanswerable`` zero, and ``window_rounding``
# is the field that says which a source does.
DateGranularity = Literal["day", "month", "year"]

# The order a keyword search comes back in, read from the client's request
# rather than from a description of the upstream, because it is the order the
# client asks for that decides what a watch with no date limit finds.
#
# ``newest_first``  the client asks the upstream to sort by a date, descending.
#                   A watch with no date limit gets the newest papers each run.
# ``relevance``     the client asks for relevance order, or sends no sort to an
#                   upstream that ranks a query by relevance. A watch with no
#                   date limit gets the most relevant papers of all years,
#                   mostly the same ones every run, and finds little that is new.
# ``unstated``      the client sends no sort and nothing establishes the
#                   upstream's default, so resmon says nothing about it.
#
# No client changes its sort when a date is set; a date only narrows what the
# order is applied to. ``result_order_established`` cites the line, as
# ``established`` does for the constraints, and an empty one fails the guard.
ResultOrder = Literal["newest_first", "relevance", "unstated"]


# ---------------------------------------------------------------------------
# entity_search (2.1) — what a source can be asked about a *person*
# ---------------------------------------------------------------------------
#
# Phase 2.1 watches people, and the first thing that requires is knowing which
# of these sources can be asked about one at all. Every client has exactly one
# search shape — a keyword string in, records out — so an author query is either
# a field syntax *inside* that string, a separate parameter the client does not
# expose today, or a different endpoint entirely. Which, per source, was
# established by ``verification_scripts/probe_entity_search.py`` on 2026-09-06
# and each entry below carries what came back.
#
# **The probe has three controls, and it needed all three.** Asking a source for
# ``au:Hinton`` and getting papers proves nothing: most of these endpoints
# tolerate an unknown field prefix and keyword-search the whole string, which
# returns plausible answers for a famous name. So each author query was run
# against (A) a real author, (B) an author who does not exist, (C) the bare name
# with no syntax, and (D) the same word under a *different* field of the same
# source.
#
# Two of those controls changed an answer:
#
# * **OAPEN** looked like a keyword search under A-versus-C — the two share
#   their first record — and is plainly a parsed field under D, where
#   ``dc.title:"Suber"`` returns nothing for a word ``dc.contributor.author``
#   finds twice. The field result is a *subset* of the keyword result, which is
#   what a working field looks like. OAPEN was withdrawn in October 2026
#   (``api_registry.RETIRED_REPOSITORIES``) and has no entry below; the
#   finding stays here because it is why control D exists.
# * **arXiv, NDL and PubMed are XML**, and the first version of the comparison
#   read JSON keys only — so for those three the controls ran and were compared
#   to nothing. Their verdicts came from A and B alone until the comparison
#   learned to read ``<id>``, ``<PMID>`` and ``<dcterms:identifier>``.
#
# ``unknown`` is a real answer and is used rather than a guess: four sources
# need a key this machine does not hold and one has been answering HTTP 500
# since it was added. Nothing about them is claimed.
EntityQuery = Literal["none", "field", "param", "endpoint", "unknown"]
EntityIdentifier = Literal["none", "orcid", "native", "unknown"]


@dataclass(frozen=True)
class EntitySearch:
    """How a source answers a question about a person, and what it gives back.

    ``returns_orcid`` and ``returns_affiliation`` are about what the record
    **actually carries**, not about which keys exist in it. That distinction is
    the whole point: Crossref puts an ``affiliation`` key on every author object
    and leaves it empty on most of them, and DataCite and Zenodo carry an
    ``orcid`` key that was populated on **none** of the 54 and 16 creators
    measured. A capability read off key names would have claimed all three.
    """

    author_query: EntityQuery
    identifier_query: EntityIdentifier = "none"
    returns_orcid: bool = False
    returns_affiliation: bool = False
    # The exact syntax, with ``{name}`` where the author goes. Empty when the
    # source cannot be asked.
    author_syntax: str = ""
    identifier_syntax: str = ""
    # What was run and what came back. This is the citation; a capability
    # without one fails ``test_repo_catalog.py``.
    established: str = ""

    @property
    def supported(self) -> bool:
        """Whether resmon will ask this source about a person at all."""
        return self.author_query in ("field", "param", "endpoint")


# The day every capability below was established. One constant, so a re-probe
# that moves the answers moves the date with them.
ENTITY_PROBED_ON = "2026-09-06"


def _entity(
    author_query: EntityQuery = "none",
    *,
    identifier_query: EntityIdentifier = "none",
    returns_orcid: bool = False,
    returns_affiliation: bool = False,
    author_syntax: str = "",
    identifier_syntax: str = "",
    established: str = "",
) -> EntitySearch:
    return EntitySearch(
        author_query=author_query,
        identifier_query=identifier_query,
        returns_orcid=returns_orcid,
        returns_affiliation=returns_affiliation,
        author_syntax=author_syntax,
        identifier_syntax=identifier_syntax,
        established=established,
    )


# ---------------------------------------------------------------------------
# Constraints — what a source will do to a query before it is sent
# ---------------------------------------------------------------------------
#
# A *constraint* is something about a source that changes what a user is able
# to ask for, and that resmon knows before anybody presses the button: a date
# window the client cannot express, a keyword search the upstream does not
# have, a cap on how much can come back, a default resmon applies when the
# user leaves a field blank. It is knowable in advance, every time.
#
# A source being down is **not** a constraint. Neither is a rate limit that
# only makes a search slower, a timeout, or a provider that has been answering
# HTTP 500 since March. Those are run-time facts; they already have a home in
# ``zero_reason`` and the source wall, and a page that warned about them
# before every search would be warning about the weather. The dividing
# question is whether the user could act on the sentence while composing the
# query. "DBLP will search all of 2025" is actionable. "OAPEN might be down"
# is not.
#
# **The credential requirement is deliberately absent from this record.** It
# is already stated once, on ``api_key_requirement`` and ``credential_name``,
# and a second copy is exactly the drift this structure exists to prevent:
# ``sweep_engine`` kept a hand-written dict of three sources that require a
# key while the catalog declared four, and GovInfo — whose client returns an
# empty list the moment it finds no key — was recorded as a source that had
# answered with nothing. Anything that needs the credential facts reads the
# two fields above, and ``test_source_constraints.py`` fails if a notice here
# restates them.
#
# What the request can express is ``date_granularity``, a field this module
# already carries. What the client *does* with a window it cannot express is a
# different fact, which that field's own comment points out and does not
# record. That is ``window_effect`` and ``window_rounding`` below.

# How faithfully the user's date window reaches the source.
#
# ``as_asked``      the bounds are sent as typed.
# ``whole_years``   the request is in whole calendar years.
# ``whole_months``  the request is in whole calendar months.
WindowEffect = Literal["as_asked", "whole_years", "whole_months"]

# Which way a coarser window is rounded, and therefore which way it is wrong.
#
# ``inward``   only whole periods *contained by* the window are searched, so a
#              window containing none is refused before any request is sent
#              and the honest answer is no results at all.
# ``outward``  the whole periods the window *touches* are searched, so records
#              outside the dates the user typed can come back.
# ``none``     the window is honored as given.
#
# Both are truthful and they fail in opposite directions, which is why one
# enum cannot carry both and a user cannot be told "year granularity" and left
# to guess which it is.
WindowRounding = Literal["none", "inward", "outward"]

# Whether the upstream searches the keywords, or resmon does.
#
# ``client_side`` is not a smaller version of ``upstream``: it means the
# endpoint has no query parameter at all, resmon retrieves the window and
# matches the terms against each record itself, and the matching rule is
# resmon's rather than the provider's.
KeywordSearch = Literal["upstream", "client_side", "none"]

# The state a sentence is true in. It is shown there and nowhere else.
#
# ``always``             true whatever is on the form.
# ``with_date_window``   only once the form has a date. arXiv's window being
#                        its submission date matters a great deal to somebody
#                        filtering by date and not at all to anybody else, and
#                        arXiv is on most selections every time.
# ``with_end_date``      only once an end date is set. The state a sentence
#                        about what resmon does with your *end* date is true
#                        in -- which is not the same as "both bounds are
#                        set", and standing one in for the other hid NIST
#                        RMM's sentence in the state where it mattered most.
# ``without_start_date`` only while the start date is blank, because the
#                        sentence is about the default resmon substitutes
#                        there. Telling somebody who typed a start date what
#                        would have happened if they had not is noise.
# ``above_record_cap``   only when the run asks for more records than the
#                        source returns in one request -- that is, more than
#                        ``SourceConstraints.records_per_request``.
#
# **Every one of these exists because a sentence was found being shown where
# it was not true.** The first version of this record had one flag; a render
# of the real panel caught bioRxiv promising a January 1, 2020 floor
# underneath a start date the user had just typed, and a review caught DBLP
# saying "a record carrying no year is dropped" directly under "DBLP will not
# be searched at all". A notice whose state cannot be expressed here does not
# get shown with an approximation -- the state gets added.
#
# ``with_end_date`` is that rule being broken and then obeyed. NIST RMM's
# sentence was scoped ``with_both_dates`` because that state already existed
# and was *close*. It is not the same state: with an end date and no start
# date the client sends no upstream date bound at all and filters every
# record locally, which is the case where "a run can come back with fewer
# in-window records than the cap you set" is most true -- and the
# approximation hid it there. The near-enough state is the trap, not the
# missing one.
#
# An enum rather than a pile of booleans, and separate from ``kind`` rather
# than read off it: two of the fifteen window-scoped notices are record
# filters rather than date-window notices, and relabelling them to get the
# display right would make ``kind`` lie about what they are. Both counts are
# asserted in ``test_source_constraints.py``, because a number written into
# a comment is a number nobody re-measures.
NoticeScope = Literal[
    "always",
    "with_date_window",
    "with_end_date",
    "without_start_date",
    "above_record_cap",
]

ConstraintKind = Literal[
    "date_window",
    "keyword_search",
    "credential",
    "result_cap",
    "applied_default",
    "record_filter",
]


@dataclass(frozen=True)
class SourceNotice:
    """One sentence a user should read before they submit, and its citation.

    ``effect`` is written in the future tense of the thing resmon will do,
    not in the abstract vocabulary of the limitation — "resmon will search the
    whole of 2025" rather than "year granularity" — because the second is a
    label and only the first tells somebody whether to change their query.

    ``established`` is where the sentence was read: the client code that
    implements it, or a provider's published wording quoted exactly. It is the
    field that makes the rest checkable, and a notice without one fails
    ``test_source_constraints.py``.
    """

    kind: ConstraintKind
    effect: str
    established: str
    applies_when: NoticeScope = "always"


@dataclass(frozen=True)
class SourceConstraints:
    """Everything resmon can tell a user about a source before they search."""

    window_effect: WindowEffect = "as_asked"
    window_rounding: WindowRounding = "none"
    # Whether records outside the typed dates are dropped again after they
    # arrive. Only meaningful with ``outward`` rounding, where it is the
    # difference between a widened *request* and a widened *answer*.
    window_refiltered_locally: bool = False
    keyword_search: KeywordSearch = "upstream"
    # The most records this source returns in one request, where the client
    # is built around a published ceiling. ``None`` where the page size is an
    # ordinary pagination detail with no consequence for the caller: a number
    # here means a run asking for more than it changes shape.
    records_per_request: int | None = None
    notices: tuple[SourceNotice, ...] = ()
    # The citation for the typed fields above. Empty is the omitted default,
    # and it fails the guard rather than reading like an answer.
    established: str = ""

    @property
    def has_anything_to_say(self) -> bool:
        """Whether this source would change anything about a plain query."""
        return bool(self.notices) or self.window_effect != "as_asked"


def _constraints(
    *,
    window_effect: WindowEffect = "as_asked",
    window_rounding: WindowRounding = "none",
    window_refiltered_locally: bool = False,
    keyword_search: KeywordSearch = "upstream",
    records_per_request: int | None = None,
    notices: tuple[SourceNotice, ...] = (),
    established: str = "",
) -> SourceConstraints:
    return SourceConstraints(
        window_effect=window_effect,
        window_rounding=window_rounding,
        window_refiltered_locally=window_refiltered_locally,
        keyword_search=keyword_search,
        records_per_request=records_per_request,
        notices=notices,
        established=established,
    )


def _notice(
    kind: ConstraintKind,
    effect: str,
    established: str,
    *,
    applies_when: NoticeScope = "always",
) -> SourceNotice:
    return SourceNotice(
        kind=kind,
        effect=effect,
        established=established,
        applies_when=applies_when,
    )


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
    attribution: str
    attribution_requirement: AttributionRequirement
    attribution_source: str
    date_granularity: DateGranularity
    result_order: ResultOrder
    result_order_established: str
    entity_search: EntitySearch
    constraints: SourceConstraints

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
    attribution: str = "",
    attribution_requirement: AttributionRequirement = "none",
    attribution_source: str = "",
    date_granularity: DateGranularity = "day",
    result_order: ResultOrder = "unstated",
    result_order_established: str = "",
    entity_search: EntitySearch | None = None,
    constraints: SourceConstraints | None = None,
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
        attribution=attribution,
        attribution_requirement=attribution_requirement,
        attribution_source=attribution_source,
        date_granularity=date_granularity,
        # "unstated" is a real answer, but only with a citation saying why:
        # the omitted default has none, and fails
        # ``test_every_entry_states_its_result_order``.
        result_order=result_order,
        result_order_established=result_order_established,
        # No default that means "cannot be asked": a source added without an
        # answer would then silently claim one. ``None`` becomes an explicit
        # ``unknown`` and ``test_every_entry_has_an_established_entity_capability``
        # fails on it, so the omission is loud.
        entity_search=entity_search or _entity("unknown", established=""),
        # Same reasoning as ``entity_search`` above, for the same reason: the
        # omitted default has an empty citation, so a source added without an
        # answer fails the guard instead of quietly claiming it constrains
        # nothing. "This source constrains nothing" is a real answer and 11 of
        # the 26 rows below give it — but it is written down, not defaulted.
        # Of the other 15, five say only that the window means a date other
        # than the publication date, which is a sentence worth one line to
        # somebody filtering by date and worth none to anybody else.
        constraints=constraints or _constraints(),
    )


# ---------------------------------------------------------------------------
# Catalog — 27 active repositories.
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
        query_method="GET Atom XML: one all: term per word joined with AND, and a submittedDate filter",
        rate_limit="0.33 req/s (1 per 3 s)",
        client_module="api_arxiv.py",
        requirement="none",
        credential_name=None,
        website="https://arxiv.org",
        registration_url=None,
        upstream_policy="\u22653 s between calls; bulk access via OAI-PMH",
        parallel_safe="Yes",
        notes=(
            "Conservative by design. Do not drop the delay. When arXiv answers "
            "429 or 503, resmon waits and asks again: 5 seconds, doubling, or "
            "longer when arXiv's Retry-After asks for longer, up to three minutes "
            "of waiting in one search. A run that still gets 429 or 503 records "
            "how many attempts it made and how long it waited."
        ),
        # arXiv's own default between bare words is OR, measured October 30,
        # 2026 (`_search_query` in api_arxiv.py has the figures). The AND is
        # resmon's, which is what the qualifier says.
        keyword_combination="Implicit AND (added by resmon)",
        keyword_combination_notes=(
            "Every word must match. arXiv itself reads bare words as any one of "
            "them (on October 30, 2026, `all:graph neural` matched 331,422 papers, "
            "as `all:graph OR all:neural` did, against 21,136 for "
            "`all:graph AND all:neural`), so resmon sends each word as its own "
            "all: term joined with AND. A quoted phrase is sent as one exact "
            "phrase. Common English words such as \"of\" and \"the\" are not "
            "required: arXiv leaves most of them out of its index, so requiring "
            "one would empty the search. A query written in "
            "arXiv's own syntax, with a field such as au: or the operators AND, "
            "OR, or ANDNOT, is sent as typed."
        ),
        result_order="newest_first",
        result_order_established=(
            "`api_arxiv.py`: `search()` sends `sortBy=submittedDate` and "
            "`sortOrder=descending`."
        ),
        attribution='Thank you to arXiv for use of its open access interoperability.',
        attribution_requirement="requested",
        attribution_source='https://info.arxiv.org/help/api/index.html',
        constraints=_constraints(
            established=(
                "`api_arxiv.py`: the `submittedDate` clause in "
                "`_search_query` pads both bounds to a valid clock time, so "
                "the window reaches arXiv as typed, and binds every word."),
            notices=(
                _notice(
                    "date_window",
                    "arXiv's date window is its submission date, not a journal "
                    "publication date.",
                    "`api_arxiv.py`: the window is built from "
                    "`submittedDate`, which is not a publication date.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "field", author_syntax='au:"{name}"',
            established=(
                f"{ENTITY_PROBED_ON}: `au:\"Hinton\"` returned 5 entries naming him; the nonsense author 0; "
                "the bare `all:\"Hinton\"` and `ti:\"Hinton\"` controls returned different "
                "id sets. No ORCID and no affiliation anywhere in the Atom record."),
        ),
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
        result_order="unstated",
        result_order_established=(
            "`api_biorxiv.py`: `search()` pages through the `/details` "
            "date-range endpoint with no sort parameter (from 2020-01-01 when "
            "no start date is set) and matches the terms itself; nothing in the "
            "client establishes the order within the range."
        ),
        constraints=_constraints(
            keyword_search="client_side",
            established=(
                "`api_biorxiv.py`: the `_BIORXIV_API_BASE` URL in "
                "`search()` is built from the two dates unrounded, and "
                "`_matches_query` does the keyword matching because the "
                "endpoint has no query parameter."),
            notices=(
                _notice(
                    "keyword_search",
                    "bioRxiv cannot be asked for keywords. resmon retrieves the "
                    "preprints posted in your date range and matches your terms "
                    "against each title and abstract itself; a preprint is kept "
                    "when any one of your terms appears.",
                    "`api_biorxiv.py`: `_matches_query`, called from the "
                    "per-item loop in `search()`. The `_BIORXIV_API_BASE` "
                    "endpoint takes a server, a date range and a cursor and "
                    "nothing else.",
                ),
                _notice(
                    "applied_default",
                    "With no start date, resmon asks bioRxiv from January 1, "
                    "2020. Nothing posted before that is retrieved.",
                    "`api_biorxiv.py`: the `2020-01-01` fallback for "
                    "`d_from` in `search()`.",
                    applies_when="without_start_date",
                ),
            ),
        ),
        entity_search=_entity(
            "none",
            established=(
                f"{ENTITY_PROBED_ON}: the details endpoint takes a date window and a cursor and has no "
                "query parameter of any kind — there is nothing to ask an author about. "
                "Established from the endpoint's own shape, not from a failed call."),
        ),
    ),
    _entry(
        slug="core",
        name="CORE",
        description="Aggregator of open-access research outputs from institutional and subject repositories",
        subject_coverage="Multi-disciplinary OA",
        endpoint="https://api.core.ac.uk/v3/search/works",
        query_method="GET with Authorization: Bearer {key}",
        rate_limit="0.167 req/s (1 per 6 s)",
        client_module="api_core.py",
        requirement="required",
        credential_name="core_api_key",
        website="https://core.ac.uk",
        registration_url="https://core.ac.uk/services/api",
        # https://api.core.ac.uk/docs/v3, "Rate limits", read October 29, 2026.
        upstream_policy=(
            "Counted in tokens by key type: a personal key 25 a minute and 1,000 a "
            "day, an academic key 10 a minute and 5,000 a day; a simple search "
            "costs 1. Replies carry X-RateLimit-Remaining and X-RateLimit-Retry-After"),
        parallel_safe="Yes",
        notes="Must register for an API key before use.",
        keyword_combination="Relevance-ranked (Lucene OR default)",
        keyword_combination_notes="CORE's Solr/Lucene backend defaults to OR between terms; documents matching more terms rank higher but single-term matches still appear.",
        result_order="relevance",
        result_order_established=(
            "`api_core.py`: `search()` sends no sort, and CORE's Lucene backend "
            "ranks documents matching more terms higher "
            "(`keyword_combination_notes`)."
        ),
        attribution='Powered by CORE',
        attribution_requirement="required",
        attribution_source='https://core.ac.uk/faq',
        constraints=_constraints(
            established=(
                "`api_core.py`: the `createdDate` clause in `search()` "
                "interpolates both bounds unrounded."),
            notices=(
                _notice(
                    "date_window",
                    "resmon sends your window to CORE as a createdDate range. "
                    "That is a different field from the work's publication "
                    "date, so a work published long ago but added to CORE "
                    "recently falls inside a recent window.",
                    "`api_core.py`: `search()` sends `createdDate>=` and "
                    "`createdDate<=`, which is not the publication-date "
                    "field.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "unknown",
            identifier_query="unknown",
            established=(
                f"{ENTITY_PROBED_ON}: not established. CORE requires an API key and this machine holds "
                "none, so nothing was asked and nothing is claimed."),
        ),
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
        result_order="relevance",
        result_order_established=(
            "`api_crossref.py`: `search()` sends no sort, and Crossref ranks a "
            "`query` by relevance (`keyword_combination_notes`)."
        ),
        constraints=_constraints(
            established=(
                "`api_crossref.py`: `search()` sends `from-pub-date` and "
                "`until-pub-date` built from the two bounds as typed."),
        ),
        entity_search=_entity(
            "param", author_syntax="query.author={name}",
            returns_orcid=True, returns_affiliation=True,
            established=(
                f"{ENTITY_PROBED_ON}: `query.author=Yoshua Bengio` returned 5 works naming him and the "
                "nonsense author 0. Over a 50-work sample: **2 of 84 authors carried an "
                "`ORCID` and 26 of 84 a non-empty `affiliation`** — the key is on every "
                "author object and empty on most, which is why this was counted rather "
                "than read off the key names."),
        ),
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
        result_order="relevance",
        result_order_established=(
            "`api_datacite.py`: `search()` sends `sort=relevance`."
        ),
        attribution='Metadata from DataCite',
        attribution_requirement="requested",
        attribution_source='https://support.datacite.org/docs/datacite-data-file-use-policy',
        # api_datacite.py:101-107 sends a whole-year `published` filter and keeps each record's own precision.
        date_granularity="year",
        constraints=_constraints(
            window_effect="whole_years",
            window_rounding="outward",
            window_refiltered_locally=True,
            established=(
                "`api_datacite.py`: `_publication_year_filter` builds the "
                "documented year-only `published` filter, `search()` falls "
                "back to a `publicationYear` range for wider or one-sided "
                "windows, and `_inside_requested_window` drops a record "
                "outside the typed dates."),
            notices=(
                _notice(
                    "date_window",
                    "DataCite can only be filtered by publication year, so "
                    "resmon asks for the whole calendar years your window "
                    "touches and then drops anything outside your exact dates "
                    "once it arrives.",
                    "`api_datacite.py`: `_publication_year_filter`, and the "
                    "`publicationYear` fallback in `search()`.",
                    applies_when="with_date_window",
                ),
                _notice(
                    "record_filter",
                    "A DataCite record dated to the year alone is kept only "
                    "when your window covers the whole of that year.",
                    "`api_datacite.py`: `_inside_requested_window` expands "
                    "a year-only record date to a whole year and requires "
                    "the whole interval inside the window.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "field", author_syntax='creators.name:"{name}"',
            established=(
                f"{ENTITY_PROBED_ON}: `creators.name:\"Yoshua Bengio\"` returned 5, the nonsense author 0, "
                "and the bare and `titles.title:` controls returned different id sets. "
                "**No ORCID and no affiliation was populated on any of the 54 creators "
                "measured**, although both keys appear in the document — the brief listed "
                "DataCite as a fill candidate and the record says otherwise."),
        ),
    ),
    _entry(
        slug="dblp",
        name="DBLP",
        description="Computer-science bibliography maintained by Schloss Dagstuhl",
        subject_coverage="Computer science",
        endpoint="https://dblp.org/search/publ/api; https://sparql.dblp.org/sparql",
        query_method=(
            "GET keyword search with q={query}, f/h pagination; POST SPARQL "
            "exact-label authored-publication search with bounded pagination"
        ),
        rate_limit="0.5 req/s (shared; at least 2 seconds between requests)",
        client_module="api_dblp.py",
        requirement="none",
        credential_name=None,
        website="https://dblp.org",
        registration_url=None,
        upstream_policy="DBLP asks automated clients to leave one or two seconds between requests",
        parallel_safe="Shared limiter across REST and SPARQL",
        notes=(
            "Keyword REST and author SPARQL share a 45-second cooperative budget. "
            "DBLP dates have year precision; YYYY-01-01 is storage encoding, not a "
            "known day. Exact-label author search may match several people and aliases "
            "may be missed. A bounded 2026-09-17 diagnostic observed REST challenge "
            "pages and useful SPARQL JSON; future hosted availability is not guaranteed."
        ),
        keyword_combination="Relevance-ranked (upstream-default, unverified)",
        keyword_combination_notes="DBLP forwards the space-separated query string verbatim; the upstream search box's exact combination semantics are not authoritatively documented.",
        result_order="unstated",
        result_order_established=(
            "`api_dblp.py`: the REST search sends no sort, and DBLP's default "
            "order is not authoritatively documented "
            "(`keyword_combination_notes`)."
        ),
        attribution='Bibliographic data from the dblp computer science bibliography',
        attribution_requirement="requested",
        attribution_source='https://dblp.org/faq/1474677.html',
        # DBLP exposes year precision. REST is filtered locally; the SPARQL
        # author route filters xsd:gYear values upstream and validates them locally.
        date_granularity="year",
        constraints=_constraints(
            window_effect="whole_years",
            window_rounding="inward",
            established=(
                "`api_dblp.py`: `_whole_year_bounds` keeps only whole years "
                "inside the window, `search()` returns with no request when "
                "there are none, and `_parse_info` matches each hit's year "
                "because the REST API has no date parameter."),
            notices=(
                _notice(
                    "date_window",
                    "DBLP records only a year, so resmon searches the whole "
                    "calendar years inside your window and matches them after "
                    "the results arrive. A window containing no complete "
                    "calendar year is refused before any request is sent.",
                    "`api_dblp.py`: `_whole_year_bounds`, and the "
                    "`note_unanswerable` early return in `search()`.",
                    applies_when="with_date_window",
                ),
                _notice(
                    "record_filter",
                    "A DBLP record carrying no year at all is dropped whenever "
                    "you set a date window.",
                    "`api_dblp.py`: the `elif date_from or date_to` branch "
                    "in `_parse_info`.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "endpoint", author_syntax='SPARQL exact rdfs:label "{name}" + dblp:authoredBy',
            established=(
                "2026-09-06 historical REST evidence: `author:Geoffrey_Hinton:` "
                "returned a hit and the nonsense author 0. That dated observation is "
                "not a current REST success; a bounded 2026-09-17 diagnostic observed "
                "REST challenge pages. On 2026-09-17, a bounded official SPARQL "
                "diagnostic returned useful exact-label authored-publication bindings. "
                "Exact-label ambiguity and alias misses remain; candidate hosted "
                "acceptance is pending."),
        ),
    ),
    _entry(
        slug="doaj",
        # Year, not day: the client sends `bibjson.year`. See the
        # DateGranularity comment above for why this was wrong until now.
        date_granularity="year",
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
        result_order="relevance",
        result_order_established=(
            "`api_doaj.py`: `search()` sends no sort, and DOAJ returns results "
            "in relevance-scored order (`keyword_combination_notes`)."
        ),
        constraints=_constraints(
            window_effect="whole_years",
            window_rounding="outward",
            established=(
                "`api_doaj.py`: `search()` clips both bounds with `[:4]` "
                "and sends `bibjson.year`; nothing narrows the answer back "
                "to the days asked for."),
            notices=(
                _notice(
                    "date_window",
                    "DOAJ is searched by publication year, so a window inside "
                    "a single year widens to the whole of it and results can "
                    "fall outside the dates you set.",
                    "`api_doaj.py`: the `bibjson.year` clause in "
                    "`search()`.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "field", author_syntax='bibjson.author.name:"{name}"',
            returns_affiliation=True,
            established=(
                f"{ENTITY_PROBED_ON}: the author field returned 5 and the nonsense author 0, and the "
                "`bibjson.title:` control a different set. **72 of 72 authors carried an "
                "affiliation and none carried an ORCID.**"),
        ),
    ),
    _entry(
        slug="dryad",
        name="Dryad",
        description="Curated research datasets published for open reuse",
        subject_coverage="Multi-disciplinary research data",
        endpoint="https://datadryad.org/api/v2/search",
        query_method="GET /search with q, publishedSince, publishedBefore, page, and per_page",
        rate_limit="1.0 req/s (conservative; no published API limit)",
        client_module="api_dryad.py",
        requirement="none",
        credential_name=None,
        website="https://datadryad.org",
        registration_url=None,
        upstream_policy="No published numeric API rate limit; resmon uses a conservative shared ceiling",
        parallel_safe="Yes",
        notes=(
            "Dryad publishes accepted datasets under CC0 for reuse: "
            "https://datadryad.org/publication_policy. Citation is recommended, "
            "not required: https://dev.datadryad.org/help/guides/reuse."
        ),
        keyword_combination="Implicit AND",
        keyword_combination_notes="Dryad's OpenAPI /search documentation says multiple q terms return only items containing all terms.",
        result_order="unstated",
        result_order_established=(
            "`api_dryad.py`: `search()` sends no sort, and nothing establishes "
            "Dryad's default order."
        ),
        constraints=_constraints(
            established=(
                "`api_dryad.py`: `search()` sends `publishedSince` and "
                "`publishedBefore` built from the two bounds as typed."),
        ),
        entity_search=_entity(
            "param", author_syntax="author={name}",
            returns_orcid=True, returns_affiliation=True,
            established=(
                f"{ENTITY_PROBED_ON}: `author=Michael Brown` returned 5 datasets and the nonsense author 0. "
                "**191 of 191 authors carried an affiliation and 22 of 191 an ORCID.**"),
        ),
    ),
    _entry(
        slug="eric",
        name="ERIC",
        description="Education research and information index maintained by the U.S. Department of Education",
        subject_coverage="Education research / Policy / Practice",
        endpoint="https://api.ies.ed.gov/eric/",
        query_method="GET JSON served as text/plain with upstream publication-year filtering",
        rate_limit="0.5 req/s (conservative; no published API limit)",
        client_module="api_eric.py",
        requirement="none",
        credential_name=None,
        website="https://eric.ed.gov",
        registration_url=None,
        upstream_policy="No published numeric rate limit; resmon waits two seconds between requests",
        parallel_safe="Yes",
        notes="ERIC documents metadata download for database use. Only publication year is searchable, so resmon preserves year-only precision and does not claim a narrower match. A date window narrower than one whole year therefore returns nothing from ERIC — there is no field to filter on, so resmon reports zero results rather than widening the window you asked for.",
        keyword_combination="Implicit OR",
        keyword_combination_notes="ERIC documents OR as the default between unmarked terms, with stemming. Explicit AND is required when every term must match.",
        result_order="unstated",
        result_order_established=(
            "`api_eric.py`: `search()` sends no sort, and nothing establishes "
            "ERIC's default order."
        ),
        # api_eric.py:168-172 — a window with no whole calendar year inside it is refused, not widened.
        date_granularity="year",
        constraints=_constraints(
            window_effect="whole_years",
            window_rounding="inward",
            established=(
                "`api_eric.py`: `_search_year_bounds` keeps only whole "
                "years inside the window, and `search()` records "
                "`year_granularity` and returns without a request when "
                "there are none."),
            notices=(
                _notice(
                    "date_window",
                    "ERIC exposes only a publication year. resmon searches the "
                    "whole calendar years inside your window, and refuses a "
                    "window containing none rather than returning records whose "
                    "position in it cannot be known.",
                    "`api_eric.py`: `_search_year_bounds`, and the "
                    "`year_granularity` early return in `search()`.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "field", author_syntax='author:"{name}"',
            established=(
                f"{ENTITY_PROBED_ON}: `author:\"John Hattie\"` returned 5, the nonsense author 0, and the "
                "`title:` control a different set. No ORCID or affiliation in the record."),
        ),
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
        result_order="relevance",
        result_order_established=(
            "`api_europepmc.py`: `search()` sends no sort, and Europe PMC's "
            "Lucene backend ranks a query by relevance (`keyword_combination`)."
        ),
        attribution='Data from Europe PMC',
        attribution_requirement="requested",
        attribution_source='https://www.ebi.ac.uk/about/terms-of-use/',
        constraints=_constraints(
            established=(
                "`api_europepmc.py`: `search()` sends `FIRST_PDATE` built "
                "from the two bounds as typed."),
        ),
        entity_search=_entity(
            "field", author_syntax='AUTH:"{name}"',
            returns_orcid=True,
            established=(
                f"{ENTITY_PROBED_ON}: `AUTH:\"Eric Topol\"` returned 5, the nonsense author 0, and the bare "
                "and `TITLE:` controls different sets. **23 of 65 authors carried an "
                "`authorId` of type ORCID; none carried an affiliation on the author "
                "object** — Europe PMC keeps affiliation elsewhere in some result types "
                "and resmon does not claim it from here."),
        ),
    ),
    _entry(
        slug="govinfo", name="GovInfo",
        description="Official U.S. government publication and granule metadata",
        subject_coverage="Legislation / Regulation / Courts / Government reports",
        endpoint="https://api.govinfo.gov/search",
        query_method="POST JSON; publishdate range; opaque offsetMark pagination",
        rate_limit="1.0 req/s (below default key quotas)",
        client_module="api_govinfo.py", requirement="required",
        credential_name="govinfo_api_key", website="https://www.govinfo.gov",
        registration_url="https://www.govinfo.gov/api-signup",
        upstream_policy="Default key limits: 36,000/hour, 1,200/minute, 40/second. https://github.com/usgpo/api#keys",
        parallel_safe="Yes; one shared limiter",
        date_granularity="day",
        keyword_combination="Implicit AND",
        keyword_combination_notes="Spaces imply AND; proper names may become phrases. Explicit Boolean/field syntax is forwarded. https://www.govinfo.gov/help/search-operators",
        result_order="relevance",
        result_order_established=(
            "`api_govinfo.py`: `search()` sends `sorts` on `score`, `DESC`."
        ),
        notes=(
            "Terms verdict: compatible for official bibliographic metadata. GPO permits local digital collections; "
            "its copyright notice warns that embedded third-party content is not automatically public domain. "
            "resmon retains title, government authors, IDs, dateIssued, collection and a link; no teasers, abstracts or document files. "
            "No retention/refresh condition is stated for these fields; private backup is consistent with this metadata reuse. "
            "https://www.govinfo.gov/about/policies "
            "Search pageSize maximum 1000; resmon uses at most 100. The response offsetMark supplies the next cursor; "
            "the client checks both publication-date bounds locally as well. "
            "Each search scans at most max(10000, Max Results) rows, rounded up to a page, and returns the retained prefix. "
            "https://www.govinfo.gov/features/search-service-overview "
            "API keys are sent in the X-Api-Key header: https://api.data.gov/docs/api-key/"
        ),
        constraints=_constraints(
            established=(
                "`api_govinfo.py`: `search()` validates both bounds and "
                "sends the documented `publishdate:range(` form with closed "
                "calendar endpoints."),
        ),
        entity_search=_entity(
            "unknown",
            identifier_query="unknown",
            established=(
                f"{ENTITY_PROBED_ON}: not established. GovInfo requires an API key and this machine holds "
                "none. Its client is Delegation 08's and was not touched."),
        ),
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
        notes=(
            "With no end date, resmon asks HAL for records dated up to the end of "
            "today (UTC). HAL holds records dated in the future, and newest first "
            "they came before every current paper: on October 30, 2026, 93 of the "
            "375 records for `climate` since October 1 were dated after that day. "
            "A record dated ahead is found by a run made after its date."
        ),
        keyword_combination="Implicit OR (Solr default)",
        keyword_combination_notes="HAL's Solr endpoint defaults to OR between terms unless the query parses as a phrase. resmon asks for the results newest first, not in relevance order.",
        result_order="newest_first",
        result_order_established=(
            "`api_hal.py`: `search()` sends `sort=producedDate_tdate desc`."
        ),
        attribution='Data from HAL, the French national open archive',
        attribution_requirement="requested",
        attribution_source='https://doc.hal.science/en/legal-aspects/',
        constraints=_constraints(
            established=(
                "`api_hal.py`: `_produced_date_range` builds the "
                "`producedDate_tdate` range from the two bounds as typed, and "
                "ends an open end at `_utc_today`."),
        ),
        entity_search=_entity(
            "field", author_syntax='authFullName_s:"{name}"',
            established=(
                f"{ENTITY_PROBED_ON}: `authFullName_s:\"Jean-Pierre Serre\"` returned 4, the nonsense author "
                "0, and the `title_s:` control 0 for the same words. **The field is an "
                "exact string**: `authFullName_s:\"Yann LeCun\"` returns 0 where "
                "`\"Yann Le Cun\"` returns 1, so a name that does not match HAL's spelling "
                "finds nothing. **No affiliation is claimed from HAL**: `labStructName_s` "
                "is a *document* field, and one record listed 2 authors against 1 lab "
                "name, so resmon cannot say whose it is. No ORCID was populated either."),
        ),
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
        notes="Author names remain in the upstream Surname, Given form. Abstracts are stored only where INSPIRE reports the abstract's own source as arXiv or CERN, which is the limit its terms of use set; records carrying only a publisher-supplied abstract are indexed without one. In a 100-record sample that was about a fifth of them.",
        keyword_combination="Implicit AND",
        keyword_combination_notes="Adjacent free-form terms currently return the same total as explicit AND in the live API; explicit OR broadens the result set. INSPIRE's help page documents the operators but not this default.",
        result_order="newest_first",
        result_order_established=(
            "`api_inspire_hep.py`: `search()` sends `sort=mostrecent`."
        ),
        constraints=_constraints(
            established=(
                "`api_inspire_hep.py`: `search()` appends `de>` and `de<` "
                "to the query, built from the two bounds as typed."),
        ),
        entity_search=_entity(
            "field", author_syntax="a {name}",
            returns_orcid=True, returns_affiliation=True,
            established=(
                f"{ENTITY_PROBED_ON}: `a Edward Witten` returned 5 and the nonsense author 0; `t` on the "
                "same words returned a different set. **9 of 9 authors carried both an "
                "identifier list including an ORCID and an affiliation.** Quoting breaks "
                "it — `a \"Edward Witten\"` returns 0, which is the first thing the probe "
                "got wrong."),
        ),
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
        result_order="unstated",
        result_order_established=(
            "`api_biorxiv.py`, as for bioRxiv: the `/details` date-range "
            "endpoint with no sort parameter (from 2020-01-01 when no start "
            "date is set), the terms matched by resmon; nothing establishes the "
            "order within the range."
        ),
        constraints=_constraints(
            keyword_search="client_side",
            established=(
                "`api_biorxiv.py`, shared with bioRxiv: the "
                "`_BIORXIV_API_BASE` URL in `search()` is built from the "
                "two dates unrounded, and `_matches_query` does the keyword "
                "matching because the endpoint has no query parameter."),
            notices=(
                _notice(
                    "keyword_search",
                    "medRxiv cannot be asked for keywords. resmon retrieves the "
                    "preprints posted in your date range and matches your terms "
                    "against each title and abstract itself; a preprint is kept "
                    "when any one of your terms appears.",
                    "`api_biorxiv.py`: `_matches_query`, called from the "
                    "per-item loop in `search()`. The `_BIORXIV_API_BASE` "
                    "endpoint takes a server, a date range and a cursor and "
                    "nothing else.",
                ),
                _notice(
                    "applied_default",
                    "With no start date, resmon asks medRxiv from January 1, "
                    "2020. Nothing posted before that is retrieved.",
                    "`api_biorxiv.py`: the `2020-01-01` fallback for "
                    "`d_from` in `search()`.",
                    applies_when="without_start_date",
                ),
            ),
        ),
        entity_search=_entity(
            "none",
            established=(
                f"{ENTITY_PROBED_ON}: the same details endpoint as bioRxiv — a date window and a cursor, "
                "no query of any kind."),
        ),
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
        keyword_combination="Implicit OR (Solr default)",
        keyword_combination_notes="NASA ADS uses Solr-style q parsing; the default operator is OR. resmon asks for the results newest first, not in relevance order.",
        result_order="newest_first",
        result_order_established=(
            "`api_nasa_ads.py`: `search()` sends `sort=date desc`."
        ),
        # api_nasa_ads.py:38-43 sends `pubdate:[YYYY-MM TO YYYY-MM]`.
        date_granularity="month",
        constraints=_constraints(
            window_effect="whole_months",
            window_rounding="outward",
            established=(
                "`api_nasa_ads.py`: `search()` clips both bounds to a "
                "`YYYY-MM` prefix and sends `pubdate`; nothing narrows the "
                "answer back to the days asked for."),
            notices=(
                _notice(
                    "date_window",
                    "NASA ADS is searched by publication month, so a window "
                    "inside a month widens to the whole of it and results can "
                    "fall outside the dates you set.",
                    "`api_nasa_ads.py`: the `pubdate` clause in `search()`.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "unknown",
            identifier_query="unknown",
            established=(
                f"{ENTITY_PROBED_ON}: not established. NASA ADS requires a token and this machine holds "
                "none. Its documented `author:` field is *not* recorded here, because a "
                "documented field resmon has not exercised is a claim, not a capability."),
        ),
    ),
    _entry(
        slug="ndl_search",
        name="NDL Search",
        description="National Diet Library of Japan cross-database bibliographic metadata",
        subject_coverage="Japanese national bibliography / Books / Articles / Cultural heritage metadata",
        endpoint="https://ndlsearch.ndl.go.jp/api/sru",
        query_method="GET SRU 1.2 with dcndl_v3 XML, dpid=open, anywhere, from/until, and at most 500 records per SRU request",
        rate_limit="0.5 req/s (conservative; no published numeric API limit)",
        client_module="api_ndl_search.py",
        requirement="none",
        credential_name=None,
        website="https://ndlsearch.ndl.go.jp/en/",
        registration_url=None,
        upstream_policy="No numeric rate limit published; NDL asks continuous users to identify their usage and may restrict heavy or concurrent traffic",
        parallel_safe="Yes",
        notes=(
            "NDL Search API v1.4: https://ndlsearch.ndl.go.jp/file/help/api/specifications/ndlsearch_api_20260331.pdf "
            "Documents API providers and metadata terms: https://ndlsearch.ndl.go.jp/en/help/api/provider . "
            "Version 1.4 accepts YYYY, YYYY-MM, YYYY-MM-DD from/until bounds. When input bounds differ in precision, resmon preserves inclusive intent by expanding lower partials to their first day and upper partials to their last day before sending same-precision clauses. "
            "The client limits requests to dpid=open and independently retains only records with an explicit PDM 1.0, CC0 1.0, or CC BY 4.0 metadata-rights URI; "
            "the open-provider summary is incomplete for current live results because they include CC BY. "
            "You must credit NDL Search API, on a website or application using the API. "
            "Also, you must credit the metadata providing database and institution in the case that credit is needed. "
            "https://ndlsearch.ndl.go.jp/en/help/api/ . "
            "This catalog note records those obligations but does not itself discharge attribution."
        ),
        keyword_combination="Implicit AND (documented for anywhere)",
        keyword_combination_notes="NDL Search API v1.4 documents AND as the default when multiple values are specified for the anywhere search field. resmon sends the query as one safely quoted anywhere value and does not claim local keyword filtering.",
        result_order="unstated",
        result_order_established=(
            "`api_ndl_search.py`: `search()` sends no sort, and nothing "
            "establishes NDL Search's default order."
        ),
        attribution='Powered by NDL Search API. Metadata provided by the National Diet Library and its contributing databases and institutions.',
        attribution_requirement="required",
        attribution_source='https://ndlsearch.ndl.go.jp/en/help/api/',
        constraints=_constraints(
            records_per_request=500,
            established=(
                "`api_ndl_search.py`: `_parse_date_bound` and `search()` "
                "send each bound at the precision it was given, expanding "
                "only to keep two different precisions inclusive."),
            notices=(
                _notice(
                    "result_cap",
                    "You have asked for more records than NDL Search returns "
                    "in one request, so resmon splits your date range into "
                    "smaller ones — which needs both a start and an end date. "
                    "Without both it returns nothing rather than a silently "
                    "truncated set.",
                    "`api_ndl_search.py`: `_MAX_RECORDS`, and the "
                    "`_collect_partitions` branch in `search()`.",
                    applies_when="above_record_cap",
                ),
                _notice(
                    "record_filter",
                    "resmon asks NDL Search only for open-provider records, and "
                    "keeps only those carrying a single Public Domain Mark 1.0, "
                    "CC0 1.0 or CC BY 4.0 metadata-rights statement. Anything "
                    "else is dropped and counted rather than stored.",
                    "`api_ndl_search.py`: `_ALLOWED_RIGHTS`, the `dpid` "
                    "clause built beside `_cql_quote`, and "
                    "`_normalized_rights_uri`.",
                ),
            ),
        ),
        entity_search=_entity(
            "field", author_syntax='creator="{name}"',
            established=(
                f"{ENTITY_PROBED_ON}: SRU `creator=\"Haruki Murakami\"` returned 5 records and the nonsense "
                "author 0; the `anywhere=` and `title=` controls returned different "
                "identifier sets. No ORCID or affiliation in the dcndl record."),
        ),
    ),
    _entry(
        slug="nist_rmm",
        name="NIST Resource Metadata Management",
        description="NIST papers and technical-report metadata",
        subject_coverage="Engineering / Government technical publications",
        endpoint="https://data.nist.gov/rmm/papers",
        query_method="GET with searchphrase, lower-bound-only from_date, skip, and limit; date_to is filtered locally",
        rate_limit="0.5 req/s (conservative; no published API limit)",
        client_module="api_nist_rmm.py",
        requirement="none",
        credential_name=None,
        website="https://data.nist.gov/rmm/",
        registration_url=None,
        upstream_policy="No authentication or numeric rate limit is documented in the RMM OpenAPI; resmon uses a conservative shared ceiling",
        parallel_safe="Yes",
        notes=(
            "The documented RMM papers API has no upstream upper date bound; "
            "resmon sends from_date only and applies date_to locally. "
            "The mapping from a record to a title, identifier and date is provisional: "
            "NIST's OpenAPI documents the response envelope but not the fields inside a "
            "record, and the endpoint has been returning HTTP 500 since this source was "
            "added, so the mapping has never been checked against a live response. A "
            "record resmon cannot map is skipped and logged rather than stored, so the "
            "failure you would see is no results rather than wrong ones. "
            "Permission to use this data is contingent upon your acceptance of the terms "
            "of this agreement and upon your providing appropriate acknowledgments of "
            "NIST’s creation of the data/work. "
            "https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications"
        ),
        keyword_combination="Undocumented",
        keyword_combination_notes="The RMM OpenAPI documents searchphrase but does not document how space-separated terms are combined.",
        result_order="unstated",
        result_order_established=(
            "`api_nist_rmm.py`: `search()` sends no sort, and nothing "
            "establishes NIST RMM's default order."
        ),
        attribution='Data created by NIST (National Institute of Standards and Technology).',
        attribution_requirement="required",
        attribution_source='https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications',
        constraints=_constraints(
            established=(
                "`api_nist_rmm.py`: `_request_date` validates day-granular "
                "bounds, and `search()` sends `from_date` only."),
            notices=(
                _notice(
                    "date_window",
                    "The NIST RMM API documents a start date and no end date, "
                    "so resmon applies your end date to the records after "
                    "they arrive rather than asking for it. A run can come "
                    "back with fewer in-window records than the cap you set, "
                    "and with no start date either, nothing bounds the "
                    "request upstream at all.",
                    # with_end_date, not with_both_dates: `search()` sets
                    # from_date only `if lower_bound`, while `_inside_window`
                    # applies the upper bound whenever it is set. So the
                    # end-date half is what makes this true, and an end date
                    # on its own is the strongest case rather than an
                    # excluded one.
                    "`api_nist_rmm.py`: `search()` sets `from_date` only when "
                    "there is a lower bound, and `_inside_window` applies the "
                    "upper bound to each record after it arrives.",
                    applies_when="with_end_date",
                ),
                _notice(
                    "date_window",
                    "NIST RMM accepts only whole-day dates written YYYY-MM-DD. "
                    "A year or a year and month is refused rather than "
                    "expanded.",
                    "`api_nist_rmm.py`: `_REQUEST_DATE` and `_request_date` "
                    "accept a whole day and nothing coarser.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "unknown",
            established=(
                f"{ENTITY_PROBED_ON}: not established, and not for want of asking — the endpoint answered "
                "`{{\"message\":\"Certificate file not found\",\"httpStatus\":\"500\"}}`, "
                "which is the same outage its catalog note has recorded since the source "
                "was added."),
        ),
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
        result_order="unstated",
        result_order_established=(
            "`api_openaire.py`: `search()` sends no sort, and nothing "
            "establishes OpenAIRE's default order."
        ),
        attribution='Data from the OpenAIRE Graph, licensed CC BY 4.0. Changes: resmon stores a normalized subset of the returned metadata.',
        attribution_requirement="required",
        attribution_source='https://graph.openaire.eu/docs/apis/terms/',
        constraints=_constraints(
            established=(
                "`api_openaire.py`: `search()` sends `fromDateAccepted` and "
                "`toDateAccepted` built from the two bounds as typed."),
            notices=(
                _notice(
                    "date_window",
                    "resmon sends your window to OpenAIRE as a date-accepted "
                    "range. That is a different field from the work's "
                    "publication date.",
                    "`api_openaire.py`: `search()` sends `fromDateAccepted` "
                    "and `toDateAccepted`, which are not the publication "
                    "date.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "param", author_syntax="author={name}",
            established=(
                f"{ENTITY_PROBED_ON}: `author=Yoshua Bengio` returned 5 results of 877 and the nonsense "
                "author 0; the echoed query shows OpenAIRE parsed it as "
                "`resultauthor exact \"Yoshua Bengio\"`. **Neither ORCID nor a per-author "
                "affiliation was established from the creator objects**, so nothing is "
                "filled from here — the brief listed it as a candidate."),
        ),
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
        result_order="relevance",
        result_order_established=(
            "`api_openalex.py`: `search()` sends no sort, and OpenAlex's "
            "`search` ranks by relevance (`keyword_combination_notes`)."
        ),
        constraints=_constraints(
            established=(
                "`api_openalex.py`: `search()` sends "
                "`from_publication_date` and `to_publication_date` built "
                "from the two bounds as typed."),
        ),
        entity_search=_entity(
            "param", author_syntax="filter=raw_author_name.search:{name}",
            identifier_query="orcid",
            identifier_syntax="filter=author.orcid:https://orcid.org/{orcid}",
            returns_orcid=True, returns_affiliation=True,
            established=(
                f"{ENTITY_PROBED_ON}: `raw_author_name.search:Yoshua Bengio` returned 1,495 works and the "
                "nonsense author 0. **`author.orcid:` is a real identifier query** — the "
                "same ORCID returned 1,294 works and OpenAlex echoed the parsed filter. "
                "**9 of 17 authorships carried an ORCID and 14 of 17 a raw affiliation "
                "string.** The anonymous pool sheds load with a rate-limit body, so the "
                "polite-pool `mailto` is not optional."),
        ),
    ),
    _entry(
        slug="openlibrary",
        name="Open Library",
        description="Open bibliographic catalog of books and other published works",
        subject_coverage="Books / Humanities / General bibliography",
        endpoint="https://openlibrary.org/search.json",
        query_method="GET work search with q, first_publish_year field clauses, page, limit, and projected fields",
        rate_limit="1.0 req/s (unidentified-client ceiling)",
        client_module="api_openlibrary.py",
        requirement="none",
        credential_name=None,
        website="https://openlibrary.org",
        registration_url=None,
        upstream_policy="1 request/second for unidentified clients; 3 requests/second only with an application-and-contact User-Agent",
        parallel_safe="Yes",
        notes="Open Library work search exposes only first publication year, so resmon preserves year-only precision and locally checks the requested window. A sub-year window returns nothing: no whole publication year can be established as inside it, so resmon does not widen the request.",
        keyword_combination="Undocumented",
        keyword_combination_notes="Open Library documents q as a Solr query, but does not document how plain unfielded space-separated terms are combined. resmon forwards the query and does not claim strict local matching.",
        result_order="unstated",
        result_order_established=(
            "`api_openlibrary.py`: `search()` sends no sort, and Open Library "
            "does not document its default order (`keyword_combination_notes`)."
        ),
        # api_openlibrary.py:162-166 — a window with no whole calendar year inside it is refused, not widened.
        date_granularity="year",
        constraints=_constraints(
            window_effect="whole_years",
            window_rounding="inward",
            established=(
                "`api_openlibrary.py`: `_search_year_bounds` keeps only "
                "whole years inside the window, and `search()` records "
                "`year_granularity` and returns without a request when "
                "there are none."),
            notices=(
                _notice(
                    "date_window",
                    "Open Library holds a first-publication year and nothing "
                    "finer. resmon searches the whole calendar years inside "
                    "your window, and refuses a window containing none rather "
                    "than overstating what it knows about a book's date.",
                    "`api_openlibrary.py`: `_publication_year_clause`, and "
                    "the `year_granularity` early return in `search()`.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "param", author_syntax="author={name}",
            established=(
                f"{ENTITY_PROBED_ON}: `author=Ursula K. Le Guin` returned 5 and the nonsense author 0. A "
                "book catalogue: no ORCID, no affiliation."),
        ),
    ),
    _entry(
        slug="osti",
        name="OSTI.GOV",
        description="U.S. Department of Energy research records including technical reports, datasets, and other grey literature",
        subject_coverage="Energy / Physical sciences / DOE-funded research / Technical reports",
        endpoint="https://www.osti.gov/api/v1/records",
        query_method="GET JSON with q, publication date filters, and page/rows pagination",
        rate_limit="0.5 req/s (conservative; no published API limit)",
        client_module="api_osti.py",
        requirement="none",
        credential_name=None,
        website="https://www.osti.gov",
        registration_url=None,
        upstream_policy="No numeric rate limit published; excessive automated requests prohibited; OSTI requests acknowledgement and links to current records",
        parallel_safe="Yes",
        notes="OSTI supports metadata export and full-corpus API access, but public access does not make records or abstracts public domain. OSTI asks users to contact it about library-database reuse and before using records or data as AI, ML, or LLM input.",
        keyword_combination="Combination semantics undocumented",
        keyword_combination_notes="OSTI documents q only as searching the full record for provided terms; it does not state how multiple terms are combined. resmon forwards the query unchanged.",
        result_order="unstated",
        result_order_established=(
            "`api_osti.py`: `search()` sends no sort, and nothing establishes "
            "OSTI's default order."
        ),
        attribution='Courtesy of OSTI.GOV, U.S. Department of Energy',
        attribution_requirement="requested",
        attribution_source='https://www.osti.gov/disclaim',
        constraints=_constraints(
            established=(
                "`api_osti.py`: `search()` sends `publication_date_start` "
                "and `publication_date_end`, converted by `_osti_date` from "
                "the two bounds as given."),
        ),
        entity_search=_entity(
            "param", author_syntax="author={name}",
            established=(
                f"{ENTITY_PROBED_ON}: `author=Steven Chu` returned 5 records and the nonsense author 0. No "
                "ORCID or affiliation in the record."),
        ),
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
        keyword_combination="Upstream default, unverified",
        keyword_combination_notes="PLOS uses a Solr backend; the default operator is typically OR, but the upstream's exact configuration is not authoritatively documented. resmon asks for the results newest first, not in relevance order.",
        result_order="newest_first",
        result_order_established=(
            "`api_plos.py`: `search()` sends `sort=publication_date desc`."
        ),
        attribution='Data Provided by PLOS',
        attribution_requirement="required",
        attribution_source='https://api.plos.org/api-display-policy/',
        constraints=_constraints(
            established=(
                "`api_plos.py`: `search()` sends `publication_date` built "
                "from the two bounds as typed."),
        ),
        entity_search=_entity(
            "field", author_syntax='author:"{name}"',
            established=(
                f"{ENTITY_PROBED_ON}: `author:\"Eric Topol\"` returned 5, the nonsense author 0, and "
                "`title:` on the same words 0. `author_affiliate` is a requestable field "
                "but was not populated in the sample, so no affiliation is claimed."),
        ),
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
        result_order="newest_first",
        result_order_established=(
            "`api_pubmed.py`: `search()` sends E-utilities `sort=pub_date`, "
            "which NCBI documents as newest publication date first."
        ),
        constraints=_constraints(
            established=(
                "`api_pubmed.py`: `_esearch` sends `mindate` and `maxdate` "
                "with `datetype`, built from the two bounds as typed."),
        ),
        entity_search=_entity(
            "field", author_syntax="{name}[au]",
            returns_orcid=True, returns_affiliation=True,
            established=(
                f"{ENTITY_PROBED_ON}: `Eric Topol[au]` returned 5 ids and the nonsense author 0; the bare "
                "term and `[ti]` controls returned different PMID sets. Over the fetched "
                "records, **30 of 30 authors carried an `<Affiliation>` and 4 of 30 an "
                "`<Identifier Source=\"ORCID\">`.**"),
        ),
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
        result_order="relevance",
        result_order_established=(
            "`api_semantic_scholar.py`: `search()` sends no sort, and Semantic "
            "Scholar's paper search ranks by relevance "
            "(`keyword_combination_notes`)."
        ),
        attribution='Data from Semantic Scholar',
        attribution_requirement="required",
        attribution_source='https://www.semanticscholar.org/product/api/license',
        # api_semantic_scholar.py:46-54 sends a `year` range.
        date_granularity="year",
        constraints=_constraints(
            window_effect="whole_years",
            window_rounding="outward",
            established=(
                "`api_semantic_scholar.py`: `search()` clips both bounds to "
                "`year_from` and `year_to`; nothing narrows the answer back "
                "to the days asked for."),
            notices=(
                _notice(
                    "date_window",
                    "Semantic Scholar is searched by publication year, so a "
                    "window inside a single year widens to the whole of it and "
                    "results can fall outside the dates you set.",
                    "`api_semantic_scholar.py`: `year_from` and `year_to` "
                    "in `search()`.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "endpoint",
            author_syntax="/author/search?query={name} then /author/{{id}}/papers",
            identifier_query="native",
            identifier_syntax="/author/{id}/papers",
            established=(
                f"{ENTITY_PROBED_ON}: the paper search has no author field; `/author/search` returned 17 "
                "matches for Yoshua Bengio and `/author/{{id}}/papers` returned his papers. "
                "The author objects carry a Semantic Scholar `authorId` and nothing else: "
                "`authors.externalIds` and `authors.affiliations` are **rejected outright** "
                "as unsupported fields, which is itself the answer about ORCID here."),
        ),
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
        result_order="relevance",
        result_order_established=(
            "`api_springer.py`: `search()` sends no sort, and Springer Nature "
            "ranks by relevance (`keyword_combination_notes`)."
        ),
        constraints=_constraints(
            established=(
                "`api_springer.py`: `search()` appends `onlinedatefrom` and "
                "`onlinedateto` to the query, built from the two bounds as "
                "typed."),
            notices=(
                _notice(
                    "date_window",
                    "resmon sends your window to Springer Nature as an online "
                    "publication date range, which for a journal article is "
                    "the date it first appeared online rather than its issue "
                    "date.",
                    "`api_springer.py`: `search()` sends `onlinedatefrom` "
                    "and `onlinedateto`, the online publication date.",
                    applies_when="with_date_window",
                ),
            ),
        ),
        entity_search=_entity(
            "unknown",
            identifier_query="unknown",
            established=(
                f"{ENTITY_PROBED_ON}: not established. Springer requires a key and this machine holds "
                "none."),
        ),
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
        result_order="relevance",
        result_order_established=(
            "`api_zenodo.py`: `search()` sends `sort=bestmatch`."
        ),
        constraints=_constraints(
            established=(
                "`api_zenodo.py`: `search()` wraps `publication_date` into "
                "the query, built from the two bounds as typed."),
        ),
        entity_search=_entity(
            "field", author_syntax='creators.name:"{name}"',
            established=(
                f"{ENTITY_PROBED_ON}: `creators.name:\"Yoshua Bengio\"` returned 5, the nonsense author 0, "
                "and the `title:` control 0. **No ORCID and no affiliation was populated on "
                "any of the 16 creators measured**, though both keys exist in the schema — "
                "the brief listed Zenodo as a fill candidate and the record says otherwise."),
        ),
    ),
]


def catalog_as_dicts() -> list[dict]:
    """Return the catalog as a list of plain dicts (safe for JSON responses)."""
    return [entry.to_dict() for entry in REPOSITORY_CATALOG]


def credential_names() -> set[str]:
    """Return the set of credential names referenced by the catalog."""
    return {e.credential_name for e in REPOSITORY_CATALOG if e.credential_name}


def required_credential_for(slug: str) -> str | None:
    """Return the credential name for a repo if it is strictly required, else None.

    This is the single answer to "does this source need a key?". It had no
    caller outside its own test for three releases while ``sweep_engine``
    carried a hand-written dict of three slugs beside it, and the fourth —
    GovInfo — was recorded as a source that had answered with nothing rather
    than one that had never been asked. The sweep's gate reads this now.
    """
    for e in REPOSITORY_CATALOG:
        if e.slug == slug and e.api_key_requirement == "required":
            return e.credential_name
    return None


def constraints_for(slug: str) -> SourceConstraints | None:
    """Return what resmon can tell a user about a source before they search.

    ``None`` for a slug the catalog does not carry, which is a different
    answer from a source that constrains nothing — that one is a record whose
    ``has_anything_to_say`` is False.
    """
    for e in REPOSITORY_CATALOG:
        if e.slug == slug:
            return e.constraints
    return None
