#!/usr/bin/env python3
"""Can each source be asked for one paper, and does resmon's own request find it?

Find a paper asks a source only by a kind of query the catalog's
``paper_lookup`` capability names, and each capability has to be established
with a live record and cited. This is that record. Opt-in, like
``probe_entity_search.py``: run it, read what it wrote, put the answers in the
catalog with their citations.

Every probe goes through resmon's own client (``client.lookup``) and resmon's
own matching (``paper_find.best_match``), so what it establishes is that
resmon's request finds the paper, not that the documentation says it should.
Each kind is run twice:

| | |
|---|---|
| **A** | a real paper inside the source's coverage, by that kind |
| **B** | an identifier or a title that does not exist |

The capability holds when A finds the paper and B finds nothing that matches.
A that finds nothing is "not established" for that kind, whatever the
documentation says.

It reads one query per kind per source on one day; a source that changes its
query parser leaves this record stale.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import api_registry, paper_find, repo_catalog  # noqa: E402
from implementation_scripts.api_base import reset_search_outcome, search_outcome  # noqa: E402

MISSING = {
    "doi": "10.9999/resmon-probe-does-not-exist-2026",
    "arxiv": "2401.99999",
    "pmid": "999999999",
    "title": "Zzqxwvyt Pflurgenhaus resmon probe title of no paper at all",
}

# One real paper per source, chosen inside that source's coverage. A paper is
# named by every kind the source is probed for; "discover" fills in what is
# read from an earlier answer.
ATTENTION = {"arxiv": "1706.03762", "title": "Attention Is All You Need"}
HIGGS = {"doi": "10.1016/j.physletb.2012.08.020", "arxiv": "1207.7214",
         "title": "Observation of a new particle in the search for the Standard Model Higgs boson "
                  "with the ATLAS detector at the LHC"}
PLOS = {"doi": "10.1371/journal.pone.0000308"}


def ask(slug: str, kind: str, value: str) -> dict:
    client = api_registry.get_client(slug)
    reset_search_outcome()
    started = time.monotonic()
    try:
        results = client.lookup(kind, value, max_results=paper_find.CANDIDATES)
        error = None
    except Exception as exc:  # noqa: BLE001 - the probe records it
        results, error = [], f"{type(exc).__name__}: {exc}"
    snapshot = search_outcome().snapshot()
    query = paper_find.PaperQuery(kind, value.lower() if kind != "title" else value, value)
    match = paper_find.best_match(results, query)
    return {
        "source": slug, "kind": kind, "value": value, "seconds": round(time.monotonic() - started, 2),
        "candidates": len(results), "matched_by": match.matched_by if match else None,
        "matched_title": getattr(match.record, "title", None) if match else None,
        "doi": getattr(match.record, "doi", None) if match else None,
        "identifiers": list(getattr(match.record, "identifiers", []) or []) if match else [],
        "attempts": snapshot.get("attempts"), "last_status": snapshot.get("last_status"),
        "sent": snapshot.get("queries_sent"), "error": error,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()
    api_registry._ensure_loaded()
    rows: list[dict] = []

    def probe(slug: str, paper: dict) -> dict:
        found = {}
        for kind in repo_catalog.PAPER_LOOKUP[slug].kinds:
            if kind not in paper:
                continue
            a = ask(slug, kind, paper[kind])
            missing = ("10.1101/2099.12.31.999999" if slug in ("biorxiv", "medrxiv") and kind == "doi"
                       else MISSING[kind])
            b = ask(slug, kind, missing)
            time.sleep(1.0)
            rows.extend([{**a, "case": "A"}, {**b, "case": "B"}])
            print(f"{slug:16} {kind:6} A={a['matched_by']} ({a['candidates']}) "
                  f"B={b['matched_by']} ({b['candidates']}) {a['error'] or ''}", flush=True)
            if a["matched_by"]:
                found = a
        return found

    plan = args.only or [s for s, c in repo_catalog.PAPER_LOOKUP.items() if c.kinds]
    # The PLOS paper's title and PMID, read from Crossref and OpenAlex first.
    plos = dict(PLOS)
    seed = ask("crossref", "doi", plos["doi"])
    plos["title"] = seed["matched_title"]
    seed = ask("openalex", "doi", plos["doi"])
    plos.update({k: v for k, v in seed["identifiers"] if k == "pmid"})
    print("PLOS paper:", plos, flush=True)

    for slug in plan:
        if slug == "arxiv":
            probe(slug, ATTENTION)
        elif slug == "inspire_hep":
            probe(slug, HIGGS)
        elif slug == "dblp":
            probe(slug, ATTENTION)
        elif slug == "semantic_scholar":
            probe(slug, {**plos, "arxiv": ATTENTION["arxiv"]})
        elif slug in ("biorxiv", "medrxiv"):
            client = api_registry.get_client(slug)
            listing = client.search("", date_from="2024-01-02", date_to="2024-01-02", max_results=1)
            if listing:
                probe(slug, {"doi": listing[0].doi})
        elif slug in ("datacite", "zenodo"):
            listing = api_registry.get_client("zenodo").search("ocean temperature", max_results=3)
            paper = next(({"doi": r.doi, "title": r.title} for r in listing if r.doi), None)
            if paper:
                probe(slug, paper)
        elif slug == "hal":
            listing = api_registry.get_client("hal").search('doiId_s:*', max_results=5)
            paper = next(({"doi": r.doi, "title": r.title} for r in listing if r.doi), None)
            if paper:
                probe(slug, paper)
        elif slug == "eric":
            listing = api_registry.get_client("eric").search("reading comprehension", max_results=1)
            if listing:
                probe(slug, {"title": listing[0].title})
        else:
            probe(slug, plos)

    args.out.write_text(json.dumps({"probed_on": repo_catalog.LOOKUP_PROBED_ON, "rows": rows}, indent=1))
    print(f"wrote {len(rows)} rows to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
