"""The repository's name is written once, and every literal copy agrees with it.

``config.REPOSITORY`` is the one place the name is chosen. The sources'
User-Agent strings are built from it, so they cannot drift. A few places cannot
import it and must spell it out: ``package.json`` (``repository`` and
``build.publish``), the workflows' ``github.repository ==`` guards (held in
``workflow_jobs.REPOSITORY_GUARD``, a literal on purpose), the issue-template
config, and Atlas's ``REPOSITORY`` constant. This test reads each of those and
compares it with ``config.py``. Renaming the project means changing
``config.REPOSITORY`` and following this test's failures to the places it names.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import config  # noqa: E402
from workflow_jobs import REPOSITORY_GUARD, WORKFLOWS_DIR  # noqa: E402

_FRONTEND = PROJECT_ROOT / "resmon_scripts" / "frontend"
_OWNER, _REPO = config.REPOSITORY.split("/")


def _package() -> dict:
    return json.loads((_FRONTEND / "package.json").read_text(encoding="utf-8"))


def test_the_url_constants_are_built_from_the_name():
    assert config.REPOSITORY_URL == f"https://github.com/{config.REPOSITORY}"
    assert config.REPOSITORY_ISSUES_URL == f"{config.REPOSITORY_URL}/issues"


def test_package_json_names_the_repository_twice_and_both_agree():
    package = _package()
    assert package["repository"] == {"type": "git", "url": f"{config.REPOSITORY_URL}.git"}
    publish = package["build"]["publish"]
    assert publish == [{"provider": "github", "owner": _OWNER, "repo": _REPO}]


def test_the_workflow_guard_constant_is_the_repository():
    assert REPOSITORY_GUARD == f"github.repository == '{config.REPOSITORY}'"


def test_every_guard_in_every_workflow_names_the_repository():
    pattern = re.compile(r"github\.repository\s*==\s*'([^']*)'")
    seen = 0
    for path in sorted(WORKFLOWS_DIR.glob("*.yml")):
        for name in pattern.findall(path.read_text(encoding="utf-8")):
            seen += 1
            assert name == config.REPOSITORY, f"{path.name} guards on {name!r}"
    assert seen, "no workflow carries a repository guard"


def test_the_issue_template_config_links_the_repository():
    text = (PROJECT_ROOT / ".github" / "ISSUE_TEMPLATE" / "config.yml").read_text(encoding="utf-8")
    urls = re.findall(r"^\s*url:\s*(\S+)\s*$", text, re.M)
    assert urls == [config.REPOSITORY_URL], urls


def test_atlas_names_the_same_repository():
    facts = (_FRONTEND / "atlas" / "src" / "screens" / "settings" / "aboutFacts.ts").read_text(encoding="utf-8")
    declared = re.findall(r"^export const REPOSITORY = '([^']+)';$", facts, re.M)
    assert declared == [config.REPOSITORY], declared
    assert "export const ISSUES_URL = `https://github.com/${REPOSITORY}/issues`;" in facts


def test_no_source_client_spells_the_repository_out():
    """The User-Agent strings take it from ``config``; a literal copy would drift."""
    offenders = [
        path.name
        for path in sorted((PROJECT_ROOT / "resmon_scripts" / "implementation_scripts").glob("*.py"))
        if path.name != "config.py" and config.REPOSITORY in path.read_text(encoding="utf-8")
    ]
    assert offenders == [], offenders
