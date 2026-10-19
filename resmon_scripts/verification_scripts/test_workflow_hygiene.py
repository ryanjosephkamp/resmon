"""Every workflow job carries its repository guard and its timeout.

``.github/workflows/README.md`` has said so since the guard was added, and that
was the whole of the enforcement. Prose is a bad place for this particular rule
for a reason that is easy to miss: **a missing guard has no observable effect in
this repository.** Nothing goes red, nothing runs twice, nothing costs anything
here — the cost lands in a private fork or mirror, which is exactly where nobody
is looking. So the guard reads as dead configuration to anyone tidying up, and
a job that loses it loses it silently. A missing ``timeout-minutes`` is the
mirror image: the job keeps working and quietly inherits GitHub's 360-minute
default, which is how a hung runner becomes a long bill.

These cases run inside ``ci.yml``'s backend job, which is already a required
check and already carries the guard. That is deliberate rather than
convenient. A **new** job would have to be made required to gate anything, and
a required check that *skips* is never satisfied — branch protection waits for
it forever, with a symptom that looks nothing like its cause. The guard makes a
job skip off this repository, so a new "does every job carry the guard?" job
would be the one check most likely to fall into that hole. Putting the rule in
the suite that already runs makes it unskippable by construction.

The parser is ``workflow_jobs.py``. It is small and narrow on purpose and it
fails closed: a workflow file it cannot read is reported as a violation, not as
having no jobs to check.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from workflow_jobs import (
    GITHUB_DEFAULT_TIMEOUT_MINUTES,
    REPOSITORY_GUARD,
    all_jobs,
    parse_jobs,
    problems,
    workflow_files,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
WORKFLOWS_DIR = PROJECT_ROOT / ".github" / "workflows"
README = WORKFLOWS_DIR / "README.md"

# Written as words in the README's opening sentence, so the test can read the
# claim the way a person does.
_NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
}


# ---------------------------------------------------------------------------
# The rule itself
# ---------------------------------------------------------------------------

def test_every_job_carries_the_repository_guard_and_a_timeout():
    """The rule, over the real files, with every violation named at once.

    One assertion rather than a parametrised case per job: the useful output
    when this goes red is the whole list, because the thing that breaks it is
    usually a new workflow with several jobs in it, not one job losing one key.
    """
    found = problems()
    assert not found, (
        "these workflow jobs do not satisfy the rule in "
        ".github/workflows/README.md:\n  " + "\n  ".join(found)
    )


def test_every_workflow_file_yields_at_least_one_job():
    """An unreadable file must not pass by having nothing to check.

    ``problems()`` already treats a zero-job file as a violation. This states
    the same property from the other side so that a change to the parser which
    starts returning nothing is a red here with an obvious cause, rather than a
    suite that silently stops checking anything.
    """
    empty = [
        path.name for path in workflow_files()
        if not parse_jobs(path.read_text(encoding="utf-8"), path.name)
    ]
    assert not empty, f"no jobs could be read from: {', '.join(empty)}"


def test_the_guard_is_the_literal_repository_name():
    """Not a variable, and not an expression that resolves to one.

    A variable could be redefined from inside a fork, which is the single thing
    the guard exists to stop. The README says so; this is the check.
    """
    for job in all_jobs():
        assert job.condition is not None and REPOSITORY_GUARD in job.condition, (
            f"{job.label}: the guard must be the literal "
            f"{REPOSITORY_GUARD!r}, not {job.condition!r}"
        )


# ---------------------------------------------------------------------------
# The denominators in the README
# ---------------------------------------------------------------------------

def test_the_readme_counts_the_jobs_it_is_talking_about():
    """"Seven workflows, N jobs" against the files.

    This found the first thing it was pointed at: the sentence said *ten* while
    the tree held eleven, because ``ci.yml``'s ``lint`` job was added without
    the count moving. Nothing was broken by that — ``lint`` carries both its
    guard and its timeout — but a denominator that is one short is a
    denominator nobody can use, and "every one of them" means nothing when the
    reader and the tree disagree about how many there are.
    """
    text = README.read_text(encoding="utf-8")
    match = re.search(r"([A-Za-z]+) workflows, ([A-Za-z]+) jobs", text)
    assert match, (
        ".github/workflows/README.md no longer opens with a workflow and job count"
    )
    stated_workflows = _NUMBER_WORDS.get(match.group(1).lower())
    stated_jobs = _NUMBER_WORDS.get(match.group(2).lower())
    assert stated_workflows == len(workflow_files()), (
        f"README says {match.group(1)} workflow files; there are "
        f"{len(workflow_files())}"
    )
    assert stated_jobs == len(all_jobs()), (
        f"README says {match.group(2)} jobs; there are {len(all_jobs())}: "
        + ", ".join(job.label for job in all_jobs())
    )


def test_the_timeout_table_has_a_row_per_job_and_the_rows_are_the_real_limits():
    """The measured-history table against the workflow files.

    The table is the only record of *why* each limit is the number it is, and a
    job with no row is a limit nobody chose. Rows are labelled
    ``` `<file>` <job> ``` — or just ``` `<file>` ``` where the workflow has a
    single job and the name would add nothing.
    """
    text = README.read_text(encoding="utf-8")
    rows: dict[str, int] = {}
    for line in text.splitlines():
        match = re.match(r"^\|\s*`([^`]+)`\s*([\w-]*)\s*\|\s*(\d+)\s*\|", line)
        if match:
            label = f"{match.group(1)} {match.group(2)}".strip()
            rows[label] = int(match.group(3))

    jobs = all_jobs()
    missing: list[str] = []
    wrong: list[str] = []
    for job in jobs:
        # Four workflows have one job each and two of those rows drop the job
        # name as redundant, so either spelling is accepted rather than
        # rewriting four rows to satisfy a regex.
        label = job.label if job.label in rows else job.workflow
        if label not in rows:
            missing.append(job.label)
        elif rows[label] != job.timeout_minutes:
            wrong.append(
                f"{label}: table says {rows[label]}, the workflow says "
                f"{job.timeout_minutes}"
            )
    assert not missing, (
        "the timeout table in .github/workflows/README.md has no row for: "
        + ", ".join(missing)
    )
    assert not wrong, "the timeout table disagrees with the workflows: " + "; ".join(wrong)
    assert len(rows) == len(jobs), (
        f"the table has {len(rows)} rows and there are {len(jobs)} jobs; a row "
        "for a job that no longer exists is as misleading as a missing one"
    )


# ---------------------------------------------------------------------------
# The check can fail
# ---------------------------------------------------------------------------
#
# A gate nobody has seen go red is somebody's word. These drive the real
# checker over real workflow text with one line taken out of it, which is the
# shape the failure actually arrives in: somebody deletes a line, or copies a
# job and edits the parts they noticed.

def _mutated(tmp_path: Path, edits: dict[str, str] | None = None) -> Path:
    """A copy of the real workflow directory with named files replaced.

    Keyed by file name rather than by keyword, because four of the seven file
    names carry a hyphen and the keyword spelling of them is a silent miss: the
    edit is dropped, the directory is a faithful copy, and the test asserting a
    violation fails for a reason that has nothing to do with the checker. That
    happened on the first run of this module.
    """
    edits = edits or {}
    unknown = set(edits) - {path.name for path in workflow_files()}
    assert not unknown, f"no such workflow file: {sorted(unknown)}"
    directory = tmp_path / "workflows"
    directory.mkdir()
    for path in workflow_files():
        directory.joinpath(path.name).write_text(
            edits.get(path.name, path.read_text(encoding="utf-8")), encoding="utf-8")
    return directory


def test_a_job_that_loses_its_guard_is_caught(tmp_path):
    real = (WORKFLOWS_DIR / "ci.yml").read_text(encoding="utf-8")
    broken = real.replace(
        "    # Runs only here — see README.md in this directory.\n"
        f"    if: {REPOSITORY_GUARD}\n",
        "",
        1,
    )
    assert broken != real, "the fixture no longer matches ci.yml; update it"
    found = problems(_mutated(tmp_path, {"ci.yml": broken}))
    assert any("ci.yml backend" in problem and "no `if:`" in problem for problem in found), (
        f"removing a job's guard was not reported: {found}"
    )


def test_a_job_whose_guard_names_the_wrong_repository_is_caught(tmp_path):
    """The failure mode the README demonstrated: a guard that silently skips.

    A job guarded on a repository name that does not exist does not fail — it
    reports ``skipped``. If it is a required check, branch protection then waits
    for it forever. So a near-miss has to be as red as an absence.
    """
    real = (WORKFLOWS_DIR / "ui-smoke.yml").read_text(encoding="utf-8")
    broken = real.replace(REPOSITORY_GUARD, "github.repository == 'ryanjosephkamp/resmon-x'")
    assert broken != real
    found = problems(_mutated(tmp_path, {"ui-smoke.yml": broken}))
    assert sum("does not carry" in problem for problem in found) == 2, (
        f"a wrong repository name in ui-smoke.yml's two jobs was not reported: {found}"
    )


def test_a_job_that_loses_its_timeout_is_caught(tmp_path):
    real = (WORKFLOWS_DIR / "release.yml").read_text(encoding="utf-8")
    broken = re.sub(r"\n    timeout-minutes: \d+", "", real, count=1)
    assert broken != real, "the fixture no longer matches release.yml; update it"
    found = problems(_mutated(tmp_path, {"release.yml": broken}))
    assert any(
        "release.yml build" in problem and "no `timeout-minutes`" in problem
        for problem in found
    ), f"removing a job's timeout was not reported: {found}"


def test_a_timeout_at_githubs_own_default_is_not_a_bound(tmp_path):
    real = (WORKFLOWS_DIR / "voice-probe.yml").read_text(encoding="utf-8")
    broken = re.sub(
        r"\n    timeout-minutes: \d+",
        f"\n    timeout-minutes: {GITHUB_DEFAULT_TIMEOUT_MINUTES}",
        real,
        count=1,
    )
    found = problems(_mutated(tmp_path, {"voice-probe.yml": broken}))
    assert any("is not a bound" in problem for problem in found), (
        f"a 360-minute timeout was accepted as a bound: {found}"
    )


def test_a_workflow_the_parser_cannot_read_is_a_failure_not_a_pass(tmp_path):
    """The one that matters most, because it is the silent one."""
    directory = _mutated(tmp_path)
    directory.joinpath("new-thing.yml").write_text(
        "name: Something\non: push\n# no jobs block at all\n", encoding="utf-8")
    found = problems(directory)
    assert any("new-thing.yml" in problem and "no jobs" in problem for problem in found), (
        f"an unreadable workflow passed every check: {found}"
    )


def test_the_parser_reads_a_folded_condition(tmp_path):
    """``journeys.yml``'s ``classic`` ANDs the guard in front of an event filter.

    It is the only job here whose ``if:`` is a folded block, and a parser that
    read only ``key: value`` would report it as unguarded. Asserted against the
    real file rather than a constructed one.
    """
    jobs = {job.name: job for job in parse_jobs(
        (WORKFLOWS_DIR / "journeys.yml").read_text(encoding="utf-8"), "journeys.yml")}
    assert set(jobs) == {"candidate", "classic"}
    assert jobs["classic"].condition is not None
    assert REPOSITORY_GUARD in jobs["classic"].condition
    assert "github.event_name == 'schedule'" in jobs["classic"].condition


def test_a_steps_level_condition_is_not_mistaken_for_the_jobs(tmp_path):
    """``if: always()`` on a step must not satisfy the job's guard.

    ``live-network.yml`` has three of them. If the parser flattened a job to
    "any ``if:`` anywhere inside it", a job with a conditional step and no guard
    would pass.
    """
    real = (WORKFLOWS_DIR / "live-network.yml").read_text(encoding="utf-8")
    assert real.count("if: always()") >= 3, "the fixture no longer matches live-network.yml"
    broken = real.replace(f"    if: {REPOSITORY_GUARD}\n", "", 1)
    assert broken != real
    found = problems(_mutated(tmp_path, {"live-network.yml": broken}))
    assert any("live-network.yml live" in problem and "no `if:`" in problem for problem in found), (
        f"a step's `if: always()` was counted as the job's guard: {found}"
    )


@pytest.mark.parametrize("name", [path.name for path in workflow_files()])
def test_each_workflow_file_is_covered_by_this_module(name):
    """The denominator for everything above: every file was actually opened.

    Parametrised from the directory listing rather than a list here, so a new
    workflow file is in this suite the moment it is committed.
    """
    jobs = parse_jobs((WORKFLOWS_DIR / name).read_text(encoding="utf-8"), name)
    assert jobs, f"{name} yielded no jobs"
    for job in jobs:
        assert job.guard_problem() is None, job.guard_problem()
        assert job.timeout_problem() is None, job.timeout_problem()
