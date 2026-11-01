"""Shared wording: abstracts and Library files that share passages word for word.

What is claimed, and tested here on authored texts whose shared passages have
known lengths:

- **A text is read the same way everywhere.** Entities decoded, markup dropped,
  NFKC, lowercase, words as runs of letters, digits and their marks; a phrase is
  8 words, hashed the same in every process.
- **Each number is what its sentence says.** The longest passage, the share of
  the shorter text's phrases, and the authors in common, each checked against a
  count made by hand.
- **Common phrasing is not evidence, and is counted in works.** A passage in
  more than three works does not make a pair; a paper held from four sources
  is one work, so wording copied from it is still found.
- **Nothing is dropped silently.** The same work and notices are set aside with
  their reason; short abstracts are counted, not compared.
- **The answer is stored with the method's version**, extended after a run by
  comparing only the new papers, and erased with the corpus.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import sqlite3
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS = PROJECT_ROOT / "resmon_scripts"
sys.path.insert(0, str(SCRIPTS))

from fastapi.testclient import TestClient      # noqa: E402

import resmon as resmon_mod                     # noqa: E402
from implementation_scripts import shared_wording as sw  # noqa: E402
from implementation_scripts.api_base import Author  # noqa: E402
from implementation_scripts.database import init_db, insert_document  # noqa: E402


# ---------------------------------------------------------------------------
# Authored texts
# ---------------------------------------------------------------------------

_SYLLABLES = ("ka lo mi ra te su no vi da pe gu zo ri ta me lu fa so ne ki ba do "
              "ve ru li ma tu se po ga").split()


def _vocabulary(seed: int = 3, size: int = 6000) -> list[str]:
    rng = random.Random(seed)
    words: set[str] = set()
    while len(words) < size:
        words.add("".join(rng.choice(_SYLLABLES) for _ in range(rng.randint(2, 4))))
    return sorted(words)


VOCABULARY = _vocabulary()


def words(rng: random.Random, n: int) -> list[str]:
    """``n`` words no other call is likely to repeat in order: 6,000 to choose from."""
    return [rng.choice(VOCABULARY) for _ in range(n)]


def text(*parts: list[str]) -> str:
    """Sentences of 12 words, so punctuation lands between words as it would."""
    flat = [w for part in parts for w in part]
    sentences = [" ".join(flat[i:i + 12]).capitalize() + "." for i in range(0, len(flat), 12)]
    return " ".join(sentences)


_counter = iter(range(1, 10**6))


def add(conn: sqlite3.Connection, abstract: str | None, *, title: str | None = None,
        authors: list[str] | None = None, orcids: list[str | None] | None = None,
        doi: str | None = None, source: str = "crossref", external_id: str | None = None,
        date: str = "2026-03-02") -> int:
    n = next(_counter)
    names = authors if authors is not None else [f"Author{n} Person"]
    structured = None
    if orcids is not None:
        structured = [Author(name, orcid) for name, orcid in zip(names, orcids)]
    doc_id = insert_document(conn, {
        "source_repository": source, "external_id": external_id or f"authored-{n}",
        "doi": doi, "title": title or f"Authored paper number {n}",
        "authors": ", ".join(names) if names else None, "abstract": abstract,
        "publication_date": date, "metadata_hash": hashlib.sha256(f"{n}".encode()).hexdigest(),
        "structured_authors": structured,
    })
    assert doc_id is not None
    return int(doc_id)


@pytest.fixture
def db(tmp_path: Path) -> sqlite3.Connection:
    path = tmp_path / "resmon.db"
    init_db(path)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    yield conn
    sw.scan_job.join()
    sw.forget(conn)
    conn.close()


def scan(conn: sqlite3.Connection, **kwargs) -> dict:
    return sw.find_pairs(conn, **kwargs)


def pair_of(result: dict, a: int, b: int) -> dict | None:
    a, b = min(a, b), max(a, b)
    return next((p for p in result["pairs"] if (p["a"], p["b"]) == (a, b)), None)


def copied(conn: sqlite3.Connection, rng: random.Random, length: int, **right: object) -> tuple[int, int]:
    """Two abstracts by different authors that share one passage of ``length`` words."""
    passage = words(rng, length)
    left = add(conn, text(words(rng, 60), passage, words(rng, 60)), authors=["Ada Lovelace"])
    other = add(conn, text(words(rng, 45), passage, words(rng, 70)),
                authors=right.pop("authors", ["Grace Hopper"]), **right)  # type: ignore[arg-type]
    return left, other


# ---------------------------------------------------------------------------
# Reading a text
# ---------------------------------------------------------------------------

def test_a_text_is_read_as_its_words():
    read = sw.read_words("Abstract <jats:p>R&amp;D ﬁnds  Ｆｕｌｌ x² café हिन्दी</jats:p>")
    # The leading label goes, the tag goes, the entity is decoded, NFKC folds
    # the ligature, the full-width letters and the superscript, and a Hindi
    # word keeps its vowel signs.
    assert read.words == ["r", "d", "finds", "full", "x2", "café", "हिन्दी"]
    for word, start, end in zip(read.words, read.starts, read.ends):
        assert read.text[start:end].casefold() == word


@pytest.mark.parametrize("sample", [
    "Abstract <jats:p>R&amp;D ﬁnds  Ｆｕｌｌ x² café हिन्दी</jats:p>",
    "İstanbul Straße ǅemal ΣΊΣΥΦΟΣ ﬀ ŉ 𝒳𝓎𝓏 ℌ 1/2 ½ Ⅻ",
    "ABSTRACT: The abstract of an abstract. " + " ".join(f"w{i}" for i in range(5000)),
    "", None,
])
def test_a_scan_reads_the_words_the_pair_view_reads(sample):
    """The scan skips the offsets for speed; it must not read different words."""
    assert sw.scan_words(sample) == sw.read_words(sample).words


def test_the_same_title_is_the_same_once_entities_are_decoded():
    assert sw.title_words("Alibaba&apos;s R&amp;D <b>platform</b>") == sw.title_words("Alibaba's R&D platform")
    assert sw.title_words("RETRACTED: A study of things") == sw.title_words("A study of things")
    assert sw.title_words("Modèle") == sw.title_words("Modele")


def test_a_bare_angle_bracket_is_not_markup():
    assert sw.read_words("p < 0.05 and q > 2").words == ["p", "0", "05", "and", "q", "2"]


# ---------------------------------------------------------------------------
# Stable hashing
# ---------------------------------------------------------------------------

PINNED = ["0x9e786a09a40737fb", "0x53d49089001e238f"]
SENTENCE = "The quick brown fox jumps over the lazy dog"


def test_a_phrase_hash_is_pinned():
    hashes = sw.phrase_hashes(sw.WordHashes()(sw.read_words(SENTENCE).words))
    assert [hex(int(h)) for h in hashes] == PINNED


@pytest.mark.parametrize("seed", ["0", "12345"])
def test_a_phrase_hash_is_the_same_in_another_process(seed: str):
    """Python's ``hash`` is salted per process; the phrase hash must not be."""
    code = ("import sys; sys.path.insert(0, sys.argv[1]);"
            "from implementation_scripts import shared_wording as sw;"
            f"print([hex(int(h)) for h in sw.phrase_hashes(sw.WordHashes()(sw.read_words({SENTENCE!r}).words))])")
    out = subprocess.run([sys.executable, "-c", code, str(SCRIPTS)], capture_output=True, text=True,
                         env={**os.environ, "PYTHONHASHSEED": seed}, check=True).stdout.strip()
    assert out == repr(PINNED)


