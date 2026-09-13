"""P3 — the identity each client fills, from a record that source really sent.

Every fixture in ``fixtures/author_identity/`` was **cut from a live response**
captured by ``probe_entity_search.py`` on 2026-09-06, not written by hand. That
matters more here than in most places: the thing under test is whether resmon
reads the field the source actually uses, and a hand-written fixture is a test
of resmon against resmon's idea of the payload. Ledger 23's shape.

The fixtures are trimmed — three authors, the fields the client reads — and
otherwise verbatim.

**What this cannot see:** whether the source still sends that shape. The
capability table records the date it was true, and the `live_network` cases in
`test_api_tier*.py` are what would notice a change. Nothing here would.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import (  # noqa: E402
    api_crossref, api_doaj, api_dryad, api_europepmc, api_inspire_hep,
    api_openalex, api_pubmed, api_semantic_scholar,
)
from implementation_scripts.api_base import Author, NormalizedResult, bare_orcid  # noqa: E402
from implementation_scripts.repo_catalog import REPOSITORY_CATALOG  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "author_identity"


def load(name: str):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# One case per client that the catalog says fills something
# ---------------------------------------------------------------------------

def test_openalex_reads_the_orcid_and_the_raw_affiliation():
    work = load("openalex")["results"][0]
    result = api_openalex.OpenAlexClient._parse_work(work)
    with_orcid = [a for a in result.authors if a.orcid]
    assert with_orcid, "the fixture was chosen because it has one"
    assert all(len(a.orcid) == 19 and a.orcid.count("-") == 3 for a in with_orcid)
    assert any(a.affiliations for a in result.authors)
    # The OpenAlex author key rides as a namespaced source id, never as an ORCID.
    assert any(("openalex", "") != sid for a in result.authors for sid in a.source_ids)


def test_crossref_reads_the_affiliation_and_bares_the_orcid():
    item = load("crossref")["message"]["items"][0]
    result = api_crossref.CrossrefClient._parse_item(item)
    assert any(a.affiliations for a in result.authors)
    for author in result.authors:
        if author.orcid:
            assert not author.orcid.startswith("http"), (
                "an ORCID stored as a URI would not compare equal to the same "
                "ORCID from a source that sends it bare")


def test_pubmed_reads_the_affiliation_and_the_orcid_identifier():
    xml = (FIXTURES / "pubmed.xml").read_text(encoding="utf-8")
    results = api_pubmed.PubmedClient._parse_xml(xml)
    assert results, "the fixture holds one article"
    authors = results[0].authors
    assert all(a.affiliations for a in authors), (
        "PubMed carried an affiliation on 30 of 30 authors measured")
    assert any(a.orcid for a in authors)


def test_europepmc_reads_the_orcid_and_claims_no_affiliation():
    item = load("europepmc")["resultList"]["result"][0]
    result = api_europepmc.EuropepmcClient._parse_result(item)
    assert any(a.orcid for a in result.authors)
    # 0 of 65 author objects carried one, so none is claimed — the capability
    # says so and this asserts the client agrees with the capability.
    assert not any(a.affiliations for a in result.authors)


def test_europepmc_falls_back_to_the_author_string():
    """`authorList` is absent on some result types; `authorString` is not."""
    item = {"id": "1", "source": "MED", "title": "T",
            "authorString": "Smith J, Doe A.", "firstPublicationDate": "2024-01-01"}
    result = api_europepmc.EuropepmcClient._parse_result(item)
    assert [a.name for a in result.authors] == ["Smith J", "Doe A"]
    assert not any(a.orcid for a in result.authors)


def test_inspire_reads_orcid_from_the_ids_array_and_ignores_other_schemes():
    hit = load("inspire_hep")["hits"]["hits"][0]
    result = api_inspire_hep.InspireHepClient._parse_record(hit)
    assert any(a.orcid for a in result.authors)
    assert any(a.affiliations for a in result.authors)
    # An INSPIRE BAI is an identifier and is *not* an ORCID; storing one in that
    # column would make two different people's identifiers compare equal.
    for author in result.authors:
        if author.orcid:
            assert bare_orcid(author.orcid) == author.orcid


def test_dryad_reads_orcid_and_affiliation_and_still_drops_the_email():
    dataset = load("dryad")["_embedded"]["stash:datasets"][0]
    result = api_dryad.DryadClient._parse_record(dataset)
    assert any(a.orcid for a in result.authors)
    assert all(a.affiliations for a in result.authors)
    blob = json.dumps([[a.name, a.orcid, list(a.affiliations)] for a in result.authors])
    assert "@" not in blob, "the email must not survive into the corpus"


def test_doaj_reads_the_affiliation_and_not_an_empty_orcid():
    record = load("doaj")["results"][0]
    result = api_doaj.DoajClient._parse_article(record)
    assert all(a.affiliations for a in result.authors)
    assert not any(a.orcid for a in result.authors), (
        "DOAJ's orcid_id was empty on all 72 authors measured; filling it from "
        "an empty field would claim an identity DOAJ never sent")


def test_semantic_scholar_keeps_its_own_id_and_claims_no_orcid():
    paper = load("semantic_scholar")["data"][0]
    result = api_semantic_scholar.SemanticScholarClient._parse_paper(paper)
    assert any(a.source_ids for a in result.authors)
    for author in result.authors:
        for scheme, _value in author.source_ids:
            assert scheme == "semantic_scholar", (
                "an unnamespaced id could be compared against another source's")
        assert author.orcid is None


# ---------------------------------------------------------------------------
# The denominator, and the rule the fills must not break
# ---------------------------------------------------------------------------

FILLED_HERE = {
    "openalex": test_openalex_reads_the_orcid_and_the_raw_affiliation,
    "crossref": test_crossref_reads_the_affiliation_and_bares_the_orcid,
    "pubmed": test_pubmed_reads_the_affiliation_and_the_orcid_identifier,
    "europepmc": test_europepmc_reads_the_orcid_and_claims_no_affiliation,
    "inspire_hep": test_inspire_reads_orcid_from_the_ids_array_and_ignores_other_schemes,
    "dryad": test_dryad_reads_orcid_and_affiliation_and_still_drops_the_email,
    "doaj": test_doaj_reads_the_affiliation_and_not_an_empty_orcid,
}


def test_every_client_the_catalog_says_fills_something_has_a_case():
    """P3's denominator: the capability table, not a list in this file.

    A source whose `returns_orcid` or `returns_affiliation` is turned on without
    a case here would be a capability the app advertises and nothing exercises.
    """
    claimed = {e.slug for e in REPOSITORY_CATALOG
               if e.entity_search.returns_orcid or e.entity_search.returns_affiliation}
    assert claimed == set(FILLED_HERE), (
        f"claimed with no case: {sorted(claimed - set(FILLED_HERE))}; "
        f"case with no claim: {sorted(set(FILLED_HERE) - claimed)}")


def test_the_string_table_keeps_filling_for_every_client():
    """Decision 4's compatibility half.

    Twenty of the twenty-seven clients still pass a list of names, and the
    corpus's author *strings* must keep arriving exactly as before — a phase
    that added identity and quietly stopped recording authors for two-thirds of
    the sources would be a functionality decrease.
    """
    plain = NormalizedResult("arxiv", "1", None, "T", ["Jane Doe", "John Smith"],
                             None, None, "u")
    assert plain.author_names == ["Jane Doe", "John Smith"]
    assert all(isinstance(a, Author) for a in plain.authors)
    assert all(a.orcid is None and not a.affiliations for a in plain.authors)


def test_a_bare_string_is_one_author_not_a_row_of_letters():
    """The shim's own sharp edge, found by the sweep-hook tests."""
    result = NormalizedResult("arxiv", "1", None, "T", "Jane Doe", None, None, "u")
    assert result.author_names == ["Jane Doe"]


