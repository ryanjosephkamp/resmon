"""Corpus-wide search and faceting.

This module searches everything resmon has ever collected rather than one
execution at a time, filtered by author, source, subject category, publication
date, and free text across titles and abstracts.

Scale
-----
The design target is a corpus of ~100,000 papers, and four decisions follow
from it. Each is a deliberate trade, not a default:

**Free text goes through FTS5, not LIKE.** ``LIKE '%term%'`` has no usable
prefix, so SQLite reads every abstract in the table -- tens of megabytes per
query at the target size. FTS5 keeps an inverted index and answers the same
question with a lookup. It is declared *external-content*, so it stores tokens
and a rowid rather than a second copy of every abstract, and triggers keep it
in step. Where FTS5 is genuinely unavailable the code degrades to LIKE rather
than failing, and says so in the response.

**Authors and categories are read from normalized tables, not split at query
time.** They are stored on ``documents`` as comma-joined strings, which cannot
be filtered or counted without reading every row. ``document_authors`` and
``document_categories`` carry indexed copies. ``documents`` remains the source
of truth; these are derived.

**Pagination is keyset, not OFFSET.** ``LIMIT 50 OFFSET 90000`` makes SQLite
walk ninety thousand rows to discard them. A cursor on the sort key seeks
directly instead, so page 1,800 costs what page 1 costs. The price is that
pages must be walked in order rather than jumped to by number, which suits a
list that reads more as it scrolls and is why the interface is built that way.
A jump goes to a date instead (``start_date``), which the same seek reaches.

**Counts are exact, within a time budget** (:data:`COUNT_BUDGET_S`). Counting
every match is the one remaining full scan, and at 100,000 papers the broadest
word search counts in under a tenth of a second, so the count is made, not
estimated. The budget is for what that measurement does not cover: a larger
collection, a slower machine, the LIKE fallback. A count that runs out of time
stops and says so, with the number it reached: ``total_is_exact`` is false and
``total`` is a floor, never a guess. A later page of the same search reuses the
first page's count rather than counting again.

One collection at a time
------------------------
Every read takes the collection it searches (``collection_id``), and the
filters narrow that collection's papers: the clause is one lookup per paper in
the membership's primary key (``paper_collections.MEMBER_SQL``). A count of a
whole collection reads the membership table instead of walking the papers.
``collection_id=None`` searches every paper in the database, which no route
asks for: an absent collection there means the default one.

Sorting by meaning
------------------
``sort="similarity"`` ranks the corpus by distance from the search phrase,
**within the structured filters** — sources, authors, categories, dates. Those
still choose which papers are in scope and switching sort never changes them.
The free-text phrase is the exception: in this sort it is what the ranking is
measured against, not a filter.

That exception was bought with a measurement. The text filter is an ``AND`` over
every word typed, so a plain-English query matches no paper and the sort has
nothing to re-order. On the real 15,707-paper corpus, **eleven of twenty natural
queries returned an empty page** while the same vectors, unfiltered, found a
relevant paper for almost every one. A control labelled "Closest to" that
answers from a keyword slice is not doing what it says.

Four consequences follow, and all are deliberate.

**Every match is ranked.** The ranking reads every stored vector in scope
(:func:`vector_index.rank_all`), not a nearest-neighbour query: ``vec0``'s
``k`` stops at 4,096, so a ranking asked of more papers than that was refused
whole and every paper came back unranked. Measured on 100,000 papers with
768-dimension vectors: 0.24 s to rank all of them.

**Papers with no vector are appended, not dropped.** A corpus mid-backfill, or
one holding papers whose sources' terms permitted no abstract, would otherwise
lose rows the moment somebody changed the sort. They come last, in the newest
order, and the response counts them so the interface can say how many are
unranked.

**The two sorts can return different totals, and that is the point.** ``newest``
answers the text filter; ``similarity`` answers the phrase. A caller that needs
the keyword set asks for ``newest``.

**Pagination becomes an offset.** Keyset pagination needs a sort key stored in an
index; a ranking is computed per query and has none. The cursor in this mode is
the number of rows already returned, into a ranking the first page computes and
later pages of the same search reuse (:data:`_RANKINGS`), so "Show more" costs a
slice of a list rather than another ranking.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
import threading
import time
from array import array
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Iterator, Optional

from . import vector_index
from .paper_collections import member_clause, revision as collection_revision

# How long counting the matches may take before the count stops and says what
# it reached. At 100,000 papers the slowest count measured (every paper with
# "model" in it, 92,934 of them) took 0.09 s, so this is a bound on the cases
# that measurement did not cover, not a limit anyone meets in ordinary use.
COUNT_BUDGET_S = 1.5
# How often, in SQLite virtual-machine steps, a count looks at the clock.
_COUNT_CHECK_STEPS = 10_000

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200

# Facet lists are truncated: a corpus of 100k papers can hold 200k distinct
# author names, and no interface can present that.
MAX_FACET_VALUES = 30


# The sort key, written once so the index, the ORDER BY and the cursor
# comparison cannot drift apart.
#
# ``pub_sort`` is a generated column holding COALESCE(publication_date, ''),
# indexed alongside id. It is a column rather than an inline expression because
# SQLite will not match a row-value comparison against an expression index: the
# expression form compiled to SCAN and lost to LIMIT/OFFSET, while this one
# compiles to SEARCH and beats it by roughly 20x at depth. The COALESCE keeps
# undated papers inside the comparison -- against a real NULL a row-value
# comparison yields NULL and the row vanishes from pagination entirely.
_ORDER_KEY = "documents.pub_sort, documents.id"
_ORDER_BY = "documents.pub_sort DESC, documents.id DESC"


def _fts_available(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents_fts'"
    ).fetchone()
    return row is not None


def _fts_query(text: str) -> str:
    """Turn user input into a safe FTS5 MATCH expression.

    Every token is quoted, so punctuation a user types cannot be read as FTS5
    syntax (``NEAR``, ``*``, ``-``, a stray quote) and cannot error the query.
    A trailing ``*`` is added to the final token so search feels
    incremental as the user types.
    """
    tokens = [t for t in text.replace('"', " ").split() if t]
    if not tokens:
        return ""
    quoted = [f'"{t}"' for t in tokens[:-1]]
    quoted.append(f'"{tokens[-1]}"*')
    return " AND ".join(quoted)


@dataclass(frozen=True)
class Count:
    """How many papers match, and whether that is all of them.

    ``exact`` is false only when counting ran out of :data:`COUNT_BUDGET_S`; then
    ``total`` is how many it had counted by then, which every match is at least.
    """

    total: int
    exact: bool


# Counts and rankings already made, for the later pages of the same search. Keyed
# by the database file, the query, and a fingerprint of what it reads, so a paper
# added or removed since is a miss rather than a stale answer; the collection's
# revision is in the fingerprint, so a move or a copy that changed which papers
# it holds is one too. Only a database in a file is cached: two in-memory
# databases cannot be told apart by name.
_COUNTS: "OrderedDict[tuple, Count]" = OrderedDict()
_COUNTS_MAX = 64
_RANKINGS: "OrderedDict[tuple, _Ranking]" = OrderedDict()
# A ranking of 100,000 papers holds 1.6 MB here (an id and a distance each), so
# a few searches' worth is a few megabytes.
_RANKINGS_MAX = 4
_CACHE_LOCK = threading.Lock()


def _db_file(conn: sqlite3.Connection) -> str:
    for row in conn.execute("PRAGMA database_list"):
        if row[1] == "main":
            return str(row[2] or "")
    return ""


def _documents_fingerprint(conn: sqlite3.Connection, collection_id: Optional[int] = None) -> tuple:
    papers = tuple(conn.execute("SELECT COUNT(*), IFNULL(MAX(id), 0) FROM documents").fetchone())
    if collection_id is None:
        return papers
    return (*papers, int(collection_id), collection_revision(conn, collection_id))


def _collection_only(where: str) -> bool:
    """Whether *where* is the collection's clause and nothing else."""
    return where == f" WHERE {member_clause()}"


