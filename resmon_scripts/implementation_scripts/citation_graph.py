# resmon_scripts/implementation_scripts/citation_graph.py
"""Citation and reference graph construction via Semantic Scholar API."""

import logging

import httpx

from .config import DEFAULT_REQUEST_TIMEOUT

logger = logging.getLogger(__name__)

_S2_BASE = "https://api.semanticscholar.org/graph/v1"
_RATE_DELAY = 3.0  # seconds between requests (public tier ≈ 1 req/s with bursts)


# ---------------------------------------------------------------------------
# Low-level fetch helpers
# ---------------------------------------------------------------------------

def _fetch_paper_title(paper_id: str) -> str:
    """Retrieve the title of a paper by its Semantic Scholar ID."""
    url = f"{_S2_BASE}/paper/{paper_id}"
    try:
        with httpx.Client(timeout=DEFAULT_REQUEST_TIMEOUT) as client:
            resp = client.get(url, params={"fields": "title"})
            resp.raise_for_status()
            return resp.json().get("title", "")
    except Exception as exc:
        logger.warning("Could not fetch title for %s: %s", paper_id, exc)
        return ""


def fetch_citations(paper_id: str, depth: int = 1) -> list[dict]:
    """Fetch papers that cite the given paper.

    Returns a list of dicts with keys ``paper_id`` and ``title``.
    *depth* controls recursive expansion (1 = direct citations only).
    """
    results: list[dict] = []
    url = f"{_S2_BASE}/paper/{paper_id}/citations"
    try:
        with httpx.Client(timeout=DEFAULT_REQUEST_TIMEOUT) as client:
            resp = client.get(url, params={"fields": "title", "limit": 100})
            resp.raise_for_status()
            data = resp.json().get("data", [])

        for item in data:
            citing = item.get("citingPaper", {})
            pid = citing.get("paperId")
            if not pid:
                continue
            entry: dict = {
                "paper_id": pid,
                "title": citing.get("title", ""),
            }
            if depth > 1:
                entry["citations"] = fetch_citations(pid, depth - 1)
            results.append(entry)

    except Exception as exc:
        logger.error("fetch_citations failed for %s: %s", paper_id, exc)

    return results


def fetch_references(paper_id: str, depth: int = 1) -> list[dict]:
    """Fetch papers referenced by the given paper.

    Returns a list of dicts with keys ``paper_id`` and ``title``.
    *depth* controls recursive expansion (1 = direct references only).
    """
    results: list[dict] = []
    url = f"{_S2_BASE}/paper/{paper_id}/references"
    try:
        with httpx.Client(timeout=DEFAULT_REQUEST_TIMEOUT) as client:
            resp = client.get(url, params={"fields": "title", "limit": 100})
            resp.raise_for_status()
            data = resp.json().get("data", [])

        for item in data:
            cited = item.get("citedPaper", {})
            pid = cited.get("paperId")
            if not pid:
                continue
            entry: dict = {
                "paper_id": pid,
                "title": cited.get("title", ""),
            }
            if depth > 1:
                entry["references"] = fetch_references(pid, depth - 1)
            results.append(entry)

    except Exception as exc:
        logger.error("fetch_references failed for %s: %s", paper_id, exc)

    return results


# ---------------------------------------------------------------------------
# Tree construction
# ---------------------------------------------------------------------------

def build_citation_tree(paper_id: str, depth: int = 1) -> dict:
    """Build a citation/reference tree rooted at *paper_id*.

    Returns a dict::

        {
            "paper_id": "...",
            "title": "...",
            "citations": [...],
            "references": [...]
        }

    Each child entry has the same shape (recursively, up to *depth*).
    """
    title = _fetch_paper_title(paper_id)
    tree: dict = {
        "paper_id": paper_id,
        "title": title,
        "citations": fetch_citations(paper_id, depth),
        "references": fetch_references(paper_id, depth),
    }
    logger.info(
        "Citation tree built for %s — %d citations, %d references",
        paper_id, len(tree["citations"]), len(tree["references"]),
    )
    return tree