def test_texts_hashed_together_are_hashed_as_they_are_alone():
    hasher = sw.WordHashes()
    rng = random.Random(1)
    batch = [hasher(words(rng, n)) for n in (3, 8, 9, 40, 7, 120)]
    hashes, owner = sw._batched_phrases(batch, 8)
    for index, one in enumerate(batch):
        assert np.array_equal(hashes[owner == index], sw.phrase_hashes(one))


# ---------------------------------------------------------------------------
# Each number
# ---------------------------------------------------------------------------

def test_the_longest_passage_and_the_share_are_counted_exactly(db):
    rng = random.Random(10)
    passage = words(rng, 37)
    left_words = words(rng, 50) + passage + words(rng, 50)       # 137 words
    right_words = words(rng, 20) + passage + words(rng, 30)      # 87 words: the shorter
    left = add(db, text(left_words), authors=["Ada Lovelace"])
    right = add(db, text(right_words), authors=["Grace Hopper"])
    pair = pair_of(scan(db), left, right)
    assert pair is not None
    assert pair["longest"] == 37
    assert pair["shorter"] == right
    # 87 words have 80 phrases; the 37-word passage holds 30 of them.
    assert (pair["shorter_phrases"], pair["shared_phrases"]) == (80, 30)
    assert pair["share"] == pytest.approx(30 / 80, abs=1e-4)
    assert pair["authors_in_common"] == []
    assert pair["category"] == "different_authors"


