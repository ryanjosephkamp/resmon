"""The collection map: where every paper sits on the Atlas plate.

What is claimed, and tested here against a corpus whose topics are known:

- **Near means similar.** Papers of one topic share regions, and a region is
  named by its topic's words.
- **The map is the same map.** One collection draws one map; a paper placed
  after the fit lands in its topic's region; a refit keeps the sky roughly where
  it was rather than spinning it.
- **The basis is stated, not implied.** Embeddings place papers only when the
  model has embedded enough of the collection; otherwise words do, and the
  answer says which.
- **Nothing outlives the corpus.** The cache beside the database goes when the
  papers go, and a fit for another collection is not trusted because ids match.
"""

from __future__ import annotations

import hashlib
import random
import sqlite3
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient      # noqa: E402

import resmon as resmon_mod                     # noqa: E402
from implementation_scripts import collection_map as cm  # noqa: E402
from implementation_scripts.database import init_db, insert_document  # noqa: E402

TOPICS = {
    "protein": ["protein", "folding", "residue", "amino", "chain", "conformation", "binding"],
    "traffic": ["traffic", "congestion", "road", "sensor", "commute", "intersection", "vehicle"],
    "quantum": ["quantum", "qubit", "circuit", "entanglement", "gate", "decoherence", "photon"],
    "fraud": ["fraud", "transaction", "anomaly", "bank", "account", "payment", "laundering"],
}
PHRASES = {
    "protein": "protein folding", "traffic": "traffic congestion",
    "quantum": "quantum circuit", "fraud": "fraud transaction",
}
FILLER = ["model", "learning", "data", "framework", "evaluation", "performance", "training",
          "estimation", "benchmark", "accuracy", "robust", "efficient", "scalable", "dataset"]


def _paper(rng: random.Random, topic: str, n: int) -> dict:
    words = TOPICS[topic]
    title = f"{PHRASES[topic]} {rng.choice(words)} {rng.choice(FILLER)} {rng.choice(FILLER)}"
    sentences = []
    for _ in range(rng.randint(4, 7)):
        chosen = [rng.choice(FILLER) for _ in range(rng.randint(6, 10))]
        chosen += [rng.choice(words) for _ in range(rng.randint(2, 4))]
        rng.shuffle(chosen)
        sentences.append(" ".join(chosen) + ".")
    text = title + " ".join(sentences)
    return {
        "source_repository": "arxiv", "external_id": f"{topic}-{n}",
        "title": title, "abstract": " ".join(sentences),
        "metadata_hash": hashlib.sha256(text.encode()).hexdigest(),
    }


def _corpus(conn: sqlite3.Connection, per_topic: int, seed: int = 7, start: int = 0) -> dict[int, str]:
    rng = random.Random(seed)
    topic_of: dict[int, str] = {}
    for n in range(start, start + per_topic):
        for topic in TOPICS:
            doc_id = insert_document(conn, _paper(rng, topic, n))
            topic_of[int(doc_id)] = topic
    conn.commit()
    return topic_of


@pytest.fixture
def db(tmp_path: Path) -> sqlite3.Connection:
    path = tmp_path / "resmon.db"
    init_db(path)
    conn = sqlite3.connect(path, check_same_thread=False)
    cm._fits.clear()
    yield conn
    cm.wait(conn)
    conn.close()
    cm._fits.clear()


def _majority(topic_of: dict[int, str], fit: cm.Fit) -> dict[int, str]:
    by_region: dict[int, list[str]] = {}
    for doc_id, region in zip(fit.ids, fit.region):
        by_region.setdefault(int(region), []).append(topic_of[int(doc_id)])
    return {r: max(set(ts), key=ts.count) for r, ts in by_region.items()}


# ---------------------------------------------------------------------------
# Words
# ---------------------------------------------------------------------------

def test_terms_pair_only_words_that_stood_next_to_each_other():
    assert cm.terms("Analysis of graph networks") == [
        "analysis", "graph", "networks", "graph networks"]


def test_terms_never_pair_a_word_with_itself():
    assert "folding folding" not in cm.terms("folding folding protein")


