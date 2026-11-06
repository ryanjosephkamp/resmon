"""American spelling in tracked source, copy, paths, and documentation.

Transport values and third-party text retain their exact spelling. Exceptions
match individual tokens, so nearby prose is still checked.
"""
from __future__ import annotations

import re
from fnmatch import fnmatchcase
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
VERB_END = r"(?:e[ds]?|ing|ations?|ers?|able|ability)"
BRITISH = re.compile(
    r"labelled|labelling|travelled|travelling|modelled|modelling|behaviour|honour|"
    r"(?:summaris|normalis|recognis|serialis|optimis|authoris|minimis|organis|"
    r"initialis|maximis|amortis|apologis|canonicalis|capitalis|characteris|"
    r"crystallis|finalis|generalis|humanis|localis|materialis|memois|neutralis|"
    r"parameteris|parametris|parenthesis|sanitis|standardis|synchronis|synthesis|"
    r"tokenis|categoris|analys(?!es\b))" + VERB_END +
    r"|colour|centre|licence|artefact|catalogue|favour|defence|signalling|"
    r"cancelled|cancelling|cancellable|grey|towards|whilst|amongst",
    re.IGNORECASE,
)

# These files are quoted upstream material or the guard's own vocabulary.
FILE_ALLOWLIST = {
    "resmon_scripts/verification_scripts/test_american_english.py":
        "Rejected vocabulary and examples exercise this guard.",
    "resmon_scripts/verification_scripts/fixtures/author_identity/openalex.json":
        "Captured upstream affiliations include official place names.",
    "site/src/data/papers.json": "Verbatim upstream paper titles, authors, and identifiers.",
}
PREFIX_ALLOWLIST = {
    "resmon_scripts/frontend/vendor/": "Pinned third-party assets must retain their published bytes.",
}

# (path or *, expression, reason). Only matches inside the expression are exempt.
TOKEN_ALLOWLIST = [
    ("*", r"aria-labelledby", "The HTML/ARIA attribute is a platform API."),
    ("*", r"AssistantTurnCancelled|RestoreCancelled", "Published HTTP schema names remain compatible."),
    ("*", r"CancelledError|\.cancelled\(|\.cancelling\(", "Python cancellation APIs are third-party names."),
    ("*", r"[\"'`]cancelled[\"'`]|``cancelled``|[\"'`]cancelling[\"'`]",
     "Stored statuses, HTTP fields, and progress event values retain their wire spelling."),
    ("*", r"[\"']cancelled by user[\"']", "Persisted source-outcome sentinel is read by the engine and renderer."),
    ("resmon_scripts/frontend/atlas/*", r"^\s*cancelled(?=\s*:)|(?<=[{,])\s*cancelled(?=\s*:)|\.cancelled\b",
     "Atlas reads the published HTTP boolean fields and mirrors them in fixtures."),
    ("resmon_scripts/implementation_scripts/response_models.py", r"^\s*cancelled(?=\s*:\s*bool)",
     "Published HTTP boolean field declarations keep their names."),
    ("*", r"[\"']\(uncategorised\)[\"']", "Existing analytics response group key is part of the HTTP output."),
    ("resmon_scripts/implementation_scripts/*.py", r"\bcancelled(?==)",
     "Keyword arguments to dict.update write the published cancellation field."),
    ("resmon_scripts/verification_scripts/fixtures/**/*.sql", r".*",
     "Historical database snapshots preserve released schema text and stored values exactly."),
    ("resmon_scripts/frontend/atlas/src/api/schema.d.ts", r"/\*\* Cancelled \*/",
     "Generated titles are derived from unchanged HTTP field names."),
    ("resmon_scripts/implementation_scripts/assistant*runtime.py", r"selected_cancelled(?:_before_spawn)?",
     "Existing runtime error codes retain their protocol spelling."),
    ("resmon_scripts/verification_scripts/test_runs_tab.py", r'"failed,cancelled"',
     "The HTTP filter combines unchanged stored status values."),
    (".github/workflows/*", r"cancelled\(\)", "GitHub Actions status function."),
    ("resmon_scripts/verification_scripts/test_release_workflow.py", r"cancelled\\\(\\\)",
     "The test matches the GitHub Actions status function in a regular expression."),
    ("*package-lock.json", r"@img/colour|/colour-", "Published dependency and tarball names."),
    ("resmon_scripts/implementation_scripts/entity_matching.py", r'"centre"', "Input vocabulary recognizes upstream affiliation spellings."),
    ("resmon_scripts/implementation_scripts/collection_map.py", r"\btowards\b", "Stop-word vocabulary matches text received from papers."),
    ("resmon_scripts/verification_scripts/probe_transcriber.py", r"/LICENCE|['\"]licence['\"]", "Upstream license URL and discovery of third-party notice filenames."),
    ("site/src/data/plate.json", r'"title": "Towards Generalist Graph-Level Anomaly Detection"', "Verbatim upstream paper title."),
]


