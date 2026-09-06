# resmon_scripts/implementation_scripts/near_duplicates.py
"""Finding the same paper twice, and saying so without touching either copy.

The problem
-----------
Dedup at insert is hash equality over ``title|authors|date`` (``normalizer.py``).
It catches the same record arriving twice; it does not catch the same *paper*
arriving from two repositories, because a preprint on arXiv and its published
version on Crossref differ in date, in author formatting, in punctuation, and
often in the title's capitalisation or a trailing subtitle. Those rows sit in the
corpus as two papers and every count treats them as two.

What this does about it, and what it refuses to do
--------------------------------------------------
It writes a **link** — a row in ``document_links`` asserting that two documents
look like the same work — and stops there. Nothing is deleted, nothing is merged,
nothing is hidden. The same paper from two sources is two records with two
provenances, two sets of terms and two external ids, and collapsing them would
throw away the thing the corpus is for: what each source actually said. Collapse
is a per-view toggle the reader turns on, off by default (P12).

Two signals, and both must agree
--------------------------------
A pair is a candidate only when the vectors are close **and** a cheap lexical
check agrees. Neither alone is sound:

*Vectors alone* rank by topic. On a monitoring corpus — which is by construction a
set of papers on one subject — the nearest neighbour of any paper is usually a
*different* paper about the same thing. Distance says "these are about the same
subject", not "these are the same work".

*Lexical alone* is what dedup already does, one notch looser. It cannot see a
retitled preprint.

Together they are complementary: the vector proposes a short list of plausible
pairs, and the lexical check decides. A shared DOI is decisive on its own, because
a DOI names a work; two records carrying one are the same work whatever the
distance says. Title similarity is the fallback, and it is a token-set ratio over
normalised titles rather than a character distance, so a trailing subtitle or a
reordered "A vs. B" costs less than it would under edit distance.

**And both signals must be independent, which took a measurement to notice.**
A paper with no abstract is embedded from its title alone (``fields = 'title'``),
so its vector *is* the title — and "close vectors plus similar titles" is then one
signal counted twice. 2,982 of the 15,707 papers in the calibration corpus are in
that state, and journal front matter is most of them: Crossref emits a record per
issue titled "Editorial Board", "Issue Information", "Untitled". Every pair of
those scores distance 0.000 and title similarity 1.000 and is not the same work.
**In a 30-pair hand-graded sample under the first rule, 27 were exactly this and
the precision was 10%.** So the title path additionally requires that *both*
documents have an abstract. A shared DOI is exempt — it is evidence in its own
right, not an inference from the text, and 27 of the 102 ground-truth pairs have
no abstract on one side.

The threshold is a claim
------------------------
Every threshold here was calibrated on Ryan's real 15,707-paper corpus, and
**three** independent 30-pair samples were graded by hand: the first to find the
rule, and two more to measure it, because a precision figure read off the sample
that chose the thresholds is fitted to its own training set. The first rule scored
**10%**; the shipped rule scores **83%** and **87%** on the two samples that did
not choose it. All three are in
``workspace/handbacks/1.9/evidence/link-calibration.md``.

The 102 pairs that share a DOI are the labelled positives: same work by
definition, and their distances (median 0.037, p95 0.493, max 0.542) are what the
gates are set against. A threshold nobody measured is a number the interface would
present as a finding.

Every link records the ``method`` that produced it, because "these two share a
DOI" and "these two have similar titles and nearby vectors" are different
strengths of claim and the interface says which one it is making.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import threading
import unicodedata
from datetime import datetime, timezone
from typing import Callable, Iterable, Optional

from . import vector_index

logger = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_MAX_DISTANCE",
    "DEFAULT_MAX_TITLE_PATH_DISTANCE",
    "DEFAULT_MIN_TITLE_SIMILARITY",
    "LINK_KIND",
    "LinksJob",
    "clear_links",
    "find_links",
    "links_for",
    "links_job",
    "normalise_title",
    "title_similarity",
]

# The link kind this module writes. One kind, because "the same work, twice" is
# the only claim it knows how to make. ``document_links.kind`` is part of the
# primary key so a later kind — a citation, a correction — can coexist.
LINK_KIND = "near_duplicate"

# Calibrated on Ryan's real 15,707-paper corpus, not chosen. The 102 pairs that
# share a DOI are ground truth -- a DOI names a work -- and their distances run
# min 0.000, median 0.037, p95 0.493, **max 0.542**. So the candidate gate is
# 0.60: wide enough to contain every known-true pair with room to spare, and a
# tighter 0.30 would have discarded 25 of the 102.
#
# The distance is L2 over unit-normalised 768-dimension vectors from
# nomic-embed-text, running 0 (identical) to 2 (opposite).
DEFAULT_MAX_DISTANCE = 0.60

# The *title* path is held tighter than the candidate gate, at just under the
# ground-truth p95 (0.493). On this path the title is already known to match, so
# the distance is the only independent signal left: two records with the same
# title whose texts sit far apart are evidence that the title is boilerplate, not
# that the papers are the same.
#
# This is what excludes a paper from a *review of* that paper -- "Training a force
# field for proteins" against "PREreview of 'Training a force field for
# proteins'", which scored 0.875 on titles and sat at 0.572.
#
# A shared DOI is exempt: it is evidence in its own right, and holding it to a
# distance would let a weaker signal veto a stronger one. Ground-truth DOI pairs
# run out to 0.542.
#
# **0.30 was tried and rejected, and the reason is worth keeping.** In the second
# graded sample every false positive sat at 0.319 or above and every true one at
# 0.197 or below -- an apparently clean separation, and tightening to 0.30 would
# have removed the entire residual error class. It did not replicate: in a third
# sample the *same* class ("Natural history specimens collected and/or identified
# and deposited.", a boilerplate title on distinct deposition records) spans
# 0.297 to 0.341, straddling the cut, while genuine pairs appear at 0.211 and
# 0.251. A threshold that looked separable on one sample and did not hold on the
# next is a threshold fitted to a sample, so it was not adopted.
DEFAULT_MAX_TITLE_PATH_DISTANCE = 0.50

# Token-set ratio, 0..1. Two titles agree when one's words are nearly the other's.
DEFAULT_MIN_TITLE_SIMILARITY = 0.85

# How many neighbours to consider per paper. A paper has at most a handful of
# genuine twins; asking for more buys nothing and costs a wider scan.
_NEIGHBOURS_PER_DOCUMENT = 6

# ``\w`` with Unicode semantics, not ``[a-z0-9]``. An ASCII-only pattern reads a
# Japanese or Chinese title as zero words, scores every such pair 0.0, and so can
# never link one -- silently, and on a catalog that includes NDL Search. Accents
# are folded by stripping combining marks below, so "café" and "cafe" still agree.
_WORD = re.compile(r"\w+", re.UNICODE)

# Words too common in scholarly titles to carry evidence. Kept deliberately short:
# a longer list starts discarding real signal, and the token-set ratio already
# tolerates a missing article.
_STOPWORDS = frozenset(
    "a an and are as at be by for from in into is of on or the to via with".split()
)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalise_title(title: Optional[str]) -> list[str]:
    """A title as a bag of comparable words.

    Accents are folded — the same paper arrives "Modele" from one source and
    "Modèle" from another — by decomposing and dropping combining marks. Case and
    punctuation go with it. **Non-Latin scripts are kept, not discarded**: an
    earlier draft encoded to ASCII and ignored what would not fit, which turned
    every Japanese title into zero words and made a whole source's papers
    unlinkable without saying so.

    Digits stay. "GPT-4" and "GPT-3" are not the same paper, and losing the
    numeral would claim they were.

    What this still cannot do is equate characters that merely *mean* the same:
    a title with "µ" and one with "u" differ by one token here, which costs them
    some similarity but usually not the match. Recorded rather than fixed —
    a transliteration table is a large thing to maintain for a small gain.
    """
    if not title:
        return []
    decomposed = unicodedata.normalize("NFKD", title)
    without_marks = "".join(c for c in decomposed if not unicodedata.combining(c))
    return [w for w in _WORD.findall(without_marks.casefold()) if w not in _STOPWORDS]


def title_similarity(left: Optional[str], right: Optional[str]) -> float:
    """Token-set ratio of two titles, 0..1. Symmetric.

    ``|A ∩ B| / max(|A|, |B|)`` over the word sets. ``max`` rather than the union
    or the smaller side on purpose: a short title that is wholly contained in a
    long one — "Attention Is All You Need" inside "Attention Is All You Need for
    Protein Folding: A Critical Reassessment" — scores 1.0 against the smaller
    denominator and would be linked. Those are different papers. Against ``max``
    it scores 5/11, well under the gate.
    """
    a, b = set(normalise_title(left)), set(normalise_title(right))
    if not a or not b:
        return 0.0
    return len(a & b) / max(len(a), len(b))


def _normalised_doi(doi: Optional[str]) -> Optional[str]:
    """A DOI reduced to what identifies it, or ``None`` if there is nothing usable.

    Sources hand over the same DOI as a bare ``10.x/y``, as an ``https://doi.org``
    URL, with a ``doi:`` prefix, and in mixed case. DOIs are case-insensitive by
    specification.
    """
    if not doi:
        return None
    text = str(doi).strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/",
                   "http://dx.doi.org/", "doi:"):
        if text.startswith(prefix):
            text = text[len(prefix):]
    text = text.strip()
    # A DOI always begins ``10.`` followed by a registrant. Anything else is a
    # source putting something other than a DOI in the DOI column, and matching
    # on it would link two papers because they share the word "unknown".
    return text if text.startswith("10.") and len(text) > 4 else None


# ---------------------------------------------------------------------------
# Finding pairs
# ---------------------------------------------------------------------------


def find_links(
    conn: sqlite3.Connection,
    model: str,
    *,
    max_distance: float = DEFAULT_MAX_DISTANCE,
    min_title_similarity: float = DEFAULT_MIN_TITLE_SIMILARITY,
    max_title_path_distance: float = DEFAULT_MAX_TITLE_PATH_DISTANCE,
    require_abstract: bool = True,
    within: Optional[Iterable[int]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """Return the near-duplicate pairs in the corpus. Writes nothing.

    Separated from the writing so the calibration script can grade candidates
    without touching a database, and so a threshold change can be evaluated
    before it is applied.

    Returns ``{"pairs", "considered", "cancelled", "reason"}``. Each pair is
    ``{a, b, distance, title_similarity, shared_doi, method, score}`` with
    ``a < b``, matching the table's CHECK.
    """
    result: dict = {"pairs": [], "considered": 0, "cancelled": False, "reason": None}

    if vector_index.load_extension(conn) is None:
        result["reason"] = (
            "Finding near-duplicates needs the vector index, and this build cannot "
            "load it. Nothing was scanned."
        )
        return result

    state = vector_index.index_state(conn)
    if state["rows"] == 0:
        result["reason"] = (
            "Nothing is embedded yet, so there are no vectors to compare. Run the "
            "backfill in Settings first."
        )
        return result

    rows = conn.execute(
        "SELECT e.document_id, e.vector, e.fields, d.title, d.doi, d.abstract, "
        "       d.source_repository "
        "FROM document_embeddings e JOIN documents d ON d.id = e.document_id "
        "WHERE e.model = ? ORDER BY e.document_id",
        (model,),
    ).fetchall()
    if not rows:
        result["reason"] = f"No documents are embedded with {model!r}."
        return result

    # Read once into memory rather than per-pair. 15,707 rows of (id, title, doi)
    # is a few megabytes; a query per candidate pair would be ~90,000 round trips.
    meta = {
        int(r["document_id"]): {
            "title": r["title"],
            "doi": _normalised_doi(r["doi"]),
            "source": r["source_repository"],
            # Whether there is anything behind the vector but the title. This is
            # the field that took precision from 10% to 60% on the graded
            # sample; ``require_abstract=False`` is for the calibration script,
            # which needs to measure what the rule would do without it.
            "has_abstract": (not require_abstract) or bool(
                r["abstract"] and str(r["abstract"]).strip()),
        }
        for r in rows
    }
    scope = set(int(i) for i in within) if within is not None else None

    seen: set[tuple[int, int]] = set()
    total = len(rows)
    for index, row in enumerate(rows):
        if should_cancel is not None and should_cancel():
            result["cancelled"] = True
            result["reason"] = "Cancelled. The pairs already found are returned."
            break
        doc_id = int(row["document_id"])
        if scope is not None and doc_id not in scope:
            continue
        result["considered"] += 1

        # +1 because a document is its own nearest neighbour at distance 0.
        neighbours = vector_index.nearest(
            conn, model, row["vector"], k=_NEIGHBOURS_PER_DOCUMENT + 1
        )
        for other_id, distance in neighbours:
            if other_id == doc_id or distance > max_distance:
                continue
            pair = (min(doc_id, other_id), max(doc_id, other_id))
            if pair in seen:
                continue
            other = meta.get(other_id)
            if other is None:
                # Embedded under this model but its document row is gone, or it
                # belongs to a model this scan is not reading. Skipped rather
                # than linked against a paper that no longer exists -- the index
                # can outlive a row (1.9a residual risk) and this must not turn
                # that into a visible, wrong assertion.
                continue
            seen.add(pair)

            this = meta[doc_id]
            shared_doi = bool(this["doi"] and other["doi"] and this["doi"] == other["doi"])
            similarity = title_similarity(this["title"], other["title"])

            if shared_doi:
                # Decisive on its own: a DOI names a work. Not held to the title
                # path's distance, because a weaker signal must not veto a
                # stronger one. The distance is still recorded, because a shared
                # DOI with a distant vector is worth being able to look at.
                method = "shared_doi"
            elif (
                similarity >= min_title_similarity
                and distance <= max_title_path_distance
                and this["has_abstract"] and other["has_abstract"]
            ):
                method = "vector+title"
            else:
                continue

            result["pairs"].append({
                "a": pair[0], "b": pair[1],
                "distance": round(float(distance), 6),
                "title_similarity": round(similarity, 4),
                "shared_doi": shared_doi,
                "method": method,
                # One number the interface can sort on. A shared DOI outranks
                # every title match, and within a method a closer pair outranks
                # a further one.
                "score": round(1.0 if shared_doi else similarity, 4),
            })

        if on_progress is not None and (index + 1) % 250 == 0:
            on_progress(index + 1, total)

    if on_progress is not None:
        on_progress(total, total)
    return result


def write_links(conn: sqlite3.Connection, pairs: list[dict]) -> int:
    """Store *pairs* in ``document_links``. Idempotent. Returns rows written.

    ``ON CONFLICT`` updates rather than ignoring, so re-running after a threshold
    change refreshes the score and the method instead of leaving the first answer
    in place. Nothing is ever deleted here: :func:`clear_links` is the only path
    that removes a link, and it is explicit.
    """
    if not pairs:
        return 0
    conn.executemany(
        "INSERT INTO document_links (document_a, document_b, kind, score, method, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(document_a, document_b, kind) DO UPDATE SET "
        "  score = excluded.score, method = excluded.method",
        [(p["a"], p["b"], LINK_KIND, p["score"], p["method"], _now()) for p in pairs],
    )
    conn.commit()
    return len(pairs)


def clear_links(conn: sqlite3.Connection, kind: str = LINK_KIND) -> int:
    """Remove every link of *kind*. Documents are untouched — links are derived.

    Exists because a threshold change makes the previous answer wrong, not stale:
    a pair that no longer qualifies must stop being asserted, and leaving it would
    be worse than never having found it.
    """
    cursor = conn.execute("DELETE FROM document_links WHERE kind = ?", (kind,))
    conn.commit()
    return cursor.rowcount


def links_for(conn: sqlite3.Connection, document_id: int) -> dict:
    """Everything linked to one document, from either side of the pair.

    The pair is stored once with ``a < b``, so this reads both columns and
    presents the *other* document either way — a caller should never have to know
    which side of the row it is on.
    """
    rows = conn.execute(
        """
        SELECT l.kind, l.score, l.method, l.created_at,
               d.id, d.title, d.source_repository, d.publication_date, d.doi, d.url
        FROM document_links l
        JOIN documents d
          ON d.id = CASE WHEN l.document_a = :id THEN l.document_b ELSE l.document_a END
        WHERE l.document_a = :id OR l.document_b = :id
        ORDER BY l.score DESC, d.id
        """,
        {"id": int(document_id)},
    ).fetchall()
    return {
        "document_id": int(document_id),
        "links": [
            {
                "id": int(r["id"]),
                "title": r["title"],
                "source_repository": r["source_repository"],
                "publication_date": r["publication_date"],
                "doi": r["doi"],
                "url": r["url"],
                "kind": r["kind"],
                "score": r["score"],
                "method": r["method"],
                "created_at": r["created_at"],
                # Rendered rather than composed in the renderer, so the wording is
                # the same in the Explorer, the Results page and the report.
                "label": _label(r["method"], r["source_repository"]),
            }
            for r in rows
        ],
        "count": len(rows),
    }


def _label(method: str, source: str) -> str:
    """"also appears as … in {source}", with the strength of the claim in it."""
    if method == "shared_doi":
        return f"also appears in {source} — same DOI"
    return f"also appears in {source} — near-identical title"


def links_map(conn: sqlite3.Connection, document_ids: list[int]) -> dict:
    """Links for many documents in one round trip — what a page of results needs.

    One query rather than one per row: the Explorer renders fifty results and
    fifty queries to badge them would be the shape ``/api/lifecycle/for-documents``
    exists to avoid.
    """
    if not document_ids:
        return {}
    ids = [int(i) for i in document_ids]
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT l.document_a, l.document_b, l.kind, l.score, l.method,
               a.title AS a_title, a.source_repository AS a_source,
               b.title AS b_title, b.source_repository AS b_source
        FROM document_links l
        JOIN documents a ON a.id = l.document_a
        JOIN documents b ON b.id = l.document_b
        WHERE l.document_a IN ({placeholders}) OR l.document_b IN ({placeholders})
        """,
        (*ids, *ids),
    ).fetchall()

    wanted = set(ids)
    out: dict[str, list[dict]] = {}
    for r in rows:
        for near, far, far_title, far_source in (
            (r["document_a"], r["document_b"], r["b_title"], r["b_source"]),
            (r["document_b"], r["document_a"], r["a_title"], r["a_source"]),
        ):
            if int(near) not in wanted:
                continue
            out.setdefault(str(int(near)), []).append({
                "id": int(far),
                "title": far_title,
                "source_repository": far_source,
                "kind": r["kind"],
                "score": r["score"],
                "method": r["method"],
                "label": _label(r["method"], far_source),
            })
    return out


