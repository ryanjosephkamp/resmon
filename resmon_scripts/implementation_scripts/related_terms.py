"""Distinctive wording in the collection's papers that use a literal term.

The baseline counts titles twice, like the map's region names. A lookup
reuses those counts, updating only papers whose text or membership changed;
there is no embedding fit, saved analysis, or outside request.
"""
from __future__ import annotations

import re
import sqlite3
import threading
from array import array
from collections import Counter, OrderedDict
from dataclasses import dataclass, field

import numpy as np

from .collection_map import _document_terms, terms
from .paper_collections import member_clause


@dataclass
class _Corpus:
    texts: dict[int, tuple[str, str]] = field(default_factory=dict)
    counts: Counter[str] = field(default_factory=Counter)
    vocabulary: dict[str, int] = field(default_factory=dict)
    vectors: dict[int, array] = field(default_factory=dict)


# Each token is a four-byte vocabulary index, never a dictionary per paper.
# Keeping two collections limits what a window changing its collection holds.
_CORPORA: OrderedDict[tuple[str, int], _Corpus] = OrderedDict()
_LOCK = threading.Lock()


def forget(conn: sqlite3.Connection, collection_id: int | None = None) -> None:
    """Release cached paper text when a collection or the corpus is erased."""
    file = next((str(row[2]) for row in conn.execute('PRAGMA database_list') if row[1] == 'main'), '')
    with _LOCK:
        for key in list(_CORPORA):
            if key[0] == file and (collection_id is None or key[1] == collection_id):
                del _CORPORA[key]


def suggest(conn: sqlite3.Connection, term: str, collection_id: int) -> dict:
    """Up to six terms, weighted by their share here and rarity in the corpus.

    The matching papers and the rest of the collection are the two classes:
    share * log(1 + mean class length / collection frequency), the map's
    class-based TF-IDF arithmetic. Only titles and abstracts contribute.

    An empty term looks nothing up but prepares the collection's counts, so
    the first lookup a person waits on reuses them; a terms field asks for it
    as it gets the keyboard.
    """
    term = ' '.join(term.lower().split())
    excluded = {term, *terms(term)}
    needle = term.split()[0] if term else ''
    pattern = re.compile(r'(?<!\w)' + re.escape(term).replace(r'\ ', r'\s+') + r'(?!\w)')
    file = next((str(row[2]) for row in conn.execute('PRAGMA database_list') if row[1] == 'main'), '')
    with _LOCK:
        key = (file, collection_id)
        corpus = _CORPORA.get(key, _Corpus()) if file else _Corpus()
        current = {int(row[0]): (row[1] or '', row[2] or '') for row in conn.execute(
            f'SELECT d.id, d.title, d.abstract FROM documents d WHERE {member_clause("d.id")}', (collection_id,))}
        matches: list[int] = []
        for doc_id, (title, abstract) in (current.items() if term else ()):
            title_lower, abstract_lower = title.lower(), abstract.lower()
            if ((needle in title_lower and pattern.search(title_lower))
                    or (needle in abstract_lower and pattern.search(abstract_lower))):
                matches.append(doc_id)
        if term and not matches:
            return {"term": term, "matched_papers": 0, "suggestions": []}
        names = list(corpus.vocabulary)
        for doc_id, old in corpus.texts.items():
            if current.get(doc_id) != old:
                corpus.counts.subtract(names[i] for i in corpus.vectors.pop(doc_id))
        for doc_id, text in current.items():
            if corpus.texts.get(doc_id) != text:
                words = _document_terms(*text)
                corpus.counts.update(words)
                corpus.vectors[doc_id] = array('I', (
                    corpus.vocabulary.setdefault(word, len(corpus.vocabulary)) for word in words))
        corpus.texts = current
        corpus.counts = +corpus.counts
        if file:
            _CORPORA[key] = corpus
            _CORPORA.move_to_end(key)
            while len(_CORPORA) > 2:
                _CORPORA.popitem(last=False)
        if not term:
            return {"term": term, "matched_papers": 0, "suggestions": []}
        names = list(corpus.vocabulary)
        baseline = np.fromiter((corpus.counts[word] for word in names), dtype=np.float64)
        # Aggregating packed tokens keeps a common term from tokenizing half
        # the collection again. The all-matching class is already the baseline.
        selected = baseline if len(matches) == len(current) else np.bincount(np.concatenate([
            np.frombuffer(corpus.vectors[doc_id], dtype=np.uint32) for doc_id in matches]), minlength=len(names))
        score = selected / max(1, float(selected.sum())) * np.log1p(float(baseline.sum()) / 2 / np.maximum(1, baseline))
        ranked = sorted((i for i in np.flatnonzero(score) if names[i] not in excluded),
                        key=lambda i: (-float(score[i]), names[i]))[:6]
        return {"term": term, "matched_papers": len(matches), "suggestions": [names[i] for i in ranked]}
