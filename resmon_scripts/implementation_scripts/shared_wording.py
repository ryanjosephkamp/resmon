# resmon_scripts/implementation_scripts/shared_wording.py
"""Papers whose abstracts share wording word for word, and what that shows.

What it measures
----------------
Two texts share a passage when the same words appear in both, in the same
order, with nothing between them. resmon finds such passages between the
abstracts it holds, and between a file in the Library and those abstracts and
the other Library files, and reports three numbers for each pair, each defined
in one sentence the interface shows beside it (:data:`DEFINITIONS`):

- the **longest passage shared word for word**, in words;
- the **share of the shorter text's 8-word phrases** that also appear in the
  other text;
- the **authors in common**.

It never says why two texts share wording, and it never uses a model. Shared
wording has innocent causes -- a template, a quoted definition, a dataset's
stock description, a correction notice, two records of the same paper -- and
it cannot see paraphrase, translation, figures or data at all. The pair view
says so (:data:`LIMITS`), and a person judges.

How a text is read
------------------
HTML character references are decoded (``&amp;`` is ``&``), markup tags some
sources leave in an abstract (JATS ``<jats:p>``, ``<p>``) are dropped, and the
text is put in Unicode NFKC form, which folds ligatures, full-width forms and
superscripts. A **word** is a run of letters, digits, and the combining marks
that belong to them (without the marks, a Hindi word falls apart at every vowel
sign), compared in lowercase (``casefold``). A leading "Abstract" label, which
some sources prepend, is not a word of the abstract. A **phrase** is every run
of :data:`PHRASE_WORDS` consecutive words; a 190-word abstract has 183.

A phrase is identified by a hash that is the same in every process and on every
machine -- never Python's ``hash``, which is salted per process. Each word is
the first 8 bytes of its BLAKE2b digest, a phrase is the polynomial
``sum(word[i] * M**(7-i))`` modulo 2**64 run through the SplitMix64 finalizer,
and the arithmetic is vectorized, which is what makes 100,000 abstracts take
seconds. A hash collision can only propose a pair; every passage reported is
checked word by word against both texts.

Why 8 words
-----------
Measured on the owner's collection on October 30, 2026: 16,061 papers, of which
12,294 have an abstract of 40 words or more. Short phrases meet by chance.
Pairs by different authors that share at least one phrase found in no more than
three works numbered 15,746 at 5 words, 4,610 at 6, 499 at 8, 87 at 10, and 29
at 12, and at 8 words nearly all of the 499 are one stock run of 8 to 14 words:
an acronym's expansion, a list of metrics, a license line. Longer phrases cost
the share its sensitivity: one changed word breaks every phrase that crosses
it, so a word changed every 15 words leaves 7 of each 15 phrases at length 8
and 3 at length 12. The scan also costs less at 8 than at 5 (3.3 s and 262 MB
against 7.2 s and 610 MB on that collection, before the reading was made
faster). Eight is the length at which a shared phrase between unrelated
abstracts is uncommon and an edited copy still keeps most of its phrases.

Common phrasing is not evidence, and is counted in works
--------------------------------------------------------
A phrase found in the abstracts of more than :data:`COMMON_WORKS` works is
common: a stock sentence of a field, or the template a family of records is
written from. A common phrase cannot make two papers a pair. It still counts in
the numbers shown, because those are defined over the texts as they are, and
the pair view says how many of the shared phrases were common.

It counts **works**, not records: records joined by a shared DOI, a
``document_links`` link, equal titles, or one arXiv id are one work. On the
owner's collection, 43,321 of the 46,301 phrases found in more than one
abstract were in one work held from several sources; counting records would
have made a paper held from four sources look like common phrasing in its own
right, and hidden its wording in another paper.

Every phrase in the abstracts of three or more works was a stock phrase or a
template (the area under the receiver operating characteristic curve, a code
availability sentence, the PRISMA name, a journal's summary headings, a dataset
family's description), and the templates reached 49 words. At "more than five"
the 49-word dataset template still made six pairs with no author in common;
at "more than three" it is common and makes none, while a text and two copies
of it (three works) still count.

Which pairs are shown, and which are set aside
----------------------------------------------
A pair is shown when, outside common phrasing, it shares a passage of at least
:data:`SHOWN_LONGEST` words, or at least :data:`SHOWN_SHARE` of the shorter
text's phrases (and no fewer than a 20-word passage has, 13). Shown pairs fall
in one of three groups by authors: **no author in common** (both records list
authors, and no two match), **text reuse by the same authors** (at least one
matches), and **authors not listed** (one record lists none, so resmon cannot
say). Authors match by ORCID where both records carry one, and otherwise by
surname and first initial, with accents folded and the "Last, First" and PubMed
"Last FM" orders read as such. Jane Smith and John Smith are therefore one
author to this rule, and a family name written first without a comma ("Wang
Wei") is read as a given name.

Two kinds of pair are set aside, each recorded with its reason rather than
dropped: **the same work** (a shared DOI, a ``document_links`` link, titles
equal word for word once entities are decoded, or two versions of one arXiv
id), and **a notice** (one record's title says it is an erratum, a
corrigendum, a correction, a retraction notice, or an expression of concern).
An abstract under :data:`MIN_WORDS` words is not compared, and the scan counts
those papers rather than leaving them out silently.

The thresholds are claims
-------------------------
Each was set from the owner's collection and from authored pairs, and graded
by reading both texts of every pair concerned.

*Where chance ends.* With commonness counted as above, the longest run of
uncommon wording between two abstracts with no author in common was 17 words (a
particle-physics stock phrase); 20 is the first round number above it. The
highest share of uncommon phrases between such abstracts was 11.4%; 20% is
nearly twice that. An abstract under 40 words is not compared, because a
20-word passage would be half of it: 689 of the collection's abstracts are
shorter, 533 of them from PubMed, where a structured abstract can arrive as its
first few words.

*Precision on real data.* The shipped rule shows 414 pairs on the owner's
collection: 396 set aside as the same work (317 by title, 77 by DOI, 2 as
versions of one arXiv paper), 1 set aside as a notice, 17 with an author in
common, and none with no author in common. All 17 with an author in common
were read and are reuse by those authors (a preprint and its published version
under a changed title, a translation, a series' shared introduction, a funding
sentence). Of 30 same-work pairs sampled, 21 were one work held twice and 9
were dataset records sharing a template title and text: set aside by the title
rule, rightly, though they are not one work, which is why the screen states the
reason ("their titles are the same word for word") and never "the same work" as
a finding. Because no pair reached the no-author-in-common group, every pair a
looser rule would have put there was graded instead: all 29 with a shared run
of 12 words or more were stock phrasing or templates, and none was one text
reused in another.

*Recall on authored pairs.* Passages of known lengths, embedded in abstracts by
different authors among 2,000 unrelated ones, 20 trials each: a verbatim
passage of 20 words or more is found every time and one of 19 never;
punctuation and case do not matter; five reordered sentences are found whether
the sentences have 12 or 24 words (by their share); one changed word in the
middle of a 40-word passage leaves a 20-word run and is found, in a 30-word
passage it is not; a word changed every 15 words across half of a 200-word
abstract is found (by its share), every 12 words is not. The smallest shared
passage the method reliably finds is 20 consecutive words.

*What it costs* (``python -m perf wording``, this machine, seeded corpora of
meaningless text). A full scan of 16,061 papers: 1.2 s, peak 141 MB for the
whole process; of 100,000: 8.2 s, 416 MB. New papers after a run: 200 against
16,061 in 1.2 s and 99 MB, against 100,000 in 7.5 s and 202 MB, because every
abstract is still read once to count the new papers' phrases. On the owner's
collection a full scan takes 1.6 s and 133 MB.

Stored, with the method's version
---------------------------------
A scan's answer is kept in a file beside the database, ``<db>-wording.json``,
as the collection map keeps its fit: derived, rebuilt by scanning again, never
backed up, and deleted with the corpus because it holds author names and text
positions taken from the papers. It records :data:`METHOD_VERSION`; an answer
from another version is reported as such and not shown as current. Each paper's
text is fingerprinted, so a pair whose text changed since the scan, or whose
paper left the collection, is not shown either, and the screen counts it.

A **full scan** compares every abstract with every other through an inverted
index of phrases: no pair is ever compared unless the two share a phrase. After
a run, **new papers** are compared against the collection: only phrases that
occur in a new or changed abstract are indexed, every abstract is read once to
count them, and only pairs with a new paper are made. Pairs found earlier are
kept as they were; a phrase that has since become common still counts in them
until the next full scan.
"""

from __future__ import annotations

import functools
import hashlib
import html
import json
import logging
import os
import re
import sqlite3
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Iterator, Optional, Sequence

import numpy as np

logger = logging.getLogger(__name__)

#: Bumped whenever a change would make a stored answer differ from what a scan
#: now finds: the reading of a text, the phrase length, a threshold, a rule.
METHOD_VERSION = 1

#: Words in a phrase. See "Why 8 words".
PHRASE_WORDS = 8

#: An abstract with fewer words than this is not compared.
MIN_WORDS = 40

#: A phrase in the abstracts of more works than this is common, and not evidence.
COMMON_WORKS = 3

#: A pair is shown when its longest passage of uncommon phrasing has this many words...
SHOWN_LONGEST = 20

#: ...or when this share of the shorter text's phrases are uncommon phrases the
#: other text has too, and they are at least as many as a shown passage has.
SHOWN_SHARE = 0.2

#: The words a scan reads for each paper, at most. A record whose "abstract"
#: is a whole article would otherwise cost as much as a hundred abstracts.
MAX_WORDS = 3000

STATE_FORMAT = 1

