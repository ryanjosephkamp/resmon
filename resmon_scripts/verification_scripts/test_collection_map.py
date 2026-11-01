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
import json
import random
import sqlite3
import struct
import subprocess
import sys
import time
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


def _matrix(rows: list[tuple[int, dict[str, float]]], vocabulary: dict[str, int]):
    indptr, indices, data = [0], [], []
    for _, weights in rows:
        for term, weight in weights.items():
            indices.append(vocabulary[term])
            data.append(weight)
        indptr.append(len(indices))
    matrix = cm._Csr(np.array(indptr, dtype=np.int64), np.array(indices, dtype=np.int32),
                     np.array(data, dtype=np.float32), len(vocabulary))
    return matrix, np.array([region for region, _ in rows])


def test_a_region_suffix_never_repeats_a_word_of_the_name():
    """Two regions both named "dark matter" were told apart as "dark matter ·
    matter halos". The suffix keeps only the words the name does not have."""
    vocabulary = {"dark matter": 0, "matter halos": 1, "galaxy rotation": 2, "neutron stars": 3}
    rows = [
        (0, {"dark matter": 30, "matter halos": 2}), (0, {"dark matter": 30, "matter halos": 2}),
        (1, {"dark matter": 30, "galaxy rotation": 2}), (1, {"dark matter": 30, "galaxy rotation": 2}),
        (2, {"neutron stars": 30}), (2, {"neutron stars": 30}),
    ]
    matrix, region = _matrix(rows, vocabulary)

    names, _ = cm._region_names(matrix, region, 3, vocabulary)

    assert names == ["dark matter · halos", "dark matter · galaxy rotation", "neutron stars"]
    for label in names:
        name, _, suffix = label.partition(" · ")
        assert not set(suffix.split()) & set(name.split()), label


@pytest.mark.parametrize("terms, used, said", [
    (["matter halos"], set(), "halos"),
    (["dark matter", "matter halos"], set(), "halos"),       # nothing new in the first
    (["matter halos", "cold halos"], {"halos"}, "cold halos"),  # not what another region took
    (["dark", "matter"], set(), None),                       # nothing that is not the name
])
def test_what_tells_a_region_apart(terms, used, said):
    assert cm._told_apart_by("dark matter", terms, used) == said


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


@pytest.mark.parametrize("seed", [7, 8, 9, 10, 11])
def test_regions_do_not_overlap(db, seed):
    """Not even by a sliver. Several corpora, because the first version of the
    separation left 0.002 of overlap on Linux's BLAS and none on macOS's."""
    _corpus(db, per_topic=50, seed=seed)
    fit = cm.fit_corpus(db, None)
    k = len(fit.disc_r)
    for a in range(k):
        for b in range(a + 1, k):
            gap = np.linalg.norm(fit.disc_xy[a] - fit.disc_xy[b]) - fit.disc_r[a] - fit.disc_r[b]
            assert gap >= 0, (a, b, gap)


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


def test_positions_are_written_as_the_decimals_they_are_rounded_to(db):
    """Four decimals, as the fit rounds them, and not the float32's seventeen-digit spelling."""
    _corpus(db, per_topic=30)
    answer = _ready(db)
    fit = cm._current(cm.cache_path(db))
    assert fit is not None
    order = {int(i): k for k, i in enumerate(fit.ids)}
    for axis, column in (("x", 0), ("y", 1)):
        written = answer["points"][axis]
        # The same place on the plate as the fit's own rounding, to well under a pixel's hundredth at any zoom.
        rounded = np.array([np.round(fit.xy[order[i], column], 4) for i in answer["points"]["id"]], np.float64)
        assert np.abs(np.array(written) - rounded).max() < 1e-7
        assert all(v == round(v, 4) for v in written)
        assert max(len(json.dumps(v)) for v in written) <= len("-0.1234")


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