def _cached(store: OrderedDict, key: Optional[tuple]):
    if key is None:
        return None
    with _CACHE_LOCK:
        hit = store.get(key)
        if hit is not None:
            store.move_to_end(key)
        return hit


def _remember(store: OrderedDict, key: Optional[tuple], value, most: int) -> None:
    if key is None:
        return
    with _CACHE_LOCK:
        store[key] = value
        store.move_to_end(key)
        while len(store) > most:
            store.popitem(last=False)


def count_where(conn: sqlite3.Connection, where: str, params: list[Any], *,
                budget_s: Optional[float] = None) -> Count:
    """Count the papers ``where`` matches, exactly, unless *budget_s* runs out first.

    With no filter at all this is SQLite's count of the table, which reads the
    smallest index and takes milliseconds at any size. With one, the matches are
    walked and counted as they come, with the clock checked every
    :data:`_COUNT_CHECK_STEPS` steps: a single ``COUNT(*)`` stopped by the clock
    says nothing about how far it got, and the count it reached is the one fact
    a stopped count still has. ``budget_s=None`` counts to the end.
    """
    if not where:
        return Count(int(conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]), True)
    if _collection_only(where):
        # A whole collection: its rows in the membership's primary key, counted
        # where they lie, rather than every paper walked and looked up.
        return Count(int(conn.execute(
            "SELECT COUNT(*) FROM collection_documents WHERE collection_id = ?", params).fetchone()[0]), True)
    deadline = None if budget_s is None else time.monotonic() + budget_s
    counted = 0
    if deadline is not None:
        conn.set_progress_handler(lambda: time.monotonic() > deadline, _COUNT_CHECK_STEPS)
    try:
        for _row in conn.execute(f"SELECT documents.id FROM documents {where}", params):
            counted += 1
    except sqlite3.OperationalError as exc:
        if deadline is None or "interrupt" not in str(exc).lower():
            raise
        return Count(counted, False)
    finally:
        if deadline is not None:
            conn.set_progress_handler(None, 0)
    return Count(counted, True)


