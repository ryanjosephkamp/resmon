#!/usr/bin/env python3
"""Every job in every workflow file, and the two things each one must carry.

``.github/workflows/README.md`` says a new job is not finished until it carries
a repository guard and a ``timeout-minutes``. That was prose, and prose is the
weakest place to put a rule whose violation has **no observable effect in this
repository**: a missing ``if:`` changes nothing here, so it reads as dead
configuration to anybody tidying up, and a missing ``timeout-minutes`` silently
inherits GitHub's 360-minute default. Neither shows up as a red anywhere.

This module reads the workflow files as data so a test can hold the rule. It is
deliberately not a general YAML parser — there is no YAML library in
``requirements.txt`` and this is not worth adding one for. It understands the
one shape these files are written in: a top-level ``jobs:`` mapping, each job a
key one level in, each job's own settings one level in from that. The narrowness
is the safety: anything it cannot read, it reports as unreadable rather than as
compliant, and ``test_workflow_hygiene.py`` fails on a workflow file that yields
no jobs. A parser that quietly returns nothing is how a guard job passes while
guarding nothing.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import NamedTuple, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
WORKFLOWS_DIR = PROJECT_ROOT / ".github" / "workflows"

# The literal, not a variable. A variable could be changed from inside a fork,
# which is the one thing the guard exists to prevent — see README.md beside the
# workflow files. Spelling it out here means a typo in a workflow (which makes
# that job skip forever rather than fail) is caught as a difference.
REPOSITORY_GUARD = "github.repository == 'ryanjosephkamp/resmon'"

# GitHub's own default when a job declares none. A job at or above it has in
# effect declared nothing.
GITHUB_DEFAULT_TIMEOUT_MINUTES = 360


class Job(NamedTuple):
    """One job, and the two facts the rule is about."""

    workflow: str          # file name, e.g. "ci.yml"
    name: str              # the job's key, e.g. "backend"
    condition: Optional[str]      # the raw ``if:`` value, flattened to one line
    timeout_minutes: Optional[int]

    @property
    def label(self) -> str:
        return f"{self.workflow} {self.name}"

    def guard_problem(self) -> Optional[str]:
        """Why this job's repository guard does not hold, or ``None``."""
        if self.condition is None:
            return f"{self.label}: no `if:` — it would run in any fork or mirror"
        if REPOSITORY_GUARD not in self.condition:
            return (
                f"{self.label}: `if:` does not carry {REPOSITORY_GUARD!r}; it says "
                f"{self.condition!r}"
            )
        return None

    def timeout_problem(self) -> Optional[str]:
        """Why this job's timeout does not hold, or ``None``."""
        if self.timeout_minutes is None:
            return (
                f"{self.label}: no `timeout-minutes` — it inherits GitHub's "
                f"{GITHUB_DEFAULT_TIMEOUT_MINUTES}-minute default silently"
            )
        if not 0 < self.timeout_minutes < GITHUB_DEFAULT_TIMEOUT_MINUTES:
            return (
                f"{self.label}: `timeout-minutes: {self.timeout_minutes}` is not a "
                f"bound — it must be between 1 and "
                f"{GITHUB_DEFAULT_TIMEOUT_MINUTES - 1}"
            )
        return None


def workflow_files(directory: Optional[Path] = None) -> list[Path]:
    """Every workflow file, sorted. ``README.md`` is documentation, not a workflow."""
    directory = directory or WORKFLOWS_DIR
    return sorted(
        path for path in directory.iterdir()
        if path.suffix in (".yml", ".yaml") and path.is_file()
    )


