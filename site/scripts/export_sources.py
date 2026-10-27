"""Write the site's copy of the source catalog: ``site/src/data/sources.json``.

The project site lists every source resmon searches, with its key requirement,
rate limit, keyword behavior and date precision. Those are statements of fact
about someone else's service, and the catalog in
``resmon_scripts/implementation_scripts/repo_catalog.py`` is where resmon keeps
them. The site is built by Node without Python, so it reads this JSON instead,
and ``verification_scripts/test_site_sources.py`` fails when the file no longer
matches the catalog: the site cannot say something about a source the app does
not.

Run from the repository root:

    .venv/bin/python site/scripts/export_sources.py
"""

from __future__ import annotations

import dataclasses
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "src" / "data" / "sources.json"

# The fields the site shows. Each one is rendered as written in the catalog.
FIELDS = (
    "slug",
    "name",
    "description",
    "subject_coverage",
    "website",
    "api_key_requirement",
    "rate_limit",
    "keyword_combination",
    "date_granularity",
    "attribution",
    "attribution_requirement",
)


def build() -> str:
    sys.path.insert(0, str(ROOT / "resmon_scripts" / "implementation_scripts"))
    from repo_catalog import REPOSITORY_CATALOG  # noqa: E402  (path set above)

    entries = []
    for entry in REPOSITORY_CATALOG:
        record = dataclasses.asdict(entry)
        out = {field: record.get(field) for field in FIELDS}
        search = record.get("entity_search") or {}
        out["author_search"] = search.get("author_query", "unknown")
        entries.append(out)
    return json.dumps({"count": len(entries), "sources": entries}, indent=2, ensure_ascii=False) + "\n"


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(build(), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
