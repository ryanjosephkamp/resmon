"""Near-duplicate links: what they assert, and what they must never do.

**P12 is the property with teeth.** A link is an assertion laid beside two
records; it must not delete one, hide one, or change a count. The corpus is
valuable *because* it keeps what each source actually said, and a feature that
quietly folded two rows into one would be trading that away for a tidier list.
So the tests below check counts and rows as hard as they check the finding.

The pairing rule is checked at both ends: a genuine cross-source duplicate is
found, and the two obvious false positives — a different paper on the same
subject, and a short title contained inside a longer one — are not. Those two
are the reason the rule is *vector **and** lexical* rather than either alone,
and a test suite that only showed the happy path would not establish it.

Vectors here are hand-written, so distances are exact and a threshold is
testable. The real corpus is where the threshold was chosen; see
``workspace/handbacks/1.9/evidence/near-duplicate-calibration.md``.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import near_duplicates, vector_index  # noqa: E402
from implementation_scripts.database import init_db  # noqa: E402

pytest.importorskip("sqlite_vec")

MODEL = "test-model"


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "corpus.db"), check_same_thread=False)
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    yield connection
    connection.close()


def _paper(
    conn: sqlite3.Connection, external_id: str, title: str, *,
    source: str = "arxiv", doi: str | None = None, vector: list[float] | None = None,
    abstract: str | None = "An abstract, so this record is more than a title.",
) -> int:
    """A paper. ``abstract=None`` makes it the title-only kind the rule rejects."""
    cursor = conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, doi, abstract, "
        "publication_date, metadata_hash) VALUES (?, ?, ?, ?, ?, '2026-01-01', ?)",
        (source, external_id, title, doi, abstract, f"h-{source}-{external_id}"),
    )
    doc_id = int(cursor.lastrowid)
    if vector is not None:
        conn.execute(
            "INSERT INTO document_embeddings (document_id, model, dims, vector, fields) "
            "VALUES (?, ?, ?, ?, 'title+abstract')",
            (doc_id, MODEL, len(vector), vector_index.pack_vector(vector)),
        )
    conn.commit()
    return doc_id


# ---------------------------------------------------------------------------
# The lexical half, on its own
# ---------------------------------------------------------------------------


def test_titles_are_compared_after_folding_case_punctuation_and_accents():
    """The same paper reaches resmon spelled several ways by several sources."""
    assert near_duplicates.title_similarity(
        "Attention Is All You Need", "attention is all you need!",
    ) == 1.0
    assert near_duplicates.title_similarity(
        "Modele de diffusion", "Modèle de diffusion",
    ) == 1.0


def test_a_non_latin_title_is_words_rather_than_nothing():
    """The bug an ASCII-only tokeniser hides.

    Encoding to ASCII and ignoring what will not fit turns every Japanese title
    into zero words, which scores 0.0 against everything — so a whole source's
    papers could never be linked, and nothing would say so. NDL Search is in the
    catalog.
    """
    assert near_duplicates.normalise_title("深層学習による画像認識")
    assert near_duplicates.title_similarity(
        "深層学習による画像認識", "深層学習による画像認識") == 1.0


def test_a_character_that_only_means_the_same_costs_one_token_not_the_match():
    """Recorded behaviour, not an aspiration: µ and u are different characters.

    The pair still clears the gate, so the limitation costs similarity rather
    than the link. A transliteration table is a large thing to maintain for this.
    """
    score = near_duplicates.title_similarity(
        "Mesure de la diffusion des µ-particules",
        "Mesure de la diffusion des u-particules",
    )
    assert score < 1.0
    assert score >= near_duplicates.DEFAULT_MIN_TITLE_SIMILARITY


def test_digits_survive_normalisation_because_gpt4_is_not_gpt3():
    """Dropping numerals would make two different papers look like one."""
    assert near_duplicates.title_similarity(
        "Evaluating GPT-4 on clinical notes", "Evaluating GPT-3 on clinical notes",
    ) < 1.0


def test_a_short_title_inside_a_long_one_is_not_a_match():
    """The false positive that a containment ratio would produce.

    ``|A ∩ B| / min(...)`` scores this 1.0 and links two unrelated papers.
    Against ``max`` it is well under the gate, which is why the denominator is
    ``max``.
    """
    short = "Attention Is All You Need"
    long = "Attention Is All You Need for Protein Folding: A Critical Reassessment"
    assert near_duplicates.title_similarity(short, long) < 0.6


def test_an_empty_or_missing_title_scores_zero_rather_than_matching_everything():
    assert near_duplicates.title_similarity(None, "anything") == 0.0
    assert near_duplicates.title_similarity("", "") == 0.0
    # A title made only of stopwords has no comparable words at all.
    assert near_duplicates.title_similarity("Of the And", "Of the And") == 0.0


@pytest.mark.parametrize("raw", [
    "10.1234/abc.def",
    "https://doi.org/10.1234/ABC.DEF",
    "doi:10.1234/Abc.Def",
    "  http://dx.doi.org/10.1234/abc.def  ",
])
def test_the_same_doi_written_five_ways_normalises_to_one(raw):
    assert near_duplicates._normalised_doi(raw) == "10.1234/abc.def"


@pytest.mark.parametrize("junk", [None, "", "unknown", "n/a", "10.", "not-a-doi"])
def test_something_that_is_not_a_doi_is_not_treated_as_one(junk):
    """Two papers must never be linked because both carry the word 'unknown'."""
    assert near_duplicates._normalised_doi(junk) is None


# ---------------------------------------------------------------------------
# Pairing: both signals must agree
# ---------------------------------------------------------------------------


@pytest.fixture
def corpus(conn):
    """A corpus containing one real duplicate and two tempting non-duplicates."""
    ids = {
        # The genuine pair: the same work, arXiv preprint and Crossref record.
        "preprint": _paper(conn, "p1", "Deep Sets for Irregular Astronomical Time Series",
                           source="arxiv", vector=[1.0, 0.0, 0.0, 0.0]),
        "published": _paper(conn, "p2", "Deep Sets for Irregular Astronomical Time-Series",
                            source="crossref", vector=[0.999, 0.02, 0.0, 0.0]),
        # Same subject, different paper. Vectors are close; titles are not.
        "sibling": _paper(conn, "p3", "Transformers for Irregular Astronomical Cadence",
                          source="arxiv", vector=[0.99, 0.05, 0.0, 0.0]),
        # Unrelated, far away.
        "other": _paper(conn, "p4", "A survey of soil microbial communities",
                        source="pubmed", vector=[0.0, 0.0, 1.0, 0.0]),
    }
    vector_index.rebuild(conn, MODEL)
    return ids


def test_a_cross_source_duplicate_is_found(conn, corpus):
    found = near_duplicates.find_links(conn, MODEL)
    pairs = {(p["a"], p["b"]) for p in found["pairs"]}
    assert (min(corpus["preprint"], corpus["published"]),
            max(corpus["preprint"], corpus["published"])) in pairs


def test_a_different_paper_on_the_same_subject_is_not_linked(conn, corpus):
    """The failure mode vectors alone would produce, and the reason for the
    lexical check.

    On a monitoring corpus every paper's nearest neighbour is about the same
    thing. ``sibling``'s vector is *closer* to ``preprint`` than some genuine
    duplicates are — that is deliberate here — and it is still not linked.
    """
    found = near_duplicates.find_links(conn, MODEL)
    linked = {i for p in found["pairs"] for i in (p["a"], p["b"])}
    assert corpus["sibling"] not in linked

    # And the distance really was inside the gate, so this is the lexical check
    # doing the work rather than the gate happening to exclude it.
    ranked = vector_index.nearest(
        conn, MODEL, vector_index.pack_vector([1.0, 0.0, 0.0, 0.0]), k=4)
    sibling_distance = dict(ranked)[corpus["sibling"]]
    assert sibling_distance <= near_duplicates.DEFAULT_MAX_DISTANCE


def test_a_shared_doi_links_two_papers_whatever_the_titles_say(conn):
    """A DOI names a work. Two records carrying one are the same work."""
    a = _paper(conn, "a", "Predicting protein folds", source="arxiv",
               doi="10.1000/xyz", vector=[1.0, 0.0, 0.0, 0.0])
    b = _paper(conn, "b", "A completely different sounding title", source="crossref",
               doi="https://doi.org/10.1000/XYZ", vector=[0.99, 0.02, 0.0, 0.0])
    vector_index.rebuild(conn, MODEL)

    found = near_duplicates.find_links(conn, MODEL)
    assert len(found["pairs"]) == 1
    pair = found["pairs"][0]
    assert {pair["a"], pair["b"]} == {a, b}
    assert pair["method"] == "shared_doi" and pair["shared_doi"] is True
    assert pair["score"] == 1.0


def test_two_records_with_no_abstract_are_not_linked_however_alike_the_titles(conn):
    """The finding that took precision from 10% to 60%, as a test.

    A paper with no abstract is embedded from its title alone, so its vector *is*
    the title — "close vectors plus matching titles" is then one signal counted
    twice. Journal front matter is the whole of this class: Crossref emits a
    record per issue titled "Editorial Board", and every pair of them scores
    distance 0.000 and similarity 1.000 while being different records.

    27 of the first 30 hand-graded pairs were exactly this.
    """
    _paper(conn, "jan", "Editorial Board", source="crossref", abstract=None,
           vector=[1.0, 0.0, 0.0, 0.0])
    _paper(conn, "feb", "Editorial Board", source="crossref", abstract=None,
           vector=[1.0, 0.0, 0.0, 0.0])
    vector_index.rebuild(conn, MODEL)
    assert near_duplicates.find_links(conn, MODEL)["pairs"] == []


def test_one_abstract_is_not_enough_because_the_other_vector_is_still_a_title(conn):
    _paper(conn, "a", "Editorial Board", source="crossref", abstract=None,
           vector=[1.0, 0.0, 0.0, 0.0])
    _paper(conn, "b", "Editorial Board", source="openalex",
           vector=[1.0, 0.0, 0.0, 0.0])
    vector_index.rebuild(conn, MODEL)
    assert near_duplicates.find_links(conn, MODEL)["pairs"] == []


def test_a_shared_doi_links_records_that_have_no_abstract_at_all(conn):
    """A DOI is evidence in its own right, not an inference from the text.

    Holding it to the abstract requirement would let a weaker signal veto a
    stronger one — and 27 of the 102 ground-truth pairs in the real corpus have
    no abstract on one side.
    """
    a = _paper(conn, "a", "Untitled", source="crossref", abstract=None,
               doi="10.5/aa", vector=[1.0, 0.0, 0.0, 0.0])
    b = _paper(conn, "b", "Untitled", source="openalex", abstract=None,
               doi="10.5/AA", vector=[1.0, 0.01, 0.0, 0.0])
    vector_index.rebuild(conn, MODEL)
    pairs = near_duplicates.find_links(conn, MODEL)["pairs"]
    assert len(pairs) == 1 and {pairs[0]["a"], pairs[0]["b"]} == {a, b}
    assert pairs[0]["method"] == "shared_doi"


def test_the_title_path_is_held_tighter_than_the_candidate_gate(conn):
    """A review *of* a paper is not the paper.

    "Training a force field for proteins" and "PREreview of 'Training a force
    field for proteins'" scored 0.875 on titles and sat at distance 0.572 in the
    real corpus — inside the 0.60 candidate gate and outside the 0.50 title path.
    """
    assert (near_duplicates.DEFAULT_MAX_TITLE_PATH_DISTANCE
            < near_duplicates.DEFAULT_MAX_DISTANCE)
    _paper(conn, "paper", "Training a force field for proteins and small molecules",
           vector=[1.0, 0.0, 0.0, 0.0])
    _paper(conn, "review",
           "PREreview of Training a force field for proteins and small molecules",
           source="openalex", vector=[1.0, 0.55, 0.0, 0.0])
    vector_index.rebuild(conn, MODEL)

    assert near_duplicates.find_links(conn, MODEL)["pairs"] == []
    # And it is the *distance*, not the title, that excluded it.
    loosened = near_duplicates.find_links(conn, MODEL, max_title_path_distance=0.60)
    assert len(loosened["pairs"]) == 1


def test_a_shared_doi_is_not_held_to_the_title_paths_distance(conn):
    a = _paper(conn, "a", "One title", doi="10.9/z", vector=[1.0, 0.0, 0.0, 0.0])
    b = _paper(conn, "b", "Quite another", source="crossref", doi="10.9/z",
               vector=[1.0, 0.55, 0.0, 0.0])
    vector_index.rebuild(conn, MODEL)
    pairs = near_duplicates.find_links(conn, MODEL)["pairs"]
    assert len(pairs) == 1 and {pairs[0]["a"], pairs[0]["b"]} == {a, b}


def test_a_pair_beyond_the_distance_gate_is_never_considered(conn):
    """Identical titles far apart in vector space are still not linked.

    Both signals, always. A title match alone is what insert-time dedup already
    does, and loosening it here would re-introduce that at a wider radius.
    """
    _paper(conn, "a", "The same title exactly", vector=[1.0, 0.0, 0.0, 0.0])
    _paper(conn, "b", "The same title exactly", source="pubmed",
           vector=[0.0, 1.0, 0.0, 0.0])
    vector_index.rebuild(conn, MODEL)
    assert near_duplicates.find_links(conn, MODEL)["pairs"] == []


def test_every_pair_is_stored_once_with_a_below_b(conn, corpus):
    found = near_duplicates.find_links(conn, MODEL)
    for pair in found["pairs"]:
        assert pair["a"] < pair["b"]
    assert len({(p["a"], p["b"]) for p in found["pairs"]}) == len(found["pairs"])


def test_a_link_to_a_document_that_no_longer_exists_is_skipped_not_asserted(conn, corpus):
    """1.9a's residual risk, not made worse.

    The ``vec0`` index can outlive a ``documents`` row — nothing reconciles them
    — so the scan must not turn a stale index entry into a visible claim about a
    paper that is gone.
    """
    conn.execute("DELETE FROM documents WHERE id = ?", (corpus["published"],))
    conn.commit()
    # The index still holds it; only the canonical rows were cascaded.
    assert corpus["published"] in [
        r[0] for r in conn.execute(
            f"SELECT document_id FROM {vector_index.INDEX_TABLE}")
    ]
    found = near_duplicates.find_links(conn, MODEL)
    linked = {i for p in found["pairs"] for i in (p["a"], p["b"])}
    assert corpus["published"] not in linked


# ---------------------------------------------------------------------------
# P12 — nothing is deleted or hidden
# ---------------------------------------------------------------------------


def test_finding_and_writing_links_changes_no_count_and_removes_no_row(conn, corpus):
    """P12. The whole property, asserted as arithmetic rather than as intent."""
    before_docs = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    before_ids = [r[0] for r in conn.execute("SELECT id FROM documents ORDER BY id")]
    before_vectors = conn.execute(
        "SELECT COUNT(*) FROM document_embeddings").fetchone()[0]

    found = near_duplicates.find_links(conn, MODEL)
    written = near_duplicates.write_links(conn, found["pairs"])
    assert written > 0, "the corpus must contain a link for this test to mean anything"

    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == before_docs
    assert [r[0] for r in conn.execute(
        "SELECT id FROM documents ORDER BY id")] == before_ids
    assert conn.execute(
        "SELECT COUNT(*) FROM document_embeddings").fetchone()[0] == before_vectors


def test_collapse_returns_a_grouping_and_hides_nothing(conn, corpus):
    """P12's mutation target: making collapse the default.

    ``collapse_groups`` cannot remove a row — every id it returns came in through
    its argument, and ``keep`` plus the folded members always account for all of
    them. A caller that ignores it sees the corpus unchanged, which is the
    default.
    """
    near_duplicates.write_links(conn, near_duplicates.find_links(conn, MODEL)["pairs"])
    ids = [r[0] for r in conn.execute("SELECT id FROM documents ORDER BY id")]

    groups = near_duplicates.collapse_groups(conn, ids)
    # A real group formed, or this proves nothing.
    assert groups["folded"], "no group formed; the test cannot establish what it is for"
    # Nothing invented, nothing lost.
    accounted = set(groups["keep"])
    for members in groups["folded"].values():
        accounted |= set(members)
    assert accounted == set(ids)
    assert len(groups["keep"]) < len(ids), "a collapse that folds nothing is not a collapse"


def test_the_explorer_total_is_the_same_with_links_present(conn, corpus):
    """The count a user reads does not move because a link was written."""
    from implementation_scripts import explorer

    before = explorer.search(conn, limit=200)["total"]
    near_duplicates.write_links(conn, near_duplicates.find_links(conn, MODEL)["pairs"])
    after = explorer.search(conn, limit=200)
    assert after["total"] == before
    assert len(after["results"]) == before


def test_clearing_links_leaves_every_document_alone(conn, corpus):
    near_duplicates.write_links(conn, near_duplicates.find_links(conn, MODEL)["pairs"])
    docs = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    removed = near_duplicates.clear_links(conn)
    assert removed > 0
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == docs
    assert conn.execute("SELECT COUNT(*) FROM document_links").fetchone()[0] == 0


def test_deleting_a_document_takes_its_links_with_it(conn, corpus):
    """A link to a paper that is gone would be an assertion about nothing."""
    near_duplicates.write_links(conn, near_duplicates.find_links(conn, MODEL)["pairs"])
    assert conn.execute("SELECT COUNT(*) FROM document_links").fetchone()[0] > 0
    conn.execute("DELETE FROM documents WHERE id = ?", (corpus["preprint"],))
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM document_links").fetchone()[0] == 0


# ---------------------------------------------------------------------------
# Reading links back
# ---------------------------------------------------------------------------


def test_a_link_reads_the_same_from_either_side(conn, corpus):
    """The pair is stored once; a caller should never know which side it is on."""
    near_duplicates.write_links(conn, near_duplicates.find_links(conn, MODEL)["pairs"])
    left = near_duplicates.links_for(conn, corpus["preprint"])
    right = near_duplicates.links_for(conn, corpus["published"])
    assert [l["id"] for l in left["links"]] == [corpus["published"]]
    assert [l["id"] for l in right["links"]] == [corpus["preprint"]]


def test_the_label_names_the_source_and_the_strength_of_the_claim(conn, corpus):
    near_duplicates.write_links(conn, near_duplicates.find_links(conn, MODEL)["pairs"])
    label = near_duplicates.links_for(conn, corpus["preprint"])["links"][0]["label"]
    assert "also appears in crossref" in label
    assert "near-identical title" in label


def test_a_shared_doi_link_says_so_rather_than_claiming_a_title_match(conn):
    a = _paper(conn, "a", "One title", doi="10.1/x", vector=[1.0, 0, 0, 0])
    _paper(conn, "b", "Another title entirely", source="pubmed", doi="10.1/X",
           vector=[0.99, 0.02, 0, 0])
    vector_index.rebuild(conn, MODEL)
    near_duplicates.write_links(conn, near_duplicates.find_links(conn, MODEL)["pairs"])
    assert "same DOI" in near_duplicates.links_for(conn, a)["links"][0]["label"]


def test_links_map_answers_a_page_of_results_in_one_query(conn, corpus):
    near_duplicates.write_links(conn, near_duplicates.find_links(conn, MODEL)["pairs"])
    ids = [r[0] for r in conn.execute("SELECT id FROM documents ORDER BY id")]
    mapped = near_duplicates.links_map(conn, ids)
    assert str(corpus["preprint"]) in mapped
    assert str(corpus["published"]) in mapped
    assert str(corpus["other"]) not in mapped


def test_links_map_of_nothing_is_empty_rather_than_everything(conn, corpus):
    near_duplicates.write_links(conn, near_duplicates.find_links(conn, MODEL)["pairs"])
    assert near_duplicates.links_map(conn, []) == {}


# ---------------------------------------------------------------------------
# The job
# ---------------------------------------------------------------------------


def _factory(tmp_path):
    def make():
        c = sqlite3.connect(str(tmp_path / "corpus.db"), check_same_thread=False)
        c.row_factory = sqlite3.Row
        return c
    return make


def test_the_scan_writes_links_and_reports_them(conn, corpus, tmp_path):
    job = near_duplicates.LinksJob()
    job.start(_factory(tmp_path), MODEL)
    assert job.join(60)
    status = job.status(conn)
    assert status["run"]["running"] is False
    assert status["links"] > 0
    assert status["by_method"]


def test_a_completed_rescan_replaces_the_previous_answer(conn, corpus, tmp_path):
    """A threshold change makes the old answer wrong, not stale.

    A pair that no longer qualifies must stop being asserted. Left in place it
    would be a finding nothing produced.
    """
    stale_a, stale_b = sorted((corpus["other"], corpus["sibling"]))
    conn.execute(
        "INSERT INTO document_links (document_a, document_b, kind, score, method) "
        "VALUES (?, ?, ?, 0.9, 'vector+title')",
        (stale_a, stale_b, near_duplicates.LINK_KIND),
    )
    conn.commit()

    job = near_duplicates.LinksJob()
    job.start(_factory(tmp_path), MODEL)
    assert job.join(60)

    remaining = {(r[0], r[1]) for r in conn.execute(
        "SELECT document_a, document_b FROM document_links")}
    assert (stale_a, stale_b) not in remaining
    assert remaining, "the real pair should still be there"


def test_a_cancelled_scan_keeps_what_it_found_and_clears_nothing(conn, corpus, tmp_path):
    """A partial scan must not delete links it never re-examined."""
    near_duplicates.write_links(conn, near_duplicates.find_links(conn, MODEL)["pairs"])
    before = conn.execute("SELECT COUNT(*) FROM document_links").fetchone()[0]
    assert before > 0

    # Cancelled while the scan is inside ``find_links``, which is where the flag
    # is actually read. Setting it before ``start`` would be cleared by ``start``
    # itself — the job resets its own flag so a previous cancel cannot poison the
    # next run, which is right, and means the cancel has to land after that.
    original = near_duplicates.find_links
    job = near_duplicates.LinksJob()

    def _cancel_then_scan(*args, **kwargs):
        kwargs["should_cancel"] = lambda: True
        return original(*args, **kwargs)

    near_duplicates.find_links = _cancel_then_scan
    try:
        job.start(_factory(tmp_path), MODEL)
        assert job.join(60)
    finally:
        near_duplicates.find_links = original

    assert job.status(conn)["run"]["cancelled"] is True
    assert conn.execute(
        "SELECT COUNT(*) FROM document_links").fetchone()[0] == before


def test_two_scans_cannot_run_at_once(conn, corpus, tmp_path):
    job = near_duplicates.LinksJob()
    started = threading.Event()

    original = near_duplicates.find_links

    def _slow(*args, **kwargs):
        started.set()
        time.sleep(1.0)
        return original(*args, **kwargs)

    near_duplicates.find_links = _slow
    try:
        job.start(_factory(tmp_path), MODEL)
        assert started.wait(10)
        with pytest.raises(RuntimeError, match="already running"):
            job.start(_factory(tmp_path), MODEL)
    finally:
        near_duplicates.find_links = original
        job.join(30)


def test_a_scan_with_nothing_embedded_says_so_rather_than_reporting_none(conn):
    """"No near-duplicates" and "nothing to compare" are different answers."""
    _paper(conn, "a", "A paper with no vector")
    found = near_duplicates.find_links(conn, MODEL)
    assert found["pairs"] == []
    assert "Nothing is embedded yet" in found["reason"]


def test_a_scan_without_the_extension_says_so(conn, corpus, monkeypatch):
    monkeypatch.setattr(vector_index, "load_extension", lambda _c: None)
    found = near_duplicates.find_links(conn, MODEL)
    assert found["pairs"] == []
    assert "cannot load it" in found["reason"]


def test_rewriting_the_same_pair_updates_it_rather_than_duplicating(conn, corpus):
    pairs = near_duplicates.find_links(conn, MODEL)["pairs"]
    near_duplicates.write_links(conn, pairs)
    for pair in pairs:
        pair["score"], pair["method"] = 0.5, "shared_doi"
    near_duplicates.write_links(conn, pairs)
    rows = conn.execute("SELECT score, method FROM document_links").fetchall()
    assert len(rows) == len(pairs)
    assert {r["method"] for r in rows} == {"shared_doi"}