def _count_for(conn: sqlite3.Connection, where: str, params: list[Any], *, fresh: bool,
               collection_id: Optional[int] = None) -> Count:
    """The search's count: made afresh for a first page, reused by its later pages."""
    file = _db_file(conn)
    key = (file, where, tuple(params), _documents_fingerprint(conn, collection_id)) if file else None
    if not fresh:
        hit = _cached(_COUNTS, key)
        if hit is not None:
            return hit
    made = count_where(conn, where, params, budget_s=COUNT_BUDGET_S)
    _remember(_COUNTS, key, made, _COUNTS_MAX)
    return made


# A day as the newest sort's jump takes it: a year, a month, or a day, written
# as publication dates are stored.
_START_DATE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")
# The largest id SQLite can hold, so a jump's seek includes every paper of its day.
_LAST_ID = 2**63 - 1


def _build_where(
    conn: sqlite3.Connection,
    *,
    query: str | None,
    sources: list[str] | None,
    authors: list[str] | None,
    categories: list[str] | None,
    date_from: str | None,
    date_to: str | None,
    collection_id: Optional[int] = None,
) -> tuple[str, list[Any], bool]:
    """Return ``(where_sql, params, used_fts)`` for the given filters, within one collection."""
    clauses: list[str] = []
    params: list[Any] = []
    used_fts = False

    if collection_id is not None:
        # First, so a search with no other filter is exactly this clause, which
        # ``count_where`` counts from the membership table.
        clauses.append(member_clause())
        params.append(int(collection_id))

    if query and query.strip():
        if _fts_available(conn):
            expr = _fts_query(query)
            if expr:
                clauses.append(
                    "documents.id IN (SELECT rowid FROM documents_fts "
                    "WHERE documents_fts MATCH ?)"
                )
                params.append(expr)
                used_fts = True
        if not used_fts:
            like = f"%{query.strip()}%"
            clauses.append("(documents.title LIKE ? OR documents.abstract LIKE ?)")
            params.extend([like, like])

    if sources:
        clauses.append(
            f"documents.source_repository IN ({','.join('?' for _ in sources)})"
        )
        params.extend(sources)

    if authors:
        # EXISTS against the indexed join table rather than LIKE over the
        # comma-joined string, so this is a seek per author, not a scan.
        clauses.append(
            "EXISTS (SELECT 1 FROM document_authors da WHERE da.document_id = documents.id "
            f"AND da.author IN ({','.join('?' for _ in authors)}))"
        )
        params.extend(authors)

    if categories:
        clauses.append(
            "EXISTS (SELECT 1 FROM document_categories dc WHERE dc.document_id = documents.id "
            f"AND dc.category IN ({','.join('?' for _ in categories)}))"
        )
        params.extend(categories)

    if date_from:
        clauses.append("documents.publication_date >= ?")
        params.append(date_from)
    if date_to:
        clauses.append("documents.publication_date <= ?")
        params.append(date_to)

    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params, used_fts