DEFINITIONS = {
    "longest": "The longest run of consecutive words that appears in both texts, word for word.",
    "share": (
        "Of every run of 8 consecutive words in the shorter text, the share that also "
        "appears somewhere in the other text."
    ),
    "authors": (
        "Authors who appear in both records: the same ORCID where both records carry one, "
        "otherwise the same surname and first initial."
    ),
}

LIMITS = [
    "resmon compares abstracts, and files you keep in the Library. It does not have the full "
    "text of these papers, so wording shared outside the abstracts is not seen.",
    "It finds words in the same order. It cannot see a paraphrase, a translation, a figure, a "
    "table, or data.",
    "Shared wording has innocent causes: a template, a quoted definition, a dataset's stock "
    "description, a correction notice, or two records of the same work.",
    "Dates are the publication dates the sources recorded. They do not say which text was "
    "written first, or whether either was taken from the other.",
]

CATEGORIES = ("different_authors", "same_authors", "authors_unknown", "same_work", "notice")

# Categories a person reviews, and the two that are set aside with a reason.
SHOWN_CATEGORIES = ("different_authors", "same_authors", "authors_unknown")
SET_ASIDE_CATEGORIES = ("same_work", "notice")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Reading a text
# ---------------------------------------------------------------------------

# A markup tag: "<" or "</", a name that starts with a letter, attributes, ">".
# A bare "<" in "p < 0.05" has a space after it and is left alone.
_TAG = re.compile(r"</?[A-Za-z][\w:.-]*(?:\s[^<>]{0,400})?/?>")


@functools.lru_cache(maxsize=1)
def _word_pattern() -> "re.Pattern[str]":
    """Word characters (``\\w``) plus every combining mark, as one class.

    Built once, on first use, from the interpreter's own Unicode tables: about
    0.1 s, which an import should not pay. ``\\w`` includes the underscore,
    which is not part of a word here, so the text it is run over has its
    underscores turned to spaces first (:func:`_matchable`), one character for
    one, which keeps every offset.
    """
    ranges: list[tuple[int, int]] = []
    start: Optional[int] = None
    for cp in range(0x110000):
        mark = unicodedata.category(chr(cp))[0] == "M"
        if mark and start is None:
            start = cp
        elif not mark and start is not None:
            ranges.append((start, cp - 1))
            start = None
    marks = "".join(
        re.escape(chr(a)) + ("-" + re.escape(chr(b)) if b != a else "") for a, b in ranges
    )
    return re.compile(f"[\\w{marks}]+")

# ASCII has no combining marks, so its words are the built-in class alone,
# which is several times faster than the class with every mark in it; most
# abstracts are ASCII once entities are decoded.
_ASCII_WORD = re.compile(r"[^\W_]+")


def _matchable(text: str) -> tuple["re.Pattern[str]", str]:
    if text.isascii():
        return _ASCII_WORD, text
    return _word_pattern(), text.replace("_", " ")


def display_text(text: Optional[str]) -> str:
    """The text as it is compared and shown: entities decoded, tags dropped, NFKC."""
    if not text:
        return ""
    decoded = html.unescape(str(text))
    return unicodedata.normalize("NFKC", _TAG.sub(" ", decoded))


@dataclass
class Words:
    """A text's words, in order, with where each sits in :func:`display_text`."""

    text: str
    words: list[str]
    starts: list[int]
    ends: list[int]

    def __len__(self) -> int:
        return len(self.words)


def read_words(text: Optional[str], *, limit: int = MAX_WORDS) -> Words:
    shown = display_text(text)
    words: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    pattern, matchable = _matchable(shown)
    for match in pattern.finditer(matchable):
        if len(words) >= limit:
            break
        words.append(match.group().casefold())
        starts.append(match.start())
        ends.append(match.end())
    if words and words[0] == "abstract":
        del words[0], starts[0], ends[0]
    return Words(shown, words, starts, ends)


def scan_words(text: Optional[str], *, limit: int = MAX_WORDS) -> list[str]:
    """The words :func:`read_words` reads, without where they sit.

    A scan reads every abstract and needs only the words; casefolding the whole
    text at once and skipping the offsets is most of the scan's time saved at
    100,000 abstracts. ``test_shared_wording`` holds the two to the same words.
    """
    pattern, matchable = _matchable(display_text(text).casefold())
    words = pattern.findall(matchable)
    if len(words) > limit:
        del words[limit:]
    if words and words[0] == "abstract":
        del words[0]
    return words


def text_print(text: Optional[str]) -> str:
    """A fingerprint of a stored text, to notice that it changed since a scan."""
    return hashlib.blake2b((text or "").encode("utf-8"), digest_size=8).hexdigest()


# ---------------------------------------------------------------------------
# Stable phrase hashes
# ---------------------------------------------------------------------------

_MULTIPLIER = np.uint64(0x9E3779B97F4A7C15)
_MIX1 = np.uint64(0xBF58476D1CE4E5B9)
_MIX2 = np.uint64(0x94D049BB133111EB)


class WordHashes:
    """Each distinct word's 64-bit hash, computed once per scan."""

    def __init__(self) -> None:
        self._known: dict[str, int] = {}

    def __call__(self, words: Sequence[str]) -> np.ndarray:
        known = self._known
        for word in set(words).difference(known):
            known[word] = int.from_bytes(
                hashlib.blake2b(word.encode("utf-8"), digest_size=8).digest(), "little")
        return np.fromiter(map(known.__getitem__, words), dtype=np.uint64, count=len(words))


def _mix(values: np.ndarray) -> np.ndarray:
    """SplitMix64's finalizer, so every bit of a phrase hash depends on every word."""
    x = values.copy()
    x ^= x >> np.uint64(30)
    x *= _MIX1
    x ^= x >> np.uint64(27)
    x *= _MIX2
    x ^= x >> np.uint64(31)
    return x


def phrase_hashes(word_hashes: np.ndarray, phrase_words: int = PHRASE_WORDS) -> np.ndarray:
    """One hash per run of ``phrase_words`` words: ``len(words) - k + 1`` of them."""
    count = len(word_hashes) - phrase_words + 1
    if count <= 0:
        return np.empty(0, dtype=np.uint64)
    out = np.zeros(count, dtype=np.uint64)
    with np.errstate(over="ignore"):
        for j in range(phrase_words):
            out *= _MULTIPLIER
            out += word_hashes[j:j + count]
        return _mix(out)


def _batched_phrases(batch: list[np.ndarray], phrase_words: int) -> tuple[np.ndarray, np.ndarray]:
    """Phrase hashes of many texts at once, and which text each came from.

    The texts are laid end to end and hashed in one pass; a phrase that would
    cross from one text into the next is dropped. Per-text numpy calls cost
    microseconds each, and at 100,000 abstracts those add up to more than the
    hashing itself.
    """
    if not batch:
        return np.empty(0, dtype=np.uint64), np.empty(0, dtype=np.int64)
    lengths = np.array([len(w) for w in batch], dtype=np.int64)
    joined = np.concatenate(batch) if len(batch) > 1 else batch[0]
    hashes = phrase_hashes(joined, phrase_words)
    if not len(hashes):
        return hashes, np.empty(0, dtype=np.int64)
    ends = np.cumsum(lengths)
    owner = np.repeat(np.arange(len(batch), dtype=np.int64), lengths)[: len(hashes)]
    keep = np.arange(len(hashes)) + phrase_words <= ends[owner]
    return hashes[keep], owner[keep]


# ---------------------------------------------------------------------------
# What a record says about itself: the same work, a notice, its authors
# ---------------------------------------------------------------------------

_NOTICE = re.compile(
    r"^[\s\[\(]*(?:"
    r"(?P<erratum>errat(?:um|a))\b"
    r"|(?P<corrigendum>corrigend(?:um|a))\b"
    r"|(?P<correction>correction(?:\s*$|\s*[:\[]|\s+to\b|\s+notice\b))"
    r"|(?P<retraction>retraction(?:\s*$|\s*:|\s+note\b|\s+notice\b|\s+of\s*:)|notice\s+of\s+retraction\b)"
    r"|(?P<concern>(?:editorial\s+)?expression\s+of\s+concern\b)"
    r")",
    re.IGNORECASE,
)

NOTICE_WORDS = {
    "erratum": "an erratum",
    "corrigendum": "a corrigendum",
    "correction": "a correction",
    "retraction": "a retraction notice",
    "concern": "an expression of concern",
}

# "RETRACTED: <title>" is the retracted article itself, not a notice about it,
# so it is not set aside as one; but the label is not part of its title when
# two records of the same work are compared.
_RETRACTED_LABEL = re.compile(r"^[\s\[\(]*(?:retracted(?:\s+article)?)[\s\]\):]*", re.IGNORECASE)


def notice_kind(title: Optional[str]) -> Optional[str]:
    """``erratum``, ``corrigendum``, ``correction``, ``retraction``, ``concern``, or None."""
    match = _NOTICE.match(display_text(title))
    if not match:
        return None
    return next(name for name, value in match.groupdict().items() if value)


def title_words(title: Optional[str]) -> tuple[str, ...]:
    """A title as compared for "the same work": decoded, accents folded, words only."""
    shown = _RETRACTED_LABEL.sub("", display_text(title))
    folded = "".join(c for c in unicodedata.normalize("NFKD", shown) if not unicodedata.combining(c))
    pattern, matchable = _matchable(folded.casefold())
    return tuple(pattern.findall(matchable))


_ARXIV_NEW = re.compile(r"(?<![\d.])(\d{4}\.\d{4,5})(?:v\d+)?\b")
_ARXIV_OLD = re.compile(r"\b([a-z][a-z.-]+/\d{7})(?:v\d+)?\b", re.IGNORECASE)


