# resmon_scripts/verification_scripts/test_source_constraints.py
"""The per-source constraint inventory, and the gate that must read from it.

A constraint is something about a source that changes what a user's query can
ask for: a date window it cannot express, a keyword search it does not have, a
credential it needs. It is not an outage. The difference matters because the
first is knowable before the search is submitted and the second is not, and
this whole inventory exists so the first kind reaches the user *before* they
wait for a sweep.

The tests here are mostly guards against one failure: a second list of sources
kept by hand beside the catalog, which drifts. That is not hypothetical. The
sweep engine carried its own dict of three repositories that require an API
key while the catalog declared four, and GovInfo — which returns `[]` the
moment it finds no key — fell through the gap and was recorded as a source
that answered with nothing.
"""

import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import credential_manager as cm  # noqa: E402
from implementation_scripts import sweep_engine as se  # noqa: E402
from implementation_scripts.api_base import BaseAPIClient  # noqa: E402
from implementation_scripts.api_registry import list_repositories  # noqa: E402
from implementation_scripts.database import init_db  # noqa: E402
from implementation_scripts.repo_catalog import (  # noqa: E402
    REPOSITORY_CATALOG,
    SourceNotice,
    catalog_as_dicts,
    constraints_for,
    required_credential_for,
)
from implementation_scripts.sweep_engine import SweepEngine  # noqa: E402


# ---------------------------------------------------------------------------
# The gate that drifted
# ---------------------------------------------------------------------------

def test_the_missing_key_gate_covers_every_source_the_catalog_says_needs_one():
    """The denominator is the catalog, not a list kept beside it.

    ``api_key_requirement == "required"`` is the catalog's own statement that
    the source returns nothing without a credential, and every client that
    declares it also checks for one and returns ``[]``. A gate that knows
    about a subset of those turns the others into a silent zero: the sweep
    asks, the client declines, and the recorded reason is that the source
    answered with nothing.
    """
    declared = {
        entry.slug for entry in REPOSITORY_CATALOG
        if entry.api_key_requirement == "required"
    }
    gated = {
        slug for slug in list_repositories()
        if se.required_credential_for_sweep(slug)
    }
    assert declared == gated, (
        "the sweep's missing-key gate and the catalog disagree about which "
        f"sources need a credential: catalog-only {sorted(declared - gated)}, "
        f"gate-only {sorted(gated - declared)}"
    )


def test_the_gate_names_the_same_credential_the_catalog_does():
    """A gate with the right slug and the wrong credential name is worse."""
    for entry in REPOSITORY_CATALOG:
        assert (
            se.required_credential_for_sweep(entry.slug)
            == required_credential_for(entry.slug)
        ), entry.slug


class _EmptyClient(BaseAPIClient):
    """A client that returns nothing, the way a keyless one does."""

    def get_name(self) -> str:
        return "GovInfo"

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        return []


def test_a_keyless_govinfo_dive_is_recorded_as_a_missing_key(monkeypatch):
    """The journey the drifted gate got wrong, end to end.

    GovInfo's client returns ``[]`` when it finds no credential, and its own
    comment says the sweep's catalog gate records that as a missing key. It
    did not, because the gate did not know about GovInfo. The user was told
    the source had been searched and had nothing.
    """
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    monkeypatch.setattr(se, "get_client", lambda _name: _EmptyClient())
    monkeypatch.setattr(cm, "get_credential", lambda _name: None)

    engine = SweepEngine(db_conn=conn, config={})
    result = engine.execute_dive("govinfo", {"query": "x", "max_results": 1})

    text = Path(result["report_path"]).read_text(encoding="utf-8")
    assert "**GovInfo**: Selected, but the API key it requires was not configured" in text, text
    conn.close()


# ---------------------------------------------------------------------------
# The inventory itself
# ---------------------------------------------------------------------------

def test_every_catalog_entry_carries_a_constraint_record_with_a_citation():
    """The pattern ``entity_search`` set: a capability nobody can leave blank.

    The denominator is the catalog, and a source added without a record gets
    the omitted default — whose ``established`` is empty — so the omission is
    loud rather than a quiet answer.
    """
    for entry in REPOSITORY_CATALOG:
        record = entry.constraints
        assert record.established.strip(), (
            f"{entry.slug} declares constraints with no record of where they "
            "were read from"
        )
        assert record.window_effect in ("as_asked", "whole_years", "whole_months"), entry.slug
        assert record.window_rounding in ("none", "inward", "outward"), entry.slug
        assert record.keyword_search in ("upstream", "client_side", "none"), entry.slug

    registered = set(list_repositories())
    covered = {entry.slug for entry in REPOSITORY_CATALOG}
    assert registered <= covered, (
        f"registered clients with no constraint record: {sorted(registered - covered)}")
    assert len(covered) == 27, f"the catalog is {len(covered)} entries, not 27"


