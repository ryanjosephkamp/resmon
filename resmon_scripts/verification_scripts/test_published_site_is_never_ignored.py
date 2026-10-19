"""The two defenses that keep a built page from being hidden by ``.gitignore``.

``docs/`` is the published site: committed output that GitHub Pages serves as
it stands. ``ci.yml``'s ``site`` job exists to notice when it stops matching a
fresh build of ``site/``. During review of the pull request that added that
job, the job was found blind to the one case it most needed to see.

``git status`` does not report ignored files, and ``docs/`` was not exempt from
the root ``.gitignore``. A file planted at ``docs/dist/page.html`` left the
gate green, because ``.gitignore`` carries ``dist/`` and a bare directory rule
matches at any depth. The planted case is not the one that would have arrived
in practice. **A document's slug becomes its directory**, so ``docs/build.md``
publishes to ``docs/build/index.html``, which ``build/`` hides: the Markdown
source commits, the page never does, and the job written to catch exactly that
drift reports byte-identical. ``build/``, ``dist/``, ``out/``, ``release/``,
``logs/`` and ``coverage/`` are all bare directory rules, and every one of them
is an ordinary document slug. No collision exists today — that was checked
across every path segment under ``docs/`` — so this was latent rather than
live.

It was fixed on both sides, and this module is about why *both* are still here:

1. ``.gitignore`` ends with a ``docs/`` negation, so a built page at such a
   path is **committable**.
2. the ``site`` job asks with ``--ignored=matching``, so a built page an ignore
   rule is hiding is **visible** as a ``!!`` row and counts as drift.

They are redundant today, and that redundancy is the problem this module
solves. With the negation in place, nothing under ``docs/`` is ignored, so the
flag never fires and never would during any ordinary failure — it cannot be
demonstrated in CI at all while its partner is present, which is why the
evidence for it in that pull request is local. A layer that is both redundant
and unexercised is a layer somebody deletes while tidying, in perfect good
faith, and the deletion has no observable effect on the day it happens. The
flag becomes the only defense precisely at the moment it has never been tried.

So the rule is held here rather than left to a reviewer noticing. Neither
assertion claims the layer *works* — the pull request's own demonstrations did
that, each half with the other removed. What these claim is narrower and is the
part that erodes: both layers are still present, so removing either is a
decision somebody makes in a diff rather than something that happens to them.

Companion to ``test_workflow_hygiene.py``, which holds the rules that apply to
every job. This one is about a single job's correctness, and it is deliberately
standalone: it reads the two files directly rather than through
``workflow_jobs.py``, because that parser reads job-level settings and the
assertion here is about a flag inside one step's shell script.
"""

from __future__ import annotations

import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
GITIGNORE = PROJECT_ROOT / ".gitignore"
CI_WORKFLOW = PROJECT_ROOT / ".github" / "workflows" / "ci.yml"

# The bare directory rules in `.gitignore` that are also plausible document
# slugs. Any one of them turns `docs/<slug>.md` into a page that cannot be
# committed. Named rather than derived, so that adding a seventh is a decision.
SLUG_COLLIDING_RULES = ("build/", "dist/", "out/", "release/", "logs/", "coverage/")


