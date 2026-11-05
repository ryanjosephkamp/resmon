"""Open copies and identifiers: what each source sends, how it is stored, and what may be downloaded.

Every record below is authored for this file in the shape the source's API
returns. No title, author or identifier is taken from a real paper's record.
"""
from __future__ import annotations

import sqlite3

import pytest

from implementation_scripts import database, open_access
from implementation_scripts.api_arxiv import ArxivClient
from implementation_scripts.api_biorxiv import BiorxivClient
from implementation_scripts.api_europepmc import EuropepmcClient
from implementation_scripts.api_inspire_hep import InspireHepClient
from implementation_scripts.api_openalex import OpenAlexClient
from implementation_scripts.api_pubmed import PubmedClient
from implementation_scripts.api_semantic_scholar import SemanticScholarClient
from implementation_scripts.normalizer import deduplicate_batch


@pytest.fixture()
def conn(tmp_path):
    connection = database.get_connection(tmp_path / "oa.db")
    database.init_db(conn=connection)
    yield connection
    connection.close()


# ---------------------------------------------------------------------------
# Licenses and identifiers as the sources write them
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw, slug", [
    ("cc-by", "cc-by"), ("CC BY 4.0", "cc-by"), ("cc by-nc", "cc-by-nc"),
    ("CCBYNCND", "cc-by-nc-nd"), ("CCBYSA", "cc-by-sa"), ("cc_by_nc_nd", "cc-by-nc-nd"),
    ("http://creativecommons.org/licenses/by-sa/4.0/", "cc-by-sa"),
    ("https://creativecommons.org/publicdomain/zero/1.0/", "cc0"),
    ("cc0", "cc0"), ("CC0 1.0", "cc0"), ("public-domain", "public-domain"),
    ("PUBLICDOMAIN", "public-domain"),
    ("http://arxiv.org/licenses/nonexclusive-distrib/1.0/", "arxiv-nonexclusive"),
    ("http://arxiv.org/licenses/assumed-1991-2003/", "arxiv-assumed"),
    ("publisher-specific-oa", "publisher-specific-oa"), ("other-oa", "other-oa"),
    ("cc_no", "cc-no"), ("", None), (None, None), ("   ", None),
])
def test_a_license_is_read_as_each_source_writes_it(raw, slug):
    assert open_access.normalize_license(raw) == slug


def test_only_open_licenses_are_open():
    assert all(open_access.is_open(s) for s in open_access.OPEN_LICENSES)
    for slug in ("publisher-specific-oa", "other-oa", "implied-oa", "cc-no", None, "unknown"):
        assert not open_access.is_open(slug)


@pytest.mark.parametrize("raw, bare", [
    ("2401.00001v2", "2401.00001"), ("arXiv:1706.03762", "1706.03762"),
    ("https://arxiv.org/abs/2401.12345v1", "2401.12345"), ("http://arxiv.org/pdf/2401.12345.pdf", "2401.12345"),
    ("http://arxiv.org/abs/hep-th/9901001v1", "hep-th/9901001"), ("not an id", None), ("10.1/x", None),
])
def test_an_arxiv_id_is_bare(raw, bare):
    assert open_access.bare_arxiv_id(raw) == bare


def test_a_doi_is_bare_and_lowercase():
    assert open_access.bare_doi("https://doi.org/10.1371/Journal.PONE.0000001") == "10.1371/journal.pone.0000001"
    assert open_access.bare_doi("doi:10.5555/ABC") == "10.5555/abc"
    assert open_access.bare_doi("not a doi") is None


# ---------------------------------------------------------------------------
# Each source's record
# ---------------------------------------------------------------------------

