# resmon_scripts/verification_scripts/test_model_list_key_transport.py
"""Where ``ai_models.list_available_models`` puts a key on the wire.

Settings › AI lists a provider's models with the key the person typed, before
it is ever used for a summary. Google's listing sent that key as ``?key=``,
the line ``llm_remote`` and ``assistant_api_runtime`` had already moved to
``x-goog-api-key``: a query string is written to every proxy's access log on
the way, and ``httpx``'s ``HTTPStatusError`` quotes the URL it requested.

Every provider that takes a key is driven here through a real ``httpx.Client``
over ``httpx.MockTransport``, so the URL asserted on is the one that would
have gone out on the socket.

What this cannot see: whether Google honors ``x-goog-api-key`` on the models
listing. That is a live-network fact; the header is the one Google documents
for the Generative Language API.
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import ai_models  # noqa: E402

# Shaped like a real Google key, so a redaction that works by shape cannot make
# the URL assertion pass for the wrong reason.
GOOGLE_SHAPED_KEY = "AIzaSyCANARY0000000000000000000000000000"
OPAQUE_KEY = "canary-model-list-41c7-not-a-real-key"


@pytest.fixture
def recorded(monkeypatch):
    requests: list[httpx.Request] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if "generativelanguage" in request.url.host:
            return httpx.Response(200, json={"models": [
                {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
            ]})
        return httpx.Response(200, json={"data": [{"id": "some-model"}]})

    real_client = httpx.Client

    def _factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return real_client(*args, transport=httpx.MockTransport(_handle), **kwargs)

    monkeypatch.setattr(ai_models.httpx, "Client", _factory)
    return requests


def test_google_lists_models_with_the_key_in_a_header(recorded):
    assert ai_models.list_available_models("google", key=GOOGLE_SHAPED_KEY) == ["gemini-2.5-flash"]

    assert len(recorded) == 1
    request = recorded[0]
    assert str(request.url) == "https://generativelanguage.googleapis.com/v1beta/models"
    assert GOOGLE_SHAPED_KEY not in str(request.url)
    assert request.headers.get("x-goog-api-key") == GOOGLE_SHAPED_KEY
    # One slot: a key copied into a second header is a second place it can leak from.
    assert request.headers.get("authorization") is None


def test_a_refused_google_listing_does_not_quote_the_key(monkeypatch):
    """The error a person reads is built from the status, never from the URL."""
    real_client = httpx.Client

    def _factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return real_client(*args, transport=httpx.MockTransport(lambda r: httpx.Response(403)), **kwargs)

    monkeypatch.setattr(ai_models.httpx, "Client", _factory)
    with pytest.raises(ai_models.ModelListError) as raised:
        ai_models.list_available_models("google", key=GOOGLE_SHAPED_KEY)
    assert GOOGLE_SHAPED_KEY not in str(raised.value)
    assert GOOGLE_SHAPED_KEY not in str(raised.value.__cause__)


@pytest.mark.parametrize("provider", ["anthropic", "custom", *sorted(ai_models._PROVIDER_SPECS)])
def test_no_provider_listing_puts_the_key_in_a_url(provider, recorded):
    """Denominator: every keyed branch of ``list_available_models``, the
    OpenAI-compatible specs read from the module so a provider added later is
    covered without an edit here."""
    ai_models.list_available_models(provider, key=OPAQUE_KEY, base_url="https://example.invalid/v1")

    assert len(recorded) == 1, provider
    request = recorded[0]
    assert OPAQUE_KEY not in str(request.url), f"{provider} sent the key in the request line"
    assert OPAQUE_KEY in (request.headers.get("authorization", "") + request.headers.get("x-api-key", ""))