@pytest.mark.parametrize("value,expected", [
    ("https://orcid.org/0000-0002-9322-3515", "0000-0002-9322-3515"),
    ("http://orcid.org/0000-0001-5109-3700", "0000-0001-5109-3700"),
    ("0000-0002-1825-009x", "0000-0002-1825-009X"),
    ("", None), (None, None), ("not an orcid", None), ("1234", None),
])
def test_an_orcid_is_stored_bare_and_upper_cased(value, expected):
    """Two sources' ids for one person have to compare equal.

    An identifier match that failed because one source sent a URI and another
    sent the bare id would silently downgrade to a name match — which is the
    exact failure the basis rule exists to make visible, arriving through the
    back door.
    """
    assert bare_orcid(value) == expected


# ---------------------------------------------------------------------------
# From the client to the corpus, which is a different claim
# ---------------------------------------------------------------------------
#
# **Everything above tests parsing, and parsing is not storing.** Written after
# a mutation that disabled the structured write path in
# ``database.index_document_facets`` left all nineteen checks above green: they
# assert what a client *builds*, and nothing asserted the identity survived the
# journey into ``document_authors``. That is the gap this section closes, and it
# is the reason the mutation column in the handback matters more than the count.

import sqlite3  # noqa: E402

from implementation_scripts import database  # noqa: E402
from implementation_scripts.normalizer import deduplicate_batch  # noqa: E402


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    database.init_db(conn=connection)
    yield connection
    connection.close()


