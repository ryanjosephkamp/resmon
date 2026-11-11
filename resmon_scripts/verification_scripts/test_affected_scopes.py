"""`.github/scripts/affected.sh` decides which suites a pull request skips.

A suite that skips wrongly is a red check nobody sees, so the rule is tested
here on the cases that matter: a merge always runs everything, a file in a
suite's scope runs it, and a file nobody has classified runs every suite.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / ".github" / "scripts" / "affected.sh"


def decide(scope: str, files: list[str] | None, event: str = "pull_request", tmp_path: Path | None = None) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GITHUB_")}
    env["GITHUB_EVENT_NAME"] = event
    if files is not None:
        env["CHANGED_FILES"] = "\n".join(files)
    out = tmp_path / "output" if tmp_path else None
    if out:
        out.unlink(missing_ok=True)
        env["GITHUB_OUTPUT"] = str(out)
    result = subprocess.run(["bash", str(SCRIPT), scope], env=env, capture_output=True, text=True, check=True)
    text = out.read_text() if out else result.stdout
    lines = [line for line in text.splitlines() if line.startswith("run=")]
    assert len(lines) == 1, text
    return lines[0].removeprefix("run=")


SITE_ONLY = ["site/src/content/guide/search.md", "docs/guide/search/index.html"]
FRONTEND_ONLY = ["resmon_scripts/frontend/atlas/src/screens/Run.tsx"]
ENGINE_ONLY = ["resmon_scripts/implementation_scripts/sweep_engine.py"]


@pytest.mark.parametrize("scope", ["app", "frontend", "engine"])
def test_a_merge_or_a_manual_run_always_runs_everything(scope, tmp_path):
    assert decide(scope, SITE_ONLY, event="push", tmp_path=tmp_path) == "true"
    assert decide(scope, SITE_ONLY, event="workflow_dispatch", tmp_path=tmp_path) == "true"


@pytest.mark.parametrize("scope", ["app", "frontend", "engine"])
def test_a_site_or_readme_change_skips_every_scoped_suite(scope, tmp_path):
    assert decide(scope, SITE_ONLY + ["README.md", "LICENSE"], tmp_path=tmp_path) == "false"


@pytest.mark.parametrize(
    "files, expected",
    [
        (FRONTEND_ONLY, {"app": "true", "frontend": "true", "engine": "false"}),
        (ENGINE_ONLY, {"app": "true", "frontend": "false", "engine": "true"}),
        (["requirements.txt"], {"app": "true", "frontend": "false", "engine": "true"}),
        (["docs/api-contract/openapi.json"], {"app": "true", "frontend": "true", "engine": "true"}),
        (["resmon_scripts/extension/found.js"], {"app": "true", "frontend": "true", "engine": "false"}),
    ],
)
def test_a_file_in_a_suites_scope_runs_it(files, expected, tmp_path):
    for scope, want in expected.items():
        assert decide(scope, SITE_ONLY + files, tmp_path=tmp_path) == want, scope


@pytest.mark.parametrize("scope", ["app", "frontend", "engine"])
@pytest.mark.parametrize("path", [".github/workflows/ci.yml", ".gitignore", "assets/icon.png"])
def test_a_workflow_change_or_an_unclassified_file_runs_everything(scope, path, tmp_path):
    assert decide(scope, SITE_ONLY + [path], tmp_path=tmp_path) == "true"


def test_an_empty_list_runs_everything(tmp_path):
    assert decide("app", [], tmp_path=tmp_path) == "true"


def test_an_unknown_scope_is_refused():
    env = {**os.environ, "GITHUB_EVENT_NAME": "pull_request", "CHANGED_FILES": "README.md"}
    result = subprocess.run(["bash", str(SCRIPT), "everything"], env=env, capture_output=True, text=True)
    assert result.returncode == 2