def test_twenty_words_are_shown_and_nineteen_are_not(db):
    rng = random.Random(11)
    shown = copied(db, rng, 20)
    hidden = copied(db, rng, 19)
    result = scan(db)
    assert pair_of(result, *shown)["longest"] == 20
    assert pair_of(result, *hidden) is None


def test_punctuation_and_case_do_not_break_a_passage(db):
    rng = random.Random(12)
    passage = words(rng, 30)
    left = add(db, text(words(rng, 50), passage, words(rng, 50)), authors=["Ada Lovelace"])
    shouted = " ".join(w.upper() + ("," if i % 4 == 0 else "") for i, w in enumerate(passage))
    right = add(db, text(words(rng, 40)) + " " + shouted + " " + text(words(rng, 40)),
                authors=["Grace Hopper"])
    assert pair_of(scan(db), left, right)["longest"] == 30


def test_reordered_sentences_are_each_found(db):
    rng = random.Random(13)
    sentences = [words(rng, 24) for _ in range(5)]
    left = add(db, text(*sentences, words(rng, 30)), authors=["Ada Lovelace"])
    right = add(db, text(words(rng, 30), *reversed(sentences)), authors=["Grace Hopper"])
    pair = pair_of(scan(db), left, right)
    assert pair is not None
    assert pair["longest"] == 24
    assert sorted(n for _, _, n in pair["passages"]) == [24] * 5


def test_a_lightly_edited_copy_is_found_by_its_share(db):
    """A word changed every 15 words leaves no 20-word passage, but most phrases."""
    rng = random.Random(14)
    original = words(rng, 150)
    edited = list(original)
    for i in range(14, len(edited), 15):
        edited[i] = rng.choice(VOCABULARY)
    left = add(db, text(original), authors=["Ada Lovelace"])
    right = add(db, text(edited), authors=["Grace Hopper"])
    pair = pair_of(scan(db), left, right)
    assert pair is not None
    assert pair["longest"] < sw.SHOWN_LONGEST
    assert pair["uncommon_share"] >= sw.SHOWN_SHARE


def test_an_edit_every_eight_words_is_not_found(db):
    rng = random.Random(15)
    original = words(rng, 150)
    edited = list(original)
    for i in range(7, len(edited), 8):
        edited[i] = rng.choice(VOCABULARY)
    left = add(db, text(original), authors=["Ada Lovelace"])
    right = add(db, text(edited), authors=["Grace Hopper"])
    assert pair_of(scan(db), left, right) is None


# ---------------------------------------------------------------------------
# Authors in common
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("left, right", [
    ("Jane Smith", "Smith, Jane"),
    ("Jane Smith", "J. Smith"),
    ("Jane Smith", "Smith J"),
    ("Jørgen Müller", "Jorgen Muller"),
    ("Ludwig van Beethoven", "van Beethoven, L."),
    ("Mary Ann O'Neil", "M. A. O'Neil"),
    ("John Smith Jr.", "J. Smith"),
])
def test_one_person_written_two_ways_is_one_author(left: str, right: str):
    common = sw.authors_in_common([sw.Author(left, None, sw.author_key(left))],
                                  [sw.Author(right, None, sw.author_key(right))])
    assert [c["by"] for c in common] == ["name"]


@pytest.mark.parametrize("left, right", [
    ("Jane Smith", "Mary Smith"),
    ("Jane Smith", "Jane Smithers"),
    ("Wei Wang", "Wang Wei"),
])
def test_two_names_that_differ_are_two_authors(left: str, right: str):
    # The last is one limit of the rule: a family name written first without a
    # comma is read as a given name.
    assert sw.authors_in_common([sw.Author(left, None, sw.author_key(left))],
                                [sw.Author(right, None, sw.author_key(right))]) == []


def test_a_surname_and_initial_cannot_tell_jane_from_john():
    """The rule as defined, and as the screen states it: two people can share both."""
    assert sw.author_key("Jane Smith") == sw.author_key("John Smith") == ("smith", "j")


def test_initials_after_a_short_first_word_are_a_surname():
    # "A SAP" is A. Sap, and "Sap A" is PubMed's A. Sap.
    assert sw.author_key("A SAP") == sw.author_key("Sap A") == ("sap", "a")


def test_an_orcid_decides_where_both_records_carry_one():
    same_orcid = sw.authors_in_common(
        [sw.Author("J. Smith", "0000000218250097", sw.author_key("J. Smith"))],
        [sw.Author("Jian Wu", "0000000218250097", sw.author_key("Jian Wu"))])
    assert [c["by"] for c in same_orcid] == ["orcid"]
    two_orcids = sw.authors_in_common(
        [sw.Author("Jane Smith", "0000000218250097", sw.author_key("Jane Smith"))],
        [sw.Author("Jane Smith", "000000021694233X", sw.author_key("Jane Smith"))])
    assert two_orcids == []


