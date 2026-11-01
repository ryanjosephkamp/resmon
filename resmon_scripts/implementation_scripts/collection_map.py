# resmon_scripts/implementation_scripts/collection_map.py
"""The collection map: where every paper sits on the Atlas plate.

What a position says
--------------------
Papers near each other have similar text. Two bases can say it, and the map
always reports which one it used:

- ``embeddings``: the vectors the person's embedding model made
  (``document_embeddings``), when a model is set and has embedded at least
  :data:`EMBEDDING_COVERAGE_FLOOR` of the corpus. Nearness is that model's
  notion of similar meaning.
- ``words``: word statistics computed here from titles and abstracts, with no
  network and no key: TF-IDF over words and adjacent word pairs, reduced by
  latent semantic analysis. Nearness is shared vocabulary, and the interface
  has to call it that rather than "meaning".

A flat map of a space with dozens of dimensions has to stretch something, so
the plate is a drawing of similarities, not a measurement of them. What it
keeps: papers of one region are similar to one another, and neighboring regions
are more alike than distant ones. What it does not keep: the exact distance
between two papers, or between two regions far apart.

How it is drawn
---------------
1. Each paper becomes a unit vector: its embedding, or its LSA vector.
2. Spherical k-means groups them into regions, about ``sqrt(n / 2)`` of them.
3. The region centers are laid out in two dimensions by t-SNE, and then pushed
   apart until no region's disc, whose area follows its paper count, overlaps
   another's.
4. Each paper sits inside its region's disc. Its angle comes from the region's
   own two main directions of variation, and its radius from how far it lies
   from the region's center compared with the region's other papers.
5. Regions are named by the words most distinctive of their papers, whichever
   basis placed them. A name is therefore always lexical.

Cheap to keep, expensive to fit
-------------------------------
A full fit at 100,000 papers takes tens of seconds, so it runs in a child
process, watched by a background thread, and its result is kept in a file
beside the database (:func:`_fit_in_child` says why a process). The file is
derived: droppable, never backed up, and deleted with the corpus. Papers that
arrive after a fit are placed against it in milliseconds. A refit happens when
they reach :data:`REFIT_FRACTION` of the papers the fit saw, or when the basis
changes. A refit starts from the map it replaces: its regions begin as the old
ones, each sits where its papers were, and each is turned to face the way it
did. So the sky is redrawn, not reshuffled, each time.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import zlib
from array import array
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional

import numpy as np


logger = logging.getLogger(__name__)

BASIS_EMBEDDINGS = "embeddings"
BASIS_WORDS = "words"

#: The share of the corpus a model must have embedded before the map uses it.
#: Below this the map would leave too much of the collection off the plate, so
#: it is placed by words, and says why.
EMBEDDING_COVERAGE_FLOOR = 0.9

#: A refit is due when papers placed since the fit reach this share of it.
REFIT_FRACTION = 0.2

#: Fixed so the same corpus draws the same map.
SEED = 20261028

LSA_DIMS = 64
#: Embeddings wider than this are projected down (a seeded Gaussian projection,
#: which keeps cosine similarity close) before anything else, so a 1,536-wide
#: model at 100,000 papers does not need 600 MB to place.
EMBEDDING_DIMS_CAP = 256
MAX_VOCABULARY = 40_000
#: A paper is described by its strongest terms only. Most of what places a paper
#: is in its first few dozen terms, and the cap is what keeps a 100,000-paper
#: fit's matrix, and so its memory and time, bounded by the corpus rather than
#: by the length of its abstracts.
TERMS_PER_PAPER = 64
#: How many quantiles of a region's center distances are kept, for placing new
#: papers at the radius their distance earns.
RADIUS_QUANTILES = 65
CACHE_VERSION = 1

# Common English words, and the words every abstract uses about itself. Neither
# says what a paper is about, and both would otherwise name regions. The second
# set is the function words of the other languages abstracts commonly arrive
# in: without them, a region of French abstracts was named "des".
_STOPWORDS = frozenset("""
a about above across after again against all almost along also although always am among an and another any
are around as at be because been before being below between both but by can cannot could did do does doing
done down during each either else enough especially etc even ever every few for from further had has have
having he her here hers herself him himself his how however i if in into is it its itself just least less
like made make makes many may me might more most much must my neither no nor not now of off often on once
one only onto or other others otherwise our ours ourselves out over own per perhaps quite rather really
same several she should since so some such than that the their theirs them themselves then there therefore
these they this those though through thus to together too toward towards under until up upon us use used
uses using very via was we well were what whatever when where whereas whether which while who whom whose
why will with within without would yet you your yours yourself
abstract al approach approaches article based paper papers present presented presents propose proposed
proposes result results show shown shows study studies studied method methods new novel provide provides
work works finally first second third two three four five further furthermore moreover addition
significant significantly respectively obtained demonstrate demonstrates demonstrated different various
introduce introduced introduces investigate investigated investigates achieve achieves achieved
compared comparison existing well-known propose including include includes important
exploring explore explores explored give gives given towards toward across able enable enables
""".split()) | frozenset("""
les des une pour sur dans par avec est sont qui que ces cette leur leurs entre plus aux nous
del los las para por con una que como sus entre sobre este esta son desde
der die das und mit von den dem ein eine einer eines ist sind auf aus bei nach zur zum wird werden
dos das uma para com como pelo pela seus suas sobre entre
della delle degli dei una per con sono come nel nella sulla tra
""".split())

# Any letter, not just a to z: "données" read as "donn" named a region once.
_TOKEN = re.compile(r"[^\W\d_][^\W_]*(?:-[^\W_]+)*")


def terms(text: str) -> list[str]:
    """The words and adjacent word pairs a text is described by.

    A pair is two kept words that stood next to each other in the text, so
    "analysis of networks" yields no "analysis networks". Pairs are what make
    region names read as phrases ("graph neural", "language models").
    """
    out: list[str] = []
    previous: Optional[str] = None
    for raw in _TOKEN.findall(text.lower()):
        if len(raw) < 3 or raw in _STOPWORDS or raw.isdigit():
            previous = None
            continue
        out.append(raw)
        if previous is not None and previous != raw:
            out.append(f"{previous} {raw}")
        previous = raw
    return out


def _document_terms(title: Optional[str], abstract: Optional[str]) -> list[str]:
    # The title counts twice: it is the author's own one-line summary.
    title_terms = terms(title or "")
    return title_terms + title_terms + terms(abstract or "")


def _hash32(value: Optional[str]) -> int:
    return zlib.crc32((value or "").encode("utf-8")) & 0x7FFFFFFF


# ---------------------------------------------------------------------------
# Sparse arithmetic, on the three arrays of a CSR matrix
# ---------------------------------------------------------------------------

@dataclass
class _Csr:
    indptr: np.ndarray   # int64, n + 1
    indices: np.ndarray  # int32, nnz
    data: np.ndarray     # float32, nnz
    cols: int

    @property
    def rows(self) -> int:
        return len(self.indptr) - 1

    def matmul(self, dense: np.ndarray, budget: int = 4_000_000) -> np.ndarray:
        """``self @ dense``, a chunk of rows at a time so memory stays bounded.

        Chunks are cut by stored entries, not by rows. Rows can be wildly
        uneven (in the transpose, a common term's row holds half the corpus),
        and a chunk of 113 such rows once asked for 1.6 GB.
        """
        width = dense.shape[1]
        out = np.zeros((self.rows, width), dtype=np.float32)
        if len(self.data) == 0:
            return out
        per_chunk = max(1, budget // width)
        start = 0
        while start < self.rows:
            limit = int(self.indptr[start]) + per_chunk
            end = int(np.searchsorted(self.indptr, limit, side="right")) - 1
            end = min(self.rows, max(end, start + 1))
            a, b = int(self.indptr[start]), int(self.indptr[end])
            if a == b:
                start = end
                continue
            product = self.data[a:b, None] * dense[self.indices[a:b]]
            lengths = np.diff(self.indptr[start:end + 1])
            filled = lengths > 0
            starts = (self.indptr[start:end][filled] - a).astype(np.int64)
            out[start:end][filled] = np.add.reduceat(product, starts, axis=0)
            start = end
        return out

    def transpose(self) -> "_Csr":
        row_of = np.repeat(np.arange(self.rows, dtype=np.int32), np.diff(self.indptr))
        order = np.argsort(self.indices, kind="stable")
        counts = np.bincount(self.indices, minlength=self.cols)
        indptr = np.zeros(self.cols + 1, dtype=np.int64)
        np.cumsum(counts, out=indptr[1:])
        return _Csr(indptr, row_of[order], self.data[order], self.rows)


def _unit_rows(matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    norms = np.linalg.norm(matrix, axis=1)
    usable = norms > 1e-9
    out = np.zeros_like(matrix)
    out[usable] = matrix[usable] / norms[usable, None]
    return out, usable


# ---------------------------------------------------------------------------
# Words: vocabulary, TF-IDF and latent semantic analysis
# ---------------------------------------------------------------------------

@dataclass
class _Words:
    vocabulary: dict[str, int]
    idf: np.ndarray
    matrix: _Csr


def _vocabulary(texts: Callable[[], Iterable[tuple[int, Optional[str], Optional[str]]]],
                count: int) -> tuple[dict[str, int], np.ndarray]:
    df: Counter = Counter()
    for _doc_id, title, abstract in texts():
        df.update(set(_document_terms(title, abstract)))
    floor = 2 if count < 1_000 else 3
    ceiling = max(floor, int(0.5 * count))
    kept = [(t, c) for t, c in df.items() if floor <= c <= ceiling]
    if not kept and count > 0:
        # A corpus too small for the floor still gets a map, from every term.
        kept = list(df.items())
    kept.sort(key=lambda tc: (-tc[1], tc[0]))
    kept = kept[:MAX_VOCABULARY]
    vocabulary = {t: i for i, (t, _c) in enumerate(kept)}
    counts = np.array([c for _t, c in kept], dtype=np.float32)
    idf = (np.log((1.0 + count) / (1.0 + counts)) + 1.0).astype(np.float32)
    return vocabulary, idf


def _tfidf_row(doc_terms: list[str], vocabulary: dict[str, int], idf: np.ndarray
               ) -> tuple[list[int], list[float]]:
    counted = Counter(t for t in doc_terms if t in vocabulary)
    if not counted:
        return [], []
    weighted = sorted(
        ((vocabulary[t], (1.0 + math.log(c)) * float(idf[vocabulary[t]])) for t, c in counted.items()),
        key=lambda cv: -cv[1],
    )[:TERMS_PER_PAPER]
    norm = math.sqrt(sum(v * v for _c, v in weighted)) or 1.0
    return [c for c, _v in weighted], [v / norm for _c, v in weighted]


def _words(texts: Callable[[], Iterable[tuple[int, Optional[str], Optional[str]]]],
           ids: np.ndarray) -> _Words:
    vocabulary, idf = _vocabulary(texts, len(ids))
    # Rows go straight into packed arrays, in id order, as the texts arrive:
    # holding them as Python lists first cost 1.2 GB at 100,000 papers.
    indptr = np.zeros(len(ids) + 1, dtype=np.int64)
    indices = array("i")
    data = array("f")
    row = 0
    for doc_id, title, abstract in texts():
        while row < len(ids) and ids[row] < doc_id:
            indptr[row + 1] = len(indices)
            row += 1
        if row < len(ids) and ids[row] == doc_id:
            cols, values = _tfidf_row(_document_terms(title, abstract), vocabulary, idf)
            indices.extend(cols)
            data.extend(values)
            indptr[row + 1] = len(indices)
            row += 1
    while row < len(ids):
        indptr[row + 1] = len(indices)
        row += 1
    return _Words(vocabulary, idf,
                  _Csr(indptr, np.frombuffer(indices, dtype=np.int32).copy(),
                       np.frombuffer(data, dtype=np.float32).copy(), len(vocabulary)))


def _orthonormal(y: np.ndarray) -> np.ndarray:
    """An orthonormal basis for the span of ``y``'s columns, done twice.

    Through the small Gram matrix rather than ``np.linalg.qr``, which works in
    double precision on the whole tall matrix and cost 400 MB at 100,000
    papers. Directions the columns do not really span are dropped, so a sketch
    wider than the corpus's rank (a dozen papers, a few terms) still has a
    basis; a Cholesky version of this failed exactly there. The second pass
    restores the orthogonality the first can lose.
    """
    q = y.astype(np.float32, copy=True)
    for _ in range(2):
        gram = (q.T @ q).astype(np.float64)
        values, vectors = np.linalg.eigh(gram)
        top = float(values.max()) if len(values) else 0.0
        if top <= 0.0:
            return np.zeros((len(y), 0), np.float32)
        keep = values > top * 1e-9
        q = (q @ (vectors[:, keep] / np.sqrt(values[keep])).astype(np.float32)).astype(np.float32)
    return q


def _lsa(matrix: _Csr, dims: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Rows in ``dims`` latent dimensions, and the term components that put a
    new row there. Randomized SVD with one power iteration (Halko, Martinsson
    and Tropp, 2011), on the sparse matrix as it is: nothing dense of size
    papers by terms is ever made."""
    dims = max(1, min(dims, matrix.rows - 1, matrix.cols - 1))
    width = dims + 10
    transposed = matrix.transpose()
    omega = rng.standard_normal((matrix.cols, width)).astype(np.float32)
    y = matrix.matmul(omega)
    del omega
    for _ in range(1):
        y = _orthonormal(y)
        z = _orthonormal(transposed.matmul(y))
        y = matrix.matmul(z)
        del z
    q = _orthonormal(y)
    del y
    if q.shape[1] == 0:
        return np.zeros((matrix.rows, 1), np.float32), np.zeros((1, matrix.cols), np.float32)
    b = transposed.matmul(q).T
    del transposed
    u_b, s, vt = np.linalg.svd(b, full_matrices=False)
    coords = (q @ u_b[:, :dims].astype(np.float32)) * s[:dims].astype(np.float32)
    return coords.astype(np.float32), vt[:dims].astype(np.float32)


# ---------------------------------------------------------------------------
# Regions: spherical k-means
# ---------------------------------------------------------------------------

def region_count(papers: int) -> int:
    if papers < 4:
        return 1
    return int(max(2, min(240, round(math.sqrt(papers / 2.0)))))


def _assign(x: np.ndarray, centers: np.ndarray, chunk: int = 20_000) -> tuple[np.ndarray, np.ndarray]:
    labels = np.empty(len(x), dtype=np.int32)
    best = np.empty(len(x), dtype=np.float32)
    for start in range(0, len(x), chunk):
        sims = x[start:start + chunk] @ centers.T
        labels[start:start + chunk] = np.argmax(sims, axis=1)
        best[start:start + chunk] = sims[np.arange(len(sims)), labels[start:start + chunk]]
    return labels, best


def _kmeans(x: np.ndarray, k: int, rng: np.random.Generator, iterations: int = 15,
            start: Optional[np.ndarray] = None) -> tuple[np.ndarray, np.ndarray]:
    """Spherical k-means. ``start`` seeds the first centers (a refit passes the
    previous regions), and k-means++ seeds the rest."""
    n = len(x)
    k = max(1, min(k, n))
    # k-means++ seeding on a sample, so it costs the same at 10,000 and 100,000.
    sample = x if n <= 20_000 else x[rng.choice(n, 20_000, replace=False)]
    centers = np.empty((k, x.shape[1]), dtype=np.float32)
    seeded = 0 if start is None else min(k, len(start))
    if seeded:
        centers[:seeded] = start[:seeded]
    else:
        centers[0] = sample[rng.integers(len(sample))]
        seeded = 1
    closest = (1.0 - sample @ centers[:seeded].T).min(1)
    for c in range(seeded, k):
        weights = np.clip(closest, 0, None) ** 2
        total = float(weights.sum())
        pick = int(rng.choice(len(sample), p=weights / total)) if total > 0 else int(rng.integers(len(sample)))
        centers[c] = sample[pick]
        closest = np.minimum(closest, 1.0 - sample @ centers[c])
    labels = np.zeros(n, dtype=np.int32)
    for _ in range(iterations):
        labels, best = _assign(x, centers)
        sums = np.zeros_like(centers)
        np.add.at(sums, labels, x)
        counts = np.bincount(labels, minlength=k)
        empty = np.flatnonzero(counts == 0)
        if len(empty):
            # An empty region takes the papers its neighbors fit least well.
            worst = np.argsort(best)[:len(empty)]
            for c, i in zip(empty, worst):
                sums[c] = x[i]
                labels[i] = c
        centers, _usable = _unit_rows(sums)
    labels, _best = _assign(x, centers)
    return labels, centers


# ---------------------------------------------------------------------------
# The plate: regions laid out, papers placed in them
# ---------------------------------------------------------------------------

def _tsne(distances: np.ndarray, init: np.ndarray, rng: np.random.Generator,
          iterations: int = 600) -> np.ndarray:
    """Exact t-SNE (van der Maaten and Hinton, 2008) for a few hundred points."""
    n = len(distances)
    perplexity = max(2.0, min(30.0, (n - 1) / 3.0))
    target = math.log(perplexity)
    p = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        d = np.delete(distances[i], i)
        lo, hi, beta = 0.0, np.inf, 1.0
        for _ in range(64):
            w = np.exp(-(d - d.min()) * beta)
            total = w.sum()
            h = math.log(total) + beta * float((d - d.min()) @ w) / total
            if abs(h - target) < 1e-5:
                break
            if h > target:
                lo = beta
                beta = beta * 2 if hi == np.inf else (beta + hi) / 2
            else:
                hi = beta
                beta = (beta + lo) / 2
        row = w / total
        p[i, np.arange(n) != i] = row
    p = (p + p.T) / (2 * n)
    p = np.maximum(p, 1e-12)
    y = init.astype(np.float64) * 1e-2 / max(1e-9, float(np.abs(init).max()))
    velocity = np.zeros_like(y)
    gains = np.ones_like(y)
    rate = max(n / 12.0, 50.0)
    for step in range(iterations):
        exaggeration = 12.0 if step < 120 else 1.0
        diff = y[:, None, :] - y[None, :, :]
        q_num = 1.0 / (1.0 + (diff ** 2).sum(-1))
        np.fill_diagonal(q_num, 0.0)
        q = np.maximum(q_num / q_num.sum(), 1e-12)
        grad = 4.0 * ((exaggeration * p - q) * q_num)[:, :, None] * diff
        grad = grad.sum(1)
        momentum = 0.5 if step < 120 else 0.8
        gains = np.where(np.sign(grad) != np.sign(velocity), gains + 0.2, gains * 0.8)
        gains = np.maximum(gains, 0.01)
        velocity = momentum * velocity - rate * gains * grad
        y = y + velocity
        y = y - y.mean(0)
    return y


def _separate(centers: np.ndarray, radii: np.ndarray, rounds: int = 300) -> np.ndarray:
    """Push discs apart until none overlap, each staying near where it started.

    Two phases. The first pushes apart while pulling each disc back toward its
    start, which keeps the layout's neighborhoods; that pull can balance the
    push with a sliver of overlap left (0.002, on Linux's BLAS and not on
    macOS's), so the second pushes with no pull until no two discs overlap.
    """
    home = centers.astype(np.float64)
    y = home.copy()
    n = len(y)
    if n < 2:
        return y
    gap = 0.04 * float(radii.mean())

    def step(pull: float) -> float:
        nonlocal y
        diff = y[:, None, :] - y[None, :, :]
        dist = np.sqrt((diff ** 2).sum(-1)) + np.eye(n)
        need = radii[:, None] + radii[None, :] + gap
        overlap = np.clip(need - dist, 0, None)
        np.fill_diagonal(overlap, 0.0)
        worst = float(overlap.max())
        if worst > 0:
            push = (overlap / dist)[:, :, None] * diff * 0.5
            y = y + push.sum(1) + pull * (home - y)
        return worst

    for _ in range(rounds):
        if step(0.01) < 1e-4:
            break
    for _ in range(2_000):
        if step(0.0) <= 1e-9:
            break
    return y


@dataclass
class Fit:
    """A fitted map, and everything needed to place a new paper against it."""

    basis: str
    model: Optional[str]
    fitted_at: str
    fitted_count: int
    ids: np.ndarray            # int64, sorted
    hashes: np.ndarray         # int32: crc32 of each paper's metadata_hash
    xy: np.ndarray             # float32, n x 2, in [-1, 1]
    region: np.ndarray         # int16
    centers: np.ndarray        # float32, k x d: unit region centers (assignment)
    means: np.ndarray          # float32, k x d: region means (local frame origin)
    frames: np.ndarray         # float32, k x 2 x d: each region's two main directions
    quantiles: np.ndarray      # float32, k x RADIUS_QUANTILES: center distances
    disc_xy: np.ndarray        # float32, k x 2
    disc_r: np.ndarray         # float32, k
    orient: np.ndarray         # float32, k x 2 x 2: turns each region's papers on the plate
    labels: list[str]
    label_terms: list[list[str]]
    sizes: np.ndarray          # int32, k (papers at fit time)
    # Words basis: how a new paper becomes a vector.
    vocabulary: dict[str, int] = field(default_factory=dict)
    idf: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))
    components: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), np.float32))
    # Embeddings basis: the projection a wide model's vectors go through.
    projection: Optional[np.ndarray] = None
    placed_since_fit: int = 0
    # Papers the fit saw and could not place (no usable text, or no vector), so
    # a request does not mistake them for new papers and try again each time.
    skipped_ids: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))
    skipped_hashes: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int32))


