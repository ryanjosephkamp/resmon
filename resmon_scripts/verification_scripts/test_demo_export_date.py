"""The collection's date uses the same time zone as the site's Source wall."""
import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType
import pytest


@pytest.fixture
def exporter(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    source = Path(__file__).resolve().parents[1] / 'frontend' / 'demos' / 'export_site.py'
    monkeypatch.syspath_prepend(str(source.parent))
    spec = importlib.util.spec_from_file_location('demo_export_site', source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_export_day_uses_new_york_at_the_utc_day_boundary(exporter: ModuleType) -> None:
    assert exporter.spoken_day('2026-11-06T04:53:24Z') == 'November 5, 2026'
    assert exporter.spoken_day('2026-11-06T05:01:00Z') == 'November 6, 2026'
    assert exporter.spoken_day('2026-07-06T03:53:24Z') == 'July 5, 2026'


def test_export_dates_the_collection_from_saved_runs_instead_of_the_export_clock(
    exporter: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    collection = tmp_path / 'collection'
    (collection / 'state').mkdir(parents=True)
    (collection / 'state' / 'resmon.db').touch()
    output = tmp_path / 'output'
    output.mkdir()
    responses = {
        '/api/map': {'state': 'ready', 'points': {'id': []}},
        '/api/today': {'now': '2026-11-08T12:00:00Z'},
        '/api/coverage/source-wall?limit=6': {
            'runs': [{'execution_id': 1, 'started_at': '2026-11-06T04:53:24Z'}],
        },
        '/api/executions/1': {},
        '/api/map/facets': {},
    }

    class SavedEngine:
        def __init__(self, env: dict, python: str, log: Path) -> None:
            pass

        def call(self, method: str, route: str) -> dict:
            assert method == 'GET'
            return responses[route]

        def stop(self) -> None:
            pass

    monkeypatch.setattr(exporter, 'Engine', SavedEngine)
    monkeypatch.setattr(exporter, 'SITE_DATA', output)
    monkeypatch.setattr(sys, 'argv', ['export_site.py', str(collection)])
    exporter.main()
    for name in ['plate.json', 'run-record.json']:
        provenance = json.loads((output / name).read_text())['provenance']
        assert 'November 5, 2026' in provenance
        assert 'November 8' not in provenance