def _gitignore_lines() -> list[str]:
    return [
        line.strip()
        for line in GITIGNORE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def _site_job_text() -> str:
    """The ``site`` job's own block of ``ci.yml``.

    Sliced rather than parsed: the assertion is about the text of a shell
    script inside a step, which no job-level parser exposes. Slicing to the
    next top-level job key keeps a flag added to some *other* job from
    satisfying this.
    """
    text = CI_WORKFLOW.read_text(encoding="utf-8")
    start = text.find("\n  site:\n")
    assert start != -1, (
        "ci.yml has no `site:` job. If it was renamed, rename it here too; if it "
        "was removed, this module and the .gitignore note it guards should go "
        "with it, as a decision rather than as leftovers."
    )
    rest = text[start + 1 :]
    following = re.search(r"\n  [a-zA-Z_][\w-]*:\n", rest)
    return rest[: following.start()] if following else rest


# ---------------------------------------------------------------------------
# Layer 1: the published site is not ignorable
# ---------------------------------------------------------------------------

def test_gitignore_un_ignores_everything_under_docs():
    """A built page at any path under ``docs/`` can be committed.

    Asserted against ``git``'s own answer rather than against the text of the
    rule, because the text is the part that is easy to get right and wrong at
    the same time: ``!docs/dist/**`` reads as a fix and is not one, since git
    will not re-include a file whose parent directory is excluded.
    """
    import subprocess

    negations = [line for line in _gitignore_lines() if line.startswith("!docs/")]
    assert negations, (
        ".gitignore has no `!docs/` negation. Without one, a document whose slug "
        "matches a bare directory rule — " + ", ".join(SLUG_COLLIDING_RULES) + " — "
        "publishes to a page that cannot be committed, and the `site` job in "
        "ci.yml cannot report it as drift unless it is also asking with "
        "`--ignored=matching`. See the note at the end of .gitignore."
    )

    # The rules that would hide a page, exercised one at a time against git.
    hidden = []
    for rule in SLUG_COLLIDING_RULES:
        candidate = f"docs/{rule.rstrip('/')}/index.html"
        result = subprocess.run(
            ["git", "check-ignore", "-q", candidate],
            cwd=PROJECT_ROOT,
            capture_output=True,
        )
        # Exit 0 means "this path is ignored"; 1 means it is not.
        if result.returncode == 0:
            hidden.append(candidate)
    assert not hidden, (
        "these publishable paths are still ignored, so the page would never be "
        "committed: " + ", ".join(hidden)
    )


# ---------------------------------------------------------------------------
# Layer 2: the gate can see an ignored page anyway
# ---------------------------------------------------------------------------

def test_the_site_job_asks_git_about_ignored_files():
    """The ``site`` job's drift check passes ``--ignored=matching``.

    This is the layer that is redundant while layer 1 holds, and it is the one
    that matters if layer 1 is ever removed. Plain ``git status --porcelain``
    is silent about an ignored file, so without the flag the gate answers
    "byte-identical" about a tree that is missing a page.
    """
    job = _site_job_text()

    # The *command*, not the job text. The first version of this asserted the
    # flag appeared anywhere in the job and passed a mutation that deleted it
    # from the command and left the comment above it in place — the comment
    # explains the flag at length, so it satisfied the search on its own. A
    # check that a comment can satisfy is not a check on the code.
    commands = [
        line
        for line in job.splitlines()
        if "git status --porcelain" in line and not line.lstrip().startswith("#")
    ]
    assert commands, (
        "the site job no longer runs `git status --porcelain` against docs/. If "
        "the drift check was rewritten, this module needs rewriting with it "
        "rather than deleting."
    )
    without_flag = [line.strip() for line in commands if "--ignored=matching" not in line]
    assert not without_flag, (
        "the site job's drift check does not pass `--ignored=matching`, so it "
        "cannot see a built page that .gitignore is hiding. That is the defect "
        "the check was added for: a file at docs/dist/page.html left this gate "
        "green. It is redundant only while .gitignore's `!docs/**` negation is "
        "also present — both are asserted in this module, and neither should be "
        "removed without removing the other deliberately.\n  "
        + "\n  ".join(without_flag)
    )


def test_both_layers_name_each_other():
    """Each layer's comment points at the other.

    A reader who finds one of these and not the other is the person who removes
    it. The cross-reference is the only thing that makes the redundancy legible
    at the place where someone would act on it, so it is worth holding.
    """
    gitignore_note = GITIGNORE.read_text(encoding="utf-8")
    assert "--ignored=matching" in gitignore_note, (
        "the docs/ note in .gitignore no longer mentions the ci.yml site job's "
        "`--ignored=matching`, so a reader there cannot tell the negation has a "
        "partner"
    )
    job = _site_job_text()
    assert ".gitignore" in job, (
        "the site job's drift step no longer mentions .gitignore, so a reader "
        "there cannot tell the flag has a partner"
    )