def test_regions_that_share_a_name_are_told_apart(db):
    _corpus(db, per_topic=60)
    fit = cm.fit_corpus(db, None)
    named = [label for label in fit.labels if label]
    assert len(named) == len(set(named)), fit.labels


def test_terms_read_any_letter():
    # "données" once became "donn" and named a region.
    assert "données" in cm.terms("les données de réseaux")
    assert "les" not in cm.terms("les données de réseaux")


# ---------------------------------------------------------------------------
# Near means similar
# ---------------------------------------------------------------------------

def test_papers_of_one_topic_share_regions_named_by_its_words(db):
    topic_of = _corpus(db, per_topic=60)
    fit = cm.fit_corpus(db, None)

    assert fit.basis == cm.BASIS_WORDS and fit.model is None
    assert len(fit.ids) == len(topic_of)
    majority = _majority(topic_of, fit)
    agree = sum(topic_of[int(d)] == majority[int(r)] for d, r in zip(fit.ids, fit.region))
    assert agree / len(fit.ids) >= 0.95, "regions mix topics"
    for region, topic in majority.items():
        named = set(fit.labels[region].replace(" · ", " ").split(" "))
        assert named & set(TOPICS[topic]), (fit.labels[region], topic)


def test_one_collection_draws_one_map(db):
    _corpus(db, per_topic=40)
    first, second = cm.fit_corpus(db, None), cm.fit_corpus(db, None)
    assert np.array_equal(first.ids, second.ids)
    assert np.allclose(first.xy, second.xy)
    assert first.labels == second.labels


def test_every_paper_is_on_the_plate_and_inside_its_region(db):
    _corpus(db, per_topic=50)
    fit = cm.fit_corpus(db, None)
    assert np.abs(fit.xy).max() <= 1.0 + 1e-4
    distance = np.linalg.norm(fit.xy - fit.disc_xy[fit.region], axis=1)
    assert (distance <= fit.disc_r[fit.region] + 1e-4).all()


def test_regions_do_not_overlap(db):
    _corpus(db, per_topic=50)
    fit = cm.fit_corpus(db, None)
    k = len(fit.disc_r)
    for a in range(k):
        for b in range(a + 1, k):
            gap = np.linalg.norm(fit.disc_xy[a] - fit.disc_xy[b]) - fit.disc_r[a] - fit.disc_r[b]
            assert gap > -1e-3, (a, b, gap)


def test_a_paper_that_arrives_later_lands_in_its_topics_region(db):
    topic_of = _corpus(db, per_topic=50)
    fit = cm.fit_corpus(db, None)
    majority = _majority(topic_of, fit)
    late = _corpus(db, per_topic=3, seed=99, start=500)

    ids = np.array(sorted(late), dtype=np.int64)
    hashes = np.zeros(len(ids), dtype=np.int32)
    assert cm.place_new(db, fit, ids, hashes) == len(ids)
    placed = dict(zip(fit.ids.tolist(), fit.region.tolist()))
    for doc_id, topic in late.items():
        assert majority[placed[doc_id]] == topic, (doc_id, topic)
    assert fit.placed_since_fit == len(ids)


def test_a_refit_keeps_the_sky_where_it_was(db):
    _corpus(db, per_topic=50)
    before = cm.fit_corpus(db, None)
    _corpus(db, per_topic=10, seed=11, start=200)  # a fifth more: a refit is due

    refit = cm.fit_corpus(db, None, previous=before)
    afresh = cm.fit_corpus(db, None)
    _shared, a, b = np.intersect1d(before.ids, refit.ids, return_indices=True)
    _shared, _a, c = np.intersect1d(before.ids, afresh.ids, return_indices=True)
    moved = np.linalg.norm(refit.xy[b] - before.xy[a], axis=1).mean()
    moved_afresh = np.linalg.norm(afresh.xy[c] - before.xy[a], axis=1).mean()
    # On a plate two units wide. Measured when this was written: 0.15 for a
    # refit and 1.2 for the same papers drawn afresh.
    assert moved < 0.25, f"a refit moved shared papers {moved:.2f} on average"
    assert moved < moved_afresh / 3
    # And it did not shrink the sky to fit the old one.
    assert refit.disc_r.mean() > 0.8 * before.disc_r.mean()