def search(
    conn: sqlite3.Connection,
    *,
    query: str | None = None,
    sources: list[str] | None = None,
    authors: list[str] | None = None,
    categories: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    cursor: str | None = None,
    limit: int = DEFAULT_PAGE_SIZE,
    sort: str = "newest",
    query_vector: Optional[bytes] = None,
    model: Optional[str] = None,
    start_date: Optional[str] = None,
    collection_id: Optional[int] = None,
) -> dict:
    """Search one collection. Returns one page plus a cursor for the next.

    *cursor* is the opaque ``"<publication_date>|<id>"`` of the last row of the
    previous page. Ordering is (publication_date DESC, id DESC), which the
    ``idx_documents_pubdate`` index matches exactly, so the seek is a
    logarithmic descent rather than a walk.

    With ``sort="similarity"`` the same filtered set comes back ranked by
    distance from *query_vector*, and **the cursor is an offset** — a decimal
    count of rows already returned, not a sort key. A ranking is computed per
    query and has no stored key to seek on, so there is nothing for a keyset
    cursor to compare against. The caller does not have to know which shape it
    holds; it round-trips whatever ``next_cursor`` it was given.

    *query_vector* and *model* are supplied by the caller rather than resolved
    here. This module knows about the corpus and nothing about lanes, settings or
    credentials, and it stays that way.

    *start_date* is the newest sort's jump: with no cursor, the page starts at
    the newest match published on or before that day (``YYYY``, ``YYYY-MM`` or
    ``YYYY-MM-DD``, compared as stored dates are), and ``newer_count`` says how
    many matches come before it. The count above the list is still every match.
    It is ignored with a cursor, which already says where the list is, and under
    the similarity sort, which is not in date order.
    """
    limit = max(1, min(int(limit), MAX_PAGE_SIZE))
    if sort == "similarity":
        return _search_by_similarity(
            conn, query=query, sources=sources, authors=authors,
            categories=categories, date_from=date_from, date_to=date_to,
            cursor=cursor, limit=limit, query_vector=query_vector, model=model,
            collection_id=collection_id,
        )
    where, params, used_fts = _build_where(
        conn, query=query, sources=sources, authors=authors,
        categories=categories, date_from=date_from, date_to=date_to,
        collection_id=collection_id,
    )

    page_where, page_params = where, list(params)
    jump = None
    if not cursor and start_date:
        if not _START_DATE.match(start_date):
            raise ValueError(f"start_date must be YYYY, YYYY-MM or YYYY-MM-DD, not {start_date!r}")
        jump = start_date
        cursor = f"{start_date}|{_LAST_ID}"
    if cursor:
        try:
            cur_date, cur_id = cursor.rsplit("|", 1)
            cur_id_int = int(cur_id)
        except (ValueError, AttributeError):
            raise ValueError(f"Malformed cursor: {cursor!r}") from None
        # A row-value comparison, not an OR of two predicates. The OR form
        # compiles to SCAN and is slower than the OFFSET it was meant to beat;
        # this form compiles to SEARCH against idx_documents_pubdate. Measured
        # on 100,000 papers at row 90,000: 0.07 ms here, 4.77 ms for the OR
        # form, 1.90 ms for LIMIT/OFFSET.
        seek = f"({_ORDER_KEY}) < (?, ?)"
        page_where = f"{page_where} AND {seek}" if page_where else f" WHERE {seek}"
        page_params.extend([cur_date, cur_id_int])

    rows = conn.execute(
        f"""
        SELECT documents.* FROM documents
        {page_where}
        ORDER BY {_ORDER_BY}
        LIMIT ?
        """,
        (*page_params, limit + 1),
    ).fetchall()

    has_more = len(rows) > limit
    page = [dict(r) for r in rows[:limit]]
    next_cursor = None
    if has_more and page:
        last = page[-1]
        # Built from the same COALESCE'd key the seek compares against, so an
        # undated paper produces '' rather than the string "None".
        next_cursor = f"{last.get('publication_date') or ''}|{last['id']}"

    counted = _count_for(conn, where, params, fresh=cursor is None or jump is not None,
                         collection_id=collection_id)
    out = {
        "results": page,
        "next_cursor": next_cursor,
        "has_more": has_more,
        "total": counted.total,
        "total_is_exact": counted.exact,
        "count_budget_ms": int(COUNT_BUDGET_S * 1000),
        "used_full_text_index": used_fts,
        "page_size": limit,
        "sort": "newest",
    }
    if jump:
        # The matches published after the day jumped to: the ones the list
        # starts below. Counted under the same budget, and said the same way.
        newer_where = f"{where} AND documents.pub_sort > ?" if where else " WHERE documents.pub_sort > ?"
        newer = count_where(conn, newer_where, [*params, jump], budget_s=COUNT_BUDGET_S)
        out.update(start_date=jump, newer_count=newer.total, newer_count_is_exact=newer.exact)
    return out