OPENALEX_WORK = {
    "id": "https://openalex.org/W9990000001", "doi": "https://doi.org/10.5555/fixture.1",
    "display_name": "An authored fixture on open copies", "publication_date": "2026-01-02",
    "authorships": [{"author": {"display_name": "Ada Fixture"}}],
    "ids": {"openalex": "https://openalex.org/W9990000001",
            "pmid": "https://pubmed.ncbi.nlm.nih.gov/99900001",
            "pmcid": "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9990001"},
    "primary_location": {"landing_page_url": "https://journal.example.org/a/1"},
    "best_oa_location": {"is_oa": True, "pdf_url": "https://journal.example.org/a/1.pdf",
                         "landing_page_url": "https://journal.example.org/a/1",
                         "license": "cc-by", "version": "publishedVersion"},
    "locations": [
        {"is_oa": False, "pdf_url": None, "landing_page_url": "https://paywall.example.org/a/1",
         "license": None, "version": "publishedVersion"},
        {"is_oa": True, "pdf_url": "https://journal.example.org/a/1.pdf",
         "landing_page_url": "https://journal.example.org/a/1",
         "license": "cc-by", "version": "publishedVersion"},
        {"is_oa": True, "pdf_url": "https://arxiv.org/pdf/2601.00001", "landing_page_url": "https://arxiv.org/abs/2601.00001",
         "license": None, "version": "submittedVersion"},
        {"is_oa": True, "pdf_url": "https://repo.example.edu/1.pdf", "landing_page_url": None,
         "license": "publisher-specific-oa", "version": "acceptedVersion"},
    ],
}


def test_openalex_keeps_its_open_locations_and_ids():
    result = OpenAlexClient._parse_work(OPENALEX_WORK)
    by_place = {loc.location: loc for loc in result.open_access}
    assert set(by_place) == {"https://journal.example.org/a/1.pdf", "https://repo.example.edu/1.pdf"}
    journal = by_place["https://journal.example.org/a/1.pdf"]
    assert (journal.license, journal.license_basis, journal.version) == ("cc-by", "record", "published")
    repo = by_place["https://repo.example.edu/1.pdf"]
    assert repo.license == "publisher-specific-oa" and not open_access.is_open(repo.license)
    # arXiv's copy is held once, through its id, not as OpenAlex's location.
    assert set(result.identifiers) == {("arxiv", "2601.00001"), ("pmid", "99900001"), ("pmcid", "PMC9990001")}


EUROPEPMC_CORE = {
    "id": "99900002", "source": "MED", "pmid": "99900002", "pmcid": "PMC9990002",
    "doi": "10.5555/fixture.2", "title": "A second authored fixture",
    "authorString": "Fixture A.", "firstPublicationDate": "2026-01-03",
    "isOpenAccess": "Y", "license": "cc by-nc",
    "fullTextUrlList": {"fullTextUrl": [
        {"availability": "Open access", "availabilityCode": "OA", "documentStyle": "pdf",
         "site": "Europe_PMC", "url": "https://europepmc.org/articles/PMC9990002?pdf=render"},
        {"availability": "Open access", "availabilityCode": "OA", "documentStyle": "html",
         "site": "Europe_PMC", "url": "https://europepmc.org/articles/PMC9990002"},
        {"availability": "Free", "availabilityCode": "F", "documentStyle": "pdf",
         "site": "PubMedCentral", "url": "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9990002/pdf/"},
        {"availability": "Subscription required", "availabilityCode": "S", "documentStyle": "pdf",
         "site": "DOI", "url": "https://paywall.example.org/2.pdf"},
    ]},
}


def test_europepmc_keeps_readable_pdfs_and_the_license_only_on_the_open_one():
    result = EuropepmcClient._parse_result(EUROPEPMC_CORE)
    by_place = {loc.location: loc for loc in result.open_access}
    assert set(by_place) == {"https://europepmc.org/articles/PMC9990002?pdf=render",
                             "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9990002/pdf/"}
    assert by_place["https://europepmc.org/articles/PMC9990002?pdf=render"].license == "cc-by-nc"
    # Free to read, with no license stated for it.
    assert by_place["https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9990002/pdf/"].license is None
    assert set(result.identifiers) == {("pmid", "99900002"), ("pmcid", "PMC9990002")}