def test_authors_are_read_from_the_record(db):
    rng = random.Random(20)
    # As a source hands them over: one name per author, in its own order.
    left, right = copied(db, rng, 30, authors=["Grace Hopper", "Lovelace, Ada"], orcids=[None, None])
    pair = pair_of(scan(db), left, right)
    assert pair["category"] == "same_authors"
    assert pair["authors_in_common"] == [{"name": "Ada Lovelace", "other_name": "Lovelace, Ada", "by": "name"}]


def test_orcids_on_the_records_decide(db):
    rng = random.Random(21)
    passage = words(rng, 30)
    left = add(db, text(words(rng, 50), passage, words(rng, 50)), authors=["Jane Smith"],
               orcids=["0000-0002-1825-0097"])
    right = add(db, text(words(rng, 50), passage, words(rng, 50)), authors=["Jane Smith"],
                orcids=["https://orcid.org/0000-0002-1694-233X"])
    assert pair_of(scan(db), left, right)["category"] == "different_authors"


def test_a_record_with_no_authors_is_not_said_to_share_none(db):
    rng = random.Random(22)
    left, right = copied(db, rng, 30, authors=[])
    assert pair_of(scan(db), left, right)["category"] == "authors_unknown"


# ---------------------------------------------------------------------------
# Set aside, with the reason
# ---------------------------------------------------------------------------

def test_a_shared_doi_is_the_same_work(db):
    rng = random.Random(30)
    left, right = copied(db, rng, 40, doi="10.1234/shared")
    db.execute("UPDATE documents SET doi = 'https://doi.org/10.1234/SHARED' WHERE id = ?", (left,))
    db.commit()
    pair = pair_of(scan(db), left, right)
    assert (pair["category"], pair["reasons"]) == ("same_work", ["shared_doi"])


def test_a_link_is_the_same_work(db):
    rng = random.Random(31)
    left, right = copied(db, rng, 40)
    db.execute("INSERT INTO document_links (document_a, document_b, kind, score, method) "
               "VALUES (?, ?, 'near_duplicate', 1.0, 'vector+title')", (min(left, right), max(left, right)))
    db.commit()
    assert pair_of(scan(db), left, right)["reasons"] == ["linked"]


def test_titles_equal_once_entities_are_decoded_are_the_same_work(db):
    rng = random.Random(32)
    left, right = copied(db, rng, 40, title="Request volatility at Alibaba&apos;s service")
    db.execute("UPDATE documents SET title = ? WHERE id = ?", ("Request Volatility at Alibaba's Service", left))
    db.commit()
    assert pair_of(scan(db), left, right)["reasons"] == ["same_title"]


def test_two_versions_of_one_arxiv_paper_are_the_same_work(db):
    rng = random.Random(33)
    passage = words(rng, 40)
    left = add(db, text(words(rng, 50), passage, words(rng, 50)), source="arxiv", external_id="2101.00001v1",
               authors=["Ada Lovelace"])
    right = add(db, text(words(rng, 50), passage, words(rng, 50)), source="openalex",
                doi="10.48550/arXiv.2101.00001", authors=["Grace Hopper"])
    assert pair_of(scan(db), left, right)["reasons"] == ["arxiv_version"]


@pytest.mark.parametrize("title, kind", [
    ("Erratum to “A study of things”", "erratum"),
    ("Corrigendum: A study of things", "corrigendum"),
    ("Correction: A study of things", "correction"),
    ("Correction to \"A study of things\"", "correction"),
    ("Retraction Note: A study of things", "retraction"),
    ("Notice of Retraction: A study of things", "retraction"),
    ("[Expression of Concern] A study of things", "concern"),
    ("Editorial Expression of Concern: A study of things", "concern"),
])
def test_a_notice_is_set_aside_as_one(db, title: str, kind: str):
    assert sw.notice_kind(title) == kind
    rng = random.Random(34)
    left, right = copied(db, rng, 40, title=title)
    pair = pair_of(scan(db), left, right)
    assert pair["category"] == "notice"
    assert pair["reasons"] == [f"notice:{right}:{kind}"]


@pytest.mark.parametrize("title", [
    "Correction of motion artifacts in brain imaging",
    "Retraction of the upper eyelid after surgery",
    "RETRACTED: A study of things",
])
def test_a_title_that_only_starts_like_a_notice_is_not_one(title: str):
    assert sw.notice_kind(title) is None


