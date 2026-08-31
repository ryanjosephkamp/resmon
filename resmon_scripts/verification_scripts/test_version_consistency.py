"""The backend and the renderer must report the same version.

This test exists because they did not. v1.8.0 was tagged on the 1.8b feature
commit, which bumped ``package.json`` to 1.8.0 and left
``config.py``'s ``APP_VERSION`` at 1.7.0 — so every v1.8.0 install answered
``GET /api/health`` with ``"version": "1.7.0"``, and About → About App, which
renders exactly that field, told users they were running the previous release.

Nothing caught it because nothing was looking. A release is the one moment
these two files must agree, and it is also the moment when the person cutting
it is thinking about everything else.
"""

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.config import APP_VERSION

_PACKAGE_JSON = PROJECT_ROOT / "resmon_scripts" / "frontend" / "package.json"


def _package_version() -> str:
    with open(_PACKAGE_JSON, encoding="utf-8") as handle:
        return json.load(handle)["version"]


def test_backend_and_renderer_versions_match():
    assert APP_VERSION == _package_version(), (
        f"config.py APP_VERSION is {APP_VERSION} but package.json is "
        f"{_package_version()}. Both must be bumped in the release commit — "
        f"/api/health serves APP_VERSION and About → About App displays it."
    )


def test_version_is_a_three_part_release_number():
    """The release workflow triggers on tags matching v[0-9]+.[0-9]+.[0-9]+."""
    parts = APP_VERSION.split(".")
    assert len(parts) == 3, APP_VERSION
    assert all(part.isdigit() for part in parts), APP_VERSION


def test_health_endpoint_serves_the_same_version():
    """The field a user actually sees, checked through the endpoint itself."""
    from fastapi.testclient import TestClient

    import resmon as resmon_mod

    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from resmon import app

    payload = TestClient(app).get("/api/health").json()
    assert payload["version"] == _package_version()