def test_europepmc_states_no_license_for_a_record_it_does_not_call_open():
    record = {**EUROPEPMC_CORE, "isOpenAccess": "N"}
    result = EuropepmcClient._parse_result(record)
    assert all(loc.license is None for loc in result.open_access)


PUBMED_XML = """<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation>
<PMID>99900003</PMID><Article><ArticleTitle>A third authored fixture</ArticleTitle>
<AuthorList><Author><LastName>Fixture</LastName><ForeName>Ada</ForeName></Author></AuthorList>
<Journal><JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal></Article>
</MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">99900003</ArticleId>
<ArticleId IdType="doi">10.5555/fixture.3</ArticleId><ArticleId IdType="pmc">PMC9990003</ArticleId>
</ArticleIdList><ReferenceList><Reference><ArticleIdList><ArticleId IdType="doi">10.5555/cited</ArticleId>
<ArticleId IdType="pmc">PMC1</ArticleId></ArticleIdList></Reference></ReferenceList></PubmedData>
</PubmedArticle></PubmedArticleSet>"""


def test_pubmed_keeps_the_pmc_id_and_not_a_cited_papers():
    [result] = PubmedClient._parse_xml(PUBMED_XML)
    assert result.doi == "10.5555/fixture.3"
    assert set(result.identifiers) == {("pmid", "99900003"), ("pmcid", "PMC9990003")}
    # PubMed states no license for the PMC copy, so it is not an open location.
    assert result.open_access == []


def test_inspire_keeps_its_arxiv_ids():
    record = {"metadata": {"control_number": 999004, "titles": [{"title": "A fourth authored fixture"}],
                           "arxiv_eprints": [{"value": "2601.00004", "categories": ["hep-th"]}]}}
    result = InspireHepClient._parse_record(record)
    assert result.identifiers == [("arxiv", "2601.00004")]


def test_semantic_scholar_keeps_its_open_pdf_and_ids():
    paper = {"paperId": "f" * 40, "title": "A fifth authored fixture",
             "externalIds": {"DOI": "10.5555/fixture.5", "ArXiv": "2601.00005", "PubMed": "99900005",
                             "PubMedCentral": "9990005"},
             "openAccessPdf": {"url": "https://repo.example.edu/5.pdf", "status": "GREEN", "license": "CCBY"}}
    result = SemanticScholarClient._parse_paper(paper)
    [pdf] = result.open_access
    assert (pdf.pdf_url, pdf.license) == ("https://repo.example.edu/5.pdf", "cc-by")
    assert set(result.identifiers) == {("arxiv", "2601.00005"), ("pmid", "99900005"), ("pmcid", "PMC9990005")}


def test_semantic_scholar_records_a_pointer_to_arxiv_as_the_arxiv_id():
    paper = {"paperId": "e" * 40, "title": "A sixth authored fixture", "externalIds": {},
             "openAccessPdf": {"url": "https://arxiv.org/pdf/2601.00006v2", "status": "GREEN", "license": None}}
    result = SemanticScholarClient._parse_paper(paper)
    assert result.open_access == [] and result.identifiers == [("arxiv", "2601.00006")]


ARXIV_FEED = """<feed xmlns="http://www.w3.org/2005/Atom"><entry>
<id>http://arxiv.org/abs/2601.00007v3</id><title>A seventh authored fixture</title>
<author><name>Ada Fixture</name></author><published>2026-01-07T00:00:00Z</published>
<summary>Authored, not fetched.</summary></entry></feed>"""


def test_arxiv_names_its_own_id():
    [result] = ArxivClient._parse_atom(ARXIV_FEED)
    assert result.identifiers == [("arxiv", "2601.00007")]


