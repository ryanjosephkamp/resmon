"""How a search's terms reach every source (``search_terms``).

Each chip a person adds is one term: a word is a word, several words are a
phrase where the source can search for one, and the text is literal. A search
matches any term by default, or every term. Each source is asked in the way its
plan says, and what each client puts into its request is asserted here, as the
exact string or parameter sent, for one term, for two terms with Any, and for
two terms with All, over a whole calendar year (some sources date papers only
by year).
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from urllib.parse import unquote

import pytest

from implementation_scripts import api_base, api_registry, search_terms
from implementation_scripts.api_base import NormalizedResult

SPLATS = ["splats", "gaussian splatting"]
YEAR = ("2024-01-01", "2024-12-31")

# The request field that carries the search, for each source that is asked for
# words. DOAJ carries it in its one path segment; GovInfo in its JSON body.
_FIELD = {
    "arxiv": "search_query", "core": "q", "crossref": "query", "datacite": "query",
    "dblp": "q", "doaj": "<path>", "dryad": "q", "eric": "search", "europepmc": "query",
    "govinfo": "<json:query>", "hal": "q", "inspire_hep": "q", "nasa_ads": "q",
    "ndl_search": "query", "openaire": "keywords", "openalex": "search", "openlibrary": "q",
    "osti": "q", "plos": "q", "pubmed": "term", "semantic_scholar": "query",
    "springer": "q", "zenodo": "q",
}


# A well-formed reply with nothing in it, for the sources asked once per term:
# a reply a client cannot read stops the asking (``search_terms._each_term``),
# and these must be asked for every term.
_EMPTY = {
    "dblp": {"result": {"hits": {"@total": "0"}}},
    "openaire": {"response": {"header": {"total": {"$": 0}}}},
    "dryad": {"_embedded": {"stash:datasets": []}, "total": 0},
}
_EMPTY_SRU = ('<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/">'
              "<numberOfRecords>0</numberOfRecords></searchRetrieveResponse>")


class _Reply:
    status_code = 200
    headers: dict = {}

    def __init__(self, slug: str):
        self._body = _EMPTY.get(slug, {})
        self.text = _EMPTY_SRU if slug == "ndl_search" else json.dumps(self._body)

    def json(self):
        return self._body


def sent_for(monkeypatch, slug: str, terms: search_terms.Terms) -> list[str]:
    """Every distinct search value one client sent for ``terms``, in order."""
    module = __import__(f"implementation_scripts.api_{slug}", fromlist=["x"])
    seen: list[str] = []

    def record(method, url, **kwargs):
        field = _FIELD[slug]
        if field == "<path>":
            value = unquote(str(url).rsplit("/", 1)[-1])
        elif field.startswith("<json:"):
            value = (kwargs.get("json") or {}).get(field[6:-1])
        else:
            value = (kwargs.get("params") or {}).get(field)
        if value is not None and value not in seen:
            seen.append(str(value))
        return _Reply(slug)

    monkeypatch.setattr(module, "safe_request", record)
    if hasattr(module, "get_credential_for"):
        monkeypatch.setattr(module, "get_credential_for", lambda *a, **k: "test-key")
    client = api_registry.get_client(slug)
    api_base.reset_search_outcome()
    try:
        search_terms.search(client, slug, terms, date_from=YEAR[0], date_to=YEAR[1], max_results=5)
    except Exception:  # an empty reply some clients cannot read; what was sent is recorded
        pass
    return seen


_ANY = search_terms.make(SPLATS, "any")
_ALL = search_terms.make(SPLATS, "all")
_ONE = search_terms.make(["gaussian splatting"])

# What each source is sent: for one term, then Any and All over
# ``["splats", "gaussian splatting"]``, each over the year 2024. A source asked
# once per term for Any lists one request per term.
EXPECTED = {
    "arxiv": (
        ['all:"gaussian splatting" AND submittedDate:[202401010000 TO 202412312359]'],
        ['(all:splats OR all:"gaussian splatting") AND submittedDate:[202401010000 TO 202412312359]'],
        ['(all:splats AND all:"gaussian splatting") AND submittedDate:[202401010000 TO 202412312359]'],
    ),
    "core": (
        ['("gaussian splatting") AND createdDate>=2024-01-01 AND createdDate<=2024-12-31'],
        ['(splats OR "gaussian splatting") AND createdDate>=2024-01-01 AND createdDate<=2024-12-31'],
        ['(splats AND "gaussian splatting") AND createdDate>=2024-01-01 AND createdDate<=2024-12-31'],
    ),
    "crossref": (["gaussian splatting"], ["splats gaussian splatting"], ["splats gaussian splatting"]),
    "datacite": (['"gaussian splatting"'], ['splats OR "gaussian splatting"'],
                 ['splats AND "gaussian splatting"']),
    "dblp": (["gaussian splatting"], ["splats", "gaussian splatting"], ["splats gaussian splatting"]),
    "doaj": (
        ['("gaussian splatting") AND bibjson.year:[2024 TO 2024]'],
        ['(splats OR "gaussian splatting") AND bibjson.year:[2024 TO 2024]'],
        ['(splats AND "gaussian splatting") AND bibjson.year:[2024 TO 2024]'],
    ),
    "dryad": (["gaussian splatting"], ["splats", "gaussian splatting"], ["splats gaussian splatting"]),
    "eric": (
        ['("gaussian splatting") AND publicationdateyear:2024'],
        ['(splats OR "gaussian splatting") AND publicationdateyear:2024'],
        ['(splats AND "gaussian splatting") AND publicationdateyear:2024'],
    ),
    "europepmc": (
        ['("gaussian splatting") AND FIRST_PDATE:[2024-01-01 TO 2024-12-31]'],
        ['(splats OR "gaussian splatting") AND FIRST_PDATE:[2024-01-01 TO 2024-12-31]'],
        ['(splats AND "gaussian splatting") AND FIRST_PDATE:[2024-01-01 TO 2024-12-31]'],
    ),
    "govinfo": (
        ['("gaussian splatting") AND publishdate:range(2024-01-01,2024-12-31)'],
        ['(splats OR "gaussian splatting") AND publishdate:range(2024-01-01,2024-12-31)'],
        ['(splats AND "gaussian splatting") AND publishdate:range(2024-01-01,2024-12-31)'],
    ),
    "hal": (['"gaussian splatting"'], ['splats OR "gaussian splatting"'],
            ['splats AND "gaussian splatting"']),
    "inspire_hep": (
        ['("gaussian splatting") and de>2024-01-01 and de<2024-12-31'],
        ['(splats or "gaussian splatting") and de>2024-01-01 and de<2024-12-31'],
        ['(splats and "gaussian splatting") and de>2024-01-01 and de<2024-12-31'],
    ),
    "nasa_ads": (
        ['("gaussian splatting") AND pubdate:[2024-01 TO 2024-12]'],
        ['(splats OR "gaussian splatting") AND pubdate:[2024-01 TO 2024-12]'],
        ['(splats AND "gaussian splatting") AND pubdate:[2024-01 TO 2024-12]'],
    ),
    "ndl_search": (
        ['dpid = "open" AND anywhere = "gaussian splatting" AND from = "2024-01-01" AND until = "2024-12-31"'],
        ['dpid = "open" AND anywhere = "splats" AND from = "2024-01-01" AND until = "2024-12-31"',
         'dpid = "open" AND anywhere = "gaussian splatting" AND from = "2024-01-01" AND until = "2024-12-31"'],
        ['dpid = "open" AND anywhere = "splats gaussian splatting" AND from = "2024-01-01" AND until = "2024-12-31"'],
    ),
    "openaire": (["gaussian splatting"], ["splats", "gaussian splatting"], ["splats gaussian splatting"]),
    "openalex": (['"gaussian splatting"'], ['splats OR "gaussian splatting"'],
                 ['splats AND "gaussian splatting"']),
    "openlibrary": (
        ['("gaussian splatting") AND first_publish_year:2024'],
        ['(splats OR "gaussian splatting") AND first_publish_year:2024'],
        ['(splats AND "gaussian splatting") AND first_publish_year:2024'],
    ),
    "osti": (['"gaussian splatting"'], ['splats OR "gaussian splatting"'],
             ['splats AND "gaussian splatting"']),
    "plos": (
        ['("gaussian splatting") AND publication_date:[2024-01-01T00:00:00Z TO 2024-12-31T23:59:59Z]'],
        ['(splats OR "gaussian splatting") AND publication_date:[2024-01-01T00:00:00Z TO 2024-12-31T23:59:59Z]'],
        ['(splats AND "gaussian splatting") AND publication_date:[2024-01-01T00:00:00Z TO 2024-12-31T23:59:59Z]'],
    ),
    "pubmed": (['"gaussian splatting"'], ['splats OR "gaussian splatting"'],
               ['splats AND "gaussian splatting"']),
    "semantic_scholar": (["gaussian splatting"], ["splats gaussian splatting"],
                         ["splats gaussian splatting"]),
    "springer": (
        ['("gaussian splatting") onlinedatefrom:2024-01-01 onlinedateto:2024-12-31'],
        ['(splats OR "gaussian splatting") onlinedatefrom:2024-01-01 onlinedateto:2024-12-31'],
        ['(splats AND "gaussian splatting") onlinedatefrom:2024-01-01 onlinedateto:2024-12-31'],
    ),
    "zenodo": (
        ['("gaussian splatting") AND publication_date:[2024-01-01 TO 2024-12-31]'],
        ['(splats OR "gaussian splatting") AND publication_date:[2024-01-01 TO 2024-12-31]'],
        ['(splats AND "gaussian splatting") AND publication_date:[2024-01-01 TO 2024-12-31]'],
    ),
}


def test_every_registered_source_has_a_plan_and_an_expectation():
    """A source added without a plan, or without its query asserted here, fails."""
    registered = set(api_registry.list_repositories())
    assert registered == set(search_terms.PLANS)
    asked_for_words = {s for s, p in search_terms.PLANS.items() if p.kind != "local"}
    assert asked_for_words == set(EXPECTED) == set(_FIELD)


@pytest.mark.parametrize("slug", sorted(EXPECTED))
@pytest.mark.parametrize(("which", "terms"), [(0, _ONE), (1, _ANY), (2, _ALL)],
                         ids=["one term", "any", "all"])
def test_what_each_source_is_sent(monkeypatch, slug, which, terms):
    assert sent_for(monkeypatch, slug, terms) == EXPECTED[slug][which]


@pytest.mark.parametrize("slug", sorted(EXPECTED))
def test_a_single_word_term_is_sent_as_a_word(monkeypatch, slug):
    sent = sent_for(monkeypatch, slug, search_terms.make(["splats"]))
    assert len(sent) == 1
    if slug == "ndl_search":
        # CQL quotes every value; within it, the word is a word.
        assert 'anywhere = "splats"' in sent[0]
    else:
        assert '"splats"' not in sent[0] and "splats" in sent[0]


# ---------------------------------------------------------------------------
# The terms themselves
# ---------------------------------------------------------------------------

def test_a_terms_text_is_literal():
    """Quotes, operators, and field prefixes inside a term are text in a phrase."""
    terms = search_terms.make(['"deep learning"', "graph OR neural", "ti:quantum", "NOT", "c++"])
    assert terms.terms == ("deep learning", "graph OR neural", "ti:quantum", "NOT", "c++")
    assert search_terms.boolean(terms) == (
        '"deep learning" OR "graph OR neural" OR "ti:quantum" OR "NOT" OR "c++"')


def test_terms_are_cleaned_and_kept_once():
    terms = search_terms.make(["  Splats ", "splats", "", '""', "gaussian   splatting"])
    assert terms.terms == ("Splats", "gaussian splatting")
    assert terms.match == "any"


@pytest.mark.parametrize(("params", "terms", "match"), [
    ({"keywords": ["splats", "gaussian splatting"]}, ("splats", "gaussian splatting"), "any"),
    ({"keywords": ["QR", "prose"], "match": "all"}, ("QR", "prose"), "all"),
    # Only a typed query: its words and quoted phrases, every one required.
    ({"query": 'splats "gaussian splatting"'}, ("splats", "gaussian splatting"), "all"),
    ({"query": "theory of mind"}, ("theory", "mind"), "all"),
    ({"query": "graph neural", "match": "any"}, ("graph", "neural"), "any"),
    # The keyword list wins over the query beside it.
    ({"keywords": ["gaussian splatting"], "query": "gaussian splatting"}, ("gaussian splatting",), "any"),
    # A stored match that is neither is read as the default, not refused.
    ({"keywords": ["a1"], "match": "some"}, ("a1",), "any"),
])
def test_the_terms_a_run_asks_for(params, terms, match):
    asked = search_terms.from_params(params)
    assert asked.terms == terms and asked.match == match


@pytest.mark.parametrize("params", [
    {}, {"keywords": []}, {"query": "  "}, {"find": {"kind": "doi"}, "query": "10.1/x"},
    {"entity_profile": {"id": 1}, "keywords": ["x"]},
])
def test_a_run_with_no_words_has_no_terms(params):
    assert search_terms.from_params(params) is None


def test_a_match_must_be_any_or_all():
    assert search_terms.normalize_match(None) == "any"
    assert search_terms.normalize_match("ALL") == "all"
    with pytest.raises(ValueError):
        search_terms.normalize_match("some")
    with pytest.raises(ValueError):
        search_terms.Terms(("a",), "some")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Whole words and phrases (bioRxiv, medRxiv, and All on a ranked source)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(("term", "text", "hit"), [
    ("ai", "The model said nothing.", False),
    ("ai", "Chains of thought.", False),
    ("ai", "Generative AI for proteins.", True),
    ("AI", "the ai era", True),
    ("splat", "Gaussian splats in the wild", False),
    ("splats", "Gaussian splats in the wild", True),
    ("gaussian splatting", "Gaussian splatting for scenes", True),
    ("gaussian splatting", "gaussian   splatting", True),
    ("gaussian splatting", "Gaussian-splatting renderer", True),
    ("gaussian splatting", "gaussian\nsplatting", True),
    ("gaussian splatting", "Splatting with a Gaussian kernel", False),
    ("gaussian splatting", "gaussian splattings", False),
    ("covid-19", "COVID 19 cases", True),
    ("c++", "Written in C++.", True),
    ("c++", "Written in C.", False),
])
def test_a_term_matches_as_whole_words(term, text, hit):
    assert search_terms.matches(text, search_terms.make([term])) is hit


def test_any_needs_one_term_and_all_needs_every_term():
    text = "Gaussian splatting for novel views"
    assert search_terms.matches(text, search_terms.make(["splats", "gaussian splatting"], "any"))
    assert not search_terms.matches(text, search_terms.make(["splats", "gaussian splatting"], "all"))
    assert search_terms.matches(text, search_terms.make(["novel", "gaussian splatting"], "all"))


def _paper(i: int, title: str, abstract: str | None = None) -> NormalizedResult:
    return NormalizedResult(source_repository="biorxiv", external_id=f"10.1101/{i}", doi=None,
                            title=title, authors=[], abstract=abstract,
                            publication_date="2026-11-01", url="https://example.org")


@pytest.mark.parametrize("slug", ["biorxiv", "medrxiv"])
@pytest.mark.parametrize(("match", "kept"), [("any", ["1", "2", "3"]), ("all", ["3"])])
def test_biorxiv_keeps_whole_words_and_phrases(monkeypatch, slug, match, kept):
    """bioRxiv and medRxiv are read in full and filtered by resmon: "ai" never
    matches "said", and a phrase only as that phrase."""
    module = __import__("implementation_scripts.api_biorxiv", fromlist=["x"])
    items = [
        _paper(1, "AI for cells"),
        _paper(2, "A study", "We use gaussian splatting here."),
        _paper(3, "AI meets Gaussian-splatting"),
        _paper(4, "What the reviewer said", "Splatting and a gaussian prior."),
    ]
    client = api_registry.get_client(slug)
    monkeypatch.setattr(client, "_page", lambda *a, **k: ([object()] * len(items), len(items)))
    monkeypatch.setattr(client, "_newest_first", lambda *a, **k: iter([list(range(len(items)))]))
    monkeypatch.setattr(client, "_parse_item", lambda i: items[i] if isinstance(i, int) else None)
    api_base.reset_search_outcome()
    found = search_terms.search(client, slug, search_terms.make(["ai", "gaussian splatting"], match),
                                date_from="2026-11-01", date_to="2026-11-02", max_results=10)
    assert sorted(r.external_id.rsplit("/", 1)[-1] for r in found) == kept
    assert module  # the client module is the one under test


# ---------------------------------------------------------------------------
# How a plan asks: one request per term, and All checked on a ranked source
# ---------------------------------------------------------------------------

class _Fake:
    """A client that records each ``search()`` and answers from a script."""

    def __init__(self, answers: dict[str, list], fail_on: str | None = None):
        self.answers = answers
        self.fail_on = fail_on
        self.asked: list[tuple[str, tuple, str]] = []

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        terms = kwargs["terms"]
        self.asked.append((query, terms.terms, terms.match))
        if query == self.fail_on:
            api_base.search_outcome().note_attempt()
            api_base.search_outcome().note_failure(503)
            return []
        return list(self.answers.get(query, []))[:max_results]


def _r(i: int, title: str = "x", abstract: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(external_id=str(i), title=title, abstract=abstract)


def test_any_on_a_per_term_source_asks_each_term_and_merges():
    fake = _Fake({"splats": [_r(1), _r(2), _r(3)], "gaussian splatting": [_r(2), _r(4)]})
    api_base.reset_search_outcome()
    found = search_terms.search(fake, "dryad", _ANY, date_from=None, date_to=None, max_results=10)
    assert fake.asked == [("splats", ("splats",), "all"),
                          ("gaussian splatting", ("gaussian splatting",), "all")]
    # A paper from each term in turn; the one both found is kept once.
    assert [r.external_id for r in found] == ["1", "2", "4", "3"]


def test_the_cap_keeps_papers_for_every_term():
    fake = _Fake({"splats": [_r(i) for i in range(10)], "gaussian splatting": [_r(100 + i) for i in range(10)]})
    api_base.reset_search_outcome()
    found = search_terms.search(fake, "openaire", _ANY, date_from=None, date_to=None, max_results=4)
    assert [r.external_id for r in found] == ["0", "100", "1", "101"]


def test_a_failed_term_stops_the_asking_and_stays_recorded():
    """A later term's success would clear the failure and record a full answer."""
    fake = _Fake({"gaussian splatting": [_r(4)]}, fail_on="splats")
    api_base.reset_search_outcome()
    found = search_terms.search(fake, "ndl_search", _ANY, date_from=None, date_to=None, max_results=10)
    assert [q for q, _, _ in fake.asked] == ["splats"]
    assert found == []
    assert api_base.search_outcome().snapshot()["last_call_failed"] is True