def _content_lines(text: str) -> list[tuple[int, int, str]]:
    """``(line number, indent, text)`` for lines that carry content.

    Blank lines and whole-line comments are dropped: both can appear at any
    indentation and neither opens or closes a block.
    """
    out: list[tuple[int, int, str]] = []
    for number, raw in enumerate(text.splitlines(), start=1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        out.append((number, len(raw) - len(raw.lstrip()), stripped))
    return out


def parse_jobs(text: str, workflow: str) -> list[Job]:
    """The jobs declared in one workflow file.

    Walks the ``jobs:`` block by indentation. The job keys are whatever sits at
    the first indentation inside it, and a job's own settings are whatever sits
    at the first indentation inside *that* — so a step's ``if:``, nested two
    levels deeper inside ``steps:``, is never mistaken for the job's.
    """
    lines = _content_lines(text)
    start = next(
        (index for index, (_, indent, body) in enumerate(lines)
         if indent == 0 and body == "jobs:"),
        None,
    )
    if start is None:
        return []

    block = []
    for number, indent, body in lines[start + 1:]:
        if indent == 0:
            break
        block.append((number, indent, body))
    if not block:
        return []

    job_indent = block[0][1]
    jobs: list[Job] = []
    current: Optional[str] = None
    settings: dict[str, list[str]] = {}
    setting_indent: Optional[int] = None
    pending_block: Optional[str] = None

    def flush() -> None:
        if current is None:
            return
        condition = " ".join(settings.get("if", [])).strip() or None
        raw_timeout = " ".join(settings.get("timeout-minutes", [])).strip()
        timeout: Optional[int] = None
        if re.fullmatch(r"\d+", raw_timeout):
            timeout = int(raw_timeout)
        jobs.append(Job(workflow, current, condition, timeout))

    for _, indent, body in block:
        if indent == job_indent and body.endswith(":"):
            flush()
            current = body[:-1].strip()
            settings, setting_indent, pending_block = {}, None, None
            continue
        if current is None:
            continue
        if setting_indent is None and indent > job_indent:
            setting_indent = indent
        if indent == setting_indent:
            pending_block = None
            match = re.match(r"^([A-Za-z][\w.-]*):\s*(.*)$", body)
            if match:
                key, value = match.group(1), match.group(2).strip()
                if value in (">", ">-", "|", "|-", ">+", "|+"):
                    # A block scalar: the value is the deeper lines that follow.
                    settings[key] = []
                    pending_block = key
                else:
                    settings[key] = [value] if value else []
        elif pending_block is not None and setting_indent is not None and indent > setting_indent:
            settings[pending_block].append(body)

    flush()
    return jobs


def all_jobs(directory: Optional[Path] = None) -> list[Job]:
    """Every job in every workflow file, in file order then declaration order."""
    jobs: list[Job] = []
    for path in workflow_files(directory):
        jobs.extend(parse_jobs(path.read_text(encoding="utf-8"), path.name))
    return jobs


def problems(directory: Optional[Path] = None) -> list[str]:
    """Every way the guard-and-timeout rule is currently broken.

    One sentence per violation, naming the workflow and the job, because the
    person reading it is looking at a list of ten-odd jobs and needs to know
    which.
    """
    found: list[str] = []
    for path in workflow_files(directory):
        parsed = parse_jobs(path.read_text(encoding="utf-8"), path.name)
        if not parsed:
            # Unreadable is not compliant. A workflow this parser cannot see
            # into would otherwise pass every check below by having no jobs.
            found.append(
                f"{path.name}: no jobs could be read from this file — either it "
                "declares none, or it is written in a shape workflow_jobs.py does "
                "not understand. Both are failures here."
            )
            continue
        for job in parsed:
            found.extend(
                problem for problem in (job.guard_problem(), job.timeout_problem())
                if problem is not None
            )
    return found


def main() -> int:                                   # pragma: no cover - entrypoint
    """Print the census, or the violations. Exit 1 when the rule is broken."""
    found = problems()
    jobs = all_jobs()
    print(f"{len(jobs)} jobs across {len(workflow_files())} workflow files.")
    for job in jobs:
        print(
            f"  {job.label}: guard "
            f"{'yes' if job.guard_problem() is None else 'NO'}, "
            f"timeout {job.timeout_minutes if job.timeout_minutes is not None else 'NONE'}"
        )
    for problem in found:
        print(f"FAIL {problem}", file=sys.stderr)
    return 1 if found else 0


if __name__ == "__main__":                           # pragma: no cover
    sys.exit(main())