def test_biorxiv_keeps_the_license_its_details_state():
    client = BiorxivClient()
    licensed = client._parse_item({"doi": "10.1101/2026.01.08.000001", "title": "An eighth authored fixture",
                                   "version": "2", "license": "cc_by", "date": "2026-01-08"})
    [copy] = licensed.open_access
    assert copy.pdf_url == "https://www.biorxiv.org/content/10.1101/2026.01.08.000001v2.full.pdf"
    assert copy.license == "cc-by" and open_access.is_open(copy.license)
    reserved = client._parse_item({"doi": "10.1101/2026.01.08.000002", "title": "A ninth authored fixture",
                                   "version": "1", "license": "cc_no", "date": "2026-01-08"})
    assert not open_access.is_open(reserved.open_access[0].license)


def test_plos_builds_its_own_pdf_under_its_license():
    copy = open_access.plos_location("10.1371/journal.pone.9990009")
    assert copy.pdf_url == ("https://journals.plos.org/plosone/article/file?"
                            "id=10.1371/journal.pone.9990009&type=printable")
    assert (copy.license, copy.license_basis) == ("cc-by", "host_policy")
    assert open_access.plos_location("10.1371/annotation.123") is None


# ---------------------------------------------------------------------------
# Storage, and a later run filling in a paper already stored
# ---------------------------------------------------------------------------

