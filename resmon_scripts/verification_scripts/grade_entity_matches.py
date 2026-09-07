#!/usr/bin/env python3
"""The field test: precision per basis, on a copy of the real corpus (P11).

**Opt-in, and never part of the suite.** It makes real requests to real
scholarly APIs and writes into a database, so it is a script somebody runs
deliberately against a *copy* of a corpus, never a test that runs itself.

## What it measures, and what it refuses to

It produces the sample. **It does not grade it**, and that separation is the
whole design: a precision figure is a human judgement about whether a paper
really is that person's, and a program that scored its own matcher would be
measuring agreement with itself. The script writes `sample.json` with everything
a grader needs — the paper, its full author list, the string that matched, the
basis and the evidence — and a grader fills in a verdict per row.

The 1.9b method, applied to a different rule: three profiles chosen to exercise
the three bases, a fixed sample per basis, graded by somebody who did not write
the matcher.

## Why the three profiles are what they are

* **An ORCID and nothing else.** A source that returns the ORCID produces
  `identifier`; the same person from a source that does not produces
  `name_only`. One profile, two bases, and the `name_only` half is the honest
  hard case — a well-known name, so a grader can actually tell.
* **A common name with an affiliation and no identifier.** This is the only way
  to produce `name+affiliation`, and it is deliberately the adversarial version:
  a name shared by many researchers, where the affiliation is the entire
  difference between a claim and a guess.
* **A common name with nothing at all.** The initials rule lives here. It is on,
  it is the largest expected source of `name_only` false positives, and this is
  the profile that measures what it costs.

## Usage

    .venv/bin/python resmon_scripts/verification_scripts/grade_entity_matches.py \\
        --database /path/to/a/COPY/of/corpus.db --out workspace/.../evidence

Never point it at a live corpus. It runs real sweeps and writes documents.
"""

from __future__ import annotations

import argparse
import json
import random
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import watch_profiles as wp          # noqa: E402
from implementation_scripts.api_registry import get_client       # noqa: E402
from implementation_scripts.database import init_db              # noqa: E402
from implementation_scripts.entity_matching import BASES, match  # noqa: E402
from implementation_scripts.repo_catalog import REPOSITORY_CATALOG  # noqa: E402

# Keyless and askable. A source needing a key this machine may not hold would
# contribute a silent zero to the sample rather than a measurement.
_KEYED = {"core", "nasa_ads", "springer"}

PROFILES = [
    {
        "label": "orcid",
        "kind": "person",
        "display_name": "Jennifer Doudna",
        "names": [{"value": "Jennifer Doudna"}, {"value": "Jennifer A. Doudna"}],
        # From the shipped starter set, where it was checked against
        # `pub.orcid.org` on 2026-09-06 and the citation stored with it.
        "identifiers": {"orcid": {
            "value": "0000-0001-9161-999X",
            "cited": "resmon's starter directory; checked against "
                     "pub.orcid.org/v3.0/0000-0001-9161-999X/person on 2026-09-06",
        }},
        "affiliations": [],
        "field_hints": [],
    },
    {
        # **A distinctive name with an affiliation and no identifier.** The same
        # person as above with the ORCID taken away, so the two rows differ by
        # exactly the thing the basis rule is about.
        "label": "affiliation_distinctive",
        "kind": "person",
        "display_name": "Jennifer Doudna",
        "names": [{"value": "Jennifer Doudna"}, {"value": "Jennifer A. Doudna"}],
        "identifiers": {},
        "affiliations": ["University of California, Berkeley"],
        "field_hints": [],
    },
    {
        # **A common name with an affiliation and no identifier**, which is the
        # adversarial half: the affiliation is the entire difference between a
        # claim and a guess, and `_affiliation_hit` is substring containment on
        # folded text, so every institute inside the Academy matches.
        #
        # The first run of this script used "Peking University" and produced
        # **zero** `name+affiliation` matches in 500 candidates — not because the
        # rule is broken but because no Wei Wang at Peking University was in
        # range. That is recorded in the handback: for a name this common, a
        # specific affiliation almost never appears, which is itself a finding
        # about how often this basis can fire at all.
        "label": "affiliation_common",
        "kind": "person",
        "display_name": "Wei Wang",
        "names": [{"value": "Wei Wang"}],
        "identifiers": {},
        "affiliations": ["Chinese Academy of Sciences"],
        "field_hints": [],
    },
    {
        "label": "name_only",
        "kind": "person",
        "display_name": "John Smith",
        "names": [{"value": "John Smith"}],
        "identifiers": {},
        "affiliations": [],
        "field_hints": [],
    },
]