def _authors_of(connection, external_id: str) -> list[sqlite3.Row]:
    return connection.execute(
        "SELECT da.author, da.orcid, da.affiliation, da.source_author_id "
        "  FROM document_authors da "
        "  JOIN documents d ON d.id = da.document_id "
        " WHERE d.external_id = ? ORDER BY da.author",
        (external_id,),
    ).fetchall()


def test_the_identity_reaches_the_corpus_and_not_only_the_client(conn):
    """P3's other half: the ORCID is in the table, not just in the object."""
    record = NormalizedResult(
        "openalex", "W1", "10.1/x", "A paper",
        [Author(name="Jane Doe", orcid="0000-0002-9322-3515",
                affiliations=("University of Montreal",),
                source_ids=(("openalex", "A123"),)),
         Author(name="John Smith")],
        None, "2024-01-01", "https://example.org/1")
    deduplicate_batch(conn, [record])

    rows = _authors_of(conn, "W1")
    assert [r["author"] for r in rows] == ["Jane Doe", "John Smith"]
    assert rows[0]["orcid"] == "0000-0002-9322-3515"
    assert rows[0]["affiliation"] == "University of Montreal"
    assert rows[0]["source_author_id"] == "openalex:A123"
    # The author with nothing but a name keeps nothing but a name. NULL is
    # "the source did not say" and must never become an empty string, which a
    # later `WHERE orcid IS NOT NULL` would count as an identifier.
    assert rows[1]["orcid"] is None
    assert rows[1]["affiliation"] is None
    assert rows[1]["source_author_id"] is None


def test_a_client_that_still_passes_names_still_fills_the_string_table(conn):
    """Twenty of twenty-seven clients pass names; none of them may regress."""
    record = NormalizedResult("arxiv", "A1", None, "Another paper",
                              ["Ada Lovelace", "Alan Turing"],
                              None, "2024-02-02", "https://example.org/2")
    deduplicate_batch(conn, [record])
    rows = _authors_of(conn, "A1")
    assert [r["author"] for r in rows] == ["Ada Lovelace", "Alan Turing"]
    assert all(r["orcid"] is None for r in rows)