def test_a_window_that_is_honored_exactly_claims_no_rounding():
    """``as_asked`` and a rounding direction are contradictory halves."""
    for entry in REPOSITORY_CATALOG:
        record = entry.constraints
        if record.window_effect == "as_asked":
            assert record.window_rounding == "none", entry.slug
            assert not record.window_refiltered_locally, entry.slug
        else:
            assert record.window_rounding != "none", entry.slug


def test_every_notice_says_what_happens_and_where_that_was_read():
    """A sentence the user reads is a claim, and it points at its source."""
    kinds = {
        "date_window", "keyword_search", "credential", "result_cap",
        "applied_default", "record_filter",
    }
    for entry in REPOSITORY_CATALOG:
        for notice in entry.constraints.notices:
            assert notice.kind in kinds, f"{entry.slug}: {notice.kind}"
            assert notice.effect.strip(), entry.slug
            assert notice.established.strip(), (
                f"{entry.slug} shows '{notice.effect}' with no citation")


# The shapes an English sentence takes when it says a source needs a key.
#
# This list is the guard, so it is worth saying what it is guarding against.
# The first version of this test checked ``kind == "credential"`` — a label —
# and a review drove straight through it: the sentence "NASA ADS requires an
# API key. Without one configured it returns nothing at all." was rejected
# spelled ``kind="credential"`` and **accepted** spelled
# ``kind="date_window"``, rendering on the form either way. A check that
# matches prose *about* the thing rather than the thing is not a check.
#
# Matching text is cruder and catches the case the label missed. It can be
# evaded by somebody determined to phrase around it, and that is fine: this
# exists to stop the honest mistake of writing the sentence twice, not an
# adversary.
#
# The last two entries are bare substrings, so **no notice may mention a key
# or a credential at all** — not even to say something a key changes. An
# earlier docstring here offered that as allowed ("a rate ceiling, a page
# size"), which was a permission the pattern did not grant: every sentence
# written to fit it was rejected, including "With an API key, Springer
# raises the page size from 25 to 100." A rule that reads as permissive and
# behaves as absolute sends the next author round a loop, so the permission
# is gone rather than the substrings. If a key-conditional fact is ever
# worth showing, it gets a typed field, the way ``records_per_request`` did.
_CREDENTIAL_PHRASES = (
    r"requires? (?:an? )?(?:api[- ])?key",
    r"needs? (?:an? )?(?:api[- ])?key",
    r"(?:api[- ])?key (?:it |that )?(?:is )?required",
    r"without (?:a |an |one )?(?:api[- ])?key",
    r"without one configured",
    r"no (?:api[- ])?key (?:is )?(?:configured|stored|set)",
    r"configure (?:an? )?(?:api[- ])?key",
    r"register for (?:an? )?(?:api[- ])?key",
    r"api key",
    r"credential",
    # A bare "key". Found while writing the check below: "PubMed's rate
    # limit rises from 3 to 10 requests a second with a key" went straight
    # through `api key`, so the rule the docstring called absolute was not.
    # `\b` keeps it off "keyword", which the bioRxiv and medRxiv sentences
    # need.
    r"\bkeys?\b",
)


def test_no_notice_tells_a_reader_that_a_source_needs_a_key():
    """Credential facts stay on the one field that already holds them.

    A second copy of "this source needs a key" is the drift this whole file
    exists to prevent — ``sweep_engine`` kept one and GovInfo fell through
    the gap. So the inventory is not allowed to carry one, and this looks at
    what each sentence *says* rather than at the label somebody chose for it.

    The bar is absolute: a notice may not mention a key or a credential,
    for any reason. See ``_CREDENTIAL_PHRASES`` for why it is not the softer
    rule it first looked like.
    """
    import re  # noqa: PLC0415

    pattern = re.compile("|".join(_CREDENTIAL_PHRASES), re.IGNORECASE)
    offenders = []
    for entry in REPOSITORY_CATALOG:
        for notice in entry.constraints.notices:
            found = pattern.search(notice.effect)
            if found:
                offenders.append(
                    f"{entry.slug} ({notice.kind}): {found.group(0)!r} in "
                    f"{notice.effect[:80]!r}")
    assert not offenders, (
        "a constraint notice states a credential requirement. That fact lives "
        "on api_key_requirement and credential_name, the sweep's gate reads "
        "it there, and RepoKeyStatus already renders it on every form that "
        "shows this panel:\n  " + "\n  ".join(offenders))


