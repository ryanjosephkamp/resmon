"""Find a paper: what was typed, who is asked, which record is the paper, and each source's lookup.

The per-source cases drive each supporting client's real ``lookup()`` with its
module's ``safe_request`` replaced by a recorder that answers with an authored
reply in that source's shape. They check two things: that the identifier or
title reaches the request in the place the catalog says it goes, and that the
reply is read into a record ``best_match`` keeps. Every record is authored.
"""
from __future__ import annotations

import json
from urllib.parse import unquote

import httpx
import pytest

from implementation_scripts import api_registry, paper_find, repo_catalog
from implementation_scripts.api_base import NormalizedResult

DOI = "10.5555/resmon.find.42"
TITLE = "An authored fixture on finding one paper across many sources"
ARXIV = "2601.00042"
PMID = "99900042"
BIORXIV_DOI = "10.1101/2026.01.01.000042"


# ---------------------------------------------------------------------------
# What was typed
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("typed, kind, value", [
    ("10.1371/journal.pone.0000308", "doi", "10.1371/journal.pone.0000308"),
    ("https://doi.org/10.5555/ABC.1", "doi", "10.5555/abc.1"),
    ("doi:10.5555/x", "doi", "10.5555/x"),
    ("arXiv:1706.03762", "arxiv", "1706.03762"),
    ("1706.03762v5", "arxiv", "1706.03762"),
    ("https://arxiv.org/abs/2401.00001v2", "arxiv", "2401.00001"),
    ("hep-th/9901001", "arxiv", "hep-th/9901001"),
    ("PMID: 12345678", "pmid", "12345678"),
    ("12345678", "pmid", "12345678"),
    ("https://pubmed.ncbi.nlm.nih.gov/12345678/", "pmid", "12345678"),
    ("  Attention   is all you need ", "title", "Attention is all you need"),
])
def test_what_was_typed_is_read_as_the_identifier_it_is(typed, kind, value):
    query = paper_find.parse(typed)
    assert (query.kind, query.value) == (kind, value)


@pytest.mark.parametrize("typed", ["", "   ", "x" * 501])
def test_nothing_or_too_much_is_refused(typed):
    with pytest.raises(ValueError):
        paper_find.parse(typed)


# ---------------------------------------------------------------------------
# Who is asked
# ---------------------------------------------------------------------------

def test_a_source_is_asked_only_by_a_kind_its_capability_names():
    asked, not_asked = paper_find.plan(paper_find.parse("arXiv:2601.00042"),
                                       ["arxiv", "crossref", "inspire_hep", "core", "dryad", "semantic_scholar"])
    assert asked == ["arxiv", "inspire_hep", "semantic_scholar"]
    why = {item["source"]: item["why"] for item in not_asked}
    assert "Crossref can be asked by DOI and title, not by arXiv id." == why["crossref"]
    assert "CORE requires a key" in why["core"]
    assert "datasets" in why["dryad"]


def test_the_kinds_a_source_can_be_asked_by_read_as_a_list_with_its_and():
    assert paper_find.listed(["DOI"]) == "DOI"
    assert paper_find.listed(["DOI", "title"]) == "DOI and title"
    assert paper_find.listed(["DOI", "PMID", "title"]) == "DOI, PMID, and title"
    _asked, not_asked = paper_find.plan(paper_find.parse("arXiv:1706.03762"), ["europepmc"])
    assert not_asked == [{"source": "europepmc",
                          "why": "EuropePMC can be asked by DOI, PMID, and title, not by arXiv id."}]


def test_biorxiv_is_asked_only_about_its_own_dois():
    asked, not_asked = paper_find.plan(paper_find.parse("10.5555/x.1"), ["biorxiv", "medrxiv", "crossref"])
    assert asked == ["crossref"]
    assert all("10.1101/" in item["why"] for item in not_asked)
    asked, _ = paper_find.plan(paper_find.parse(BIORXIV_DOI), ["biorxiv", "medrxiv"])
    assert asked == ["biorxiv", "medrxiv"]


def test_a_retired_source_is_not_asked_with_the_registrys_reason():
    _asked, not_asked = paper_find.plan(paper_find.parse(DOI), ["oapen"])
    assert "withdrawn" in not_asked[0]["why"]


def test_every_catalog_entry_states_its_paper_lookup():
    """A source without a cited answer would quietly claim one; every entry has an ``established``."""
    for entry in repo_catalog.REPOSITORY_CATALOG:
        capability = entry.paper_lookup
        assert capability.established and capability.established != "PROBE", entry.slug
        assert set(capability.kinds) <= set(paper_find.KINDS), entry.slug
        for kind, syntax in capability.syntax:
            assert kind in capability.kinds and "{value}" in syntax, entry.slug
    assert set(repo_catalog.PAPER_LOOKUP) == {e.slug for e in repo_catalog.REPOSITORY_CATALOG}
    assert len(paper_find.lookup_sources()["doi"]) >= 10