def test_the_paper_hash_does_not_change_when_a_source_learns_an_orcid(conn):
    """Cross-source dedup keys on names, and must keep doing so.

    The same paper from a source that carries an ORCID and from one that does
    not is one paper. If the metadata hash covered the identity fields, the day
    a client learned to fill them every cross-source duplicate would stop
    matching and the corpus would quietly double.
    """
    from implementation_scripts.normalizer import normalize_result  # noqa: PLC0415

    plain = NormalizedResult("arxiv", "X1", None, "Same title",
                             ["Jane Doe"], None, "2024-03-03", "u")
    rich = NormalizedResult("openalex", "X2", None, "Same title",
                            [Author(name="Jane Doe", orcid="0000-0002-9322-3515",
                                    affiliations=("MIT",))],
                            None, "2024-03-03", "u")
    assert (normalize_result(plain)._metadata_hash
            == normalize_result(rich)._metadata_hash)


def test_schema_13_is_the_version_and_its_columns_exist(conn):
    # 16 since Library; 13's columns are still what this file is
    # about, and they are asserted directly below rather than through the
    # version number.
    assert database.SCHEMA_VERSION == 18
    assert database.get_schema_version(conn) == 18
    columns = {row[1] for row in conn.execute("PRAGMA table_info(document_authors)")}
    assert {"orcid", "affiliation", "source_author_id"} <= columns


def test_an_upgraded_database_gains_the_columns_and_backfills_nothing():
    """Schema 13 on a corpus that predates it.

    Nothing is backfilled and nothing may be: every author row already in a
    corpus came from a comma-joined string that never carried an identifier, so
    NULL is the true answer and any inferred value would be resmon asserting an
    identity it never received. Same rule as schema 11's refusal to backfill
    `routines.intent`.
    """
    # Built by taking a *current* database back to 12 rather than by writing a
    # pre-13 schema by hand: a hand-written one is a guess about what a real
    # upgrading corpus looks like, and the first attempt at this test proved it
    # by omitting three columns other migrations expect. Everything but
    # `document_authors` is therefore exactly what an upgrading user has.
    old = sqlite3.connect(":memory:")
    old.row_factory = sqlite3.Row
    database.init_db(conn=old)
    old.execute("INSERT INTO documents (source_repository, external_id, title, "
                "authors, metadata_hash) VALUES ('arxiv', 'OLD1', 'Older paper', "
                "'Jane Doe', 'h1')")
    doc_id = old.execute(
        "SELECT id FROM documents WHERE external_id = 'OLD1'").fetchone()["id"]
    old.execute("INSERT INTO document_authors (document_id, author) VALUES (?, ?)",
                (doc_id, "Jane Doe"))
    old.execute("DROP INDEX IF EXISTS idx_document_authors_orcid")
    for column in ("orcid", "affiliation", "source_author_id"):
        old.execute(f"ALTER TABLE document_authors DROP COLUMN {column}")
    # Schema-17/18 objects cannot predate this synthetic marker. Drop only
    # the four empty Evidence tables; their explicit indexes leave with them.
    for table in ('evidence_answers', 'evidence_notes', 'evidence_project_files', 'evidence_projects'):
        assert old.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] == 0
        old.execute(f'DROP TABLE {table}')
    old.execute("UPDATE app_settings SET value = '12' WHERE key = 'schema_version'")
    old.commit()
    assert {r[1] for r in old.execute("PRAGMA table_info(document_authors)")} == {
        "document_id", "author"}, "the fixture is not a pre-13 table"

    database.init_db(conn=old)

    columns = {row[1] for row in old.execute("PRAGMA table_info(document_authors)")}
    assert {"orcid", "affiliation", "source_author_id"} <= columns
    # A 12 -> current upgrade, so this tracks the constant: what the test is
    # for is that the columns arrive and stay empty, not which number the
    # marker reached.
    assert database.get_schema_version(old) == database.SCHEMA_VERSION
    row = old.execute(
        "SELECT orcid, affiliation, source_author_id FROM document_authors "
        "WHERE author = 'Jane Doe'").fetchone()
    assert row["orcid"] is None and row["affiliation"] is None
    assert row["source_author_id"] is None
    old.close()