def test_all_on_a_per_term_source_is_one_request():
    fake = _Fake({"splats gaussian splatting": [_r(1)]})
    api_base.reset_search_outcome()
    search_terms.search(fake, "dblp", _ALL, date_from=None, date_to=None, max_results=10)
    assert fake.asked == [("splats gaussian splatting", ("splats", "gaussian splatting"), "all")]


def test_any_on_a_ranked_source_keeps_what_it_ranked():
    fake = _Fake({"splats gaussian splatting": [_r(1, "Unrelated"), _r(2, "Splats")]})
    api_base.reset_search_outcome()
    found = search_terms.search(fake, "crossref", _ANY, date_from=None, date_to=None, max_results=10)
    assert [r.external_id for r in found] == ["1", "2"]


def test_all_on_a_ranked_source_keeps_only_papers_with_every_term():
    fake = _Fake({"splats gaussian splatting": [
        _r(1, "Splats and Gaussian splatting"),
        _r(2, "Gaussian splatting", "We render splats."),
        _r(3, "Splats", None),
        _r(4, "Gaussian kernels for splatting", "splats"),
    ]})
    api_base.reset_search_outcome()
    found = search_terms.search(fake, "semantic_scholar", _ALL, date_from=None, date_to=None, max_results=10)
    assert [r.external_id for r in found] == ["1", "2"]
    assert api_base.search_outcome().snapshot()["explicit_reason"] is None