def _search_by_similarity(
    conn: sqlite3.Connection,
    *,
    query: str | None,
    sources: list[str] | None,
    authors: list[str] | None,
    categories: list[str] | None,
    date_from: str | None,
    date_to: str | None,
    cursor: str | None,
    limit: int,
    query_vector: Optional[bytes],
    model: Optional[str],
    collection_id: Optional[int] = None,
) -> dict:
    """The collection, ranked by distance, within the structured filters.

    **The free-text phrase is the ranking query and not a filter here** — the one
    thing that separates this from the newest sort, and what lets a
    plain-English query work. Sources, authors, categories and dates still apply exactly as
    they do everywhere else; the phrase does not.

    Why: the text filter is an ``AND`` over every word typed, so a plain-English
    query shares no wording with any title and matches nothing, leaving the sort
    with nothing to re-order. Measured on the real 15,707-paper corpus,
    **eleven of twenty natural queries returned an empty page** while the same
    vectors, unfiltered, found a relevant paper for almost all of them. The
    control says "Closest to", and a control that says that and then answers
    from a keyword slice is not doing what its label promises.

    The invariant that holds is about the *structured* filters: switching sort
    never changes which sources, authors, categories or dates are in scope. It is
    kept by construction — the scope is ``_build_where`` with ``query=None``, the
    same clause the other sort uses minus the phrase — and everything after is a
    permutation of it plus an append of whatever the ranking did not cover.
    """
    if not query_vector or not model:
        # A similarity sort with nothing to be similar to. Rather than silently
        # falling back to newest -- which would leave a user looking at a list
        # labelled by a sort it is not in -- the response says the ranking did
        # not happen and carries the filtered set in the default order.
        page = search(
            conn, query=query, sources=sources, authors=authors,
            categories=categories, date_from=date_from, date_to=date_to,
            cursor=cursor, limit=limit, collection_id=collection_id,
        )
        page["sort"] = "newest"
        page["similarity_unavailable"] = (
            "Ranking by meaning needs a search phrase and an embedding model. "
            "Showing the newest first."
        )
        return page

    # ``query=None`` is the whole of R1. Everything else the user set still
    # narrows the corpus; the phrase they typed only orders what is left.
    where, params, _ = _build_where(
        conn, query=None, sources=sources, authors=authors,
        categories=categories, date_from=date_from, date_to=date_to,
        collection_id=collection_id,
    )
    offset = _offset_from(cursor)
    ranking = _ranking_for(conn, where, params, model, query_vector, fresh=offset == 0,
                           collection_id=collection_id)

    window = list(ranking.ids[offset : offset + limit])
    rows = _rows_in_order(conn, window)
    position = {doc_id: offset + k for k, doc_id in enumerate(window)}
    for row in rows:
        at = position[row["id"]]
        row["distance"] = ranking.distances[at] if at < ranking.ranked else None

    total = len(ranking.ids)
    has_more = offset + limit < total
    return {
        "results": rows,
        "next_cursor": str(offset + len(window)) if has_more else None,
        "has_more": has_more,
        # Every paper in scope is in the ranking, ranked or appended, so its
        # length is the count, and an exact one.
        "total": total,
        "total_is_exact": True,
        "count_budget_ms": int(COUNT_BUDGET_S * 1000),
        # False, always, and not an oversight: this sort does not run the phrase
        # through FTS at all. Reporting True because an index exists would tell
        # a caller the text index shaped this result set when it did not.
        "used_full_text_index": False,
        "page_size": limit,
        "sort": "similarity",
        "ranked_count": ranking.ranked,
        # Reported so the interface can say "312 of 400 ranked; 88 not yet
        # embedded" rather than presenting a partial ranking as a whole one.
        "unranked_count": total - ranking.ranked,
        "model": model,
    }


