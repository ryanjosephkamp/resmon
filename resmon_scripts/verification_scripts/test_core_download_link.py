"""CORE's link for a work: its download link, then a full-text link it lists, then its page.

A precedence slip made the download link depend on the full-text list: a work
with a ``downloadUrl`` and no ``sourceFulltextUrls`` was stored with only its
CORE page, so the paper's own PDF link was lost.
"""
from __future__ import annotations

import pytest

from implementation_scripts.api_core import CoreClient


def _work(**fields: object) -> dict:
    return {"id": 4242, "title": "A CORE work", "authors": [{"name": "Ada Fixture"}],
            "publishedDate": "2026-10-01T00:00:00", **fields}


@pytest.mark.parametrize("fields,expected", [
    ({"downloadUrl": "https://core.ac.uk/download/4242.pdf"}, "https://core.ac.uk/download/4242.pdf"),
    ({"downloadUrl": "https://core.ac.uk/download/4242.pdf", "sourceFulltextUrls": []},
     "https://core.ac.uk/download/4242.pdf"),
    ({"downloadUrl": "https://core.ac.uk/download/4242.pdf", "sourceFulltextUrls": ["https://repo.example.org/a.pdf"]},
     "https://core.ac.uk/download/4242.pdf"),
    ({"sourceFulltextUrls": ["", "https://repo.example.org/a.pdf"]}, "https://repo.example.org/a.pdf"),
    ({"downloadUrl": "", "sourceFulltextUrls": None}, "https://core.ac.uk/works/4242"),
    ({}, "https://core.ac.uk/works/4242"),
])
def test_the_link_kept_for_a_work(fields: dict, expected: str) -> None:
    result = CoreClient._parse_work(_work(**fields))
    assert result is not None
    assert result.url == expected