# ---------------------------------------------------------------------------
# The basis is stated
# ---------------------------------------------------------------------------

def _embed(conn: sqlite3.Connection, topic_of: dict[int, str], model: str, share: float, dims: int) -> None:
    rng = np.random.default_rng(5)
    axes = {t: rng.standard_normal(dims) for t in TOPICS}
    for i, (doc_id, topic) in enumerate(sorted(topic_of.items())):
        if i >= share * len(topic_of):
            break
        vector = axes[topic] + 0.3 * rng.standard_normal(dims)
        vector /= np.linalg.norm(vector)
        conn.execute(
            "INSERT INTO document_embeddings (document_id, model, dims, vector, fields) VALUES (?, ?, ?, ?, ?)",
            (doc_id, model, dims, struct.pack(f"<{dims}f", *vector), "title+abstract"))
    conn.commit()


def test_embeddings_place_papers_only_above_the_coverage_floor(db):
    topic_of = _corpus(db, per_topic=40)
    _embed(db, topic_of, "test-model", share=0.85, dims=32)
    below = cm.fit_corpus(db, "test-model")
    assert below.basis == cm.BASIS_WORDS and below.model is None

    db.execute("DELETE FROM document_embeddings")
    _embed(db, topic_of, "test-model", share=0.95, dims=32)
    above = cm.fit_corpus(db, "test-model")
    assert above.basis == cm.BASIS_EMBEDDINGS and above.model == "test-model"
    # The 5% without a vector are not on the plate rather than placed by words.
    assert len(above.ids) == int(np.ceil(0.95 * len(topic_of)))


def test_a_wide_model_is_projected_and_still_groups_by_topic(db):
    topic_of = _corpus(db, per_topic=30)
    _embed(db, topic_of, "wide", share=1.0, dims=cm.EMBEDDING_DIMS_CAP + 44)
    fit = cm.fit_corpus(db, "wide")
    assert fit.projection is not None and fit.centers.shape[1] == cm.EMBEDDING_DIMS_CAP
    majority = _majority(topic_of, fit)
    agree = sum(topic_of[int(d)] == majority[int(r)] for d, r in zip(fit.ids, fit.region))
    assert agree / len(fit.ids) >= 0.95


# ---------------------------------------------------------------------------
# The cache, and what the engine answers
# ---------------------------------------------------------------------------

def _ready(conn: sqlite3.Connection, model: str | None = None) -> dict:
    opener = lambda: conn  # noqa: E731 - the tests' one connection, shared
    answer = cm.snapshot(conn, model, opener)
    if answer["state"] == "fitting":
        cm.wait(conn)
        answer = cm.snapshot(conn, model, opener)
    return answer


def test_an_empty_collection_has_an_empty_map(db):
    answer = cm.snapshot(db, None, lambda: db)
    assert answer["state"] == "empty" and answer["points"]["id"] == []


def test_the_map_covers_every_paper_with_text_and_counts_the_rest(db):
    topic_of = _corpus(db, per_topic=30)
    insert_document(db, {"source_repository": "arxiv", "external_id": "blank", "title": "On it",
                         "abstract": None, "metadata_hash": "blank"})
    db.commit()
    answer = _ready(db)
    assert answer["state"] == "ready" and answer["basis"] == "words"
    assert sorted(answer["points"]["id"]) == sorted(topic_of)
    assert answer["unplaced"] == {"no_text": 1, "not_embedded": 0}
    assert sum(r["size"] for r in answer["regions"]) == len(topic_of)
    lengths = {len(v) for v in answer["points"].values()}
    assert lengths == {len(topic_of)}


def test_papers_that_cannot_be_placed_are_counted_once_not_refitted_forever(db):
    for n in range(2):
        insert_document(db, {"source_repository": "arxiv", "external_id": f"bare-{n}",
                             "title": f"Paper {n}", "metadata_hash": f"bare-{n}"})
    db.commit()
    answer = _ready(db)
    assert answer["state"] == "ready" and answer["points"]["id"] == []
    assert answer["unplaced"]["no_text"] == 2
    again = cm.snapshot(db, None, lambda: db)
    assert again["state"] == "ready" and not again["refitting"]


