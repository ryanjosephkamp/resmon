"""Corpus-wide search and faceting.

Until now the only way to look at papers was one execution at a time. This
module searches everything resmon has ever collected, filtered by author,
source, subject category, publication date, and free text across titles and
abstracts.

Scale
-----
The design target is a corpus of ~100,000 papers, and three decisions follow
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
pages must be walked in order rather than jumped to, which suits a "load more"
list and is why the interface is built that way.

Result counts are capped (:data:`COUNT_CAP`). Counting an unbounded match set
is the one remaining full scan, and "10,000+" is as useful to a person as an
exact five-digit number.

Sorting by meaning (1.9)
------------------------
``sort="similarity"`` re-orders **the same filtered set** that ``sort="newest"``
returns. It is a sort, not a search: the filters choose the papers and the
ranking chooses their order, so the two sorts answer with the same ``total`` and
the same set of ids. Anything else would make a sort control silently change what
a user is looking at.

Two consequences follow, and both are deliberate.

**Papers with no vector are appended, not dropped.** A corpus mid-backfill, or
one holding papers whose sources' terms permitted no abstract, would otherwise
lose rows the moment somebody changed the sort. They come last, in the newest
order, and the response counts them so the interface can say how many are
unranked.

**Pagination becomes an offset.** Keyset pagination needs a sort key stored in an
index; a ranking is computed per query and has none. The cursor in this mode is
the number of rows already returned. That is the thing keyset pagination exists
to avoid, and it is affordable here for a reason the newest sort cannot rely on:
the ranking is bounded by :data:`COUNT_CAP`, already materialised in memory, and
walking to row 9,000 of a Python list costs nothing.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from . import vector_index

# Above this, the total is reported as "N+" rather than counted exactly. The
# exact number of matches beyond ten thousand changes no decision a user makes,
# and counting it is the only unbounded scan left in the query.
COUNT_CAP = 10_000

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


def _build_where(
    conn: sqlite3.Connection,
    *,
    query: str | None,
    sources: list[str] | None,
    authors: list[str] | None,
    categories: list[str] | None,
    date_from: str | None,
    date_to: str | None,
) -> tuple[str, list[Any], bool]:
    """Return ``(where_sql, params, used_fts)`` for the given filters."""
    clauses: list[str] = []
    params: list[Any] = []
    used_fts = False

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
) -> dict:
    """Search the corpus. Returns one page plus a cursor for the next.

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
    """
    limit = max(1, min(int(limit), MAX_PAGE_SIZE))
    if sort == "similarity":
        return _search_by_similarity(
            conn, query=query, sources=sources, authors=authors,
            categories=categories, date_from=date_from, date_to=date_to,
            cursor=cursor, limit=limit, query_vector=query_vector, model=model,
        )
    where, params, used_fts = _build_where(
        conn, query=query, sources=sources, authors=authors,
        categories=categories, date_from=date_from, date_to=date_to,
    )

    page_where, page_params = where, list(params)
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

    # Bounded count: stop at the cap instead of counting an unbounded match set.
    counted = conn.execute(
        f"SELECT COUNT(*) FROM (SELECT documents.id FROM documents {where} LIMIT ?)",
        (*params, COUNT_CAP + 1),
    ).fetchone()[0]

    return {
        "results": page,
        "next_cursor": next_cursor,
        "has_more": has_more,
        "total": min(counted, COUNT_CAP),
        "total_is_capped": counted > COUNT_CAP,
        "count_cap": COUNT_CAP,
        "used_full_text_index": used_fts,
        "page_size": limit,
        "sort": "newest",
    }


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
) -> dict:
    """The same filtered set, re-ordered by distance. See the module docstring.

    The invariant this function exists to keep (P4) is that ``total`` and the id
    set are **identical** to the newest sort for the same filters. It is kept by
    construction rather than by care: the candidate set is
    :func:`matching_ids`, which is the same ``_build_where`` the other sort uses,
    and everything after that is a permutation of it plus an append of whatever
    the ranking did not cover.
    """
    if not query_vector or not model:
        # A similarity sort with nothing to be similar to. Rather than silently
        # falling back to newest -- which would leave a user looking at a list
        # labelled by a sort it is not in -- the response says the ranking did
        # not happen and carries the filtered set in the default order.
        page = search(
            conn, query=query, sources=sources, authors=authors,
            categories=categories, date_from=date_from, date_to=date_to,
            cursor=cursor, limit=limit,
        )
        page["sort"] = "newest"
        page["similarity_unavailable"] = (
            "Ranking by meaning needs a search phrase and an embedding model. "
            "Showing the newest first."
        )
        return page

    # The candidate set, in the default order and bounded by the same cap the
    # newest sort counts to. This is the whole of the P4 guarantee: everything
    # below permutes this list.
    candidates = matching_ids(
        conn, query=query, sources=sources, authors=authors,
        categories=categories, date_from=date_from, date_to=date_to,
        limit=COUNT_CAP,
    )
    total_is_capped = len(candidates) >= COUNT_CAP

    ranked = vector_index.nearest(
        conn, model, query_vector, k=max(1, len(candidates)), within_ids=candidates
    )
    distances = {doc_id: distance for doc_id, distance in ranked}

    # Unembedded ids keep their default-order position relative to each other and
    # go last as a block. A paper without a vector has not been judged distant --
    # it has not been judged -- and the response distinguishes the two by carrying
    # ``distance: None`` rather than a large number.
    ordered_ids = [doc_id for doc_id, _ in ranked]
    unranked_ids = [doc_id for doc_id in candidates if doc_id not in distances]
    ordered_ids.extend(unranked_ids)

    offset = _offset_from(cursor)
    window = ordered_ids[offset : offset + limit]
    rows = _rows_in_order(conn, window)
    for row in rows:
        row["distance"] = distances.get(row["id"])

    has_more = offset + limit < len(ordered_ids)
    return {
        "results": rows,
        "next_cursor": str(offset + len(window)) if has_more else None,
        "has_more": has_more,
        "total": min(len(ordered_ids), COUNT_CAP),
        "total_is_capped": total_is_capped,
        "count_cap": COUNT_CAP,
        # The filters ran through the same ``_build_where``; whether FTS served
        # them is a property of the filter, not of the sort.
        "used_full_text_index": _fts_available(conn) and bool(query and query.strip()),
        "page_size": limit,
        "sort": "similarity",
        "ranked_count": len(ranked),
        # Reported so the interface can say "312 of 400 ranked; 88 not yet
        # embedded" rather than presenting a partial ranking as a whole one.
        "unranked_count": len(unranked_ids),
        "model": model,
    }


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
) -> dict:
    """Available filter values and their counts, for the current filter set.

    Counts reflect everything *except* the facet being counted, so unticking a
    source does not make the other sources' numbers appear to change for no
    reason.
    """
    def _counts(column_sql: str, join: str, exclude: str,
                standalone: str | None = None) -> list[dict]:
        where, params, _ = _build_where(
            conn, query=query,
            sources=None if exclude == "sources" else sources,
            authors=None if exclude == "authors" else authors,
            categories=None if exclude == "categories" else categories,
            date_from=date_from, date_to=date_to,
        )

        # With no filters at all, counting straight out of the facet table beats
        # joining to documents by a wide margin -- 12 ms against 542 ms on
        # 100,000 papers, because (document_id, author) is the primary key so
        # the join adds nothing but work. The join is only needed once a filter
        # has to be applied to the documents themselves.
        if not where and standalone:
            rows = conn.execute(
                f"""
                SELECT value, COUNT(*) AS count FROM ({standalone})
                GROUP BY value
                HAVING value IS NOT NULL AND TRIM(value) <> ''
                ORDER BY count DESC, value ASC
                LIMIT ?
                """,
                (MAX_FACET_VALUES,),
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
        ),
        "categories": _counts(
            "dc.category",
            "JOIN document_categories dc ON dc.document_id = documents.id",
            "categories",
            standalone="SELECT category AS value FROM document_categories",
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
    limit: int = COUNT_CAP,
) -> list[int]:
    """Every document id matching the filters, for exporting a filtered view.

    Bounded by *limit* so an accidental unfiltered export cannot try to
    serialize the entire corpus into one BibTeX file.
    """
    where, params, _ = _build_where(
        conn, query=query, sources=sources, authors=authors,
        categories=categories, date_from=date_from, date_to=date_to,
    )
    rows = conn.execute(
        f"""
        SELECT documents.id FROM documents {where}
        ORDER BY {_ORDER_BY}
        LIMIT ?
        """,
        (*params, int(limit)),
    ).fetchall()
    return [r["id"] for r in rows]