def test_short_abstracts_are_counted_not_compared(db):
    rng = random.Random(35)
    add(db, text(words(rng, 39)))
    add(db, None)
    add(db, "   ")
    add(db, text(words(rng, 40)))
    result = scan(db)
    assert result["not_compared"] == {"no_abstract": 2, "too_short": 1}
    assert result["compared"] == 1


# ---------------------------------------------------------------------------
# Common phrasing, counted in works
# ---------------------------------------------------------------------------

def _template_family(conn: sqlite3.Connection, rng: random.Random, records: int, template: list[str]) -> list[int]:
    return [add(conn, text(template, words(rng, 80)), authors=[f"Writer{n} Person{n}"]) for n in range(records)]


def test_a_template_in_more_than_three_works_is_common(db):
    rng = random.Random(40)
    family = _template_family(db, rng, 4, words(rng, 40))
    result = scan(db)
    assert result["pairs"] == []
    assert len(family) == 4


def test_the_same_template_in_three_works_is_shown(db):
    rng = random.Random(41)
    family = _template_family(db, rng, 3, words(rng, 40))
    result = scan(db)
    assert {(p["a"], p["b"]) for p in result["pairs"]} == {
        (family[0], family[1]), (family[0], family[2]), (family[1], family[2])}


def test_a_paper_held_from_four_sources_is_one_work(db):
    """Counting records would make its own abstract common, and hide a copy of it."""
    rng = random.Random(42)
    abstract_words = words(rng, 150)
    held = [add(db, text(abstract_words), doi="10.5555/held", authors=["Ada Lovelace"],
                source=source) for source in ("arxiv", "crossref", "openalex", "pubmed")]
    copy = add(db, text(words(rng, 30), abstract_words[20:80], words(rng, 30)), authors=["Grace Hopper"])
    result = scan(db)
    for record in held:
        pair = pair_of(result, record, copy)
        assert pair is not None and pair["category"] == "different_authors"
        assert pair["longest"] == 60
    assert all(pair_of(result, a, b)["category"] == "same_work" for a in held for b in held if a < b)


def test_common_phrases_still_count_in_the_numbers(db):
    rng = random.Random(43)
    template = words(rng, 30)
    _template_family(db, rng, 4, template)
    passage = words(rng, 30)
    left = add(db, text(template, passage, words(rng, 40)), authors=["Ada Lovelace"])
    right = add(db, text(template, passage, words(rng, 50)), authors=["Grace Hopper"])
    pair = pair_of(scan(db), left, right)
    # The template is in six works and the passage follows it: one run of 60
    # words, of which the 30 after the template are uncommon.
    assert pair["longest"] == 60
    assert pair["longest_uncommon"] >= 30
    assert pair["common_phrases"] > 0


# ---------------------------------------------------------------------------
# Stored, versioned, extended after a run
# ---------------------------------------------------------------------------

def _full(conn: sqlite3.Connection) -> dict:
    sw.scan_job.start(lambda: conn, "full")
    assert sw.scan_job.join()
    status = sw.scan_job.status()
    assert status["error"] is None, status
    return sw.load_state(conn)


def test_a_scan_is_stored_beside_the_database_with_the_method_version(db):
    rng = random.Random(50)
    left, right = copied(db, rng, 30)
    state = _full(db)
    path = sw.state_path(db)
    assert path is not None and path.name.endswith("-wording.json") and path.exists()
    stored = json.loads(path.read_text())
    assert stored["method_version"] == sw.METHOD_VERSION
    assert stored["kind"] == "full"
    assert [(p["a"], p["b"]) for p in state["pairs"]] == [(min(left, right), max(left, right))]


def test_an_answer_from_another_method_version_is_not_shown(db):
    rng = random.Random(51)
    left, right = copied(db, rng, 30)
    state = _full(db)
    state = {**state, "method_version": sw.METHOD_VERSION - 1}
    sw.save_state(db, state)
    view = sw.overview(db)
    assert view["state"] == "other_version" and view["groups"] == []
    with pytest.raises(LookupError):
        sw.pair_view(db, left, right)
    # And a run does not extend it: new papers against an old answer would
    # read as a whole answer.
    assert sw.scan_job.after_run(lambda: db) is False