def test_the_credential_guard_catches_the_sentence_whatever_it_is_labeled():
    """The guard's own red, kept because the first version did not have one.

    A guard with no demonstration that it fires is a guard nobody has seen
    work. Both spellings below are rejected here; only the first was rejected
    before.
    """
    import re  # noqa: PLC0415

    pattern = re.compile("|".join(_CREDENTIAL_PHRASES), re.IGNORECASE)
    sentence = (
        "NASA ADS requires an API key. Without one configured it returns "
        "nothing at all."
    )
    assert pattern.search(sentence), "the guard would not catch the real sentence"
    # The label is irrelevant to the guard, which is the whole point.
    for kind in ("credential", "date_window", "record_filter", "result_cap"):
        assert pattern.search(SourceNotice(
            kind=kind, effect=sentence, established="x").effect)
    # And it does not fire on the sentences the inventory actually carries.
    assert not pattern.search(
        "DBLP records only a year, so resmon searches the whole calendar "
        "years inside your window.")

    # The class an earlier docstring here called allowed. Every one of these
    # is rejected, which is why that permission was removed rather than the
    # substrings narrowed — the rule is absolute and now says so.
    for described_benefit in (
        "With an API key, Springer raises the page size from 25 to 100.",
        "A stored credential raises CORE's ceiling to roughly 10,000 a day.",
        "Semantic Scholar answers faster for callers sending an API key.",
        "PubMed's rate limit rises from 3 to 10 requests a second with a key.",
    ):
        assert pattern.search(described_benefit), (
            "this sentence is rejected today; if that ever changes, the "
            "docstring's claim about what is allowed has to change with it")


def test_date_granularity_and_window_effect_say_the_same_thing():
    """Two fields, one quantity, and nothing was comparing them.

    ``date_granularity`` is the finest precision the request can express.
    ``window_effect`` is the same fact in the vocabulary the search forms
    need. They are redundant by construction, which is exactly why they are
    worth checking against each other: DOAJ's client clips both bounds with
    ``[:4]`` and sends a year range, and ``date_granularity`` said ``day``
    for three releases. The Repositories page rendered that as "Exact dates
    — resmon can ask for any window" while the sweep widened the window to
    the whole year, and nobody saw it because the two statements lived on
    different screens.

    Either field alone can be mistyped. Both wrong in the same direction
    takes effort, and that is the whole value of a redundant pair.
    """
    agreed = {
        "day": "as_asked",
        "month": "whole_months",
        "year": "whole_years",
    }
    wrong = [
        (e.slug, e.date_granularity, e.constraints.window_effect)
        for e in REPOSITORY_CATALOG
        if agreed[e.date_granularity] != e.constraints.window_effect
    ]
    assert not wrong, (
        "date_granularity and window_effect disagree, so one of the two "
        "screens that render them is lying: "
        + ", ".join(f"{s}: {g} vs {w}" for s, g, w in wrong))


def test_the_four_sources_that_refuse_a_sub_year_window_are_the_ones_that_do_it():
    """``inward`` is the rounding that can return nothing, and it is checkable.

    Each of these clients computes whole calendar years inside the requested
    window and declines to call the source when there are none —
    ``note_unanswerable`` in three of them and an early ``[]`` in DBLP.
    Listing them here is not a second inventory: it is the assertion that the
    inventory matches the four ``note_unanswerable``/early-return sites.
    """
    inward = {
        entry.slug for entry in REPOSITORY_CATALOG
        if entry.constraints.window_rounding == "inward"
    }
    assert inward == {"dblp", "eric", "oapen", "openlibrary"}, sorted(inward)


def test_the_two_client_side_keyword_sources_are_the_two_with_no_query_parameter():
    """bioRxiv and medRxiv share one client and one missing capability."""
    client_side = {
        entry.slug for entry in REPOSITORY_CATALOG
        if entry.constraints.keyword_search == "client_side"
    }
    assert client_side == {"biorxiv", "medrxiv"}, sorted(client_side)


# ---------------------------------------------------------------------------
# The API surface
# ---------------------------------------------------------------------------