def test_all_on_a_ranked_source_that_keeps_none_says_why():
    from implementation_scripts import zero_reason  # noqa: PLC0415

    fake = _Fake({"splats gaussian splatting": [_r(1, "Splats"), _r(2, "Gaussian kernels")]})
    api_base.reset_search_outcome()
    api_base.search_outcome().note_attempt()
    found = search_terms.search(fake, "crossref", _ALL, date_from=None, date_to=None, max_results=10)
    assert found == []
    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert reason == "records_unusable" and detail["detail"] == "all_terms"
    assert zero_reason.answered("ok", 0, reason) is True
    words = zero_reason.sentence("Crossref", reason, detail)
    assert words == ("Crossref answered with 2 records ranked by relevance, and none had every "
                     "term in its title or abstract, so resmon kept none.")
    assert zero_reason.label(reason, detail) == "answered; none had every term"


def test_a_stopped_search_asks_no_further_term():
    fake = _Fake({"splats": [_r(1)]})
    api_base.reset_search_outcome()
    api_base.search_outcome().stop.set()
    assert search_terms.search(fake, "dryad", _ANY, date_from=None, date_to=None, max_results=10) == []
    assert fake.asked == []


def test_atlas_reads_a_typed_query_with_the_same_stop_words():
    """Atlas opens a search stored with only a query as the terms the engine asks
    for (``screens/sources/terms.ts``), so the two stop-word lists are one."""
    import re
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "frontend" / "atlas" / "src" / "screens"
              / "sources" / "terms.ts").read_text(encoding="utf-8")
    listed = re.search(r"STOP_WORDS: ReadonlySet<string> = new Set\(\[(.*?)\]\)", source, re.S)
    assert listed is not None
    assert set(re.findall(r"'([a-z]+)'", listed.group(1))) == set(search_terms.STOP_WORDS)