def test_after_a_run_only_the_new_papers_are_compared(db):
    rng = random.Random(52)
    first = copied(db, rng, 30)
    original = add(db, text(words(rng, 150)), authors=["Ada Lovelace"])
    _full(db)
    before = sw.load_state(db)

    # A run brings a paper that copies one already held.
    held = db.execute("SELECT abstract FROM documents WHERE id = ?", (original,)).fetchone()[0]
    newcomer = add(db, " ".join(held.split()[10:60]) + " " + text(words(rng, 40)), authors=["Grace Hopper"])
    assert sw.scan_job.after_run(lambda: db) is True
    assert sw.scan_job.join()
    after = sw.load_state(db)

    assert after["kind"] == "new"
    assert after["full_scan_at"] == before["full_scan_at"]
    pairs = {(p["a"], p["b"]) for p in after["pairs"]}
    assert (min(first), max(first)) in pairs           # kept from before
    assert (original, newcomer) in pairs               # found now
    assert newcomer in after["documents"]["ids"]


def test_a_changed_text_is_compared_again_and_its_old_pair_dropped(db):
    rng = random.Random(53)
    left, right = copied(db, rng, 30)
    _full(db)
    db.execute("UPDATE documents SET abstract = ? WHERE id = ?", (text(words(rng, 120)), right))
    db.commit()
    view = sw.overview(db)
    assert view["withheld"] == 1 and all(g["count"] == 0 for g in view["groups"])
    sw.scan_job.after_run(lambda: db)
    assert sw.scan_job.join()
    assert sw.load_state(db)["pairs"] == []
    assert sw.overview(db)["withheld"] == 0


def test_a_run_on_a_collection_never_scanned_compares_nothing(db):
    rng = random.Random(54)
    copied(db, rng, 30)
    assert sw.scan_job.after_run(lambda: db) is False
    assert sw.load_state(db) is None


def test_a_cancelled_scan_keeps_the_answer_before_it(db):
    rng = random.Random(55)
    left, right = copied(db, rng, 30)
    stored = _full(db)
    result = sw.find_pairs(db, should_cancel=lambda: True)
    assert result["cancelled"] is True
    assert sw.load_state(db) == stored


# ---------------------------------------------------------------------------
# What the screen reads
# ---------------------------------------------------------------------------

def test_the_pair_view_highlights_the_passage_in_both_texts(db):
    rng = random.Random(60)
    passage = words(rng, 33)
    left = add(db, text(words(rng, 50), passage, words(rng, 50)), authors=["Ada Lovelace"], date="2021-03-02")
    right = add(db, text(words(rng, 20), passage, words(rng, 80)), authors=["Grace Hopper"], date="2020-06-05")
    _full(db)
    view = sw.pair_view(db, left, right)
    # The earlier date is on the left, only as a reading order.
    assert (view["left"]["id"], view["right"]["id"]) == (right, left)
    assert len(view["passages"]) == 1
    span = view["passages"][0]
    assert span["words"] == 33
    for side in ("left", "right"):
        start, end = span[side]
        shown = view[side]["text"][start:end]
        assert sw.read_words(shown).words == passage
    assert view["summary"][0].startswith("These two abstracts share a 33-word passage word for word and ")
    assert view["summary"][1] == "They list no author in common."
    assert view["summary"][2] == "The first was published June 5, 2020, and the second March 2, 2021."
    assert view["definitions"] == sw.DEFINITIONS and view["limits"] == sw.LIMITS


def test_the_words_never_say_more_than_was_measured():
    assert sw.percent_words(0.589) == "58%"
    assert sw.percent_words(0.999) == "99%"
    assert sw.percent_words(1.0) == "100%"
    assert sw.percent_words(0.004) == "under 1%"
    assert sw.date_words("2021-03-02") == "March 2, 2021"
    assert sw.date_words("2021-03") == "March 2021"
    assert sw.date_words("2021") == "2021"
    banned = ("plagiar", "copied", "stolen", "theft", "original", "infring", "misconduct", "suspicious")
    said = " ".join([*sw.DEFINITIONS.values(), *sw.LIMITS, *sw.LIBRARY_LIMITS, *sw.CATEGORY_LABELS.values(),
                     *sw.CATEGORY_NOTES.values(), *sw.REASON_WORDS.values()]).lower()
    assert not [word for word in banned if word in said]


def test_a_papers_own_pairs(db):
    rng = random.Random(61)
    left, right = copied(db, rng, 30)
    loner = add(db, text(words(rng, 100)))
    _full(db)
    mine = sw.pairs_for(db, left)
    assert mine["compared"] is True
    assert [(p["a"], p["b"]) for p in mine["pairs"]] == [(min(left, right), max(left, right))]
    assert sw.pairs_for(db, loner)["pairs"] == []