def test_the_catalog_dicts_carry_the_constraints():
    """``catalog_as_dicts`` is what the route returns; the field must survive."""
    for row in catalog_as_dicts():
        assert "constraints" in row, row["slug"]
        record = row["constraints"]
        assert isinstance(record, dict), row["slug"]
        assert "window_effect" in record and "notices" in record, row["slug"]
        for notice in record["notices"]:
            assert set(notice) == {
                "kind", "effect", "established", "applies_when",
            }, row["slug"]


def test_the_sources_route_returns_the_constraints():
    """FastAPI drops a field the response model does not declare.

    That is the whole reason ``LosslessModel`` exists in this codebase, and an
    inventory the renderer cannot see is an inventory that does not work.
    """
    import resmon as resmon_mod  # noqa: PLC0415
    from fastapi.testclient import TestClient  # noqa: PLC0415

    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    client = TestClient(resmon_mod.app)

    response = client.get("/api/repositories/catalog")
    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 27
    for row in rows:
        assert "constraints" in row, row["slug"]
        assert "window_effect" in row["constraints"], row["slug"]
        assert "keyword_search" in row["constraints"], row["slug"]
        assert isinstance(row["constraints"]["notices"], list), row["slug"]

    dblp = next(row for row in rows if row["slug"] == "dblp")
    assert dblp["constraints"]["window_effect"] == "whole_years"
    assert dblp["constraints"]["window_rounding"] == "inward"


def test_every_citation_names_a_file_and_a_construct_that_exist():
    """A citation pointing at nothing is worse than no citation at all.

    These say ``api_dblp.py: _whole_year_bounds`` rather than
    ``api_dblp.py:138-152`` on purpose: a line number is wrong the moment
    anybody edits the file above it, and silently so. A name is checkable,
    and this is the check.

    **The contract is backticks.** Every code token a citation quotes is
    written in backticks, every backticked token must appear verbatim in the
    module, and every citation must carry at least one that is not
    ``search()``. The middle rule is the one with teeth; the last rule is why
    it has any.

    Its first version extracted tokens by regex from free prose and counted
    69 checks across 49 citations — of which **45 were the token `search`,
    which every ``api_*.py`` contains by definition, and 29 citations had
    nothing else at all.** A review renamed DOAJ's real clause from
    ``bibjson.year`` to ``bibjson.published_year``, left the citation saying
    ``bibjson.year`` untouched, and the suite stayed green. A guard that
    reports a large number while checking almost nothing is worse than no
    guard, because the number gets quoted.
    """
    import re  # noqa: PLC0415

    module_dir = Path(__file__).resolve().parent.parent / "implementation_scripts"
    filename = re.compile(r"api_[a-z_]+\.py")
    backticked = re.compile(r"`([^`]+)`")

    problems: list[str] = []
    checks = 0
    for entry in REPOSITORY_CATALOG:
        citations = [("record", entry.constraints.established)]
        citations += [(n.kind, n.established) for n in entry.constraints.notices]
        for kind, citation in citations:
            where = f"{entry.slug} [{kind}]"
            tokens = backticked.findall(citation)
            modules = [tok for tok in tokens if filename.fullmatch(tok)]
            others = [tok for tok in tokens if not filename.fullmatch(tok)
                      and tok != "search()"]
            if not modules:
                problems.append(f"{where}: names no module in backticks")
                continue
            if not others:
                problems.append(
                    f"{where}: names only its module and `search()`, which "
                    "every client contains — nothing here is checkable")
            sources = {}
            for name in modules:
                path = module_dir / name
                if not path.exists():
                    problems.append(f"{where}: {name} does not exist")
                    continue
                sources[name] = path.read_text(encoding="utf-8")
            if not sources:
                continue
            for token in tokens:
                if filename.fullmatch(token):
                    continue
                probe = token[:-2] if token.endswith("()") else token
                checks += 1
                if not any(probe in src for src in sources.values()):
                    problems.append(
                        f"{where}: `{token}` is in none of {sorted(sources)}")
    assert not problems, "\n".join(problems)
    # A floor rather than an exact count, so adding a citation does not need
    # this number edited; a drop would mean the contract stopped being read.
    assert checks >= 50, f"only {checks} tokens were actually checked"