def arxiv_id(source: Optional[str], external_id: Optional[str], doi: Optional[str],
             url: Optional[str]) -> Optional[str]:
    """The arXiv identifier without its version, from whichever field carries it."""
    candidates: list[str] = []
    if source == "arxiv" and external_id:
        candidates.append(str(external_id))
    if doi and "arxiv" in str(doi).lower():
        candidates.append(str(doi).lower().split("arxiv.", 1)[-1])
    if url and "arxiv.org/" in str(url).lower():
        candidates.append(str(url).split("arxiv.org/", 1)[-1].split("/", 1)[-1])
    for text in candidates:
        for pattern in (_ARXIV_NEW, _ARXIV_OLD):
            match = pattern.search(text)
            if match:
                return match.group(1).lower()
    return None


def normalized_doi(doi: Optional[str]) -> Optional[str]:
    if not doi:
        return None
    text = str(doi).strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/",
                   "http://dx.doi.org/", "doi:"):
        if text.startswith(prefix):
            text = text[len(prefix):]
    text = text.strip()
    return text if text.startswith("10.") and len(text) > 4 else None


_SUFFIXES = frozenset({"jr", "sr", "ii", "iii", "iv"})
_INITIALS = re.compile(r"^[A-Z]{1,3}$")


def _fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def author_key(name: Optional[str]) -> Optional[tuple[str, str]]:
    """``(surname, first initial)`` for a name as sources write it, or None.

    "Last, First" is read as such; so is PubMed's "Last FM", whose last word is
    one to three capital initials (but not when the first word is no longer
    than they are: "A SAP" is A. Sap). Otherwise the last word is the surname,
    which keeps "Ludwig van Beethoven" and "van Beethoven, L." together.
    Accents are folded ("Jørgen" and "Jorgen" agree) and hyphens dropped
    inside a surname. The initial is empty when the name is one word.
    """
    if not name:
        return None
    text = _fold(html.unescape(str(name))).replace(".", " ").strip()
    if not text:
        return None
    if "," in text:
        last, first = text.split(",", 1)
        surname_part, given = last.split(), first.split()
    else:
        parts = [p for p in text.split() if p.strip(" -").casefold() not in _SUFFIXES]
        if not parts:
            return None
        if len(parts) >= 2 and _INITIALS.match(parts[-1]) and len(parts[0]) > len(parts[-1]):
            surname_part, given = parts[:-1], [parts[-1]]
        else:
            surname_part, given = parts[-1:], parts[:-1]
    surname_part = [p for p in surname_part if p.strip(" -").casefold() not in _SUFFIXES]
    if not surname_part:
        return None
    surname = re.sub(r"[^\w]", "", surname_part[-1].casefold())
    if not surname:
        return None
    initial = ""
    for word in given:
        letters = re.sub(r"[^\w]", "", word)
        if letters:
            initial = letters[0].casefold()
            break
    return surname, initial


def normalized_orcid(orcid: Optional[str]) -> Optional[str]:
    if not orcid:
        return None
    digits = re.sub(r"[^0-9Xx]", "", str(orcid).rsplit("/", 1)[-1]).upper()
    return digits if len(digits) == 16 else None


@dataclass
class Author:
    name: str
    orcid: Optional[str]
    key: Optional[tuple[str, str]]


def authors_in_common(left: Sequence[Author], right: Sequence[Author]) -> list[dict]:
    """The authors of ``left`` who are also in ``right``, each with how they were matched.

    Two authors are one person when both carry an ORCID and the ORCIDs are
    equal. When either lacks one, they are one person when their surnames and
    first initials agree (a one-word name agrees with any initial). Two
    different ORCIDs are two people, whatever the names say.
    """
    by_orcid: dict[str, list[Author]] = {}
    by_key: dict[str, list[Author]] = {}
    for author in right:
        if author.orcid:
            by_orcid.setdefault(author.orcid, []).append(author)
        if author.key:
            by_key.setdefault(author.key[0], []).append(author)
    found: list[dict] = []
    for author in left:
        match: Optional[tuple[Author, str]] = None
        if author.orcid and author.orcid in by_orcid:
            match = (by_orcid[author.orcid][0], "orcid")
        elif author.key:
            for other in by_key.get(author.key[0], []):
                if author.orcid and other.orcid:
                    continue
                if other.key and (not author.key[1] or not other.key[1]
                                  or author.key[1] == other.key[1]):
                    match = (other, "name")
                    break
        if match is not None:
            found.append({"name": author.name, "other_name": match[0].name, "by": match[1]})
    return found


def _authors_of(conn: sqlite3.Connection, ids: Iterable[int]) -> dict[int, list[Author]]:
    wanted = sorted({int(i) for i in ids})
    out: dict[int, list[Author]] = {i: [] for i in wanted}
    for chunk in _chunks(wanted, 500):
        marks = ",".join("?" for _ in chunk)
        for row in conn.execute(
            f"SELECT document_id, author, orcid FROM document_authors "
            f"WHERE document_id IN ({marks}) ORDER BY document_id, rowid", chunk,
        ):
            name = str(row[1])
            out[int(row[0])].append(Author(name, normalized_orcid(row[2]), author_key(name)))
    # A record stored before the author table existed has its names only in
    # ``documents.authors``.
    missing = [i for i in wanted if not out[i]]
    for chunk in _chunks(missing, 500):
        marks = ",".join("?" for _ in chunk)
        for row in conn.execute(
            f"SELECT id, authors FROM documents WHERE id IN ({marks})", chunk,
        ):
            for name in [n.strip() for n in str(row[1] or "").split(",") if n.strip()]:
                out[int(row[0])].append(Author(name, None, author_key(name)))
    return out


def _chunks(items: Sequence[int], size: int) -> Iterator[list[int]]:
    for start in range(0, len(items), size):
        yield list(items[start:start + size])


# ---------------------------------------------------------------------------
# A pair's passages and numbers
# ---------------------------------------------------------------------------


@dataclass
class Text:
    """One compared text: its words, their hashes, and its phrases."""

    words: Words
    phrases: np.ndarray

    @classmethod
    def read(cls, text: Optional[str], hasher: WordHashes,
             phrase_words: int = PHRASE_WORDS, limit: int = MAX_WORDS) -> "Text":
        words = read_words(text, limit=limit)
        return cls(words, phrase_hashes(hasher(words.words), phrase_words))


def passages(left: Text, right: Text, phrase_words: int = PHRASE_WORDS) -> list[tuple[int, int, int]]:
    """Every maximal run of words both texts share, as ``(left_start, right_start, words)``.

    Built from shared phrases: consecutive phrases at a constant offset between
    the two texts are one passage. Each is then checked word by word, so a hash
    collision cannot become a reported passage. Longest first.
    """
    common = np.intersect1d(left.phrases, right.phrases, assume_unique=False)
    if not len(common):
        return []
    at_right: dict[int, list[int]] = {}
    for j in np.flatnonzero(np.isin(right.phrases, common)).tolist():
        at_right.setdefault(int(right.phrases[j]), []).append(j)
    matches: set[tuple[int, int]] = set()
    for i in np.flatnonzero(np.isin(left.phrases, common)).tolist():
        for j in at_right.get(int(left.phrases[i]), ()):
            matches.add((i, j))
    found: list[tuple[int, int, int]] = []
    for i, j in sorted(matches):
        if (i - 1, j - 1) in matches:
            continue  # inside a run that started earlier
        end = 0
        while (i + end + 1, j + end + 1) in matches:
            end += 1
        length = end + phrase_words
        # Word by word: trim to what really agrees.
        same = 0
        while (same < length and i + same < len(left.words)
               and j + same < len(right.words)
               and left.words.words[i + same] == right.words.words[j + same]):
            same += 1
        if same >= phrase_words:
            found.append((i, j, same))
    found.sort(key=lambda p: (-p[2], p[0], p[1]))
    return found


@dataclass
class Measure:
    passages: list[tuple[int, int, int]]
    longest: int
    longest_uncommon: int
    shorter: str  # "left" or "right"
    shorter_phrases: int
    shared_phrases: int
    common_phrases: int

    @property
    def share(self) -> float:
        return self.shared_phrases / self.shorter_phrases if self.shorter_phrases else 0.0

    @property
    def uncommon_phrases(self) -> int:
        return self.shared_phrases - self.common_phrases

    @property
    def uncommon_share(self) -> float:
        return self.uncommon_phrases / self.shorter_phrases if self.shorter_phrases else 0.0


def measure(left: Text, right: Text, is_common: Callable[[np.ndarray], np.ndarray],
            phrase_words: int = PHRASE_WORDS) -> Measure:
    """The pair's passages and numbers.

    ``is_common`` marks which of an array of phrase hashes are common in the
    collection. The longest passage counts every shared word; the longest of
    uncommon phrasing is the longest run made of uncommon phrases alone, which
    is what decides whether a pair is shown.
    """
    found = passages(left, right, phrase_words)
    longest = found[0][2] if found else 0
    longest_uncommon = 0
    for i, _j, length in found:
        flags = is_common(left.phrases[i:i + length - phrase_words + 1])
        run = 0
        for flag in flags.tolist():
            run = 0 if flag else run + 1
            if run:
                longest_uncommon = max(longest_uncommon, run + phrase_words - 1)
    if len(left.words) <= len(right.words):
        shorter, short, other = "left", left, right
    else:
        shorter, short, other = "right", right, left
    inside = np.isin(short.phrases, other.phrases)
    shared = int(inside.sum())
    common = int(is_common(short.phrases[inside]).sum()) if shared else 0
    return Measure(found, longest, longest_uncommon, shorter, int(len(short.phrases)), shared, common)


# ---------------------------------------------------------------------------
# The scan
# ---------------------------------------------------------------------------