@dataclass(frozen=True)
class _Ranking:
    """One search's whole order: the ranked papers closest first, then the rest.

    ``ids[:ranked]`` are ranked, with ``distances`` beside them; the ids after
    those have no vector for the model and are in the newest order.
    """

    ids: array
    distances: array
    ranked: int


def _ranking_for(conn: sqlite3.Connection, where: str, params: list[Any], model: str,
                 vector: bytes, *, fresh: bool, collection_id: Optional[int] = None) -> _Ranking:
    """Rank every paper in scope; a first page ranks afresh, its later pages reuse it."""
    file = _db_file(conn)
    key = None
    if file:
        embedded = tuple(conn.execute(
            "SELECT COUNT(*), IFNULL(MAX(embedded_at), '') FROM document_embeddings WHERE model = ?",
            (model,),
        ).fetchone())
        key = (file, model, hashlib.sha256(vector).hexdigest(), where, tuple(params),
               _documents_fingerprint(conn, collection_id), embedded)
    if not fresh:
        hit = _cached(_RANKINGS, key)
        if hit is not None:
            return hit

    ranked = vector_index.rank_all(conn, model, vector, documents_where=where, params=params)
    ids = array("q", (doc_id for doc_id, _ in ranked))
    distances = array("d", (distance for _, distance in ranked))
    in_scope = count_where(conn, where, params)
    if in_scope.total > len(ranked):
        # Unembedded ids keep their default-order position relative to each
        # other and go last as a block. A paper without a vector has not been
        # judged distant -- it has not been judged -- and the response
        # distinguishes the two by carrying ``distance: None`` rather than a
        # large number. Read only when something is missing: the query costs a
        # look-up per paper in scope even when it finds none.
        dims = len(vector) // 4
        cond = f"{where} AND" if where else " WHERE"
        ids.extend(int(row[0]) for row in conn.execute(
            f"SELECT documents.id FROM documents{cond} NOT EXISTS ("
            "SELECT 1 FROM document_embeddings de WHERE de.document_id = documents.id "
            "AND de.model = ? AND de.dims = ? AND length(de.vector) = ?) "
            f"ORDER BY {_ORDER_BY}",
            (*params, model, dims, dims * 4),
        ))
    made = _Ranking(ids=ids, distances=distances, ranked=len(ranked))
    _remember(_RANKINGS, key, made, _RANKINGS_MAX)
    return made


def _offset_from(cursor: str | None) -> int:
    """A similarity cursor is a decimal offset. Anything else starts from zero.

    Deliberately forgiving rather than raising: a user who switches sort with a
    keyset cursor in hand should get the first page of the new ranking, not a
    400. The newest sort's cursor still raises on a malformed value, because
    there a bad cursor means a page silently skipped.
    """
    if not cursor:
        return 0
    try:
        return max(0, int(cursor))
    except (TypeError, ValueError):
        return 0