def test_the_citation_guard_catches_a_renamed_construct():
    """The guard's own red, because the first version did not fire on this.

    Renaming the thing a citation quotes, and leaving the citation alone, is
    the exact way these decay. The check has to notice.
    """
    import re  # noqa: PLC0415

    backticked = re.compile(r"`([^`]+)`")
    doaj = next(e for e in REPOSITORY_CATALOG if e.slug == "doaj")
    quoted = backticked.findall(doaj.constraints.established)
    assert "bibjson.year" in quoted, (
        "this test is pinned to DOAJ's citation naming bibjson.year")

    source = (
        Path(__file__).resolve().parent.parent
        / "implementation_scripts" / "api_doaj.py"
    ).read_text(encoding="utf-8")
    assert "bibjson.year" in source
    # The rename the review performed. The guard reads the module, so the
    # citation and a renamed clause cannot both be satisfied.
    assert "bibjson.year" not in source.replace("bibjson.year", "bibjson.published_year")


def _only(entry, notice):
    """The entry as if it carried only this notice, so a state table can ask
    about one sentence rather than about the source."""
    from dataclasses import replace  # noqa: PLC0415
    return replace(entry, constraints=replace(entry.constraints, notices=(notice,)))


def test_the_coverage_numbers_this_change_claims_are_the_real_ones():
    """The denominators the PR and the comments use, read from the catalog.

    Two different counts are easy to confuse and both get quoted: how many
    sources carry no constraint at all, and how many will put a line on a
    search form. They are not the same number, because a ``date_window``
    notice is shown only once a date is set. Pinning both stops a later
    change quietly making a stated figure wrong.
    """
    quiet = [e.slug for e in REPOSITORY_CATALOG if not e.constraints.has_anything_to_say]
    assert len(quiet) == 11, f"{len(quiet)} quiet sources, not 11: {sorted(quiet)}"
    assert sorted(quiet) == [
        "crossref", "dryad", "europepmc", "govinfo", "hal", "inspire_hep",
        "openalex", "osti", "plos", "pubmed", "zenodo",
    ]

    # The outward set and the one declared per-request cap. Both are quoted
    # in the pull request's count list beside figures that were asserted,
    # which made the whole list read as checked when two of it was not.
    outward = sorted(
        e.slug for e in REPOSITORY_CATALOG
        if e.constraints.window_rounding == "outward"
    )
    assert outward == ["datacite", "doaj", "nasa_ads", "semantic_scholar"], outward
    assert sum(1 for e in REPOSITORY_CATALOG
               if e.constraints.window_refiltered_locally) == 1
    caps = {e.slug: e.constraints.records_per_request
            for e in REPOSITORY_CATALOG
            if e.constraints.records_per_request is not None}
    assert caps == {"ndl_search": 500}, caps

    # The scope histogram, because the pull request quotes it and nothing
    # was checking it. A figure in a body that no test holds is a figure
    # that goes stale the first time somebody adds a notice.
    from collections import Counter  # noqa: PLC0415

    scopes = Counter(
        n.applies_when for e in REPOSITORY_CATALOG for n in e.constraints.notices
    )
    assert sum(scopes.values()) == 22, sum(scopes.values())
    assert dict(scopes) == {
        "with_date_window": 15,
        "always": 3,
        "without_start_date": 2,
        "above_record_cap": 1,
        "with_end_date": 1,
    }, dict(scopes)

    # And the claim that scope is worth keeping separate from ``kind``: two
    # of the window-scoped notices are record filters, not date-window
    # notices, so reading one off the other would make ``kind`` lie.
    window_scoped = [
        n for e in REPOSITORY_CATALOG for n in e.constraints.notices
        if n.applies_when == "with_date_window"
    ]
    assert sum(1 for n in window_scoped if n.kind == "record_filter") == 2

    # Which sources speak in which form state, evaluated the way the renderer
    # evaluates it. This is the audit of every notice against every state it
    # can be shown in, written down rather than done once by eye: the first
    # round of this change did it by eye and shipped DBLP contradicting
    # itself.
    def speaks(entry, *, has_from, has_to, max_results):
        cap = entry.constraints.records_per_request
        for notice in entry.constraints.notices:
            scope = notice.applies_when
            if scope == "with_date_window" and not (has_from or has_to):
                continue
            if scope == "with_end_date" and not has_to:
                continue
            if scope == "without_start_date" and has_from:
                continue
            if scope == "above_record_cap" and not (
                cap is not None and max_results is not None and max_results > cap
            ):
                continue
            return True
        return False

    def speakers(**state):
        return sorted(e.slug for e in REPOSITORY_CATALOG if speaks(e, **state))

    def shown(**state):
        return sorted(
            (e.slug, n.kind)
            for e in REPOSITORY_CATALOG for n in e.constraints.notices
            if speaks(_only(e, n), **state)
        )

    # **Every combination of the two date fields, not a selection of them.**
    # The first version of this table evaluated (none), (start), (start+end)
    # and two caps, and skipped (end only) — which is exactly where NIST
    # RMM's sentence had been hidden by a scope that was close enough. A
    # table that samples the state space is the same enumeration failure the
    # sweep was about, committed by the thing meant to prevent it.
    STATES = [(False, False), (True, False), (False, True), (True, True)]

    # Nothing filled in: three sources, and only the sentences a bare form
    # makes true.
    assert speakers(has_from=False, has_to=False, max_results=100) == [
        "biorxiv", "medrxiv", "ndl_search",
    ]
    assert shown(has_from=False, has_to=False, max_results=100) == [
        ("biorxiv", "applied_default"), ("biorxiv", "keyword_search"),
        ("medrxiv", "applied_default"), ("medrxiv", "keyword_search"),
        ("ndl_search", "record_filter"),
    ]

    # A start date alone retires the two bioRxiv floors and admits the
    # window-scoped sentences. NIST RMM has one sentence here: the
    # whole-day one. Its end-date sentence is not about this state.
    assert speakers(has_from=True, has_to=False, max_results=100) == [
        "arxiv", "biorxiv", "core", "datacite", "dblp", "doaj", "eric",
        "medrxiv", "nasa_ads", "ndl_search", "nist_rmm", "oapen", "openaire",
        "openlibrary", "semantic_scholar", "springer",
    ]
    from_only = shown(has_from=True, has_to=False, max_results=100)
    assert ("biorxiv", "applied_default") not in from_only
    assert len([n for n in from_only if n[0] == "nist_rmm"]) == 1

    # **An end date and no start date.** The state the first table never
    # looked at. `search()` sets from_date only when there is a lower bound,
    # so here resmon sends no upstream date bound at all and `_inside_window`
    # filters every record locally — the case where "fewer in-window records
    # than the cap you set" is most true, and the one where the sentence had
    # gone missing. bioRxiv's floor is still correct here too: an end date
    # does not fill in the start date the default stands in for.
    to_only = shown(has_from=False, has_to=True, max_results=100)
    assert len([n for n in to_only if n[0] == "nist_rmm"]) == 2, (
        "NIST RMM's end-date sentence belongs in the state it is most true in")
    assert ("biorxiv", "applied_default") in to_only

    # Both dates: the same NIST RMM pair, nothing new.
    both = shown(has_from=True, has_to=True, max_results=100)
    assert len([n for n in both if n[0] == "nist_rmm"]) == 2
    assert len(both) == len(from_only) + 1

    # The cap sentence waits until the run actually exceeds the cap. All four
    # forms stop the slider at 500; a saved configuration loads its stored
    # max_results unclamped, which is the only way to reach this.
    for has_from, has_to in STATES:
        assert ("ndl_search", "result_cap") not in shown(
            has_from=has_from, has_to=has_to, max_results=500)
        assert ("ndl_search", "result_cap") in shown(
            has_from=has_from, has_to=has_to, max_results=2000)


