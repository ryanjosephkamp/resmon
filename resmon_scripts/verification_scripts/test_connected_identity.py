"""Handler guards precede SQLite/capability access; metadata is read, not inferred."""
from concurrent.futures import ThreadPoolExecutor
import os
import sqlite3
from uuid import uuid4
import pytest
from fastapi import HTTPException
import resmon
from implementation_scripts import runtime_identity as identity


@pytest.mark.parametrize("handler", [resmon.health, lambda expected_runtime_id: resmon.get_execution(999999, expected_runtime_id)])
@pytest.mark.parametrize("expected,code", [("", 422), ("bad", 422), (str(uuid4()).upper(), 422), (str(uuid4()), 409)])
def test_refusal_precedes_any_database_or_capability_work(monkeypatch, handler, expected, code):
    def forbidden():
        raise AssertionError("wrong runtime reached database")
    monkeypatch.setattr(resmon, "_get_db", forbidden)
    with pytest.raises(HTTPException) as exc:
        handler(expected_runtime_id=expected)
    assert exc.value.status_code == code
    if code == 409:
        assert exc.value.detail == {"code": "instance_mismatch", "message": "This request reached a different running app.",
            "expected_runtime_id": expected, "actual_runtime_id": identity.current_runtime_id()}


def test_saved_schema_unknowns_and_no_writes():
    with sqlite3.connect(":memory:") as conn:
        assert identity.project(conn)["schema_version"] is None
        conn.execute("CREATE TABLE app_settings (key TEXT, value TEXT)")
        assert identity.project(conn)["schema_version"] is None
        conn.execute("INSERT INTO app_settings VALUES ('schema_version', '9')")
        before = conn.total_changes
        projection = identity.project(conn)
        assert projection == {"contract_version": 1, "runtime_id": identity.current_runtime_id(),
                              "schema_version": 9, "corpus_id": None, "build_id": None}
        assert conn.total_changes == before
        conn.execute("UPDATE app_settings SET value='bad'")
        assert identity.project(conn)["schema_version"] is None


def test_concurrent_identity_stays_one_uuid4():
    with ThreadPoolExecutor(max_workers=8) as pool:
        tokens = list(pool.map(lambda _: identity.current_runtime_id(), range(100)))
    assert len(set(tokens)) == 1 and identity.valid_runtime_id(tokens[0])


@pytest.mark.skipif(not hasattr(os, "fork"), reason="fork does not exist on this platform; independent spawn/restart covered separately")
def test_preloaded_fork_child_gets_its_own_identity():
    read_fd, write_fd = os.pipe()
    parent = identity.current_runtime_id()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        os.write(write_fd, identity.current_runtime_id().encode())
        os.close(write_fd)
        os._exit(0)
    os.close(write_fd)
    try:
        child = os.read(read_fd, 100).decode()
    finally:
        os.close(read_fd)
        _, status = os.waitpid(pid, 0)
    assert status == 0 and identity.valid_runtime_id(child) and child != parent
    assert identity.current_runtime_id() == parent
