"""The assistant's status is one answer from one read of its settings.

``GET /api/assistant/status`` builds the runtime, the other routes, and the
composer's choices from the assistant's settings. It read them twice, once for
the runtime and once for the choices, so a save landing between the two reads
gave an answer whose runtime and choices described different settings.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

import resmon as resmon_mod


def test_the_status_reads_the_settings_once_for_the_whole_answer(monkeypatch) -> None:
    real = resmon_mod._assistant_settings
    reads: list[dict] = []

    def counted(conn):
        settings = real(conn)
        reads.append(settings)
        return settings

    monkeypatch.setattr(resmon_mod, "_assistant_settings", counted)
    seen: dict = {}
    real_runtime = resmon_mod.assistant_runtime.runtime_status
    real_choices = resmon_mod.assistant_choices.descriptor

    def runtime(settings, **kwargs):
        seen["runtime"] = settings
        return real_runtime(settings, **kwargs)

    def choices(settings, **kwargs):
        seen["choices"] = settings
        return real_choices(settings, **kwargs)

    monkeypatch.setattr(resmon_mod.assistant_runtime, "runtime_status", runtime)
    monkeypatch.setattr(resmon_mod.assistant_choices, "descriptor", choices)

    answer = TestClient(resmon_mod.create_app()).get("/api/assistant/status")

    assert answer.status_code == 200, answer.text
    assert len(reads) == 1
    assert seen["runtime"] is seen["choices"] is reads[0]