# ---------------------------------------------------------------------------
# Which record is the paper
# ---------------------------------------------------------------------------

def _record(**fields) -> NormalizedResult:
    base = dict(source_repository="openalex", external_id="W1", doi=DOI, title=TITLE,
                authors=["Ada Fixture", "Bo Placeholder"], abstract=None,
                publication_date="2026-01-02", url="https://example.org/1")
    return NormalizedResult(**{**base, **fields})


def test_an_identifier_query_keeps_only_a_record_that_carries_it():
    citing = _record(doi="10.5555/another", external_id="W2")
    match = paper_find.best_match([citing, _record()], paper_find.parse(DOI))
    assert match.matched_by == "doi" and match.record.external_id == "W1" and match.candidates == 2
    assert paper_find.best_match([citing], paper_find.parse(DOI)) is None
    upper = _record(doi=DOI.upper())
    assert paper_find.best_match([upper], paper_find.parse(DOI)).matched_by == "doi"


def test_an_arxiv_or_pmid_query_reads_the_records_ids():
    arxiv = _record(source_repository="arxiv", external_id=f"{ARXIV}v2", doi=None)
    assert paper_find.best_match([arxiv], paper_find.parse(ARXIV)).matched_by == "arxiv"
    via_ids = _record(identifiers=[("arxiv", ARXIV)])
    assert paper_find.best_match([via_ids], paper_find.parse(f"arXiv:{ARXIV}")).matched_by == "arxiv"
    datacite = _record(doi=f"10.48550/arXiv.{ARXIV}")
    assert paper_find.best_match([datacite], paper_find.parse(ARXIV)).matched_by == "arxiv"
    pubmed = _record(source_repository="pubmed", external_id=PMID)
    assert paper_find.best_match([pubmed], paper_find.parse(PMID)).matched_by == "pmid"


def test_a_title_matches_exactly_or_closely_and_never_by_a_guess():
    exact = _record(title=TITLE.upper() + ".")
    close = _record(external_id="W3", title=TITLE.replace("many", "several"))
    other = _record(external_id="W4", title="A different authored paper about finding things")
    query = paper_find.parse(TITLE)
    assert paper_find.best_match([other, close, exact], query).record is exact
    found = paper_find.best_match([other, close], query)
    assert found.matched_by == "close_title" and found.similarity >= paper_find.CLOSE_TITLE
    assert paper_find.best_match([other], query) is None
    # A short title can match exactly, never closely.
    short = paper_find.parse("Deep learning")
    assert paper_find.best_match([_record(title="Deep learning")], short).matched_by == "exact_title"
    assert paper_find.best_match([_record(title="Deep learning in practice")], short) is None


def test_what_differs_from_the_reference_copy():
    ref = _record()
    copy = _record(source_repository="semantic_scholar", title=TITLE + ": a preprint",
                   publication_date="2025-12-01", doi=None, authors=["A. Fixture"])
    fields = {d["field"]: d for d in paper_find.differences(copy, ref)}
    assert set(fields) == {"title", "year", "doi", "author_count"}
    assert fields["year"] == {"field": "year", "this": "2025", "reference": "2026"}
    assert paper_find.differences(ref, ref) == []


def test_the_reference_copy_is_the_record_of_the_agency_first():
    matches = {s: paper_find.Match(_record(source_repository=s), "doi", None, 1)
               for s in ("semantic_scholar", "openalex", "crossref")}
    assert paper_find.reference(matches) == "crossref"
    close_only = {"crossref": paper_find.Match(_record(), "close_title", 0.9, 1),
                  "openalex": paper_find.Match(_record(), "exact_title", 1.0, 1)}
    assert paper_find.reference(close_only) == "openalex"


# ---------------------------------------------------------------------------
# Each supporting source's lookup, against an authored reply in its own shape
# ---------------------------------------------------------------------------

ATOM = f"""<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/{ARXIV}v1</id>
<title>{TITLE}</title><author><name>Ada Fixture</name></author><published>2026-01-02T00:00:00Z</published>
</entry></feed>"""
CROSSREF_ITEM = {"DOI": DOI, "title": [TITLE], "URL": f"https://doi.org/{DOI}",
                 "author": [{"given": "Ada", "family": "Fixture"}], "issued": {"date-parts": [[2026, 1, 2]]}}
OPENALEX_WORK = {"id": "https://openalex.org/W42", "doi": f"https://doi.org/{DOI}", "display_name": TITLE,
                 "publication_date": "2026-01-02", "ids": {"pmid": f"https://pubmed.ncbi.nlm.nih.gov/{PMID}"}}