def _rows_in_order(conn: sqlite3.Connection, ids: list[int]) -> list[dict]:
    """Fetch *ids* and return them in the order given, not the order SQLite likes."""
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    rows = {
        int(row["id"]): dict(row)
        for row in conn.execute(
            f"SELECT documents.* FROM documents WHERE documents.id IN ({placeholders})",
            ids,
        )
    }
    return [rows[doc_id] for doc_id in ids if doc_id in rows]


def similar_to(
    conn: sqlite3.Connection, document_id: int, model: str, k: int = 10
) -> dict:
    """The *k* nearest neighbours of one document. Self excluded.

    No embedding call: the document's own vector is already stored, so
    "more like this" costs one index query and nothing at the provider.

    Returns ``{"document_id", "model", "neighbours", "reason"}``. ``reason`` is
    a sentence when the list is empty and ``None`` when it is not — an empty
    neighbour list has three quite different causes (this paper is not embedded,
    nothing else is, the extension will not load) and a bare ``[]`` would say
    none of them.
    """
    k = max(1, int(k))
    row = conn.execute(
        "SELECT vector FROM document_embeddings WHERE document_id = ? AND model = ?",
        (document_id, model),
    ).fetchone()
    if row is None:
        return {
            "document_id": document_id,
            "model": model,
            "neighbours": [],
            "reason": (
                "This paper has no vector for the current model, so resmon cannot say "
                "what it is like. Run the backfill in Settings to include it."
            ),
        }

    # k + 1 because the document is its own nearest neighbour at distance 0 and
    # is dropped below. Asking for k and then removing one would quietly return
    # k-1 every time.
    ranked = vector_index.nearest(conn, model, row["vector"], k=k + 1)
    neighbours = [(doc_id, distance) for doc_id, distance in ranked if doc_id != document_id][:k]
    if not neighbours:
        state = vector_index.extension_status(conn)
        return {
            "document_id": document_id,
            "model": model,
            "neighbours": [],
            "reason": (
                state["reason"]
                or "Nothing else in the corpus is embedded with this model yet."
            ),
        }

    rows = _rows_in_order(conn, [doc_id for doc_id, _ in neighbours])
    by_id = {row["id"]: row for row in rows}
    return {
        "document_id": document_id,
        "model": model,
        "neighbours": [
            {
                **by_id[doc_id],
                "distance": distance,
                # Named on every neighbour because "the same paper from another
                # source" and "a different paper on the same subject" look
                # identical in a list of titles, and the source is what tells
                # them apart.
                "source_repository": by_id[doc_id]["source_repository"],
            }
            for doc_id, distance in neighbours
            if doc_id in by_id
        ],
        "reason": None,
    }


