"""The project site lists every source from a JSON copy of the catalog.

``site/src/data/sources.json`` is written by ``site/scripts/export_sources.py``
from ``REPOSITORY_CATALOG``, because the site is built by Node and cannot import
the catalog. The site states each source's key requirement, rate limit, keyword
behavior and date precision as fact, so a copy that drifted from the catalog
would have the site say something about a source that the app does not. This
test fails when it has: rerun the script and commit the file.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "site" / "scripts" / "export_sources.py"
COPY = ROOT / "site" / "src" / "data" / "sources.json"


def _exporter():
    spec = importlib.util.spec_from_file_location("export_sources", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_the_site_copy_of_the_catalog_is_current():
    expected = _exporter().build()
    assert COPY.read_text(encoding="utf-8") == expected, (
        "site/src/data/sources.json no longer matches the catalog. Run "
        "`.venv/bin/python site/scripts/export_sources.py` and commit the result."
    )


def test_the_site_lists_every_shipped_source_once():
    from implementation_scripts.repo_catalog import REPOSITORY_CATALOG

    data = json.loads(COPY.read_text(encoding="utf-8"))
    slugs = [entry["slug"] for entry in data["sources"]]
    assert data["count"] == len(slugs) == len(set(slugs))
    assert slugs == [entry.slug for entry in REPOSITORY_CATALOG]


#: Where the site's guide and the README write the number of sources in words a
#: reader takes as a count: "26 open scholarly sources", "The 26 sources",
#: "Of the 26 sources", "lists all 26".
COUNT_PHRASES = (
    r"\b(\d+) open scholarly sources\b",
    r"\b[Tt]he (\d+) sources\b",
    r"\bOf the (\d+) sources\b",
    r"\blists all (\d+)\b",
)


def test_every_written_count_of_the_sources_is_the_catalogs():
    """The home page says the count from the catalog when it is built; the guide
    and the README are prose, so a source added or retired has to be counted
    again there. This names every place that still says the old number."""
    import re

    from implementation_scripts.repo_catalog import REPOSITORY_CATALOG

    pages = sorted((ROOT / "site" / "src" / "content").rglob("*.md")) + [ROOT / "README.md"]
    wrong = []
    for page in pages:
        for line_number, line in enumerate(page.read_text(encoding="utf-8").splitlines(), start=1):
            for phrase in COUNT_PHRASES:
                for match in re.finditer(phrase, line):
                    if int(match.group(1)) != len(REPOSITORY_CATALOG):
                        wrong.append(f"{page.relative_to(ROOT)}:{line_number}: {match.group(0)!r}")
    assert not wrong, (
        f"The catalog holds {len(REPOSITORY_CATALOG)} sources, and these say otherwise:\n" + "\n".join(wrong)
    )