S2_PAPER = {"paperId": "a" * 40, "title": TITLE, "externalIds": {"DOI": DOI, "ArXiv": ARXIV, "PubMed": PMID}}
PUBMED_XML = f"""<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>{PMID}</PMID><Article>
<ArticleTitle>{TITLE}</ArticleTitle></Article></MedlineCitation><PubmedData><ArticleIdList>
<ArticleId IdType="doi">{DOI}</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>"""
DATACITE_RECORD = {"id": DOI, "attributes": {"doi": DOI, "titles": [{"title": TITLE}],
                                             "publicationYear": 2026, "url": "https://example.org/d"}}

# slug -> (kind -> (value, the text that must reach the request, the reply))
CASES = {
    "arxiv": {"arxiv": (ARXIV, f"id_list={ARXIV}", ATOM), "title": (TITLE, f'ti:"{TITLE}"', ATOM)},
    "crossref": {"doi": (DOI, f"/works/{DOI}", {"message": CROSSREF_ITEM}),
                 "title": (TITLE, f"query.bibliographic={TITLE}", {"message": {"items": [CROSSREF_ITEM]}})},
    "openalex": {"doi": (DOI, f"/works/doi:{DOI}", OPENALEX_WORK),
                 "pmid": (PMID, f"/works/pmid:{PMID}", OPENALEX_WORK),
                 "title": (TITLE, f"title.search:{TITLE}", {"results": [OPENALEX_WORK]})},
    "semantic_scholar": {"doi": (DOI, f"/paper/DOI:{DOI}", S2_PAPER),
                         "arxiv": (ARXIV, f"/paper/ARXIV:{ARXIV}", S2_PAPER),
                         "pmid": (PMID, f"/paper/PMID:{PMID}", S2_PAPER),
                         "title": (TITLE, f"query={TITLE}", {"data": [S2_PAPER]})},
    "pubmed": {"pmid": (PMID, f"term={PMID}[pmid]", PUBMED_XML),
               "doi": (DOI, f"term={DOI}[doi]", PUBMED_XML),
               "title": (TITLE, f'term="{TITLE}"[Title]', PUBMED_XML)},
    "biorxiv": {"doi": (BIORXIV_DOI, f"/details/biorxiv/{BIORXIV_DOI}", {"collection": [
        {"doi": BIORXIV_DOI, "title": TITLE, "version": "1", "date": "2026-01-01", "license": "cc_by"},
        {"doi": BIORXIV_DOI, "title": TITLE, "version": "2", "date": "2026-02-01", "license": "cc_by"}]})},
    "medrxiv": {"doi": (BIORXIV_DOI, f"/details/medrxiv/{BIORXIV_DOI}", {"collection": [
        {"doi": BIORXIV_DOI, "title": TITLE, "version": "1", "date": "2026-01-01"}]})},
    "datacite": {"doi": (DOI, f"/dois/{DOI}", {"data": DATACITE_RECORD}),
                 "title": (TITLE, f'titles.title:"{TITLE}"', {"data": [DATACITE_RECORD]})},
    "doaj": {"doi": (DOI, f'doi:"{DOI}"', {"results": [
        {"id": "a1", "bibjson": {"title": TITLE, "identifier": [{"type": "doi", "id": DOI}]}}], "total": 1}),
             "title": (TITLE, f'bibjson.title:"{TITLE}"', {"results": [
                 {"id": "a1", "bibjson": {"title": TITLE}}], "total": 1})},
    "europepmc": {"doi": (DOI, f'DOI:"{DOI}"', {"resultList": {"result": [
        {"id": PMID, "source": "MED", "pmid": PMID, "doi": DOI, "title": TITLE}]}}),
                  "pmid": (PMID, f"EXT_ID:{PMID} AND SRC:MED", {"resultList": {"result": [
                      {"id": PMID, "source": "MED", "pmid": PMID, "doi": DOI, "title": TITLE}]}}),
                  "title": (TITLE, f'TITLE:"{TITLE}"', {"resultList": {"result": [
                      {"id": PMID, "source": "MED", "pmid": PMID, "title": TITLE}]}})},
    "hal": {"doi": (DOI, f'doiId_s:"{DOI}"', {"response": {"docs": [
        {"docid": 42, "halId_s": "hal-042", "title_s": [TITLE], "doiId_s": DOI}]}}),
            "title": (TITLE, f'title_t:"{TITLE}"', {"response": {"docs": [
                {"docid": 42, "halId_s": "hal-042", "title_s": [TITLE]}]}})},
    "inspire_hep": {k: (v, needle, {"hits": {"total": 1, "hits": [{"metadata": {
        "control_number": 42, "titles": [{"title": TITLE}], "dois": [{"value": DOI}],
        "arxiv_eprints": [{"value": ARXIV}]}}]}}) for k, v, needle in (
            ("doi", DOI, f"doi {DOI}"), ("arxiv", ARXIV, f"arxiv {ARXIV}"), ("title", TITLE, f't "{TITLE}"'))},
    "plos": {"doi": (DOI, f'id:"{DOI}"', {"response": {"docs": [{"id": DOI, "title": TITLE}]}}),
             "title": (TITLE, f'title:"{TITLE}"', {"response": {"docs": [{"id": DOI, "title": TITLE}]}})},
    "zenodo": {k: (v, needle, {"hits": {"total": 1, "hits": [{"id": 42, "doi": DOI, "metadata": {
        "title": TITLE, "publication_date": "2026-01-02"}}]}}) for k, v, needle in (
            ("doi", DOI, f'doi:"{DOI}"'), ("title", TITLE, f'title:"{TITLE}"'))},
    "eric": {"title": (TITLE, f'title:"{TITLE}"', {"response": {"numFound": 1, "docs": [
        {"id": "EJ0000042", "title": TITLE, "publicationdateyear": 2026}]}})},
}


