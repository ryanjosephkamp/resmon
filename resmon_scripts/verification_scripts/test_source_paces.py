"""Each source is asked at the pace its catalog entry states, by one limiter, whoever asks.

The catalog's ``rate_limit`` is shown to people (Settings › Sources, and the
"Requests allowed" column people choose sources from) as resmon's pace for
each source. PLOS's entry said 5 a second while PLOS asks for 10 a minute; the
retraction and version checks paced Crossref and bioRxiv with limiters of
their own, so a check and a search together went at twice the pace, and asked
arXiv with none at all.
"""
from __future__ import annotations

import ast
import importlib
import re
from pathlib import Path

import pytest

from implementation_scripts import api_arxiv, api_biorxiv, api_crossref, lifecycle
from implementation_scripts.repo_catalog import REPOSITORY_CATALOG

ENGINE = Path(__file__).resolve().parent.parent / "implementation_scripts"


def _limiter(entry):
    module = importlib.import_module(f"implementation_scripts.{entry.client_module.removesuffix('.py')}")
    return module._RATE_LIMITER


@pytest.mark.parametrize("entry", REPOSITORY_CATALOG, ids=lambda e: e.slug)
def test_each_limiter_runs_at_the_pace_its_catalog_entry_states(entry) -> None:
    stated = re.match(r"^\s*(\d+(?:\.(\d+))?) req/s", entry.rate_limit)
    assert stated, f"{entry.slug}'s rate_limit does not start with a pace: {entry.rate_limit!r}"
    places = len(stated.group(2) or "")
    actual = 1.0 / _limiter(entry)._interval
    assert abs(actual - float(stated.group(1))) <= 0.5 * 10 ** -places + 1e-9, (
        f"{entry.slug}: the catalog says {entry.rate_limit!r}, and its limiter runs at {actual:.4f} req/s")
    # "1 per 3 s", where the entry says it, agrees as well.
    spaced = re.search(r"1 per (\d+(?:\.\d+)?) s\b", entry.rate_limit)
    if spaced:
        assert abs(_limiter(entry)._interval - float(spaced.group(1))) < 0.05, entry.slug


def test_plos_is_asked_no_faster_than_it_asks() -> None:
    from implementation_scripts import api_plos

    # 10 a minute, 300 an hour, 7,200 a day: one every 12 seconds keeps within all three.
    assert api_plos._RATE_LIMITER._interval >= 12.0


def test_crossref_is_asked_no_faster_than_its_public_pool_answers_lists() -> None:
    assert api_crossref._RATE_LIMITER._interval >= 1.0


def test_the_lifecycle_checks_wait_on_the_search_clients_own_limiters() -> None:
    assert lifecycle._CROSSREF_LIMITER is api_crossref._RATE_LIMITER
    assert lifecycle._BIORXIV_LIMITER is api_biorxiv._RATE_LIMITER
    assert lifecycle._ARXIV_LIMITER is api_arxiv._RATE_LIMITER


def test_the_arxiv_lookup_is_paced(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    class Answer:
        status_code = 200
        text = "<feed/>"

    def safe_request(method, url, **kwargs):
        seen.update(kwargs)
        return Answer()

    monkeypatch.setattr(lifecycle, "safe_request", safe_request)
    lifecycle.ArxivLifecycleProvider().fetch_many(["2601.00001"])
    assert seen.get("rate_limiter") is api_arxiv._RATE_LIMITER


def test_the_arxiv_license_read_is_paced_with_arxivs_api(monkeypatch: pytest.MonkeyPatch) -> None:
    from implementation_scripts import full_text  # noqa: PLC0415

    seen: dict = {}

    class Answer:
        status_code = 200
        text = "<OAI-PMH/>"

    def safe_request(method, url, **kwargs):
        seen.update(kwargs)
        return Answer()

    monkeypatch.setattr(full_text, "safe_request", safe_request)
    assert full_text.arxiv_license("2601.00001") is None
    assert seen.get("rate_limiter") is api_arxiv._RATE_LIMITER


def test_only_a_source_client_makes_a_limiter_and_it_makes_one() -> None:
    """One pace per source: a limiter is made once, at the top of its source's client, and nowhere else."""
    for path in sorted(ENGINE.glob("*.py")):
        if path.name == "api_base.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        made = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                and getattr(node.func, "id", getattr(node.func, "attr", None)) == "RateLimiter"]
        if path.name == "full_text.py":
            # A download host is not a source: Get the PDF paces each host it
            # fetches from, one limiter per host, made in one place
            # (``Worker.limiter``). arXiv's license read goes to arXiv's API and
            # waits on api_arxiv's limiter, which the next test checks.
            owners = {node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
                      and any(call in ast.walk(node) for call in made)}
            assert len(made) == 1 and owners == {"limiter"}, "full_text.py makes a limiter outside Worker.limiter"
            continue
        if not path.name.startswith("api_"):
            assert not made, f"{path.name} makes a limiter of its own; it should wait on the source client's"
            continue
        top = [node for node in tree.body if isinstance(node, ast.Assign)
               and any(getattr(t, "id", None) == "_RATE_LIMITER" for t in node.targets)
               and isinstance(node.value, ast.Call)]
        assert len(made) <= 1 and len(top) == len(made), f"{path.name} makes {len(made)} limiters"
