"""The release workflow publishes once, from every leg, after each leg has launched its app.

``release.yml`` builds four legs (macOS arm64, macOS Intel, Windows, Linux). A leg
that fails must stop the release, and a release must carry every leg's files, so
publishing is a job of its own that waits for the whole matrix and runs only for a
version tag. These cases read the file as text, as ``workflow_jobs.py`` does; the
workflow itself can only be run on GitHub.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
WORKFLOW = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
FRONTEND = ROOT / "resmon_scripts" / "frontend"

BUILD, PUBLISH = WORKFLOW.split("\n  publish:\n")
BUILD = BUILD.split("\n  build:\n")[1]


def _legs() -> list[str]:
    matrix = BUILD.split("      matrix:\n        include:\n")[1].split("\n    defaults:")[0]
    return ["- os:" + leg for leg in matrix.split("- os:")[1:]]


def test_there_is_a_leg_for_each_of_the_four_targets():
    systems = [re.search(r"os: (\S+)", leg).group(1) for leg in _legs()]
    assert systems == ["macos-14", "macos-15-intel", "windows-latest", "ubuntu-latest"]


def test_no_leg_publishes_anything():
    assert "gh release" not in BUILD
    assert "contents: write" not in WORKFLOW.split("\njobs:\n")[0], "the workflow's default token is read-only"


def test_publish_waits_for_every_leg_and_runs_for_a_version_tag_only():
    assert re.search(r"^    needs: build$", PUBLISH, re.M)
    condition = re.search(r"^    if: (.+)$", PUBLISH, re.M).group(1)
    assert "github.event_name == 'push'" in condition
    # `needs` with no `always()` or `failure()`: a failed or cancelled leg skips the job.
    assert not re.search(r"always\(\)|failure\(\)|cancelled\(\)", condition)
    assert "contents: write" in PUBLISH


def test_publish_makes_one_release_with_every_file():
    assert PUBLISH.count("gh release create") == 1
    assert "merge-multiple: true" in PUBLISH
    # The seven files: two disk images, the installer and its blockmap, the AppImage, two feeds.
    assert "-eq 7" in PUBLISH
    assert "test ! -e release-files/latest-mac.yml" in PUBLISH


def test_every_artifact_a_leg_uploads_expires_in_three_days():
    uploads = re.findall(r"uses: actions/upload-artifact@v4\n(.*?)(?=\n      - |\n  \w|\Z)", BUILD, re.S)
    assert len(uploads) == 2
    for block in uploads:
        assert re.search(r"retention-days: 3$", block, re.M)


def test_every_leg_names_its_backend_and_app():
    for leg in _legs():
        backend = re.search(r"backend: (\S+)", leg).group(1)
        runtime = re.search(r"runtime: (\S+)", leg).group(1)
        assert runtime.startswith(backend + "/python/")
        assert re.search(r"app: (resmon\.app|win-unpacked|linux-unpacked)$", leg, re.M)


def test_the_launch_check_runs_the_spec_that_exists_and_cannot_skip():
    spec = "e2e/packaged-command-line.spec.ts"
    assert (FRONTEND / spec).is_file()
    step = BUILD.split("name: Launch check")[1].split("\n      - name:")[0]
    assert spec in step
    assert "RESMON_REQUIRE_PACKAGED: '1'" in step
    assert "xvfb-run" in step, "Linux needs a virtual display"


def test_the_bundled_command_line_is_run_before_the_app_is_launched():
    run_cli = BUILD.index("name: Run the command line inside the app")
    launch = BUILD.index("name: Launch check")
    assert run_cli < launch
    step = BUILD[run_cli:launch]
    assert '-I "$PYZ" --version' in step
    assert "the command line inside the resmon app" in step


@pytest.mark.parametrize("name", ["update metadata", "bundled runtime is genuinely portable"])
def test_the_checks_that_were_already_here_are_still_here(name):
    assert name in BUILD