def _supported_cases():
    for slug, capability in sorted(repo_catalog.PAPER_LOOKUP.items()):
        for kind in capability.kinds:
            yield slug, kind


def test_every_supported_kind_has_a_fixture_case():
    missing = [f"{slug}/{kind}" for slug, kind in _supported_cases() if kind not in CASES.get(slug, {})]
    assert not missing, missing


# Every supported kind, and the lookup written for PubMed, whose capability
# the live check could not establish (``repo_catalog.PAPER_LOOKUP`` says why):
# its code is held to the same request and reading.
@pytest.mark.parametrize("slug, kind", [(s, k) for s in sorted(CASES) for k in CASES[s]], ids=lambda x: str(x))
def test_each_source_is_asked_where_its_catalog_says_and_its_reply_read(slug, kind, monkeypatch):
    value, needle, reply = CASES[slug][kind]
    module = __import__(f"implementation_scripts.api_{'biorxiv' if slug == 'medrxiv' else slug}",
                        fromlist=["x"])
    sent: list[str] = []

    def recorder(method, url, **kwargs):
        params = {**(kwargs.get("params") or {}), **(kwargs.get("json") or {})}
        text = unquote(str(url)) + " " + " ".join(f"{k}={v}" for k, v in params.items())
        sent.append(text)
        request = httpx.Request(method, url)
        body = reply
        if slug == "pubmed":
            body = ({"esearchresult": {"idlist": [PMID]}} if "esearch" in str(url) else PUBMED_XML)
        if isinstance(body, str):
            return httpx.Response(200, text=body, headers={"content-type": "application/xml"}, request=request)
        return httpx.Response(200, text=json.dumps(body), headers={"content-type": "application/json"},
                              request=request)

    monkeypatch.setattr(module, "safe_request", recorder)
    client = api_registry.get_client(slug)
    results = client.lookup(kind, value, max_results=paper_find.CANDIDATES)
    assert any(needle in text for text in sent), f"{slug} {kind}: sent {sent}"
    match = paper_find.best_match(results, paper_find.PaperQuery(kind, value.lower() if kind != "title" else value,
                                                                 value))
    assert match is not None, f"{slug} {kind}: read {results}"
    assert match.matched_by == ("exact_title" if kind == "title" else kind)


def test_a_404_for_an_identifier_is_an_answer_not_a_failure(monkeypatch):
    from implementation_scripts import api_crossref, zero_reason
    from implementation_scripts.api_base import reset_search_outcome, search_outcome

    def not_there(method, url, **kwargs):
        outcome = search_outcome()
        outcome.note_attempt()
        outcome.note_failure(404, url)
        return httpx.Response(404, text="Resource not found.", request=httpx.Request(method, url))

    monkeypatch.setattr(api_crossref, "safe_request", not_there)
    reset_search_outcome()
    assert api_registry.get_client("crossref").lookup("doi", DOI) == []
    reason, _detail = zero_reason.derive(search_outcome().snapshot())
    assert reason == "answered_empty"


def test_doaj_keeps_a_dois_slash_inside_its_one_path_segment(monkeypatch):
    from implementation_scripts import api_doaj
    urls = []

    def recorder(method, url, **kwargs):
        urls.append(str(url))
        return httpx.Response(200, text='{"results": [], "total": 0}', request=httpx.Request(method, url))

    monkeypatch.setattr(api_doaj, "safe_request", recorder)
    api_registry.get_client("doaj").lookup("doi", DOI)
    path = urls[0][len(api_doaj._DOAJ_API_URL) + 1:]
    assert "/" not in path and unquote(path) == f'doi:"{DOI}"'