PER_BASIS = 30


def askable_keyless() -> list[str]:
    return sorted(
        e.slug for e in REPOSITORY_CATALOG
        if e.entity_search.supported and e.slug not in _KEYED
    )


def collect(conn: sqlite3.Connection, sources: list[str],
            max_results: int) -> list[dict]:
    """Every candidate every source returned, with the matcher's verdict on it.

    Rejected candidates are kept in the raw record — a precision figure needs
    the denominator the source produced, not only the numerator resmon accepted.
    """
    rows: list[dict] = []
    for spec in PROFILES:
        profile = wp.create_profile(conn, dict(spec))
        for slug in sources:
            try:
                records = get_client(slug).search_entity(
                    profile, max_results=max_results)
            except Exception as exc:                    # an outage is not a match
                print(f"  {spec['label']:<12} {slug:<18} — {type(exc).__name__}",
                      file=sys.stderr)
                continue
            kept = 0
            for record in records:
                found = match(record.authors or [], profile)
                if found is None:
                    continue
                kept += 1
                rows.append({
                    "profile": spec["label"],
                    "profile_name": spec["display_name"],
                    "source": slug,
                    "external_id": record.external_id,
                    "title": record.title,
                    "doi": record.doi,
                    "url": record.url,
                    "publication_date": record.publication_date,
                    "authors": [
                        {"name": a.name, "orcid": a.orcid,
                         "affiliations": list(a.affiliations or ())}
                        for a in (record.authors or [])
                    ],
                    "basis": found.basis,
                    "matched_author": found.matched_author,
                    "evidence": found.evidence,
                    # Filled in by a person. `true` = this really is that person.
                    "verdict": None,
                    "grader_note": "",
                })
            print(f"  {spec['label']:<12} {slug:<18} {len(records):>3} returned, "
                  f"{kept:>3} matched", file=sys.stderr)
    return rows


def sample(rows: list[dict], per_basis: int, seed: int) -> dict:
    """A fixed sample per basis, drawn reproducibly.

    Seeded so a re-grade draws the same rows, and shuffled rather than taken
    from the head so the sample is not "whatever the first source returned".
    """
    rng = random.Random(seed)
    out: dict = {}
    for basis in BASES:
        pool = [r for r in rows if r["basis"] == basis]
        rng.shuffle(pool)
        out[basis] = pool[:per_basis]
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True,
                        help="a COPY of a corpus. Never a live one.")
    parser.add_argument("--out", required=True, help="directory for the evidence")
    parser.add_argument("--max-results", type=int, default=50)
    parser.add_argument("--seed", type=int, default=2026)
    args = parser.parse_args()

    database = Path(args.database)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(database), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # The upgrade path, on a real corpus. Schema 13's index over
    # `document_authors(orcid)` broke exactly this and a fresh database never
    # meets it, so running it here is part of the field test rather than setup.
    init_db(conn=conn)

    sources = askable_keyless()
    print(f"asking {len(sources)} sources about {len(PROFILES)} profiles",
          file=sys.stderr)
    rows = collect(conn, sources, args.max_results)

    (out / "all-matches.json").write_text(
        json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    drawn = sample(rows, PER_BASIS, args.seed)
    (out / "sample.json").write_text(
        json.dumps(drawn, indent=2, ensure_ascii=False), encoding="utf-8")

    print(json.dumps({b: len(v) for b, v in drawn.items()}, indent=2))
    print(json.dumps(
        {b: sum(1 for r in rows if r["basis"] == b) for b in BASES}, indent=2))
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