@dataclass
class Settings:
    phrase_words: int = PHRASE_WORDS
    min_words: int = MIN_WORDS
    common_works: int = COMMON_WORKS
    shown_longest: int = SHOWN_LONGEST
    shown_share: float = SHOWN_SHARE

    @property
    def shown_phrases(self) -> int:
        """The phrases in a passage of ``shown_longest`` words."""
        return self.shown_longest - self.phrase_words + 1

    def shows(self, result: "Measure") -> bool:
        return (result.longest_uncommon >= self.shown_longest
                or (result.uncommon_phrases >= self.shown_phrases
                    and result.uncommon_share >= self.shown_share))

    def as_dict(self) -> dict:
        return {"phrase_words": self.phrase_words, "min_words": self.min_words,
                "common_works": self.common_works, "shown_longest": self.shown_longest,
                "shown_share": self.shown_share}


@dataclass(slots=True)
class _Paper:
    id: int
    title: Optional[str]
    doi: Optional[str]
    date: Optional[str]
    arxiv: Optional[str]
    print: str


def _rows(conn: sqlite3.Connection, ids: Optional[Sequence[int]] = None) -> Iterator[sqlite3.Row]:
    sql = ("SELECT id, title, abstract, doi, publication_date, source_repository, external_id, url "
           "FROM documents")
    if ids is None:
        yield from conn.execute(sql + " ORDER BY id")
        return
    for chunk in _chunks(sorted(ids), 500):
        marks = ",".join("?" for _ in chunk)
        yield from conn.execute(sql + f" WHERE id IN ({marks}) ORDER BY id", chunk)


def _texts_for(conn: sqlite3.Connection, ids: Iterable[int]) -> dict[int, Optional[str]]:
    out: dict[int, Optional[str]] = {}
    for row in _rows(conn, list(set(int(i) for i in ids))):
        out[int(row["id"])] = row["abstract"]
    return out


class _Cancelled(Exception):
    pass