def test_a_scan_that_ends_after_an_erase_saves_nothing(db, monkeypatch):
    """The corpus is erased while a scan runs: its answer, about erased papers, is not kept."""
    copied(db, random.Random(72), 30)
    db.commit()
    original = sw.find_pairs

    def erased_meanwhile(conn, **kwargs):
        result = original(conn, **kwargs)
        sw.forget(conn)  # the erase lands while the scan is comparing
        return result

    monkeypatch.setattr(sw, "find_pairs", erased_meanwhile)
    sw.scan_job.start(lambda: db, "full")
    assert sw.scan_job.join()
    path = sw.state_path(db)
    assert path is not None and not path.exists()
    assert sw.load_state(db) is None
    assert sw.scan_job.status()["error"] is None


# ---------------------------------------------------------------------------
# Through the routes
# ---------------------------------------------------------------------------

@pytest.fixture
def client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    yield TestClient(resmon_mod.app)
    sw.scan_job.join()
    sw.forget(resmon_mod._get_db())


def test_the_routes_scan_list_and_open_a_pair(client):
    conn = resmon_mod._get_db()
    rng = random.Random(70)
    left, right = copied(conn, rng, 30)
    assert client.get("/api/shared-wording").json()["state"] == "never"

    started = client.post("/api/shared-wording/scan")
    assert started.status_code == 200, started.text
    assert started.json()["running"] is True
    assert sw.scan_job.join()

    body = client.get("/api/shared-wording").json()
    assert body["state"] == "ready"
    assert body["scan"]["compared"] == 2
    groups = {g["category"]: g for g in body["groups"]}
    assert groups["different_authors"]["count"] == 1
    a, b = min(left, right), max(left, right)
    assert (groups["different_authors"]["pairs"][0]["a"], groups["different_authors"]["pairs"][0]["b"]) == (a, b)

    view = client.get(f"/api/shared-wording/pairs/{b}/{a}")
    assert view.status_code == 200, view.text
    assert view.json()["longest"] == 30
    assert client.get(f"/api/shared-wording/papers/{left}").json()["pairs"][0]["a"] == a
    assert client.get(f"/api/shared-wording/pairs/{a}/{a + 999}").status_code == 404


def test_a_second_scan_while_one_runs_is_refused(client, monkeypatch):
    import threading
    release = threading.Event()
    original = sw.find_pairs

    def slow(*args, **kwargs):
        release.wait(10)
        return original(*args, **kwargs)

    monkeypatch.setattr(sw, "find_pairs", slow)
    assert client.post("/api/shared-wording/scan").status_code == 200
    second = client.post("/api/shared-wording/scan")
    assert second.status_code == 409
    assert "already running" in second.json()["detail"]
    release.set()
    assert sw.scan_job.join()


def test_erasing_the_corpus_erases_the_answer(client):
    conn = resmon_mod._get_db()
    copied(conn, random.Random(71), 30)
    client.post("/api/shared-wording/scan")
    assert sw.scan_job.join()
    path = sw.state_path(conn)
    assert path is not None and path.exists()
    response = client.post("/api/admin/erase-corpus", json={"confirm": "CONFIRM"})
    assert response.status_code == 200, response.text
    assert not path.exists()
    assert client.get("/api/shared-wording").json()["state"] == "never"


def _launch(run_prepared) -> int:
    """A run through the engine's own launcher, with ``run_prepared`` standing in for the sources."""
    import time
    from unittest.mock import patch
    from implementation_scripts.admission import admission
    from implementation_scripts.progress import progress_store
    from implementation_scripts.sweep_engine import SweepEngine

    conn = resmon_mod._get_db()
    with patch("resmon.SweepEngine.run_prepared", run_prepared):
        engine = SweepEngine(db_conn=conn, config={"ai_enabled": False, "ai_settings": None})
        exec_id = engine.prepare_execution("deep_dive", [], {"query": "x"})
        progress_store.register(exec_id)
        resmon_mod._launch_execution(engine, exec_id, conn)
        # The admission slot is returned after every hook has run.
        deadline = time.monotonic() + 10
        time.sleep(0.05)
        while exec_id in admission._active and time.monotonic() < deadline:
            time.sleep(0.05)
    return exec_id


def test_a_finished_run_with_new_papers_compares_them(client):
    from implementation_scripts import database
    conn = resmon_mod._get_db()
    rng = random.Random(72)
    held_words = words(rng, 150)
    held = add(conn, text(held_words), authors=["Ada Lovelace"])
    client.post("/api/shared-wording/scan")
    assert sw.scan_job.join()
    assert sw.load_state(conn)["pairs"] == []
    newcomer: dict = {}

    def run_prepared(self, exec_id: int) -> dict:
        newcomer["id"] = add(self.db, text(held_words[30:90], words(rng, 60)), authors=["Grace Hopper"])
        database.update_execution_status(self.db, exec_id, "completed", new_result_count=1)
        return {"execution_id": exec_id}

    _launch(run_prepared)
    assert sw.scan_job.join()
    state = sw.load_state(conn)
    assert state["kind"] == "new"
    assert [(p["a"], p["b"], p["longest"]) for p in state["pairs"]] == [(held, newcomer["id"], 60)]


