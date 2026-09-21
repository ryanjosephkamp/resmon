"""The four branches of ``runtime_identity.process_is_alive``, pinned once.

The rule used to be written out three times -- in ``resmon``'s startup
reconciliation, in ``delivery.requeue_orphaned`` and inline in
``selected_evidence_runtime._startup`` -- and three copies of a one-sided rule
are three chances for one of them to drift towards "dead" and tell a user a
live run has stopped. This file is where the rule is tested; the three call
sites are tested for what they *do* with the answer, in their own suites.
"""
import builtins

from implementation_scripts import runtime_identity


def _kill_raising(monkeypatch, exc):
    def _kill(pid, sig):
        raise exc

    monkeypatch.setattr(runtime_identity.os, "kill", _kill)


def test_a_live_pid_reads_alive(monkeypatch):
    monkeypatch.setattr(runtime_identity.os, "kill", lambda pid, sig: None)
    assert runtime_identity.process_is_alive(4242) is True


def test_process_lookup_error_is_the_only_proof_of_death(monkeypatch):
    _kill_raising(monkeypatch, ProcessLookupError())
    assert runtime_identity.process_is_alive(4242) is False


def test_permission_error_reads_alive(monkeypatch):
    """Another user's pid: we could not tell, so we do not claim it is gone."""
    _kill_raising(monkeypatch, PermissionError())
    assert runtime_identity.process_is_alive(4242) is True


def test_any_other_oserror_reads_alive(monkeypatch):
    _kill_raising(monkeypatch, OSError("ESRCH-ish, but not ProcessLookupError"))
    assert runtime_identity.process_is_alive(4242) is True


def test_values_that_are_not_pids_read_dead(monkeypatch):
    """``os.kill`` is never reached for these -- asking is the bug."""
    def _never(pid, sig):  # pragma: no cover - the assertion is that it is not called
        raise AssertionError(f"os.kill was asked about {pid!r}")

    monkeypatch.setattr(runtime_identity.os, "kill", _never)
    for value in (None, 0, -1, True, False, "4242", 4242.0):
        assert runtime_identity.process_is_alive(value) is False, value


def test_the_three_call_sites_share_this_one_implementation():
    """No fourth copy: the two aliases are this function, not a lookalike."""
    import resmon as resmon_mod
    from implementation_scripts import delivery

    assert resmon_mod._owner_process_is_alive is runtime_identity.process_is_alive
    assert delivery._owner_process_is_alive is runtime_identity.process_is_alive
    assert "os.kill" not in builtins.open(
        delivery.__file__.replace(".pyc", ".py")).read().split("def requeue_orphaned")[0]