def collapse_groups(conn: sqlite3.Connection, document_ids: list[int]) -> dict:
    """Which of *document_ids* a per-view collapse would fold into which.

    **Returns a grouping; it hides nothing.** The caller decides whether to act on
    it, and by default does not (P12). Every id in ``keep`` and ``folded`` came in
    through ``document_ids``: the counts a page shows are unchanged by the
    existence of links, because this function cannot add or remove a row.

    The kept row of a group is the lowest id — the one resmon saw first. Arbitrary,
    but stable, which matters more: a collapse that reordered itself between two
    renders of the same page would be worse than none.
    """
    ids = [int(i) for i in document_ids]
    if not ids:
        return {"keep": [], "folded": {}}
    linked = links_map(conn, ids)
    present = set(ids)

    # Union-find over the links that fall inside this page.
    parent: dict[int, int] = {i: i for i in ids}

    def _root(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for near, entries in linked.items():
        for entry in entries:
            far = int(entry["id"])
            if far not in present:
                continue
            ra, rb = _root(int(near)), _root(far)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)

    groups: dict[int, list[int]] = {}
    for i in ids:
        groups.setdefault(_root(i), []).append(i)

    keep = [i for i in ids if _root(i) == i]
    folded = {str(root): sorted(members) for root, members in groups.items()
              if len(members) > 1}
    return {"keep": keep, "folded": folded}