def _place(vectors: np.ndarray, fit_region: np.ndarray, means: np.ndarray, frames: np.ndarray,
           quantiles: np.ndarray, disc_xy: np.ndarray, disc_r: np.ndarray, orient: np.ndarray,
           ids: np.ndarray) -> np.ndarray:
    offsets = vectors - means[fit_region]
    local = np.einsum("nd,ncd->nc", offsets, frames[fit_region])
    angle = np.arctan2(local[:, 1], local[:, 0])
    # A paper exactly at its region's mean has no direction of its own; give it
    # a fixed one from its id rather than piling every such paper on one ray.
    still = np.abs(local).sum(1) < 1e-9
    angle[still] = (ids[still] % 360) * (math.pi / 180.0)
    distance = np.linalg.norm(offsets, axis=1)
    q = np.empty(len(vectors), dtype=np.float32)
    for i, (c, d) in enumerate(zip(fit_region, distance)):
        breakpoints = quantiles[c]
        q[i] = np.searchsorted(breakpoints, d, side="right") / len(breakpoints)
    radius = disc_r[fit_region] * (0.06 + 0.94 * np.clip(q, 0, 1) ** 0.85)
    direction = np.einsum("ni,nij->nj", np.stack([np.cos(angle), np.sin(angle)], 1), orient[fit_region])
    xy = disc_xy[fit_region] + radius[:, None] * direction
    return xy.astype(np.float32)