def _rows(conn, table):
    return [dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY 1, 2")]


def test_a_run_stores_open_copies_and_ids_with_its_papers(conn):
    deduplicate_batch(conn, [OpenAlexClient._parse_work(OPENALEX_WORK)])
    [doc] = conn.execute("SELECT id FROM documents").fetchall()
    places = {r["location"]: r for r in _rows(conn, "document_open_access")}
    assert set(places) == {"https://journal.example.org/a/1.pdf", "https://repo.example.edu/1.pdf",
                           "https://arxiv.org/pdf/2601.00001"}
    assert places["https://arxiv.org/pdf/2601.00001"]["license"] is None
    assert all(r["document_id"] == doc[0] and r["reported_by"] == "openalex" for r in places.values())
    assert {(r["scheme"], r["value"]) for r in _rows(conn, "document_identifiers")} == {
        ("arxiv", "2601.00001"), ("pmid", "99900001"), ("pmcid", "PMC9990001")}


def test_a_later_run_fills_in_a_paper_stored_before_its_source_said_anything(conn):
    bare = OpenAlexClient._parse_work({**OPENALEX_WORK, "locations": [], "best_oa_location": None, "ids": {}})
    deduplicate_batch(conn, [bare])
    assert _rows(conn, "document_open_access") == []
    # The same record from the same source, now with its open copies: the
    # insert is ignored, and the copies are still recorded against the paper.
    stats = deduplicate_batch(conn, [OpenAlexClient._parse_work(OPENALEX_WORK)])
    assert stats["duplicates"] == 1
    assert len(_rows(conn, "document_open_access")) == 3


def test_a_refresh_keeps_a_license_and_moves_seen_at(conn):
    unlicensed = {**OPENALEX_WORK, "best_oa_location": None, "locations": [
        {"is_oa": True, "pdf_url": "https://journal.example.org/a/1.pdf", "license": None}]}
    deduplicate_batch(conn, [OpenAlexClient._parse_work(unlicensed)])
    [before] = _rows(conn, "document_open_access")
    assert before["license"] is None and before["license_basis"] is None
    deduplicate_batch(conn, [OpenAlexClient._parse_work(OPENALEX_WORK)])
    after = {r["location"]: r for r in _rows(conn, "document_open_access")}["https://journal.example.org/a/1.pdf"]
    assert (after["license"], after["license_basis"]) == ("cc-by", "record")
    assert after["first_seen_at"] == before["first_seen_at"]
    # A source that stops stating a license does not erase the one it stated.
    deduplicate_batch(conn, [OpenAlexClient._parse_work(unlicensed)])
    again = {r["location"]: r for r in _rows(conn, "document_open_access")}["https://journal.example.org/a/1.pdf"]
    assert again["license"] == "cc-by"


def test_the_copies_of_a_paper_are_its_doi_and_arxiv_siblings(conn):
    deduplicate_batch(conn, [OpenAlexClient._parse_work(OPENALEX_WORK)])
    feed = ARXIV_FEED.replace("2601.00007v3", "2601.00001v1")
    deduplicate_batch(conn, ArxivClient._parse_atom(feed))
    pubmed = PubmedClient._parse_xml(PUBMED_XML.replace("10.5555/fixture.3", "10.5555/FIXTURE.1"))
    deduplicate_batch(conn, pubmed)
    ids = {r["source_repository"]: r["id"] for r in conn.execute("SELECT id, source_repository FROM documents")}
    assert set(open_access.copies_of(conn, ids["openalex"])) == set(ids.values())
    assert open_access.copies_of(conn, ids["arxiv"])[0] == ids["arxiv"]
    assert set(open_access.copies_of(conn, ids["arxiv"])) == {ids["arxiv"], ids["openalex"]}


# ---------------------------------------------------------------------------
# Which copy may be downloaded
# ---------------------------------------------------------------------------

def _row(**fields) -> dict:
    base = {"id": 1, "reported_by": "openalex", "pdf_url": "https://journal.example.org/a.pdf",
            "license": "cc-by", "version": "published"}
    return {**base, **fields}


def test_a_copy_needs_a_stated_open_license_or_to_be_arxivs_own():
    assert open_access.downloadable(_row())
    assert not open_access.downloadable(_row(license=None))
    assert not open_access.downloadable(_row(license="publisher-specific-oa"))
    assert not open_access.downloadable(_row(pdf_url=None, landing_url="https://journal.example.org/a"))
    arxiv = _row(pdf_url="https://arxiv.org/pdf/2601.00001", license=None, version="submitted")
    assert open_access.needs_license_lookup(arxiv) and open_access.downloadable(arxiv)


@pytest.mark.parametrize("fields", [
    {"reported_by": "core"}, {"reported_by": "nasa_ads"}, {"reported_by": "springer"},
    {"pdf_url": "https://link.springer.com/content/pdf/10.1007/x.pdf"},
    {"pdf_url": "https://core.ac.uk/download/1.pdf"},
    {"pdf_url": "https://articles.adsabs.harvard.edu/pdf/1"},
])
def test_nothing_comes_from_nasa_ads_springer_or_core_whatever_the_license(fields):
    row = _row(**fields)
    assert open_access.refusal(row) is not None and not open_access.downloadable(row)


def test_the_best_copy_is_licensed_first_then_the_version_of_record():
    arxiv = _row(id=1, pdf_url="https://arxiv.org/pdf/2601.00001", license=None, version="submitted")
    accepted = _row(id=2, pdf_url="https://repo.example.edu/a.pdf", version="accepted")
    published = _row(id=3, version="published")
    assert open_access.best_copy([arxiv, accepted, published])["id"] == 3
    assert open_access.best_copy([arxiv, accepted])["id"] == 2
    assert open_access.best_copy([arxiv])["id"] == 1
    assert open_access.best_copy([_row(license=None)]) is None


def test_the_summary_says_why_there_is_nothing_to_download():
    assert open_access.summary([])["why_not"] == "no_open_copy"
    assert open_access.summary([_row(pdf_url=None, landing_url="https://x.example.org/")])["why_not"] == "no_pdf"
    assert open_access.summary([_row(reported_by="core")])["why_not"] == "refused_source"
    assert open_access.summary([_row(license=None)])["why_not"] == "no_license"
    assert open_access.summary([_row()])["downloadable"] is True


def test_the_schema_holds_a_stated_license_to_its_basis(conn):
    conn.execute("INSERT INTO documents (source_repository, external_id, title, metadata_hash) "
                 "VALUES ('x', '1', 't', 'h')")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO document_open_access (document_id, reported_by, location, pdf_url, license, "
                     "first_seen_at, seen_at) VALUES (1, 'x', 'https://a/1', 'https://a/1', 'cc-by', 'n', 'n')")
