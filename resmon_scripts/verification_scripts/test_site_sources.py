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