def _region_names(matrix: _Csr, region: np.ndarray, k: int, vocabulary: dict[str, int]
                  ) -> tuple[list[str], list[list[str]]]:
    """Each region's most distinctive terms (class-based TF-IDF): a term weighs
    in a region by its share of that region's text, discounted by how much of
    the whole collection's text it is."""
    words = [""] * len(vocabulary)
    for term, i in vocabulary.items():
        words[i] = term
    if matrix.cols == 0 or len(matrix.data) == 0:
        return ["" for _ in range(k)], [[] for _ in range(k)]
    row_of = np.repeat(np.arange(matrix.rows), np.diff(matrix.indptr))
    flat = region[row_of].astype(np.int64) * matrix.cols + matrix.indices
    weight = np.bincount(flat, weights=matrix.data, minlength=k * matrix.cols).reshape(k, matrix.cols)
    totals = weight.sum(1, keepdims=True)
    share = weight / np.maximum(totals, 1e-9)
    spread = weight.sum(0)
    average = float(totals.mean())
    score = share * np.log1p(average / np.maximum(spread, 1e-9))
    names: list[str] = []
    top_terms: list[list[str]] = []
    for c in range(k):
        order = np.argsort(-score[c])[:12]
        ranked = [words[i] for i in order if score[c, i] > 0]
        name = ranked[0] if ranked else ""
        # A pair reads better than either of its words alone, when it is nearly
        # as distinctive: "graph neural" over "graph".
        if name and " " not in name:
            for candidate in ranked[1:6]:
                if " " in candidate and name in candidate.split(" ") and \
                        score[c, vocabulary[candidate]] >= 0.6 * score[c, vocabulary[name]]:
                    name = candidate
                    break
        names.append(name)
        top_terms.append([t for t in ranked if t != name][:4])
    # Regions with one name are told apart by their next term, less any word
    # the name already has, and never by what another region of that name was
    # told apart by.
    groups: dict[str, list[int]] = {}
    for c, name in enumerate(names):
        if name:
            groups.setdefault(name, []).append(c)
    for name, members in groups.items():
        if len(members) < 2:
            continue
        used: set[str] = set()
        for c in members:
            other = _told_apart_by(name, top_terms[c], used)
            if other:
                used.add(other)
                names[c] = f"{name} · {other}"
    return names, top_terms


