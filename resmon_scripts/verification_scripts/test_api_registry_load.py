# resmon_scripts/verification_scripts/test_api_registry_load.py
"""The source list loads once, whole, however many runs ask for it at once.

On November 4, 2026, two watches fired at midnight as the engine's first users
of the registry. ``_ensure_loaded`` set ``_loaded`` before it imported the
client modules, with no lock, so the second thread found it true and asked for
"crossref" before ``api_crossref`` had registered: that run failed after 0
seconds with "Unknown repository: crossref". These cases slow the import down
so the race is certain rather than lucky, and hold the fix: a second caller
waits for the first, and an import that raises leaves the list to be loaded
again rather than half loaded for good. The engine also loads it at start.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import api_registry  # noqa: E402


class _Fake:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


@pytest.fixture
def unloaded(monkeypatch):
    """The registry as an engine finds it before any run: not loaded yet."""
    monkeypatch.setattr(api_registry, "_loaded", False)
    monkeypatch.delitem(api_registry._REGISTRY, "late_source", raising=False)
    yield
    api_registry._REGISTRY.pop("late_source", None)


def test_a_run_that_asks_while_another_loads_the_list_waits_for_it(monkeypatch, unloaded):
    started = threading.Event()

    def slow_import():
        started.set()
        time.sleep(0.3)  # the client modules, imported one after another
        api_registry.register_client("late_source", _Fake)

    monkeypatch.setattr(api_registry, "_import_clients", slow_import)
    first = threading.Thread(target=api_registry._ensure_loaded)
    first.start()
    assert started.wait(2)
    time.sleep(0.01)
    # The second run, a moment later: it waits for the list rather than finding it empty.
    client = api_registry.get_client("late_source", option=1)
    first.join(2)
    assert isinstance(client, _Fake) and client.kwargs == {"option": 1}
    assert api_registry._loaded is True


def test_an_import_that_raises_leaves_the_list_to_be_loaded_again(monkeypatch, unloaded):
    calls: list[int] = []

    def flaky_import():
        calls.append(1)
        if len(calls) == 1:
            raise ImportError("a client could not be imported")
        api_registry.register_client("late_source", _Fake)

    monkeypatch.setattr(api_registry, "_import_clients", flaky_import)
    with pytest.raises(ImportError):
        api_registry._ensure_loaded()
    assert api_registry._loaded is False, "a failed load was taken as a finished one"
    assert isinstance(api_registry.get_client("late_source"), _Fake)
    assert api_registry._loaded is True and len(calls) == 2


def test_the_engine_loads_the_list_when_it_starts(monkeypatch, unloaded):
    import resmon

    loads: list[int] = []
    monkeypatch.setattr(api_registry, "_import_clients", lambda: loads.append(1))
    resmon._ensure_clients_loaded_on_startup()
    assert loads == [1] and api_registry._loaded is True
