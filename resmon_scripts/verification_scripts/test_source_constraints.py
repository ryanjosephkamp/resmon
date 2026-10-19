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


def test_the_inventory_does_not_restate_the_credential_requirement():
    """Credential facts stay on the one field that already holds them.

    A second copy of "this source needs a key" is the drift this file exists
    to prevent, so the inventory is not allowed to carry one. A notice *about*
    a credential may describe what the key changes — a rate ceiling, a page
    size — but it may not be the place a reader learns the key is required.
    """
    for entry in REPOSITORY_CATALOG:
        for notice in entry.constraints.notices:
            if notice.kind != "credential":
                continue
            assert entry.api_key_requirement != "required", (
                f"{entry.slug} restates a required credential in its "
                "constraint record; the requirement lives on "
                "api_key_requirement and nowhere else")


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
                "kind", "effect", "established", "needs_date_window",
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

    # What a form shows with no date range set: every notice that is not
    # about a date window, plus nothing else.
    with_open_window = sorted(
        e.slug for e in REPOSITORY_CATALOG
        if any(not n.needs_date_window for n in e.constraints.notices)
    )
    assert with_open_window == ["biorxiv", "medrxiv", "ndl_search"], with_open_window


def test_constraints_for_answers_by_slug_and_refuses_an_unknown_one():
    assert constraints_for("dblp").window_effect == "whole_years"
    assert constraints_for("arxiv").window_effect == "as_asked"
    assert constraints_for("not-a-source") is None