def test_the_fit_runs_in_a_child_process(db, monkeypatch):
    """Not in the engine's interpreter, where it held up every request beside it."""
    _corpus(db, per_topic=20)

    def in_the_engine(*_args, **_kwargs):
        raise AssertionError("the engine fitted the map in its own process")

    monkeypatch.setattr(cm, "fit_corpus", in_the_engine)
    assert cm.snapshot(db, None, lambda: db)["state"] == "fitting"
    cm.wait(db)
    answer = cm.snapshot(db, None, lambda: db)
    assert answer["state"] == "ready" and answer["error"] is None
    assert len(answer["points"]["id"]) == 80
    path = cm.cache_path(db)
    assert path is not None and path.exists()
    assert not path.with_name(path.name + cm._CHILD_SUFFIX).exists()


def test_a_child_that_cannot_fit_says_why_and_leaves_no_file(db, monkeypatch, tmp_path):
    _corpus(db, per_topic=20)
    monkeypatch.setattr(cm, "_database_of", lambda _path: tmp_path / "no-such-folder" / "resmon.db")
    cm.snapshot(db, None, lambda: db)
    cm.wait(db)
    path = cm.cache_path(db)
    assert "unable to open database file" in cm._errors[str(path)]
    assert not path.exists()
    assert not path.with_name(path.name + cm._CHILD_SUFFIX).exists()


def _fitting_children(database: Path) -> list[str]:
    """The processes fitting this database's map, by their command line.

    ``-e`` and ``args`` are POSIX, so this reads every process on macOS and on
    Linux alike. ``-axo`` did not: on Linux ``-a`` leaves out processes with no
    terminal, which is every process on a CI runner.
    """
    listing = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True, check=True).stdout
    return [line for line in listing.splitlines()
            if "implementation_scripts.collection_map" in line and str(database) in line]


def _leftovers(path: Path) -> list[str]:
    return sorted(p.name for p in path.parent.iterdir() if p.name.startswith(path.name))


@pytest.mark.skipif(sys.platform == "win32", reason="the slow interpreter is a shell script")
def test_erasing_during_a_fit_stops_it_and_keeps_nothing_of_the_papers(db, monkeypatch, tmp_path):
    """An erase while the map is fitted: no file, no map in memory, no child left fitting."""
    _corpus(db, per_topic=20)
    path = cm.cache_path(db)
    database = Path(str(path)[: -len("-map.npz")])
    # The child starts a second late, so the erase lands while it is running.
    slow = tmp_path / "slow-python"
    slow.write_text(f"#!/bin/sh\nsleep 1\nexec {sys.executable} \"$@\"\n")
    slow.chmod(0o755)
    monkeypatch.setattr(sys, "executable", str(slow))

    assert cm.snapshot(db, None, lambda: db)["state"] == "fitting"
    deadline = time.monotonic() + 10
    while not _fitting_children(database) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert _fitting_children(database), "no child was fitting the map"

    cm.forget(db)
    cm.wait(db)
    time.sleep(2)  # past when the child would have finished had it been left running
    assert _leftovers(path) == []
    assert cm._fits.get(str(path)) is None
    assert str(path) not in cm._errors
    assert _fitting_children(database) == []


def test_a_fit_that_ends_after_an_erase_stores_nothing(db, monkeypatch):
    """The fit's result arrives after ``forget``: neither the map nor its file is kept."""
    _corpus(db, per_topic=20)
    path = cm.cache_path(db)

    def finished_after_an_erase(where, model):
        written = where.with_name(where.name + cm._CHILD_SUFFIX)
        cm.save(cm.fit_corpus(db, model), written)
        cm.forget(db)  # the corpus is erased just before the fit's result is stored
        return cm.load(written), written

    monkeypatch.setattr(cm, "_fit_in_child", finished_after_an_erase)
    cm.snapshot(db, None, lambda: db)
    cm.wait(db)
    assert _leftovers(path) == []
    assert cm._fits.get(str(path)) is None
    assert str(path) not in cm._errors


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