def facets(
    conn: sqlite3.Connection,
    *,
    query: str | None = None,
    sources: list[str] | None = None,
    authors: list[str] | None = None,
    categories: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    collection_id: Optional[int] = None,
) -> dict:
    """Available filter values and their counts, for the current filter set.

    Counts reflect everything *except* the facet being counted, so unticking a
    source does not make the other sources' numbers appear to change for no
    reason.
    """
    def _counts(column_sql: str, join: str, exclude: str,
                standalone: str | None = None, column: str = "documents.id") -> list[dict]:
        where, params, _ = _build_where(
            conn, query=query,
            sources=None if exclude == "sources" else sources,
            authors=None if exclude == "authors" else authors,
            categories=None if exclude == "categories" else categories,
            date_from=date_from, date_to=date_to, collection_id=collection_id,
        )

        # With no filters at all, counting straight out of the facet table beats
        # joining to documents by a wide margin -- 12 ms against 542 ms on
        # 100,000 papers, because (document_id, author) is the primary key so
        # the join adds nothing but work. The join is only needed once a filter
        # has to be applied to the documents themselves. A whole collection is
        # still no filter on the documents: the facet table's rows are kept to
        # its papers by the same lookup, with no join.
        if (not where or _collection_only(where)) and standalone:
            within = f" WHERE {member_clause(column)}" if where else ""
            rows = conn.execute(
                f"""
                SELECT value, COUNT(*) AS count FROM ({standalone}{within})
                GROUP BY value
                HAVING value IS NOT NULL AND TRIM(value) <> ''
                ORDER BY count DESC, value ASC
                LIMIT ?
                """,
                (*params, MAX_FACET_VALUES),
            ).fetchall()
            return [{"value": r["value"], "count": r["count"]} for r in rows]

        rows = conn.execute(
            f"""
            SELECT {column_sql} AS value, COUNT(DISTINCT documents.id) AS count
            FROM documents {join}
            {where}
            GROUP BY value
            HAVING value IS NOT NULL AND TRIM(value) <> ''
            ORDER BY count DESC, value ASC
            LIMIT ?
            """,
            (*params, MAX_FACET_VALUES),
        ).fetchall()
        return [{"value": r["value"], "count": r["count"]} for r in rows]

    # A facet table's rows are kept to the collection by their ``document_id``.
    return {
        "sources": _counts(
            "documents.source_repository", "", "sources",
            standalone="SELECT source_repository AS value FROM documents",
        ),
        "authors": _counts(
            "da.author",
            "JOIN document_authors da ON da.document_id = documents.id",
            "authors",
            standalone="SELECT author AS value FROM document_authors",
            column="document_authors.document_id",
        ),
        "categories": _counts(
            "dc.category",
            "JOIN document_categories dc ON dc.document_id = documents.id",
            "categories",
            standalone="SELECT category AS value FROM document_categories",
            column="document_categories.document_id",
        ),
        "max_values": MAX_FACET_VALUES,
    }


def matching_ids(
    conn: sqlite3.Connection,
    *,
    query: str | None = None,
    sources: list[str] | None = None,
    authors: list[str] | None = None,
    categories: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: Optional[int] = None,
    collection_id: Optional[int] = None,
) -> list[int]:
    """Every document id matching the filters, newest first; *limit* stops it early."""
    where, params, _ = _build_where(
        conn, query=query, sources=sources, authors=authors,
        categories=categories, date_from=date_from, date_to=date_to,
        collection_id=collection_id,
    )
    sql = f"SELECT documents.id FROM documents {where} ORDER BY {_ORDER_BY}"
    if limit is not None:
        sql += " LIMIT ?"
        params = [*params, int(limit)]
    return [r["id"] for r in conn.execute(sql, params).fetchall()]


def count_matching(
    conn: sqlite3.Connection,
    *,
    query: str | None = None,
    sources: list[str] | None = None,
    authors: list[str] | None = None,
    categories: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    collection_id: Optional[int] = None,
) -> int:
    """How many documents match the filters, counted to the end (no time budget).

    For an export, which says how many papers its file holds before sending the
    first of them: the count and the papers are read in one transaction, so the
    number is the file's.
    """
    where, params, _ = _build_where(
        conn, query=query, sources=sources, authors=authors,
        categories=categories, date_from=date_from, date_to=date_to,
        collection_id=collection_id,
    )
    return count_where(conn, where, params).total


def iter_matching(
    conn: sqlite3.Connection,
    *,
    query: str | None = None,
    sources: list[str] | None = None,
    authors: list[str] | None = None,
    categories: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    batch: int = 500,
    collection_id: Optional[int] = None,
) -> Iterator[dict]:
    """Every matching document, newest first, read *batch* rows at a time.

    One query, walked with a cursor, so an export of the whole collection holds
    one batch of papers at a time rather than all of them.
    """
    where, params, _ = _build_where(
        conn, query=query, sources=sources, authors=authors,
        categories=categories, date_from=date_from, date_to=date_to,
        collection_id=collection_id,
    )
    cursor = conn.execute(f"SELECT documents.* FROM documents {where} ORDER BY {_ORDER_BY}", params)
    try:
        while True:
            rows = cursor.fetchmany(batch)
            if not rows:
                return
            for row in rows:
                yield dict(row)
    finally:
        try:
            cursor.close()
        except sqlite3.ProgrammingError:
            pass  # the export's connection closed first, when its reader went away
