"""The backend, the renderer, and the command line must report the same version.

``GET /api/health`` serves ``APP_VERSION``, About -> About App renders exactly
that field, and the command line prints and sends its own ``__version__``. When
they differ, a user is told they are running a version they are not, and the
check that decides whether a running service is this app's own compares them.
The release is the one moment these files must agree, so a test holds them
together instead of leaving it to whoever cuts the release.
"""

import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.config import APP_VERSION

_PACKAGE_JSON = PROJECT_ROOT / "resmon_scripts" / "frontend" / "package.json"
_CLI_INIT = PROJECT_ROOT / "resmon_scripts" / "cli" / "resmon_cli" / "__init__.py"


def _package_version() -> str:
    with open(_PACKAGE_JSON, encoding="utf-8") as handle:
        return json.load(handle)["version"]


def test_backend_and_renderer_versions_match():
    assert APP_VERSION == _package_version(), (
        f"config.py APP_VERSION is {APP_VERSION} but package.json is "
        f"{_package_version()}. Both must be bumped together — "
        f"/api/health serves APP_VERSION and About → About App displays it."
    )


def _cli_version() -> str:
    """Read ``__version__`` from the source, so the check needs no install."""
    match = re.search(r'^__version__ = "([^"]+)"$', _CLI_INIT.read_text(encoding="utf-8"), re.M)
    assert match, f"no __version__ in {_CLI_INIT}"
    return match.group(1)


def test_command_line_carries_the_app_version():
    assert _cli_version() == APP_VERSION, (
        f"resmon_cli.__version__ is {_cli_version()} but config.py APP_VERSION is "
        f"{APP_VERSION}. The command line carries the app's version; bump all "
        f"three together."
    )


def test_package_lock_root_entries_match():
    lock = json.loads((_PACKAGE_JSON.parent / "package-lock.json").read_text(encoding="utf-8"))
    assert lock["version"] == _package_version(), lock["version"]
    assert lock["packages"][""]["version"] == _package_version(), lock["packages"][""]["version"]


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