def test_a_run_that_brought_nothing_new_starts_nothing(client, monkeypatch):
    from implementation_scripts import database
    calls: list[int] = []
    monkeypatch.setattr(sw.scan_job, "after_run", lambda *a, **k: calls.append(1) or True)

    def run_prepared(self, exec_id: int) -> dict:
        database.update_execution_status(self.db, exec_id, "completed", new_result_count=0)
        return {"execution_id": exec_id}

    _launch(run_prepared)
    assert calls == []


# ---------------------------------------------------------------------------
# A Library file, page by page
# ---------------------------------------------------------------------------

@pytest.fixture
def vault(tmp_path: Path):
    from implementation_scripts import database as dbm, library as lib
    database = tmp_path / "library.db"
    conn = dbm.get_connection(database)
    dbm.init_db(conn=conn)
    parent = tmp_path / "vault-parent"
    parent.mkdir()
    configured = lib.create_vault(conn, str(parent))["vault"]

    def put(name: str, raw: bytes, document_id: int | None = None) -> dict:
        with lib.Import(conn, configured["vault_id"], name, document_id) as upload:
            upload.write(raw)
            return upload.finish()["file"]

    try:
        yield conn, configured["vault_id"], put
    finally:
        conn.close()


def test_a_text_file_is_compared_with_the_abstracts(vault):
    conn, vault_id, put = vault
    rng = random.Random(80)
    passage = words(rng, 40)
    source = add(conn, text(words(rng, 60), passage, words(rng, 60)), authors=["Ada Lovelace"])
    add(conn, text(words(rng, 150)))
    item = put("notes.txt", (text(words(rng, 100), passage, words(rng, 100)) + "\n").encode())
    result = sw.compare_file(conn, vault_id, item["file_id"], item["version_id"])
    assert result["pages_read"] == 1 and result["abstracts_compared"] == 2
    assert [(m["kind"], m["document_id"], m["page"], m["longest"]) for m in result["matches"]] == [
        ("paper", source, 1, 40)]
    assert sw.read_words(result["matches"][0]["passages"][0]["text"]).words == passage
    assert result["matches"][0]["linked"] is False


def test_a_pdf_is_read_page_by_page_and_names_the_page(vault, monkeypatch):
    from test_evidence_pdf import text_pages
    from implementation_scripts import evidence, evidence_pdf
    conn, vault_id, put = vault
    rng = random.Random(81)
    passage = words(rng, 30)
    other_passage = words(rng, 25)
    paper = add(conn, text(words(rng, 60), passage, words(rng, 60)), authors=["Ada Lovelace"])
    pdf = put("paper.pdf", text_pages([text(words(rng, 60)), text(words(rng, 20), passage, words(rng, 20)),
                                       text(words(rng, 10), other_passage, words(rng, 30))]), paper)
    put("other.txt", (text(words(rng, 50), other_passage, words(rng, 50)) + "\n").encode())

    # The reader is single-page for the whole engine: a busy refusal is waited
    # out, not counted as an unread page.
    real = evidence_pdf.extract
    busy = {"left": 2}

    def sometimes_busy(raw: bytes, page: int, **kwargs):
        if busy["left"]:
            busy["left"] -= 1
            evidence.refuse("reader_busy", "Another bounded PDF page is being read.", 409)
        return real(raw, page, **kwargs)

    monkeypatch.setattr(evidence_pdf, "extract", sometimes_busy)
    waits: list[float] = []
    result = sw.compare_file(conn, vault_id, pdf["file_id"], pdf["version_id"], wait=waits.append)
    assert waits == [0.25, 0.25]
    assert (result["page_count"], result["pages_read"], result["pages_unread"]) == (3, 3, [])
    found = {(m["kind"], m["page"], m.get("document_id"), m.get("other_page")): m for m in result["matches"]}
    assert set(found) == {("paper", 2, paper, None), ("file", 3, None, 1)}
    assert found[("paper", 2, paper, None)]["linked"] is True
    assert found[("paper", 2, paper, None)]["longest"] == 30
    assert found[("file", 3, None, 1)]["longest"] == 25
    assert sw.read_words(found[("file", 3, None, 1)]["passages"][0]["text"]).words == other_passage