# ---------------------------------------------------------------------------
# The job
# ---------------------------------------------------------------------------


class LinksJob:
    """One near-duplicate scan at a time, cancellable, on the D3 pattern.

    Deliberately the same shape as :class:`embedding_job.BackfillJob` — module
    singleton, daemon thread, cooperative stop, status read from the database
    rather than from counters — because they are the same kind of work and two
    shapes for one job type is a thing a reader has to learn twice.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._state: dict = self._idle_state()

    @staticmethod
    def _idle_state() -> dict:
        return {
            "running": False, "model": None, "processed": 0, "total": 0,
            "found": 0, "started_at": None, "finished_at": None,
            "cancelled": False, "reason": None,
        }

    def status(self, conn: sqlite3.Connection) -> dict:
        with self._lock:
            run = dict(self._state)
        stored = conn.execute(
            "SELECT COUNT(*) FROM document_links WHERE kind = ?", (LINK_KIND,)
        ).fetchone()[0]
        by_method = dict(conn.execute(
            "SELECT method, COUNT(*) FROM document_links WHERE kind = ? GROUP BY method",
            (LINK_KIND,),
        ).fetchall())
        return {
            "run": run,
            "links": int(stored),
            "by_method": {str(k): int(v) for k, v in by_method.items()},
            "thresholds": {
                "max_distance": DEFAULT_MAX_DISTANCE,
                "min_title_similarity": DEFAULT_MIN_TITLE_SIMILARITY,
            },
        }

    def start(self, connection_factory: Callable[[], sqlite3.Connection], model: str,
              *, close_connection: bool = True) -> dict:
        """Begin a scan on a daemon thread. Raises if one is already running.

        The factory is called **on the worker thread**: each thread holds its own
        connection (BUG-020), and sharing one is what segfaults CPython.
        """
        with self._lock:
            if self._state["running"]:
                raise RuntimeError("A near-duplicate scan is already running.")
            self._cancel.clear()
            self._state = self._idle_state()
            self._state.update(running=True, model=model, started_at=_now())
            snapshot = dict(self._state)
        self._thread = threading.Thread(
            target=self._run, args=(connection_factory, model, close_connection),
            daemon=True, name="near-duplicate-scan",
        )
        self._thread.start()
        return snapshot

    def cancel(self) -> dict:
        with self._lock:
            if not self._state["running"]:
                return {"status": "idle"}
        self._cancel.set()
        return {"status": "cancelling"}

    def join(self, timeout: float = 60.0) -> bool:
        thread = self._thread
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    def _run(self, connection_factory: Callable[[], sqlite3.Connection], model: str,
             close_connection: bool) -> None:
        conn = None
        try:
            conn = connection_factory()

            def _progress(done: int, total: int) -> None:
                with self._lock:
                    self._state["processed"], self._state["total"] = done, total

            found = find_links(
                conn, model,
                should_cancel=self._cancel.is_set, on_progress=_progress,
            )
            # A completed scan replaces the previous answer wholesale: a pair that
            # no longer qualifies must stop being asserted. A *cancelled* scan
            # does not, because it only looked at part of the corpus and clearing
            # would delete links it never re-examined.
            if not found["cancelled"] and found["reason"] is None:
                clear_links(conn)
            written = write_links(conn, found["pairs"])
            with self._lock:
                self._state.update(
                    found=written, cancelled=found["cancelled"], reason=found["reason"],
                )
        except Exception as exc:  # pragma: no cover - defence around a daemon thread
            logger.exception("near-duplicate scan failed")
            with self._lock:
                self._state["reason"] = f"The scan stopped: {type(exc).__name__}: {exc}"
        finally:
            with self._lock:
                self._state["running"] = False
                self._state["finished_at"] = _now()
            if conn is not None and close_connection:
                try:
                    conn.close()
                except Exception:  # pragma: no cover
                    logger.debug("scan connection close failed", exc_info=True)


links_job = LinksJob()