def test_a_mislabeled_notice_moves_between_states_and_the_table_sees_it():
    """What the state table does and does not catch, demonstrated.

    It catches a scope that is wrong, because a wrong scope changes which
    state a sentence appears in and the table pins the exact set in all four.
    Moving bioRxiv's blank-start floor to ``always`` — the round-one defect,
    reintroduced through the label rather than the code — shows up as the
    sentence appearing in a state it was asserted out of.

    It does not catch a sentence whose scope is right and whose *text* is
    wrong about what happens in that state. Reading the rendered panel is
    still the only thing that finds those.
    """
    from dataclasses import replace  # noqa: PLC0415

    biorxiv = next(e for e in REPOSITORY_CATALOG if e.slug == "biorxiv")
    floor = next(n for n in biorxiv.constraints.notices
                 if n.kind == "applied_default")
    assert floor.applies_when == "without_start_date"

    mislabeled = replace(floor, applies_when="always")
    # With a start date typed, the real scope hides it and the mislabel does
    # not. That difference is what the table's exact-set assertions compare.
    def visible(notice, has_from):
        if notice.applies_when == "without_start_date" and has_from:
            return False
        return True

    assert not visible(floor, has_from=True)
    assert visible(mislabeled, has_from=True)


def test_constraints_for_answers_by_slug_and_refuses_an_unknown_one():
    assert constraints_for("dblp").window_effect == "whole_years"
    assert constraints_for("arxiv").window_effect == "as_asked"
    assert constraints_for("not-a-source") is None
