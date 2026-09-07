"""Watch profiles: the model, the warning, and the round trip (P7, P8).

Hermetic throughout — a profile is a record, and everything here is about what
resmon will and will not store. The parts that need a real backend (the API's
`basis_warning`, the MCP surface, the editor) live in their own files and say so.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import database, watch_profiles as wp  # noqa: E402


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    database.init_db(conn=connection)
    yield connection
    connection.close()


# ---------------------------------------------------------------------------
# P8 — a profile that can only ever match by name says so at creation
# ---------------------------------------------------------------------------

def test_a_profile_with_nothing_but_a_name_is_told_every_match_is_name_only(conn):
    profile = wp.create_profile(conn, {"display_name": "John Smith"})
    assert profile["basis_warning"]
    assert "name-only" in profile["basis_warning"]
    assert "Add an ORCID" in profile["basis_warning"]


def test_a_profile_with_an_affiliation_is_warned_differently_and_accurately(conn):
    """An affiliation is better than nothing and is not identity.

    Two warnings rather than one, because "name and affiliation" and "name" are
    different guarantees and a single sentence for both would overstate one of
    them.
    """
    profile = wp.create_profile(conn, {
        "display_name": "John Smith", "affiliations": ["MIT"]})
    warning = profile["basis_warning"]
    assert "name and affiliation" in warning
    assert "same name at the same institution" in warning
    assert "name-only" not in warning


def test_an_orcid_retires_the_warning(conn):
    profile = wp.create_profile(conn, {
        "display_name": "Jane Doe",
        "identifiers": {"orcid": {"value": "0000-0002-1825-0097", "cited": "her site"}}})
    assert profile["basis_warning"] is None


def test_a_profile_with_no_identifier_is_accepted_rather_than_refused(conn):
    """Refusing would be worse than warning.

    Watching someone whose ORCID you do not have is a real and ordinary case.
    The product's answer is to say what the matches will be, not to make the
    feature unavailable to anyone who has not gone identifier-hunting first.
    """
    assert wp.create_profile(conn, {"display_name": "Someone"})["id"]


# ---------------------------------------------------------------------------
# Validation — what is refused, and what is merely normalised
# ---------------------------------------------------------------------------

def test_an_orcid_is_stored_bare_however_it_was_typed(conn):
    """The profile's id and the corpus's id must compare equal."""
    profile = wp.create_profile(conn, {
        "display_name": "Jane Doe",
        "identifiers": {"orcid": {"value": "https://orcid.org/0000-0002-1825-009x"}}})
    assert profile["identifiers"]["orcid"]["value"] == "0000-0002-1825-009X"
    stored = conn.execute("SELECT orcid FROM watch_profiles").fetchone()["orcid"]
    assert stored == "0000-0002-1825-009X", (
        "the lifted column is what the matcher joins on and must match too")


@pytest.mark.parametrize("value", ["not-an-orcid", "1234", "0000-0002-1825"])
def test_a_thing_that_is_not_an_orcid_is_refused_with_an_example(conn, value):
    with pytest.raises(wp.ProfileError) as caught:
        wp.create_profile(conn, {"display_name": "X",
                                 "identifiers": {"orcid": {"value": value}}})
    assert "0000-0002-1825-0097" in str(caught.value), (
        "a refusal that does not show the shape is a dead end")


def test_a_ror_id_is_accepted_bare_or_as_a_url(conn):
    for value in ("https://ror.org/02mhbdp94", "02mhbdp94", "02MHBDP94"):
        profile = wp.create_profile(conn, {
            "kind": "institution", "display_name": "Somewhere",
            "identifiers": {"ror": {"value": value}}})
        assert profile["identifiers"]["ror"]["value"] == "02mhbdp94"


def test_a_profile_with_no_name_is_refused(conn):
    with pytest.raises(wp.ProfileError):
        wp.create_profile(conn, {"kind": "person", "names": []})


def test_an_unknown_kind_is_refused_and_lists_the_kinds(conn):
    with pytest.raises(wp.ProfileError) as caught:
        wp.create_profile(conn, {"kind": "spaceship", "display_name": "X"})
    assert "person" in str(caught.value)


def test_aliases_are_kept_and_deduplicated_case_insensitively(conn):
    profile = wp.create_profile(conn, {
        "display_name": "Vincent Lariviere",
        "names": ["Vincent Lariviere", "vincent lariviere", "Vincent Larivière"]})
    values = [n["value"] for n in profile["names"]]
    assert values == ["Vincent Lariviere", "Vincent Larivière"], (
        "the same spelling twice is one name; a different spelling is not")


def test_a_non_latin_name_is_not_assigned_a_script_resmon_guessed(conn):
    """A name written in another script is one person with two spellings.

    `script` is defaulted only when the value is entirely ASCII. Anything else
    stays empty rather than being asserted, because guessing the script of a
    name is exactly the kind of plausible metadata this app refuses to invent.
    """
    profile = wp.create_profile(conn, {
        "display_name": "Haruki Murakami", "names": ["Haruki Murakami", "村上春樹"]})
    scripts = {n["value"]: n["script"] for n in profile["names"]}
    assert scripts["Haruki Murakami"] == "latin"
    assert scripts["村上春樹"] == ""


def test_field_hints_are_stored_and_are_documented_as_disambiguation_only(conn):
    profile = wp.create_profile(conn, {
        "display_name": "John Smith", "field_hints": ["condensed matter"]})
    assert profile["field_hints"] == ["condensed matter"]
    assert "disambiguat" in wp.__doc__.lower()
    assert "never used to search" in wp.__doc__ or "never used to search" in (
        wp.validate_profile.__doc__ or "")


# ---------------------------------------------------------------------------
# P7 — export and import round-trip
# ---------------------------------------------------------------------------

def test_export_then_import_round_trips_the_profile(conn):
    original = wp.create_profile(conn, {
        "kind": "person",
        "display_name": "Jane Doe",
        "names": ["Jane Doe", "J. Doe"],
        "identifiers": {"orcid": {"value": "0000-0002-1825-0097", "cited": "her site"},
                        "openalex": {"value": "A5023888391", "cited": "openalex.org"}},
        "affiliations": ["University of Somewhere"],
        "field_hints": ["astronomy"],
        "notes": "A note.",
    })
    document = wp.profile_to_json(original)
    assert document["schema"] == wp.JSON_SCHEMA_VERSION
    # The id and the timestamps are deliberately absent: an imported profile is
    # the same *person*, not the same row.
    assert "id" not in document and "created_at" not in document

    reimported = wp.create_profile(conn, wp.profile_from_json(json.loads(json.dumps(document))))
    for field in ("kind", "display_name", "names", "identifiers", "affiliations",
                  "field_hints", "notes"):
        assert reimported[field] == original[field], field
    assert reimported["id"] != original["id"]


def test_a_file_from_a_newer_resmon_is_refused_by_name(conn):
    with pytest.raises(wp.ProfileError) as caught:
        wp.profile_from_json({"schema": wp.JSON_SCHEMA_VERSION + 1,
                              "display_name": "Jane"})
    assert "newer resmon" in str(caught.value)
    assert "Update resmon" in str(caught.value)


def test_a_file_with_no_schema_field_is_refused(conn):
    with pytest.raises(wp.ProfileError) as caught:
        wp.profile_from_json({"display_name": "Jane"})
    assert "'schema'" in str(caught.value)


# ---------------------------------------------------------------------------
# P7's denominator — the starter directory
# ---------------------------------------------------------------------------

def test_every_starter_profile_loads_and_validates():
    """The denominator is the directory itself, not a count in this test."""
    files = sorted(wp.STARTER_DIRECTORY.glob("*.json"))
    assert files, "the starter directory is empty"
    loaded = wp.load_starter_profiles()
    assert len(loaded) == len(files)


@pytest.mark.parametrize(
    "path", sorted(wp.STARTER_DIRECTORY.glob("*.json")), ids=lambda p: p.stem)
def test_every_starter_profile_carries_a_verified_identifier(path):
    """A curated set is where an unverified identifier would do the most harm.

    Every one of these was checked against the public ORCID record on
    2026-09-06 and the `cited` field records that check. One candidate was
    dropped because his ORCID record has no public name, so the check could not
    confirm it — see the directory's README.
    """
    document = json.loads(path.read_text(encoding="utf-8"))
    profile = wp.profile_from_json(document)
    orcid = (profile["identifiers"].get("orcid") or {})
    assert orcid.get("value"), f"{path.name} ships without an identifier"
    assert "pub.orcid.org" in orcid.get("cited", ""), (
        f"{path.name}'s identifier has no record of being verified")
    assert wp.basis_warning_for(profile) is None


def test_every_starter_profile_imports_into_a_real_database(conn):
    for profile in wp.load_starter_profiles():
        stored = wp.create_profile(conn, profile)
        assert stored["id"]
    assert len(wp.list_profiles(conn)) == len(wp.load_starter_profiles())


def test_a_broken_starter_file_is_skipped_rather_than_breaking_the_picker(tmp_path):
    (tmp_path / "good.json").write_text(json.dumps({
        "schema": 1, "kind": "person", "display_name": "Fine"}), encoding="utf-8")
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    (tmp_path / "wrong.json").write_text(json.dumps({"display_name": "No schema"}),
                                         encoding="utf-8")
    loaded = wp.load_starter_profiles(tmp_path)
    assert [p["display_name"] for p in loaded] == ["Fine"]


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

def test_updating_a_profile_keeps_its_id_and_moves_its_orcid_column(conn):
    profile = wp.create_profile(conn, {"display_name": "Jane Doe"})
    assert conn.execute("SELECT orcid FROM watch_profiles").fetchone()["orcid"] is None
    updated = wp.update_profile(conn, profile["id"], {
        "display_name": "Jane Doe",
        "identifiers": {"orcid": {"value": "0000-0002-1825-0097"}}})
    assert updated["id"] == profile["id"]
    assert conn.execute("SELECT orcid FROM watch_profiles").fetchone()["orcid"] == (
        "0000-0002-1825-0097")


def test_deleting_a_profile_takes_its_matches_and_leaves_the_corpus(conn):
    """A match row is a statement about a paper, not the paper.

    Deleting the person you were watching must not delete their work out of your
    library, and `Nothing is deleted from the corpus by any 2.1 path` is a
    constraint of the phase rather than a hope about the foreign keys.
    """
    profile = wp.create_profile(conn, {"display_name": "Jane Doe"})
    conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash) "
        "VALUES ('arxiv', 'D1', 'A paper', 'h')")
    doc_id = conn.execute("SELECT id FROM documents").fetchone()["id"]
    conn.execute(
        "INSERT INTO watch_profile_matches "
        "(document_id, profile_id, basis, matched_author) VALUES (?, ?, ?, ?)",
        (doc_id, profile["id"], "name_only", "Jane Doe"))
    conn.commit()

    assert wp.delete_profile(conn, profile["id"]) is True
    assert conn.execute("SELECT COUNT(*) FROM watch_profile_matches").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1


def test_a_match_needs_a_basis_the_schema_recognises(conn):
    """No match without a basis, enforced by the table rather than by care."""
    profile = wp.create_profile(conn, {"display_name": "Jane Doe"})
    conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash) "
        "VALUES ('arxiv', 'D1', 'A paper', 'h')")
    doc_id = conn.execute("SELECT id FROM documents").fetchone()["id"]
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO watch_profile_matches "
            "(document_id, profile_id, basis, matched_author) VALUES (?, ?, ?, ?)",
            (doc_id, profile["id"], "probably", "Jane Doe"))