def find_pairs(
    conn: sqlite3.Connection,
    *,
    settings: Optional[Settings] = None,
    new_ids: Optional[Iterable[int]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    on_progress: Optional[Callable[[str, int, int], None]] = None,
) -> dict:
    """Find the pairs of abstracts that share wording. Writes nothing.

    With ``new_ids``, only pairs that include one of those papers are made
    (the scan after a run). Separated from the storing so the calibration can
    grade what a rule would show without touching a database, and so a
    threshold can be measured before it is changed.

    Returns ``{"pairs", "documents", "compared", "not_compared", "cancelled",
    "settings"}``: every paper read, with its text fingerprint, and the papers
    not compared by reason (``no_abstract``, ``too_short``).
    """
    settings = settings or Settings()
    k = settings.phrase_words
    cancel = should_cancel or (lambda: False)
    progress = on_progress or (lambda stage, done, total: None)
    hasher = WordHashes()
    total = int(conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0])
    new = set(int(i) for i in new_ids) if new_ids is not None else None

    # Papers by their place in this scan; the index packs that place into the
    # low bits of a phrase key.
    papers: list[_Paper] = []
    documents: dict[int, str] = {}
    not_compared = {"no_abstract": 0, "too_short": 0}

    # With new papers only, their phrases are what the index is restricted to.
    wanted: Optional[np.ndarray] = None
    if new is not None:
        pieces = []
        for row in _rows(conn, sorted(new)):
            words = scan_words(row["abstract"])
            if len(words) >= settings.min_words:
                pieces.append(phrase_hashes(hasher(words), k))
        wanted = np.unique(np.concatenate(pieces)) if pieces else np.empty(0, np.uint64)

    # First pass: every abstract, its phrases, into (phrase, place) entries.
    bits = max(1, int(total).bit_length() + 1)
    shift = np.uint64(bits)
    low = np.uint64((1 << bits) - 1)
    chunks: list[np.ndarray] = []
    batch: list[np.ndarray] = []
    batch_places: list[int] = []

    def flush() -> None:
        if not batch:
            return
        hashes, owner = _batched_phrases(batch, k)
        places = np.asarray(batch_places, dtype=np.uint64)[owner]
        if wanted is not None:
            keep = np.isin(hashes, wanted)
            hashes, places = hashes[keep], places[keep]
        if len(hashes):
            chunks.append(np.unique((hashes & ~low) | places))
        batch.clear()
        batch_places.clear()

    for count, row in enumerate(_rows(conn)):
        if count % 2000 == 0:
            if cancel():
                return _cancelled(settings)
            progress("reading", count, total)
        doc_id = int(row["id"])
        abstract = row["abstract"]
        documents[doc_id] = text_print(abstract)
        if not abstract or not str(abstract).strip():
            not_compared["no_abstract"] += 1
            continue
        words = scan_words(abstract)
        if len(words) < settings.min_words:
            not_compared["too_short"] += 1
            continue
        papers.append(_Paper(
            doc_id, row["title"], normalized_doi(row["doi"]), row["publication_date"],
            arxiv_id(row["source_repository"], row["external_id"], row["doi"], row["url"]),
            documents[doc_id],
        ))
        if new is not None and wanted is not None and not len(wanted):
            continue
        batch.append(hasher(words))
        batch_places.append(len(papers) - 1)
        # Small batches on purpose: at 2,000 abstracts a batch the arrays each
        # one makes and drops fragmented the heap between the entries kept,
        # and the peak was 164 MB where 250 a batch reaches 73 (16,000 papers).
        if len(batch) >= 250:
            flush()
    flush()
    progress("reading", total, total)

    # Into one array, each piece freed as it is copied, so the index is never
    # held twice.
    keys = np.empty(sum(len(c) for c in chunks), dtype=np.uint64)
    at = 0
    while chunks:
        piece = chunks.pop(0)
        keys[at:at + len(piece)] = piece
        at += len(piece)
    keys.sort()
    if cancel():
        return _cancelled(settings)

    # Second: a phrase in two or more abstracts, but in no more than
    # ``common_works`` works, makes pairs of every abstract it is in, and
    # each pair counts the phrases it shares. Common phrases are kept, by their
    # packed top bits, to mark them when passages are measured.
    work = _works(conn, papers)
    pair_codes: list[np.ndarray] = []
    common_tops: list[np.ndarray] = []
    n_places = np.int64(len(papers))
    new_places = (np.array(sorted(p for p, paper in enumerate(papers) if paper.id in new), dtype=np.int64)
                  if new is not None else None)
    for start, sizes, tops in _runs(keys, shift):
        too_many = sizes > _MAX_RECORDS_PER_PHRASE
        if too_many.any():
            common_tops.append(tops[too_many])
        for size in np.unique(sizes[~too_many]).tolist():
            at = sizes == size
            pick = start[at]
            members = (keys[pick[:, None] + np.arange(size)] & low).astype(np.int64)
            in_works = np.sort(work[members], axis=1)
            distinct = 1 + (np.diff(in_works, axis=1) != 0).sum(axis=1)
            common = distinct > settings.common_works
            if common.any():
                common_tops.append(tops[at][common])
            members = members[~common]
            if not len(members):
                continue
            a_index, b_index = np.triu_indices(size, 1)
            a, b = members[:, a_index].ravel(), members[:, b_index].ravel()
            if new_places is not None:
                touch = np.isin(a, new_places) | np.isin(b, new_places)
                a, b = a[touch], b[touch]
            pair_codes.append(a * n_places + b)
    common_sorted = np.unique(np.concatenate(common_tops)) if common_tops else np.empty(0, np.uint64)
    del keys
    if cancel():
        return _cancelled(settings)

    codes = np.concatenate(pair_codes) if pair_codes else np.empty(0, dtype=np.int64)
    del pair_codes
    codes, shared = np.unique(codes, return_counts=True)
    # Either way a pair is shown, it shares at least as many uncommon phrases
    # as a shown passage has, so a pair with fewer is not measured.
    candidates = codes[shared >= settings.shown_phrases]

    def is_common(hashes: np.ndarray) -> np.ndarray:
        if not len(common_sorted) or not len(hashes):
            return np.zeros(len(hashes), dtype=bool)
        tops = hashes >> shift
        at = np.clip(np.searchsorted(common_sorted, tops), 0, len(common_sorted) - 1)
        return common_sorted[at] == tops

    # Third: read the candidates' texts again and measure each pair.
    pairs_by_place = [(int(c // n_places), int(c % n_places)) for c in candidates.tolist()]
    involved = {papers[p].id for pair in pairs_by_place for p in pair}
    texts = _texts_for(conn, involved)
    # A text read for measuring is dropped after the last pair it is in: at
    # 100,000 papers with a few thousand pairs, keeping every one cost more
    # than the index.
    uses: dict[int, int] = {}
    for pair in pairs_by_place:
        for p in pair:
            uses[papers[p].id] = uses.get(papers[p].id, 0) + 1
    read: dict[int, Text] = {}

    def text_of(doc_id: int) -> Text:
        if doc_id not in read:
            read[doc_id] = Text.read(texts.pop(doc_id, None), hasher, k)
        return read[doc_id]

    def done_with(doc_id: int) -> None:
        uses[doc_id] -= 1
        if not uses[doc_id]:
            read.pop(doc_id, None)

    measured: list[tuple[_Paper, _Paper, Measure]] = []
    for n, (pa, pb) in enumerate(pairs_by_place):
        if n % 200 == 0:
            if cancel():
                return _cancelled(settings)
            progress("measuring", n, len(pairs_by_place))
        left, right = papers[pa], papers[pb]
        result = measure(text_of(left.id), text_of(right.id), is_common, k)
        done_with(left.id)
        done_with(right.id)
        if settings.shows(result):
            measured.append((left, right, result))
    progress("measuring", len(pairs_by_place), len(pairs_by_place))

    pairs = _classify(conn, measured)
    return {
        "pairs": pairs,
        "documents": documents,
        "compared": len(papers),
        "not_compared": not_compared,
        "considered": total,
        "candidates": len(pairs_by_place),
        "cancelled": False,
        "settings": settings.as_dict(),
    }


#: A phrase in more abstracts than this is common however few works they are:
#: no paper is held from sixty-four sources, and counting the works of a run
#: that long costs more than it can change.
_MAX_RECORDS_PER_PHRASE = 64


def _works(conn: sqlite3.Connection, papers: Sequence[_Paper]) -> np.ndarray:
    """Which work each compared paper belongs to, by its place in the scan.

    Records of one work are those the set-aside rule would call the same work:
    a shared DOI, a ``document_links`` link, equal titles, or one arXiv id.
    Commonness is counted in works so that a paper resmon holds from four
    sources does not make its own abstract look like common phrasing, which
    would hide its wording in another paper.
    """
    parent = list(range(len(papers)))

    def root(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def join(x: int, y: int) -> None:
        rx, ry = root(x), root(y)
        if rx != ry:
            parent[max(rx, ry)] = min(rx, ry)

    first: dict[tuple, int] = {}
    place = {paper.id: n for n, paper in enumerate(papers)}
    for n, paper in enumerate(papers):
        # A title by the digest of its words: a dict of 100,000 word tuples
        # cost 90 MB.
        words = title_words(paper.title)
        title = hashlib.blake2b("\x1f".join(words).encode("utf-8"), digest_size=12).digest() if words else None
        for key in (("doi", paper.doi), ("arxiv", paper.arxiv), ("title", title)):
            if not key[1]:
                continue
            if key in first:
                join(first[key], n)
            else:
                first[key] = n
    for a, b in conn.execute("SELECT document_a, document_b FROM document_links"):
        if int(a) in place and int(b) in place:
            join(place[int(a)], place[int(b)])
    return np.array([root(n) for n in range(len(papers))], dtype=np.int64)


def _cancelled(settings: Settings) -> dict:
    return {"pairs": [], "documents": {}, "compared": 0, "not_compared": {}, "considered": 0,
            "candidates": 0, "cancelled": True, "settings": settings.as_dict()}


def _runs(keys: np.ndarray, shift: np.uint64, chunk: int = 1 << 18
          ) -> Iterator[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Runs of equal phrases in the sorted keys, a chunk at a time, two or more long.

    Yields ``(starts, sizes, phrase_tops)``. A chunk is extended to the end of
    the run it would cut, so no run is split between two chunks, and only runs
    of two or more are yielded: at 100,000 abstracts most of 17 million
    phrases occur once, and an array of their starts would cost more than the
    index.
    """
    n = len(keys)
    begin = 0
    while begin < n:
        end = min(begin + chunk, n)
        while end < n and (keys[end] >> shift) == (keys[end - 1] >> shift):
            end += 1
        tops = keys[begin:end] >> shift
        edges = np.flatnonzero(tops[1:] != tops[:-1]) + 1
        starts = np.concatenate(([0], edges))
        sizes = np.diff(np.concatenate((starts, [len(tops)])))
        many = sizes >= 2
        yield starts[many] + begin, sizes[many], tops[starts[many]]
        begin = end


def _links_between(conn: sqlite3.Connection, ids: Iterable[int]) -> set[tuple[int, int]]:
    wanted = sorted(set(int(i) for i in ids))
    found: set[tuple[int, int]] = set()
    for chunk in _chunks(wanted, 400):
        marks = ",".join("?" for _ in chunk)
        for row in conn.execute(
            f"SELECT document_a, document_b FROM document_links "
            f"WHERE document_a IN ({marks}) OR document_b IN ({marks})", (*chunk, *chunk),
        ):
            found.add((int(row[0]), int(row[1])))
    return found


def _classify(conn: sqlite3.Connection, measured: list) -> list[dict]:
    """Put each shown pair in its group, or set it aside with the reason."""
    ids = {p.id for left, right, _ in measured for p in (left, right)}
    authors = _authors_of(conn, ids)
    links = _links_between(conn, ids)
    out: list[dict] = []
    for left, right, result in measured:
        a, b = (left, right) if left.id < right.id else (right, left)
        reasons: list[str] = []
        if a.doi and a.doi == b.doi:
            reasons.append("shared_doi")
        if (a.id, b.id) in links:
            reasons.append("linked")
        title_a, title_b = title_words(a.title), title_words(b.title)
        if title_a and title_a == title_b:
            reasons.append("same_title")
        if a.arxiv and a.arxiv == b.arxiv:
            reasons.append("arxiv_version")
        common = authors_in_common(authors.get(a.id, []), authors.get(b.id, []))
        notices = {doc.id: notice_kind(doc.title) for doc in (a, b) if notice_kind(doc.title)}
        if reasons:
            category = "same_work"
        elif notices:
            category = "notice"
            reasons = [f"notice:{doc_id}:{kind}" for doc_id, kind in sorted(notices.items())]
        elif not authors.get(a.id) or not authors.get(b.id):
            category = "authors_unknown"
        elif common:
            category = "same_authors"
        else:
            category = "different_authors"
        flipped = left.id != a.id
        passages_ab = [[j, i, n] if flipped else [i, j, n] for i, j, n in result.passages]
        shorter = result.shorter
        if flipped:
            shorter = "right" if shorter == "left" else "left"
        out.append({
            "a": a.id, "b": b.id,
            "category": category,
            "reasons": reasons,
            "longest": result.longest,
            "longest_uncommon": result.longest_uncommon,
            "shorter": a.id if shorter == "left" else b.id,
            "shorter_phrases": result.shorter_phrases,
            "shared_phrases": result.shared_phrases,
            "common_phrases": result.common_phrases,
            "share": round(result.share, 4),
            "uncommon_share": round(result.uncommon_share, 4),
            "authors_in_common": common,
            "passages": passages_ab,
            "prints": [a.print, b.print],
            "dates": [a.date, b.date],
        })
    out.sort(key=lambda p: (-p["longest"], -p["share"], p["a"], p["b"]))
    return out


# ---------------------------------------------------------------------------
# The stored answer, beside the database
# ---------------------------------------------------------------------------

_store_lock = threading.RLock()
#: Databases with no file keep their answer here; files are cached by path,
#: modification time and size, so reading the screen does not parse the file.
_memory: dict[Optional[str], tuple[Optional[tuple[int, int]], dict]] = {}


def state_path(conn: sqlite3.Connection) -> Optional[Path]:
    """``<database>-wording.json``, or None for a database with no file."""
    for row in conn.execute("PRAGMA database_list"):
        if row[1] == "main" and row[2]:
            return Path(f"{row[2]}-wording.json")
    return None


def load_state(conn: sqlite3.Connection) -> Optional[dict]:
    path = state_path(conn)
    key = str(path) if path is not None else None
    with _store_lock:
        if path is None:
            held = _memory.get(None)
            return held[1] if held else None
        try:
            info = path.stat()
        except FileNotFoundError:
            _memory.pop(key, None)
            return None
        stamp = (info.st_mtime_ns, info.st_size)
        held = _memory.get(key)
        if held and held[0] == stamp:
            return held[1]
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("shared wording: ignoring an unreadable answer at %s", path, exc_info=True)
            return None
        if not isinstance(state, dict) or state.get("format") != STATE_FORMAT:
            return None
        _memory[key] = (stamp, state)
        return state


def save_state(conn: sqlite3.Connection, state: dict) -> None:
    path = state_path(conn)
    with _store_lock:
        if path is None:
            _memory[None] = (None, state)
            return
        temporary = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        temporary.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, path)
        info = path.stat()
        _memory[str(path)] = ((info.st_mtime_ns, info.st_size), state)


def forget(conn: sqlite3.Connection) -> None:
    """Drop the stored answer, in memory and on disk.

    Called when the corpus is erased: the file holds author names and text
    positions taken from the papers, and ids restart after an erase, so an
    answer kept would describe papers that are not there.
    """
    path = state_path(conn)
    with _store_lock:
        _memory.pop(str(path) if path is not None else None, None)
        if path is not None:
            try:
                path.unlink()
            except FileNotFoundError:
                pass


def _new_state(result: dict, *, kind: str, started_at: str, seconds: float,
               previous: Optional[dict]) -> dict:
    ids = sorted(result["documents"])
    finished = _now()
    return {
        "format": STATE_FORMAT,
        "method_version": METHOD_VERSION,
        "settings": result["settings"],
        "kind": kind,
        "started_at": started_at,
        "finished_at": finished,
        "seconds": round(seconds, 2),
        "full_scan_at": finished if kind == "full" else (previous or {}).get("full_scan_at"),
        "considered": len(ids),
        "compared": result["compared"],
        "not_compared": result["not_compared"],
        "documents": {"ids": ids, "prints": [result["documents"][i] for i in ids]},
        "pairs": result["pairs"],
    }


def _merge(previous: dict, result: dict, new_ids: set[int], *, started_at: str,
           seconds: float) -> dict:
    """Pairs found before, less any that touch a new, changed, or departed
    paper, plus the pairs this pass found."""
    present = set(result["documents"])
    kept = [p for p in previous.get("pairs", [])
            if p["a"] in present and p["b"] in present
            and p["a"] not in new_ids and p["b"] not in new_ids]
    merged = dict(result)
    merged["pairs"] = sorted(kept + result["pairs"],
                             key=lambda p: (-p["longest"], -p["share"], p["a"], p["b"]))
    return _new_state(merged, kind="new", started_at=started_at, seconds=seconds, previous=previous)


def _stored_prints(state: dict) -> dict[int, str]:
    docs = state.get("documents") or {}
    return dict(zip(docs.get("ids", []), docs.get("prints", [])))


def _changed_since(conn: sqlite3.Connection, state: dict) -> set[int]:
    """Papers whose text the stored answer has not compared: new, or changed."""
    known = _stored_prints(state)
    out: set[int] = set()
    for row in conn.execute("SELECT id, abstract FROM documents"):
        doc_id = int(row[0])
        if known.get(doc_id) != text_print(row[1]):
            out.add(doc_id)
    return out


# ---------------------------------------------------------------------------
# The job: one scan at a time, in the background
# ---------------------------------------------------------------------------


class ScanJob:
    """A scan on a daemon thread, the shape :class:`near_duplicates.LinksJob` has.

    ``full`` compares every abstract; ``new`` compares the papers that arrived
    or changed since the stored answer, and is what a finished run starts. A
    ``new`` asked for while a scan runs is run after it, once.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._again: Optional[Callable[[], sqlite3.Connection]] = None
        self._state: dict = self._idle()

    @staticmethod
    def _idle() -> dict:
        return {"running": False, "kind": None, "stage": None, "done": 0, "total": 0,
                "started_at": None, "finished_at": None, "cancelled": False, "error": None,
                "found": None}

    def status(self) -> dict:
        with self._lock:
            return dict(self._state)

    def start(self, open_connection: Callable[[], sqlite3.Connection], kind: str = "full",
              *, close_connection: bool = False) -> dict:
        if kind not in ("full", "new"):
            raise ValueError(kind)
        with self._lock:
            if self._state["running"]:
                raise RuntimeError("A shared-wording scan is already running.")
            self._cancel.clear()
            self._state = self._idle()
            self._state.update(running=True, kind=kind, stage="reading", started_at=_now())
            snapshot = dict(self._state)
        self._thread = threading.Thread(
            target=self._run, args=(open_connection, kind, close_connection),
            daemon=True, name="shared-wording-scan",
        )
        self._thread.start()
        return snapshot

    def after_run(self, open_connection: Callable[[], sqlite3.Connection],
                  *, close_connection: bool = False) -> bool:
        """Compare the papers a finished run brought, if the person has scanned before.

        Nothing happens on a collection never scanned, or scanned by another
        version of the method: comparing new papers against an answer that is
        not there, or not current, would make a partial answer look whole.
        """
        conn = open_connection()
        try:
            state = load_state(conn)
        finally:
            if close_connection:
                conn.close()
        if state is None or state.get("method_version") != METHOD_VERSION:
            return False
        with self._lock:
            if self._state["running"]:
                self._again = open_connection
                return True
        try:
            self.start(open_connection, "new", close_connection=close_connection)
        except RuntimeError:
            with self._lock:
                self._again = open_connection
        return True

    def cancel(self) -> dict:
        with self._lock:
            if not self._state["running"]:
                return {"status": "idle"}
        self._cancel.set()
        return {"status": "cancelling"}

    def join(self, timeout: float = 120.0) -> bool:
        deadline = time.monotonic() + timeout
        while True:
            thread = self._thread
            if thread is None:
                return True
            thread.join(max(0.0, deadline - time.monotonic()))
            if thread.is_alive():
                return False
            if thread is self._thread:
                return True

    def _progress(self, stage: str, done: int, total: int) -> None:
        with self._lock:
            self._state.update(stage=stage, done=done, total=total)

    def _run(self, open_connection: Callable[[], sqlite3.Connection], kind: str,
             close_connection: bool) -> None:
        conn = None
        clock = time.perf_counter()
        try:
            conn = open_connection()
            started = self.status()["started_at"] or _now()
            previous = load_state(conn)
            if kind == "new" and (previous is None or previous.get("method_version") != METHOD_VERSION):
                kind = "full"
            if kind == "new":
                new_ids = _changed_since(conn, previous or {})
                result = find_pairs(conn, new_ids=new_ids, should_cancel=self._cancel.is_set,
                                    on_progress=self._progress)
                if not result["cancelled"]:
                    save_state(conn, _merge(previous or {}, result, new_ids, started_at=started,
                                            seconds=time.perf_counter() - clock))
            else:
                result = find_pairs(conn, should_cancel=self._cancel.is_set, on_progress=self._progress)
                if not result["cancelled"]:
                    save_state(conn, _new_state(result, kind="full", started_at=started,
                                                seconds=time.perf_counter() - clock, previous=previous))
            with self._lock:
                self._state.update(cancelled=result["cancelled"], found=len(result["pairs"]),
                                   kind=kind)
        except Exception as exc:  # a daemon thread: say what stopped it, never raise
            logger.exception("shared wording: the scan failed")
            with self._lock:
                self._state["error"] = f"The scan stopped: {type(exc).__name__}: {exc}"
        finally:
            with self._lock:
                self._state["running"] = False
                self._state["finished_at"] = _now()
                again, self._again = self._again, None
            if conn is not None and close_connection:
                try:
                    conn.close()
                except Exception:  # pragma: no cover
                    logger.debug("shared wording: closing the scan's connection failed", exc_info=True)
        if again is not None and not self._cancel.is_set():
            try:
                self.start(again, "new", close_connection=close_connection)
            except RuntimeError:  # pragma: no cover - another start won the race
                pass


scan_job = ScanJob()


# ---------------------------------------------------------------------------
# What the screen reads
# ---------------------------------------------------------------------------

CATEGORY_LABELS = {
    "different_authors": "No author in common",
    "same_authors": "Text reuse by the same authors",
    "authors_unknown": "Authors not listed",
    "same_work": "Set aside: records of the same work",
    "notice": "Set aside: a notice",
}

CATEGORY_NOTES = {
    "different_authors": "Both records list their authors, and no author appears in both.",
    "same_authors": "At least one author appears in both records.",
    "authors_unknown": "One of the two records lists no authors, so resmon cannot say whether they share one.",
    "same_work": (
        "A shared DOI, a link resmon made between them, titles that are the same word for word, "
        "or two versions of one arXiv paper. Each pair says which."
    ),
    "notice": "One of the two is an erratum, a corrigendum, a correction, a retraction notice, or an expression of concern, as its title says.",
}

REASON_WORDS = {
    "shared_doi": "They carry the same DOI.",
    "linked": "resmon links them as the same work.",
    "same_title": "Their titles are the same word for word.",
    "arxiv_version": "They are versions of one arXiv paper.",
}

_MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August",
           "September", "October", "November", "December")
#: Groups this long are shown in part; the screen says how many there are.
GROUP_LIMIT = 500


def date_words(value: Optional[str]) -> Optional[str]:
    """"March 2, 2021", "March 2021", or "2021", as much as the record says."""
    if not value:
        return None
    match = re.match(r"^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", str(value))
    if not match:
        return str(value)
    year, month, day = match.groups()
    if month and 1 <= int(month) <= 12:
        name = _MONTHS[int(month) - 1]
        if day and 1 <= int(day) <= 31:
            return f"{name} {int(day)}, {year}"
        return f"{name} {year}"
    return year


def percent_words(share: float) -> str:
    """A share as a whole percent, rounded down so it never says more than was measured."""
    if share <= 0:
        return "0%"
    whole = int(share * 100 + 1e-9)
    return "under 1%" if whole == 0 else f"{whole}%"


def reason_words(category: str, reasons: Sequence[str]) -> Optional[str]:
    if category == "same_work":
        return " ".join(REASON_WORDS[r] for r in reasons if r in REASON_WORDS) or None
    if category == "notice":
        said = []
        for reason in reasons:
            _, doc_id, kind = reason.split(":", 2)
            said.append(f"Paper {doc_id} is {NOTICE_WORDS.get(kind, 'a notice')}, as its title says.")
        return " ".join(said) or None
    return None


def _documents(conn: sqlite3.Connection, ids: Iterable[int]) -> dict[int, sqlite3.Row]:
    out: dict[int, sqlite3.Row] = {}
    for chunk in _chunks(sorted(set(int(i) for i in ids)), 500):
        marks = ",".join("?" for _ in chunk)
        for row in conn.execute(
            f"SELECT id, title, authors, abstract, source_repository, publication_date, doi, url "
            f"FROM documents WHERE id IN ({marks})", chunk,
        ):
            out[int(row["id"])] = row
    return out


def _current(conn: sqlite3.Connection, state: dict, pairs: Sequence[dict]
             ) -> tuple[list[dict], int, dict[int, sqlite3.Row]]:
    """The stored pairs whose two texts are still the ones compared, and how many are not."""
    rows = _documents(conn, {p[k] for p in pairs for k in ("a", "b")})
    prints = {i: text_print(r["abstract"]) for i, r in rows.items()}
    kept = [p for p in pairs
            if prints.get(p["a"]) == p["prints"][0] and prints.get(p["b"]) == p["prints"][1]]
    return kept, len(pairs) - len(kept), rows


def _side(row: sqlite3.Row) -> dict:
    return {"id": int(row["id"]), "title": row["title"], "publication_date": row["publication_date"],
            "source_repository": row["source_repository"]}


def _ordered(pair: dict, rows: dict[int, sqlite3.Row]) -> tuple[int, int]:
    """Left and right: the earlier publication date first, then the lower number.

    Only a reading order. The screen states both dates and draws nothing from
    which came first.
    """
    a, b = pair["a"], pair["b"]
    da, db = rows[a]["publication_date"] or "", rows[b]["publication_date"] or ""
    if da and db and db < da:
        return b, a
    return a, b


def brief(pair: dict, rows: dict[int, sqlite3.Row]) -> dict:
    left, right = _ordered(pair, rows)
    return {
        "a": pair["a"], "b": pair["b"],
        "category": pair["category"],
        "reasons": list(pair["reasons"]),
        "reason_words": reason_words(pair["category"], pair["reasons"]),
        "longest": pair["longest"],
        "share": pair["share"],
        "authors_in_common": len(pair["authors_in_common"]),
        "left": _side(rows[left]),
        "right": _side(rows[right]),
    }


def _scan_facts(state: dict) -> dict:
    return {key: state.get(key) for key in (
        "kind", "started_at", "finished_at", "seconds", "full_scan_at", "considered", "compared",
        "not_compared", "method_version")}


def overview(conn: sqlite3.Connection) -> dict:
    """``GET /api/shared-wording``: the last scan, the job, and the pairs by group."""
    state = load_state(conn)
    out: dict = {
        "state": "never",
        "method_version": METHOD_VERSION,
        "settings": Settings().as_dict(),
        "definitions": DEFINITIONS,
        "limits": LIMITS,
        "job": scan_job.status(),
        "scan": None,
        "withheld": 0,
        "arrived_since": 0,
        "groups": [],
    }
    if state is None:
        return out
    out["scan"] = _scan_facts(state)
    if state.get("method_version") != METHOD_VERSION:
        out["state"] = "other_version"
        return out
    out["state"] = "ready"
    known = set((state.get("documents") or {}).get("ids", []))
    out["arrived_since"] = sum(1 for (i,) in conn.execute("SELECT id FROM documents") if i not in known)
    pairs, withheld, rows = _current(conn, state, state.get("pairs", []))
    out["withheld"] = withheld
    for category in CATEGORIES:
        members = [p for p in pairs if p["category"] == category]
        out["groups"].append({
            "category": category,
            "label": CATEGORY_LABELS[category],
            "note": CATEGORY_NOTES[category],
            "count": len(members),
            "pairs": [brief(p, rows) for p in members[:GROUP_LIMIT]],
        })
    return out


def pairs_for(conn: sqlite3.Connection, document_id: int) -> dict:
    """What one paper shares, for its page."""
    state = load_state(conn)
    out = {"document_id": int(document_id), "state": "never", "compared": None,
           "phrase_words": PHRASE_WORDS, "pairs": []}
    if state is None:
        return out
    if state.get("method_version") != METHOD_VERSION:
        out["state"] = "other_version"
        return out
    out["state"] = "ready"
    row = conn.execute("SELECT abstract FROM documents WHERE id = ?", (int(document_id),)).fetchone()
    stored = _stored_prints(state).get(int(document_id))
    if row is None or stored is None or stored != text_print(row[0]):
        out["compared"] = None  # arrived or changed since the scan
    else:
        out["compared"] = len(read_words(row[0])) >= int(state["settings"].get("min_words", MIN_WORDS))
    mine = [p for p in state.get("pairs", []) if int(document_id) in (p["a"], p["b"])]
    pairs, _, rows = _current(conn, state, mine)
    out["pairs"] = [brief(p, rows) for p in pairs]
    return out


def pair_view(conn: sqlite3.Connection, a: int, b: int) -> dict:
    """``GET /api/shared-wording/pairs/{a}/{b}``: both texts, the passages, the numbers.

    Passages are codepoint offsets into each side's ``text``, the text as it
    was compared (entities decoded, markup dropped, NFKC). Raises ``LookupError``
    when the pair is not in the stored answer.
    """
    a, b = min(int(a), int(b)), max(int(a), int(b))
    state = load_state(conn)
    if state is None or state.get("method_version") != METHOD_VERSION:
        raise LookupError("There is no current shared-wording scan. Scan the collection first.")
    pair = next((p for p in state.get("pairs", []) if p["a"] == a and p["b"] == b), None)
    if pair is None:
        raise LookupError(f"Papers {a} and {b} are not a pair in the last scan.")
    rows = _documents(conn, (a, b))
    if a not in rows or b not in rows:
        raise LookupError("One of these papers is no longer in your collection.")
    changed = [i for i, stored in zip((a, b), pair["prints"]) if text_print(rows[i]["abstract"]) != stored]
    left, right = _ordered(pair, rows)
    words = {i: read_words(rows[i]["abstract"]) for i in (a, b)}

    def side(doc_id: int) -> dict:
        row = rows[doc_id]
        return {**_side(row), "authors": row["authors"], "doi": row["doi"], "url": row["url"],
                "text": words[doc_id].text, "words": len(words[doc_id])}

    passages = []
    if not changed:
        for i, j, n in pair["passages"]:
            at = {a: (i, n), b: (j, n)}
            spans = {}
            for doc_id in (left, right):
                start, length = at[doc_id]
                w = words[doc_id]
                spans[doc_id] = [w.starts[start], w.ends[start + length - 1]]
            passages.append({"left": spans[left], "right": spans[right], "words": n})
    view = {
        "a": a, "b": b,
        "state": "changed" if changed else "current",
        "category": pair["category"],
        "label": CATEGORY_LABELS[pair["category"]],
        "reasons": list(pair["reasons"]),
        "reason_words": reason_words(pair["category"], pair["reasons"]),
        "left": side(left),
        "right": side(right),
        "longest": pair["longest"],
        "share": pair["share"],
        "shorter": pair["shorter"],
        "shorter_phrases": pair["shorter_phrases"],
        "shared_phrases": pair["shared_phrases"],
        "common_phrases": pair["common_phrases"],
        "authors_in_common": pair["authors_in_common"],
        "passages": passages,
        "summary": summary(pair, rows, left, right, changed),
        "definitions": DEFINITIONS,
        "limits": LIMITS,
        "scanned_at": state.get("finished_at"),
        "method_version": METHOD_VERSION,
    }
    return view


def summary(pair: dict, rows: dict[int, sqlite3.Row], left: int, right: int,
            changed: Sequence[int] = ()) -> list[str]:
    """The pair in sentences: what was measured, the authors, the dates, and nothing else."""
    if changed:
        return [
            "The text of " + " and ".join(f"paper {i}" for i in changed)
            + " changed after the scan, so the passages it found are not shown. Scan again to compare the texts as they are now."
        ]
    k = PHRASE_WORDS
    lines = [
        f"These two abstracts share a {pair['longest']}-word passage word for word and "
        f"{percent_words(pair['share'])} of the shorter one's {k}-word phrases."
    ]
    common = pair["authors_in_common"]
    if pair["category"] == "authors_unknown":
        missing = [side for side, doc in (("first", left), ("second", right))
                   if not (rows[doc]["authors"] or "").strip()]
        whose = " and ".join(f"the {s}" for s in missing) or "one of them"
        lines.append(f"No authors are recorded for {whose}, so resmon cannot say whether they share one.")
    elif not common:
        lines.append("They list no author in common.")
    else:
        names = [c["name"] for c in common]
        shown = ", ".join(names[:3]) + (f", and {len(names) - 3} more" if len(names) > 3 else "")
        noun = "author" if len(names) == 1 else "authors"
        lines.append(f"They list {len(names)} {noun} in common: {shown}.")
    first, second = date_words(rows[left]["publication_date"]), date_words(rows[right]["publication_date"])
    if first and second:
        lines.append(f"The first was published {first}, and the second {second}.")
    elif first or second:
        lines.append(f"The {'first' if first else 'second'} was published {first or second}; "
                     f"no publication date is recorded for the other.")
    else:
        lines.append("No publication date is recorded for either.")
    if pair["common_phrases"]:
        works = int(COMMON_WORKS)
        lines.append(
            f"{pair['common_phrases']} of the shared {k}-word phrases are common in your collection "
            f"(each is in the abstracts of more than {works} works), so they did not count toward listing this pair."
        )
    said = reason_words(pair["category"], pair["reasons"])
    if said:
        lines.append(f"Set aside: {said}")
    return lines


# ---------------------------------------------------------------------------
# A Library file, page by page
# ---------------------------------------------------------------------------

#: How long a page waits for the PDF reader, which reads one page at a time
#: for the whole engine, before the comparison says it could not read it.
READER_WAIT_SECONDS = 120.0

_HYPHEN_BREAK = re.compile(r"(\w)-\n(\w)")

LIBRARY_LIMITS = [
    "Each page is compared on its own, so a passage that runs across a page break is found as two.",
    "Text is what the PDF reader extracts: tables, equations, columns, and images can be missing or "
    "out of order, and a scanned page with no text layer has no words to compare.",
    "Abstracts are compared, not the full text of papers, and files are compared with the other files "
    "in this Library only.",
] + LIMITS[1:]


def _read_pages(conn: sqlite3.Connection, vault_id: str, row: dict, *,
                should_cancel: Callable[[], bool], wait: Callable[[float], None]) -> dict:
    """Every page's text from a kept file, through the engine's own readers.

    A PDF is read one page at a time by ``evidence_pdf.extract`` (its sandboxed
    worker, its limits), and a page refused because another page is being read
    (``reader_busy``) is asked for again rather than counted as unread. TXT and
    MD are one page, read by ``library_text``.
    """
    from . import evidence, evidence_pdf, library, library_text

    pages: list[tuple[int, str]] = []
    unread: list[dict] = []
    if row["media_type"] != "application/pdf":
        text = library_text.read_text(conn, vault_id, row["file_id"], row["version_id"])["text"]
        return {"pages": [(1, text)], "page_count": 1, "unread": unread}
    with library.retained(conn, vault_id, row["file_id"], row["version_id"], evidence_pdf.MAX_INPUT) as (_, fd, _p):
        raw = bytearray()
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            raw.extend(chunk)
    data = bytes(raw)
    page_count: Optional[int] = None
    page = 1
    while page_count is None or page <= min(page_count, 200):
        if should_cancel():
            raise _Cancelled()
        waited = 0.0
        while True:
            try:
                result = evidence_pdf.extract(data, page)
                break
            except evidence.EvidenceError as exc:
                if exc.reason != "reader_busy" or waited >= READER_WAIT_SECONDS:
                    raise
                if should_cancel():
                    raise _Cancelled()
                wait(0.25)
                waited += 0.25
        if result.get("page_count") is not None:
            page_count = int(result["page_count"])
        if result["status"] == "extracted":
            pages.append((page, _HYPHEN_BREAK.sub(r"\1\2", result["text"])))
        else:
            unread.append({"page": page, "status": result["status"]})
            if page_count is None:
                break
        page += 1
    return {"pages": pages, "page_count": page_count, "unread": unread}


def compare_file(
    conn: sqlite3.Connection, vault_id: str, file_id: str, version_id: str, *,
    should_cancel: Optional[Callable[[], bool]] = None,
    on_progress: Optional[Callable[[str, int, int], None]] = None,
    wait: Callable[[float], None] = time.sleep,
    page_cache: Optional[dict] = None,
) -> dict:
    """Compare one Library file, page by page, with the abstracts and the other files.

    Common phrasing is judged as for abstracts: a phrase in the abstracts of
    more than :data:`COMMON_WORKS` works is not evidence. A match is reported
    by the shown rule abstracts use, and names this file's page and the passage.
    """
    from . import library

    cancel = should_cancel or (lambda: False)
    progress = on_progress or (lambda stage, done, total: None)
    settings = Settings()
    k = settings.phrase_words
    hasher = WordHashes()
    cache = page_cache if page_cache is not None else {}

    with library.checked_vault(conn, vault_id):
        row = library.file_row(conn, file_id, version_id)
        if row["vault_id"] != vault_id:
            raise library.LibraryError("wrong_vault", "This file belongs to another vault.")
        others = [library.file_row(conn, r["file_id"]) for r in conn.execute(
            "SELECT file_id FROM library_files WHERE vault_id = ? AND file_id != ? ORDER BY id",
            (vault_id, file_id))]
    linked = {int(r[0]) for r in conn.execute(
        "SELECT document_id FROM library_file_documents WHERE file_id = ?", (file_id,))}

    def pages_of(file_row: dict) -> dict:
        key = (file_row["version_id"], file_row["sha256"])
        if key not in cache:
            cache[key] = _read_pages(conn, vault_id, file_row, should_cancel=cancel, wait=wait)
        return cache[key]

    progress("reading this file", 0, 1)
    mine = pages_of(row)
    texts = {page: Text.read(text, hasher, k, limit=200_000) for page, text in mine["pages"]}
    wanted = (np.unique(np.concatenate([t.phrases for t in texts.values()]))
              if texts else np.empty(0, np.uint64))

    # The abstracts: which share this file's phrases, and how common each
    # phrase is, counted in works as a scan counts it.
    papers: list[_Paper] = []
    hits: dict[int, set[int]] = {}
    phrase_places: dict[int, set[int]] = {}
    total = int(conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0])
    for count, doc in enumerate(_rows(conn)):
        if count % 2000 == 0:
            if cancel():
                raise _Cancelled()
            progress("reading abstracts", count, total)
        words = read_words(doc["abstract"])
        if len(words) < settings.min_words:
            continue
        papers.append(_Paper(int(doc["id"]), doc["title"], normalized_doi(doc["doi"]),
                             doc["publication_date"],
                             arxiv_id(doc["source_repository"], doc["external_id"], doc["doi"], doc["url"]),
                             ""))
        if not len(wanted):
            continue
        phrases = np.unique(phrase_hashes(hasher(words.words), k))
        shared = phrases[np.isin(phrases, wanted)]
        if len(shared):
            place = len(papers) - 1
            hits[place] = set(shared.tolist())
            for value in shared.tolist():
                phrase_places.setdefault(value, set()).add(place)
    work = _works(conn, papers) if papers else np.empty(0, dtype=np.int64)
    common = {value for value, places in phrase_places.items()
              if len(places) > _MAX_RECORDS_PER_PHRASE
              or len({int(work[p]) for p in places}) > settings.common_works}
    common_sorted = np.array(sorted(common), dtype=np.uint64)

    def is_common(hashes: np.ndarray) -> np.ndarray:
        if not len(common_sorted) or not len(hashes):
            return np.zeros(len(hashes), dtype=bool)
        return np.isin(hashes, common_sorted)

    matches: list[dict] = []
    candidates = [p for p, values in hits.items() if len(values - common) >= settings.shown_phrases]
    abstracts = _texts_for(conn, [papers[p].id for p in candidates])
    for n, place in enumerate(candidates):
        if cancel():
            raise _Cancelled()
        progress("measuring", n, len(candidates))
        paper = papers[place]
        other = Text.read(abstracts.get(paper.id), hasher, k)
        for page, text in texts.items():
            result = measure(text, other, is_common, k)
            if settings.shows(result):
                matches.append(_file_match(result, page, text, {
                    "kind": "paper", "document_id": paper.id, "title": paper.title,
                    "publication_date": paper.date, "linked": paper.id in linked}))

    files_not_read: list[dict] = []
    for n, other_row in enumerate(others):
        if cancel():
            raise _Cancelled()
        progress("reading the other files", n, len(others))
        try:
            theirs = pages_of(other_row)
        except _Cancelled:
            raise
        except Exception as exc:  # one unreadable file is reported, not fatal
            reason = getattr(exc, "reason", None) or type(exc).__name__
            files_not_read.append({"file_id": other_row["file_id"], "name": other_row["original_name"],
                                   "reason": str(exc) or reason})
            continue
        for other_page, other_text in theirs["pages"]:
            other = Text.read(other_text, hasher, k, limit=200_000)
            if not len(np.intersect1d(other.phrases, wanted)):
                continue
            for page, text in texts.items():
                result = measure(text, other, is_common, k)
                if settings.shows(result):
                    matches.append(_file_match(result, page, text, {
                        "kind": "file", "file_id": other_row["file_id"], "name": other_row["original_name"],
                        "other_page": other_page}))
    progress("done", 1, 1)
    matches.sort(key=lambda m: (-m["longest"], m["page"]))
    return {
        "file": {"file_id": row["file_id"], "version_id": row["version_id"], "name": row["original_name"],
                 "media_type": row["media_type"]},
        "page_count": mine["page_count"],
        "pages_read": len(mine["pages"]),
        "pages_unread": mine["unread"],
        "abstracts_compared": len(papers),
        "files_compared": len(others) - len(files_not_read),
        "files_not_read": files_not_read,
        "matches": matches,
        "settings": settings.as_dict(),
        "definitions": DEFINITIONS,
        "limits": LIBRARY_LIMITS,
        "method_version": METHOD_VERSION,
    }


def _file_match(result: Measure, page: int, text: Text, other: dict) -> dict:
    words = text.words
    passages = []
    for i, _j, n in result.passages:
        start, end = words.starts[i], words.ends[i + n - 1]
        passages.append({"words": n, "start": start, "end": end, "text": words.text[start:end]})
    # In the order the response model declares, which is the order on the wire.
    kind = other.pop("kind")
    return {"kind": kind, "page": page, "longest": result.longest, "share": round(result.share, 4),
            "shorter_phrases": result.shorter_phrases, "shared_phrases": result.shared_phrases,
            "passages": passages, **other}


class LibraryJob:
    """One Library comparison at a time; each file's last answer kept in memory.

    Not stored: it is asked for, read, and asked for again. The PDF reader is
    one page at a time for the whole engine, so two comparisons at once would
    only take turns.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._running: Optional[tuple[str, str]] = None
        self._answers: dict[tuple[str, str], dict] = {}
        self._pages: dict = {}

    def status(self, file_id: str, version_id: str) -> dict:
        with self._lock:
            held = self._answers.get((file_id, version_id))
            return dict(held) if held else {"state": "never", "file_id": file_id, "version_id": version_id}

    def start(self, open_connection: Callable[[], sqlite3.Connection], vault_id: str,
              file_id: str, version_id: str) -> dict:
        with self._lock:
            if self._running is not None:
                raise RuntimeError("Another Library file is being compared. Try again when it finishes.")
            self._running = (file_id, version_id)
            self._cancel.clear()
            entry = {"state": "running", "file_id": file_id, "version_id": version_id,
                     "stage": "starting", "done": 0, "total": 0, "started_at": _now(),
                     "finished_at": None, "result": None, "error": None}
            self._answers[(file_id, version_id)] = entry
            snapshot = dict(entry)
        thread = threading.Thread(target=self._run, args=(open_connection, vault_id, file_id, version_id),
                                  daemon=True, name="shared-wording-library")
        self._thread = thread
        thread.start()
        return snapshot

    def cancel(self) -> None:
        self._cancel.set()

    def join(self, timeout: float = 120.0) -> bool:
        thread = getattr(self, "_thread", None)
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    def _run(self, open_connection: Callable[[], sqlite3.Connection], vault_id: str,
             file_id: str, version_id: str) -> None:
        key = (file_id, version_id)

        def progress(stage: str, done: int, total: int) -> None:
            with self._lock:
                self._answers[key].update(stage=stage, done=done, total=total)

        conn = None
        try:
            conn = open_connection()
            result = compare_file(conn, vault_id, file_id, version_id, should_cancel=self._cancel.is_set,
                                  on_progress=progress, page_cache=self._pages)
            with self._lock:
                self._answers[key].update(state="done", result=result)
        except _Cancelled:
            with self._lock:
                self._answers[key].update(state="cancelled")
        except Exception as exc:
            message = str(exc) if getattr(exc, "reason", None) else f"{type(exc).__name__}: {exc}"
            if not getattr(exc, "reason", None):
                logger.exception("shared wording: a Library comparison failed")
            with self._lock:
                self._answers[key].update(state="failed", error=message,
                                          reason=getattr(exc, "reason", None))
        finally:
            with self._lock:
                self._answers[key]["finished_at"] = _now()
                self._running = None
            if conn is not None:
                try:
                    conn.close()
                except Exception:  # pragma: no cover
                    pass


library_job = LibraryJob()