def test_one_paper_is_a_map_of_one(db):
    _corpus(db, per_topic=1)  # four papers, one per topic
    db.execute("DELETE FROM documents WHERE id > 1")
    db.commit()
    answer = _ready(db)
    assert answer["state"] == "ready" and len(answer["points"]["id"]) == 1
    assert len(answer["regions"]) == 1


def test_the_fit_is_kept_beside_the_database_and_reused(db):
    _corpus(db, per_topic=30)
    first = _ready(db)
    path = cm.cache_path(db)
    assert path is not None and path.exists() and path.name.endswith("-map.npz")
    cm._fits.clear()  # a new process: nothing in memory
    second = cm.snapshot(db, None, lambda: db)
    assert second["state"] == "ready" and not second["refitting"]
    assert second["points"] == first["points"]


def test_papers_since_the_fit_are_placed_without_a_refit_until_a_fifth(db):
    _corpus(db, per_topic=40)
    _ready(db)
    _corpus(db, per_topic=2, seed=3, start=900)   # 8 papers, 5% of 160
    answer = cm.snapshot(db, None, lambda: db)
    assert answer["placed_since_fit"] == 8 and not answer["refitting"]
    assert len(answer["points"]["id"]) == 168

    _corpus(db, per_topic=10, seed=4, start=950)  # now 48 since, over a fifth
    answer = cm.snapshot(db, None, lambda: db)
    assert answer["state"] == "ready"
    cm.wait(db)
    answer = cm.snapshot(db, None, lambda: db)
    assert answer["placed_since_fit"] == 0 and answer["fitted_count"] == 208


def test_a_fit_for_other_papers_is_not_trusted_because_their_ids_match(db):
    _corpus(db, per_topic=30)
    _ready(db)
    # Not through the Danger Zone (which forgets the map itself): the papers
    # change under the same ids, as a replaced database file would.
    db.execute("DELETE FROM documents")
    db.execute("DELETE FROM sqlite_sequence WHERE name='documents'")
    db.commit()
    _corpus(db, per_topic=30, seed=1234)
    answer = cm.snapshot(db, None, lambda: db)
    assert answer["state"] == "fitting"


def test_forgetting_removes_the_file_and_the_fit(db):
    _corpus(db, per_topic=20)
    _ready(db)
    path = cm.cache_path(db)
    cm.forget(db)
    assert not path.exists()
    assert cm._fits.get(str(path)) is None


# ---------------------------------------------------------------------------
# Through the route
# ---------------------------------------------------------------------------

@pytest.fixture
def client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    cm._fits.clear()
    yield TestClient(resmon_mod.app)
    conn = resmon_mod._get_db()
    cm.wait(conn)
    cm.forget(conn)


def test_the_route_answers_fitting_then_ready(client):
    conn = resmon_mod._get_db()
    topic_of = _corpus(conn, per_topic=20)
    first = client.get("/api/map")
    assert first.status_code == 200, first.text
    assert first.json()["state"] in ("fitting", "ready")
    cm.wait(conn)
    ready = client.get("/api/map").json()
    assert ready["state"] == "ready" and ready["basis"] == "words"
    assert sorted(ready["points"]["id"]) == sorted(topic_of)
    assert ready["embedding_coverage"] is None


def test_erasing_the_corpus_erases_the_map(client):
    conn = resmon_mod._get_db()
    _corpus(conn, per_topic=20)
    client.get("/api/map")
    cm.wait(conn)
    assert client.get("/api/map").json()["state"] == "ready"
    path = cm.cache_path(conn)
    assert path is not None and path.exists()

    response = client.post("/api/admin/erase-corpus", json={"confirm": "CONFIRM"})
    assert response.status_code == 200, response.text
    assert not path.exists()
    assert client.get("/api/map").json()["state"] == "empty"