def _told_apart_by(name: str, terms: list[str], used: set[str]) -> Optional[str]:
    """The suffix that tells a region from others of the same name, or None.

    The words of the first term that are not already words of the name: a
    suffix never repeats one. "causal inference · causal" says nothing, and
    "dark matter · matter halos" says "matter" twice where "dark matter · halos"
    says the same thing once.
    """
    words_in_name = set(name.split(" "))
    for term in terms:
        suffix = " ".join(w for w in term.split(" ") if w and w not in words_in_name)
        if suffix and suffix not in used:
            return suffix
    return None


def _warm_start(previous: Optional[Fit], ids: np.ndarray, region: np.ndarray, centers: np.ndarray
                ) -> Optional[np.ndarray]:
    """Each region's place on a refit: the mean previous position of its papers.

    None when too few papers are shared to say, and the map is drawn afresh. A
    region whose papers are all new starts beside the most similar region that
    has a past.
    """
    k = len(centers)
    if previous is None:
        return None
    shared, here, there = np.intersect1d(ids, previous.ids, return_indices=True)
    if len(shared) < max(3, len(ids) // 4):
        return None
    sums = np.zeros((k, 2))
    counts = np.zeros(k)
    np.add.at(sums, region[here], previous.xy[there])
    np.add.at(counts, region[here], 1)
    known = counts > 0
    start = np.zeros((k, 2))
    start[known] = sums[known] / counts[known, None]
    known_ids = np.flatnonzero(known)
    for step, c in enumerate(np.flatnonzero(~known)):
        nearest = known_ids[int(np.argmax(centers[known_ids] @ centers[c]))]
        angle = 2.399963 * (step + 1)  # the golden angle, so newcomers fan out
        start[c] = start[nearest] + 0.05 * np.array([math.cos(angle), math.sin(angle)])
    return start


def _normalize_plate(disc_xy: np.ndarray, disc_r: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lo = (disc_xy - disc_r[:, None]).min(0)
    hi = (disc_xy + disc_r[:, None]).max(0)
    middle = (lo + hi) / 2
    half = float(max(hi - lo)) / 2 or 1.0
    return ((disc_xy - middle) / half).astype(np.float32), (disc_r / half).astype(np.float32)


def _previous_regions(previous: Optional[Fit], ids: np.ndarray, vectors: np.ndarray
                      ) -> Optional[np.ndarray]:
    """The previous fit's regions, as centers in this fit's space: the mean of
    each one's papers that are still here. Largest first, so a smaller k keeps
    the regions that matter most."""
    if previous is None:
        return None
    shared, here, there = np.intersect1d(ids, previous.ids, return_indices=True)
    if len(shared) < max(3, len(ids) // 4):
        return None
    old = previous.region[there].astype(np.int64)
    k_old = int(old.max()) + 1
    sums = np.zeros((k_old, vectors.shape[1]), dtype=np.float32)
    np.add.at(sums, old, vectors[here])
    counts = np.bincount(old, minlength=k_old)
    order = [c for c in np.argsort(-counts) if counts[c] > 0]
    centers, _usable = _unit_rows(sums[order])
    return centers


def _orient_to(previous: Fit, ids: np.ndarray, xy: np.ndarray, region: np.ndarray,
               disc_xy: np.ndarray, orient: np.ndarray) -> np.ndarray:
    """Turn (or mirror) each region about its center so its papers sit as near
    as they can to where they were. A region's own axes have no preferred sign,
    so without this a refit could mirror a region for no reason."""
    shared, here, there = np.intersect1d(ids, previous.ids, return_indices=True)
    turned = orient.copy()
    for c in range(len(disc_xy)):
        mine = region[here] == c
        if int(mine.sum()) < 3:
            continue
        now = xy[here][mine] - disc_xy[c]
        then = previous.xy[there][mine] - disc_xy[c]
        u, _s, vt = np.linalg.svd(now.T @ then)
        turned[c] = orient[c] @ (u @ vt)
    return turned.astype(np.float32)


def fit(ids: np.ndarray, hashes: np.ndarray, vectors: np.ndarray, words: _Words, *,
        basis: str, model: Optional[str], previous: Optional[Fit] = None,
        components: Optional[np.ndarray] = None, projection: Optional[np.ndarray] = None) -> Fit:
    """Lay out papers whose unit vectors are ``vectors`` (one row per id)."""
    rng = np.random.default_rng(SEED)
    n = len(ids)
    if n == 0:
        width = vectors.shape[1] if vectors.ndim == 2 else 1
        return Fit(
            basis=basis, model=model,
            fitted_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            fitted_count=0, ids=np.zeros(0, np.int64), hashes=np.zeros(0, np.int32),
            xy=np.zeros((0, 2), np.float32), region=np.zeros(0, np.int16),
            centers=np.zeros((0, width), np.float32), means=np.zeros((0, width), np.float32),
            frames=np.zeros((0, 2, width), np.float32), quantiles=np.zeros((0, RADIUS_QUANTILES), np.float32),
            disc_xy=np.zeros((0, 2), np.float32), disc_r=np.zeros(0, np.float32),
            orient=np.zeros((0, 2, 2), np.float32), labels=[], label_terms=[], sizes=np.zeros(0, np.int32),
            vocabulary=words.vocabulary, idf=words.idf,
            components=components if components is not None else np.zeros((0, 0), np.float32),
            projection=projection,
        )
    k = region_count(n)
    region, centers = _kmeans(vectors, k, rng, start=_previous_regions(previous, ids, vectors))
    k = len(centers)
    sizes = np.bincount(region, minlength=k).astype(np.int32)
    means = np.zeros((k, vectors.shape[1]), dtype=np.float32)
    np.add.at(means, region, vectors)
    means /= np.maximum(sizes, 1)[:, None]
    frames = np.zeros((k, 2, vectors.shape[1]), dtype=np.float32)
    quantiles = np.zeros((k, RADIUS_QUANTILES), dtype=np.float32)
    for c in range(k):
        members = np.flatnonzero(region == c)
        offsets = vectors[members] - means[c]
        if len(members) > 3_000:
            offsets_for_frame = offsets[rng.choice(len(members), 3_000, replace=False)]
        else:
            offsets_for_frame = offsets
        if len(members) >= 2:
            _u, _s, vt = np.linalg.svd(offsets_for_frame, full_matrices=False)
            frames[c, :min(2, len(vt))] = vt[:2]
        quantiles[c] = np.quantile(np.linalg.norm(offsets, axis=1), np.linspace(0, 1, RADIUS_QUANTILES)) \
            if len(members) else 0.0

    # Disc areas follow paper counts, and together cover about half the plate.
    radii = np.maximum(np.sqrt(sizes / max(1, n) * (0.5 * 4.0) / math.pi), 0.01).astype(np.float64)

    # A refit puts each region where its papers were and only nudges discs
    # apart, so the sky is redrawn rather than reshuffled. Measured on a corpus
    # grown by a fifth: drawing afresh moved shared papers 0.8 of a plate 2
    # wide on average, and t-SNE warm-started from the old positions still 0.5.
    warm_start = _warm_start(previous, ids, region, centers)
    if warm_start is not None:
        disc_xy = _separate(warm_start, radii).astype(np.float32)
        disc_r = radii.astype(np.float32)
        extent = float(np.max(np.abs(disc_xy) + disc_r[:, None]))
        if extent > 1.25:
            disc_xy, disc_r = _normalize_plate(disc_xy, disc_r)
    else:
        disc_xy, disc_r = _layout(centers, radii, rng)

    orient = np.repeat(np.eye(2, dtype=np.float32)[None], k, axis=0)
    xy = _place(vectors, region, means, frames, quantiles, disc_xy, disc_r, orient, ids)
    if warm_start is not None and previous is not None:
        orient = _orient_to(previous, ids, xy, region, disc_xy, orient)
        xy = _place(vectors, region, means, frames, quantiles, disc_xy, disc_r, orient, ids)
    labels, label_terms = _region_names(words.matrix, region, k, words.vocabulary)
    return Fit(
        basis=basis, model=model,
        fitted_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        fitted_count=n, ids=ids.astype(np.int64), hashes=hashes.astype(np.int32),
        xy=xy.astype(np.float32), region=region.astype(np.int16), centers=centers,
        means=means, frames=frames, quantiles=quantiles,
        disc_xy=disc_xy.astype(np.float32), disc_r=disc_r.astype(np.float32), orient=orient,
        labels=labels, label_terms=label_terms, sizes=sizes,
        vocabulary=words.vocabulary, idf=words.idf,
        components=components if components is not None else np.zeros((0, 0), np.float32),
        projection=projection,
    )


def _layout(centers: np.ndarray, radii: np.ndarray, rng: np.random.Generator
            ) -> tuple[np.ndarray, np.ndarray]:
    """A fresh layout of the regions: t-SNE of their centers, discs pushed
    apart, the whole fitted to the plate."""
    k = len(centers)
    if k >= 5:
        similarity = np.clip(centers @ centers.T, -1, 1)
        distances = 2.0 - 2.0 * similarity
        centered = centers - centers.mean(0)
        _u, _s, vt = np.linalg.svd(centered, full_matrices=False)
        layout = _tsne(distances, centered @ vt[:2].T, rng)
    elif k > 1:
        centered = centers - centers.mean(0)
        _u, _s, vt = np.linalg.svd(centered, full_matrices=False)
        layout = centered @ vt[:2].T if vt.shape[0] >= 2 else np.c_[centered @ vt[0], np.zeros(k)]
    else:
        layout = np.zeros((1, 2))
    spread = float(np.ptp(layout, axis=0).max()) if k > 1 else 1.0
    layout = layout / (spread or 1.0)
    return _normalize_plate(_separate(layout, radii), radii)


# ---------------------------------------------------------------------------
# Reading the corpus
# ---------------------------------------------------------------------------

def _corpus(conn: sqlite3.Connection) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Every paper's id, a hash of its metadata hash, and the day it was first
    seen (days since 1970-01-01, UTC), in id order."""
    rows = conn.execute(
        "SELECT id, metadata_hash, CAST(julianday(first_seen_at) - 2440587.5 AS INTEGER) "
        "FROM documents ORDER BY id"
    ).fetchall()
    ids = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
    hashes = np.fromiter((_hash32(r[1]) for r in rows), dtype=np.int32, count=len(rows))
    seen = np.fromiter((r[2] if r[2] is not None else 0 for r in rows), dtype=np.int32, count=len(rows))
    return ids, hashes, seen


def _texts(conn: sqlite3.Connection, ids: Optional[np.ndarray] = None
           ) -> Callable[[], Iterable[tuple[int, Optional[str], Optional[str]]]]:
    def rows() -> Iterable[tuple[int, Optional[str], Optional[str]]]:
        if ids is None:
            for row in conn.execute("SELECT id, title, abstract FROM documents ORDER BY id"):
                yield row[0], row[1], row[2]
            return
        wanted = [int(i) for i in ids]
        for start in range(0, len(wanted), 500):
            chunk = wanted[start:start + 500]
            marks = ",".join("?" * len(chunk))
            for row in conn.execute(
                    f"SELECT id, title, abstract FROM documents WHERE id IN ({marks}) ORDER BY id", chunk):
                yield row[0], row[1], row[2]
    return rows


def _projection(dims: int) -> Optional[np.ndarray]:
    if dims <= EMBEDDING_DIMS_CAP:
        return None
    rng = np.random.default_rng(SEED + dims)
    return (rng.standard_normal((dims, EMBEDDING_DIMS_CAP)) / math.sqrt(EMBEDDING_DIMS_CAP)).astype(np.float32)


def _embedding_vectors(conn: sqlite3.Connection, model: str, ids: np.ndarray,
                       projection: Optional[np.ndarray], dims: Optional[int]
                       ) -> tuple[np.ndarray, np.ndarray, Optional[int]]:
    """The model's vectors for ``ids`` (projected if wide), and which ids had one."""
    position = {int(d): i for i, d in enumerate(ids)}
    width = None if dims is None else (projection.shape[1] if projection is not None else dims)
    out: Optional[np.ndarray] = None if width is None else np.zeros((len(ids), width), np.float32)
    has = np.zeros(len(ids), dtype=bool)
    batch_rows: list[int] = []
    batch: list[np.ndarray] = []

    def flush() -> None:
        if not batch or out is None:
            return
        block = np.vstack(batch)
        out[batch_rows] = block @ projection if projection is not None else block
        has[batch_rows] = True
        batch_rows.clear()
        batch.clear()

    wanted = None if len(ids) == 0 else ids
    query = "SELECT document_id, dims, vector FROM document_embeddings WHERE model = ?"
    for doc_id, row_dims, blob in conn.execute(query, (model,)):
        at = position.get(int(doc_id))
        if at is None or wanted is None:
            continue
        if dims is None:
            dims = int(row_dims)
            projection = _projection(dims)
            width = projection.shape[1] if projection is not None else dims
            out = np.zeros((len(ids), width), np.float32)
        if int(row_dims) != dims:
            continue  # a vector of another width cannot share this space
        batch_rows.append(at)
        batch.append(np.frombuffer(blob, dtype="<f4"))
        if len(batch) >= 5_000:
            flush()
    flush()
    if out is None:
        out = np.zeros((len(ids), 1), np.float32)
    return out, has, dims


def embedding_coverage(conn: sqlite3.Connection, model: Optional[str], total: int) -> Optional[dict]:
    if not model:
        return None
    embedded = int(conn.execute(
        "SELECT COUNT(*) FROM document_embeddings e JOIN documents d ON d.id = e.document_id "
        "WHERE e.model = ?", (model,)).fetchone()[0])
    # The order of ``EmbeddingCoverage``, the model it is answered through.
    return {"embedded": embedded, "total": total, "model": model}


def choose_basis(coverage: Optional[dict]) -> tuple[str, Optional[str]]:
    """Embeddings when the set model covers enough of the corpus, else words."""
    if coverage and coverage["total"] and \
            coverage["embedded"] / coverage["total"] >= EMBEDDING_COVERAGE_FLOOR:
        return BASIS_EMBEDDINGS, coverage["model"]
    return BASIS_WORDS, None


def _take(matrix: _Csr, rows: np.ndarray) -> _Csr:
    starts, ends = matrix.indptr[rows], matrix.indptr[rows + 1]
    lengths = ends - starts
    indptr = np.zeros(len(rows) + 1, dtype=np.int64)
    np.cumsum(lengths, out=indptr[1:])
    picks = np.concatenate([np.arange(s, e) for s, e in zip(starts, ends)]) if len(rows) else np.zeros(0, np.int64)
    return _Csr(indptr, matrix.indices[picks], matrix.data[picks], matrix.cols)


def fit_corpus(conn: sqlite3.Connection, model: Optional[str], previous: Optional[Fit] = None) -> Fit:
    """A full fit of everything in the database, on the basis its coverage allows."""
    ids, hashes, _seen = _corpus(conn)
    basis, use_model = choose_basis(embedding_coverage(conn, model, len(ids)))
    words = _words(_texts(conn), ids)
    rng = np.random.default_rng(SEED)
    components = None
    projection = None
    if basis == BASIS_WORDS:
        if words.matrix.rows >= 3 and words.matrix.cols >= 3:
            coords, components = _lsa(words.matrix, LSA_DIMS, rng)
        else:
            # Too few papers or terms to reduce: the TF-IDF rows are the vectors.
            components = np.eye(max(1, words.matrix.cols), dtype=np.float32)[:, :words.matrix.cols]
            coords = words.matrix.matmul(components.T) if words.matrix.cols else \
                np.zeros((words.matrix.rows, 1), np.float32)
        vectors, usable = _unit_rows(coords)
    else:
        raw, has, dims = _embedding_vectors(conn, use_model or "", ids, None, None)
        projection = _projection(dims) if dims else None
        vectors, usable = _unit_rows(raw)
        usable &= has
    keep = np.flatnonzero(usable)
    words_kept = _Words(words.vocabulary, words.idf, _take(words.matrix, keep))
    fitted = fit(ids[keep], hashes[keep], vectors[keep], words_kept, basis=basis, model=use_model,
                 previous=previous, components=components, projection=projection)
    fitted.skipped_ids = ids[~usable].astype(np.int64)
    fitted.skipped_hashes = hashes[~usable].astype(np.int32)
    return fitted


def _vectors_for_new(conn: sqlite3.Connection, current: Fit, ids: np.ndarray
                     ) -> tuple[np.ndarray, np.ndarray]:
    if current.basis == BASIS_WORDS:
        out = np.zeros((len(ids), current.components.shape[0]), np.float32)
        at = {int(d): i for i, d in enumerate(ids)}
        for doc_id, title, abstract in _texts(conn, ids)():
            cols, values = _tfidf_row(_document_terms(title, abstract), current.vocabulary, current.idf)
            if cols:
                out[at[int(doc_id)]] = current.components[:, cols] @ np.asarray(values, np.float32)
        vectors, usable = _unit_rows(out)
        return vectors, usable
    dims = current.projection.shape[0] if current.projection is not None else current.centers.shape[1]
    raw, has, _dims = _embedding_vectors(conn, current.model or "", ids, current.projection, dims)
    vectors, usable = _unit_rows(raw)
    return vectors, usable & has


def place_new(conn: sqlite3.Connection, current: Fit, ids: np.ndarray, hashes: np.ndarray) -> int:
    """Place papers the fit has not seen, against it. Returns how many were placed."""
    if len(ids) == 0:
        return 0
    if len(current.centers) == 0:
        vectors, usable = np.zeros((len(ids), 1), np.float32), np.zeros(len(ids), bool)
    else:
        vectors, usable = _vectors_for_new(conn, current, ids)
    current.skipped_ids = np.concatenate([current.skipped_ids, ids[~usable].astype(np.int64)])
    current.skipped_hashes = np.concatenate([current.skipped_hashes, hashes[~usable].astype(np.int32)])
    keep = np.flatnonzero(usable)
    if len(keep) == 0:
        return 0
    vectors = vectors[keep]
    region, _best = _assign(vectors, current.centers)
    xy = _place(vectors, region, current.means, current.frames, current.quantiles,
                current.disc_xy, current.disc_r, current.orient, ids[keep])
    all_ids = np.concatenate([current.ids, ids[keep].astype(np.int64)])
    order = np.argsort(all_ids, kind="stable")
    current.ids = all_ids[order]
    current.hashes = np.concatenate([current.hashes, hashes[keep].astype(np.int32)])[order]
    current.xy = np.vstack([current.xy, xy])[order]
    current.region = np.concatenate([current.region, region.astype(np.int16)])[order]
    current.placed_since_fit += len(keep)
    return int(len(keep))


# ---------------------------------------------------------------------------
# The cache file beside the database
# ---------------------------------------------------------------------------

def cache_path(conn: sqlite3.Connection) -> Optional[Path]:
    """``<database>-map.npz``, or None for a database with no file."""
    for row in conn.execute("PRAGMA database_list"):
        if row[1] == "main" and row[2]:
            return Path(f"{row[2]}-map.npz")
    return None


def save(current: Fit, path: Path) -> None:
    meta = {
        "version": CACHE_VERSION, "basis": current.basis, "model": current.model,
        "fitted_at": current.fitted_at, "fitted_count": current.fitted_count,
        "placed_since_fit": current.placed_since_fit,
        "labels": current.labels, "label_terms": current.label_terms,
        "vocabulary": sorted(current.vocabulary, key=current.vocabulary.__getitem__),
    }
    arrays = {
        "ids": current.ids, "hashes": current.hashes, "xy": current.xy, "region": current.region,
        "centers": current.centers, "means": current.means, "frames": current.frames,
        "quantiles": current.quantiles, "disc_xy": current.disc_xy, "disc_r": current.disc_r,
        "orient": current.orient,
        "skipped_ids": current.skipped_ids, "skipped_hashes": current.skipped_hashes,
        "sizes": current.sizes, "idf": current.idf, "components": current.components,
        "meta": np.frombuffer(json.dumps(meta).encode("utf-8"), dtype=np.uint8),
    }
    if current.projection is not None:
        arrays["projection"] = current.projection
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    with open(temporary, "wb") as handle:
        np.savez(handle, **arrays)
    os.replace(temporary, path)


def load(path: Path) -> Optional[Fit]:
    try:
        with np.load(path, allow_pickle=False) as stored:
            meta = json.loads(bytes(stored["meta"]).decode("utf-8"))
            if meta.get("version") != CACHE_VERSION:
                return None
            return Fit(
                basis=meta["basis"], model=meta["model"], fitted_at=meta["fitted_at"],
                fitted_count=int(meta["fitted_count"]), ids=stored["ids"], hashes=stored["hashes"],
                xy=stored["xy"], region=stored["region"], centers=stored["centers"],
                means=stored["means"], frames=stored["frames"], quantiles=stored["quantiles"],
                disc_xy=stored["disc_xy"], disc_r=stored["disc_r"], orient=stored["orient"],
                labels=list(meta["labels"]),
                label_terms=[list(t) for t in meta["label_terms"]], sizes=stored["sizes"],
                vocabulary={t: i for i, t in enumerate(meta["vocabulary"])}, idf=stored["idf"],
                components=stored["components"],
                projection=stored["projection"] if "projection" in stored.files else None,
                placed_since_fit=int(meta.get("placed_since_fit", 0)),
                skipped_ids=stored["skipped_ids"], skipped_hashes=stored["skipped_hashes"],
            )
    except FileNotFoundError:
        return None
    except Exception:  # a damaged or foreign file is a missing cache, refitted
        logger.warning("collection map: ignoring unreadable cache %s", path, exc_info=True)
        return None


# ---------------------------------------------------------------------------
# The engine's view: one fit per database, refitted in the background
# ---------------------------------------------------------------------------

_lock = threading.RLock()
_fits: dict[Optional[str], Fit] = {}
_jobs: dict[Optional[str], threading.Thread] = {}
_errors: dict[Optional[str], str] = {}


def _key(path: Optional[Path]) -> Optional[str]:
    return str(path) if path is not None else None


def _current(path: Optional[Path]) -> Optional[Fit]:
    key = _key(path)
    with _lock:
        if key not in _fits and path is not None:
            loaded = load(path)
            if loaded is not None:
                _fits[key] = loaded
        return _fits.get(key)


def fitting(path: Optional[Path]) -> bool:
    with _lock:
        job = _jobs.get(_key(path))
        return job is not None and job.is_alive()


#: The directory ``implementation_scripts`` is imported from, for the child.
_SCRIPTS = Path(__file__).resolve().parent.parent

#: How a child's file is named beside the cache while it is written and read.
_CHILD_SUFFIX = "-fit.npz"


def _database_of(path: Path) -> Path:
    """The database a cache file sits beside (``<database>-map.npz``)."""
    return Path(str(path)[: -len("-map.npz")])


def _fit_in_child(path: Path, model: Optional[str]) -> tuple[Fit, Path]:
    """Fit the database ``path`` belongs to in a child process: its fit, and the file it wrote.

    A fit is seconds of NumPy and Python loops. On a thread it shares the
    engine's interpreter lock, and every request answered meanwhile waits for
    the lock again after each row SQLite hands back: on the first launch over
    10,000 papers, Today's read took 2.1 s beside the fit and 0.21 s alone,
    and the window waited for it. A child has its own interpreter, so the
    engine answers as fast while a fit runs. The child reads the database,
    starts from the map kept beside it, and writes its fit beside that. On
    macOS and Linux it exits if the engine does; on Windows, where an orphan
    keeps its parent's id, it finishes the fit and then exits.
    """
    output = path.with_name(f"{path.name}{_CHILD_SUFFIX}")
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(p for p in (str(_SCRIPTS), env.get("PYTHONPATH", "")) if p)
    done = subprocess.run(
        [sys.executable, "-m", "implementation_scripts.collection_map",
         str(_database_of(path)), str(path), str(output), model or ""],
        cwd=str(_SCRIPTS), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE, text=True, check=False,
    )
    fresh = load(output) if done.returncode == 0 else None
    if fresh is None:
        try:
            output.unlink()
        except FileNotFoundError:
            pass
        said = (done.stderr or "").strip().splitlines()
        raise RuntimeError(said[-1] if said else f"the fit exited with status {done.returncode} and kept no map")
    return fresh, output


def _child(database: str, cache: str, output: str, model: str) -> int:
    """The child's whole work: one fit, written to ``output``."""
    engine = os.getppid()

    def outlive_nothing() -> None:
        # Orphaned, a child is adopted by another parent: the engine is gone,
        # and so is anyone to read the fit.
        while True:
            time.sleep(0.5)
            if os.getppid() != engine:
                os._exit(0)

    threading.Thread(target=outlive_nothing, name="collection-map-parent", daemon=True).start()
    conn = sqlite3.connect(database, timeout=30)
    conn.execute("PRAGMA query_only = ON")
    try:
        fresh = fit_corpus(conn, model or None, previous=load(Path(cache)))
    finally:
        conn.close()
    save(fresh, Path(output))
    return 0


def _start_fit(path: Optional[Path], model: Optional[str],
               open_connection: Callable[[], sqlite3.Connection]) -> None:
    key = _key(path)
    with _lock:
        running = _jobs.get(key)
        if running is not None and running.is_alive():
            return
        _errors.pop(key, None)

        def run() -> None:
            try:
                if path is None:
                    # A database with no file has nothing a child could open.
                    conn = open_connection()
                    fresh = fit_corpus(conn, model, previous=_current(path))
                    with _lock:
                        _fits[key] = fresh
                    return
                fresh, written = _fit_in_child(path, model)
                with _lock:
                    _fits[key] = fresh
                    os.replace(written, path)
            except Exception as exc:
                logger.exception("collection map: fit failed")
                with _lock:
                    _errors[key] = f"{type(exc).__name__}: {exc}"

        thread = threading.Thread(target=run, name="collection-map-fit", daemon=True)
        _jobs[key] = thread
        thread.start()


def wait(conn: sqlite3.Connection, timeout: float = 120.0) -> None:
    """Block until a fit in progress for this database ends (for tests and tools)."""
    with _lock:
        job = _jobs.get(_key(cache_path(conn)))
    if job is not None:
        job.join(timeout)


def forget(conn: sqlite3.Connection) -> None:
    """Drop the map of this database, in memory and on disk.

    Called when the corpus is erased: the file holds positions and words taken
    from the papers, and erasing the papers has to erase them too.
    """
    path = cache_path(conn)
    with _lock:
        _fits.pop(_key(path), None)
        _errors.pop(_key(path), None)
    if path is not None:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def snapshot(conn: sqlite3.Connection, model: Optional[str],
             open_connection: Callable[[], sqlite3.Connection]) -> dict:
    """The map as the plate draws it, starting or scheduling a fit as needed.

    ``state`` is ``empty`` (no papers), ``fitting`` (no usable map yet; one is
    being fitted), ``failed`` (the last fit raised, and there is no map), or
    ``ready``. A ready map can be ``refitting`` at the same time, and is served
    meanwhile: the old sky until the new one is ready.
    """
    path = cache_path(conn)
    ids, hashes, seen = _corpus(conn)
    coverage = embedding_coverage(conn, model, len(ids))
    basis, use_model = choose_basis(coverage)
    base = {
        "basis": None, "model": None, "fitted_at": None, "fitted_count": 0, "placed_since_fit": 0,
        "refitting": False, "error": None, "embedding_coverage": coverage,
        "unplaced": {"no_text": 0, "not_embedded": 0},
        "regions": [], "points": {"id": [], "x": [], "y": [], "region": [], "seen_day": []},
    }
    if len(ids) == 0:
        if _current(path) is not None:
            forget(conn)
        return {"state": "empty", **base}

    with _lock:
        current = _current(path)
        matching = 0
        if current is not None:
            # A paper the fit placed, or saw and could not place, is known.
            known_ids = np.concatenate([current.ids, current.skipped_ids])
            known_hashes = np.concatenate([current.hashes, current.skipped_hashes])
            order = np.argsort(known_ids, kind="stable")
            known_ids, known_hashes = known_ids[order], known_hashes[order]
            if len(known_ids):
                at = np.clip(np.searchsorted(known_ids, ids), 0, len(known_ids) - 1)
                same = (known_ids[at] == ids) & (known_hashes[at] == hashes)
            else:
                same = np.zeros(len(ids), bool)
            matching = int(same.sum())
        # A fit that knows fewer than half of today's papers is another
        # collection's (a reset, a replaced database), not a stale one.
        if current is None or matching < 0.5 * len(ids):
            _start_fit(path, model, open_connection)
            error = _errors.get(_key(path))
            state = "failed" if error and not fitting(path) else "fitting"
            return {"state": state, **base, "error": error}

        new = ~same
        if new.any():
            # Keep only the papers still here, then place the ones the fit lacks.
            keep = np.isin(current.ids, ids[same])
            if not keep.all():
                current.ids, current.hashes = current.ids[keep], current.hashes[keep]
                current.xy, current.region = current.xy[keep], current.region[keep]
            still_skipped = np.isin(current.skipped_ids, ids[same])
            current.skipped_ids = current.skipped_ids[still_skipped]
            current.skipped_hashes = current.skipped_hashes[still_skipped]
            place_new(conn, current, ids[new], hashes[new])
            if path is not None:
                save(current, path)
        due = (current.basis != basis or current.model != use_model
               or current.placed_since_fit >= REFIT_FRACTION * max(1, current.fitted_count))
        if due:
            _start_fit(path, model, open_connection)

        on_plate = np.isin(current.ids, ids)
        served_ids = current.ids[on_plate]
        xy = current.xy[on_plate]
        region = current.region[on_plate].astype(np.int64)
        seen_by_id = seen[np.searchsorted(ids, served_ids)]
        unplaced = len(ids) - len(served_ids)
        not_embedded = 0
        if current.basis == BASIS_EMBEDDINGS and coverage:
            not_embedded = min(unplaced, max(0, coverage["total"] - coverage["embedded"]))
        counts = np.bincount(region, minlength=len(current.labels))
        regions = [
            {"id": c, "label": current.labels[c], "terms": current.label_terms[c],
             "x": round(float(current.disc_xy[c, 0]), 4), "y": round(float(current.disc_xy[c, 1]), 4),
             "r": round(float(current.disc_r[c]), 4), "size": int(counts[c])}
            for c in range(len(current.labels)) if counts[c] > 0
        ]
        return {
            "state": "ready",
            **base,
            "basis": current.basis,
            "model": current.model,
            "fitted_at": current.fitted_at,
            "fitted_count": current.fitted_count,
            "placed_since_fit": current.placed_since_fit,
            "refitting": fitting(path),
            "error": _errors.get(_key(path)),
            "unplaced": {"no_text": unplaced - not_embedded, "not_embedded": not_embedded},
            "regions": regions,
            "points": {
                "id": served_ids.tolist(),
                "x": np.round(xy[:, 0], 4).tolist(),
                "y": np.round(xy[:, 1], 4).tolist(),
                "region": region.tolist(),
                "seen_day": seen_by_id.tolist(),
            },
        }


if __name__ == "__main__":
    sys.exit(_child(*sys.argv[1:5]))