def violations(path: str, content: str) -> list[str]:
    if path in FILE_ALLOWLIST or any(path.startswith(p) for p in PREFIX_ALLOWLIST):
        return []
    patterns = [re.compile(pattern) for glob, pattern, reason in TOKEN_ALLOWLIST
                if fnmatchcase(path, glob)]
    found = []
    for number, line in enumerate(content.splitlines(), 1):
        allowed = [match.span() for pattern in patterns for match in pattern.finditer(line)]
        for match in BRITISH.finditer(line):
            if not any(start <= match.start() and match.end() <= end for start, end in allowed):
                found.append(f"{path}:{number}: {match.group()}: {line.strip()}")
    return found


def test_tracked_text_uses_american_english() -> None:
    paths = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    found = []
    for name in paths:
        if not name or name.startswith("docs/"):
            continue
        found.extend(violations(name, name))
        if name in FILE_ALLOWLIST or any(name.startswith(p) for p in PREFIX_ALLOWLIST):
            continue
        path = ROOT / name
        if not path.is_file():
            continue  # A staged path rename may still be in progress.
        raw = path.read_bytes()
        if b"\0" in raw:
            continue
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        found.extend(violations(name, content))
    assert not found, "Use American spelling (or document an exact compatibility exception):\n" + "\n".join(found)


@pytest.mark.parametrize("text", [
    "labelled", "behaviour", "honouring", "summarisation", "_normalise_title",
    "unrecognised", "serialisable", "colour", "centre", "licence", "artefact",
    "catalogue", "optimisation", "travelled", "organisation", "authorised",
    "minimising", "initialised", "maximise", "modelled", "favour", "cancelled run",
    "cancelling the run", "grey", "towards", "whilst", "amongst", "canonicalisation",
    "parametrised", "_humanise_days", "mislabelled", "signalling", "analyse",
    "if not cancelled:", "greyColor", "moveTowards",
])
def test_reports_file_and_line_for_prose_and_identifiers(text: str) -> None:
    result = violations("source.py", "American English.\n" + text)
    assert len(result) == 1
    assert result[0].startswith("source.py:2:")


def test_compatibility_exceptions_do_not_hide_neighboring_prose() -> None:
    result = violations("source.tsx", '<p aria-labelledby="heading">A cancelled run</p>')
    assert len(result) == 1
    assert ": cancelled:" in result[0]
    assert not violations("source.py", 'if run.status == "cancelled": pass')
    assert not violations("source.py", "raise asyncio.CancelledError()")
    assert not violations("resmon_scripts/frontend/atlas/src/example.ts", "run.cancelled || { cancelled: false }")
    assert not violations("source.py", 'word = "optimistic organism premise"')
    # "Analyses" is also the plural of "analysis", in American English too.
    assert not violations("source.md", "Two analyses agree.")
    assert violations("source.md", "It was analysed twice.")


def test_internal_cancellation_arrays_are_not_transport_fields() -> None:
    path = "resmon_scripts/frontend/e2e/example.spec.ts"
    found = violations(path, "const facts = { cancelled: [] };\nfacts.cancelled.push(url);")
    assert len(found) == 2
    assert found[0].startswith(path + ":1:")
    assert found[1].startswith(path + ":2:")
