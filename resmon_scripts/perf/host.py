"""The app as the background service, started and measured beside the bare engine.

The background service was a bare Python process; with ``--service`` the app is
the service instead, and runs the same engine as its child (``electron/host.ts``
says why). That costs an Electron main process and the helpers Chromium starts
with it, and this module measures what it costs: the same seeded corpus, the
same recordings, one form after the other in one sitting, by role and in total,
idle and after a run, as resident size and as physical footprint (the number
compression cannot hide; see ``resources.footprint_mb``).

``start_host`` launches the app the way a unit would, minus the unit: it is
never registered with launchd, its state is the harness's own, and it refuses
the installed service's port like every process the harness starts.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import httpx

from . import engine, instance, resources

FRONTEND = instance.SCRIPTS / "frontend"
HOOK = Path(__file__).resolve().parent / "hook"


def checkout_executable(frontend: Path = FRONTEND) -> list[str]:
    """The checkout's Electron binary and the app directory it runs.

    The binary itself rather than ``node_modules/.bin/electron``, which is a
    Node script that starts the binary as its child: measured from the script,
    the tree would carry a Node process the installed app does not have.
    """
    relative = (frontend / "node_modules" / "electron" / "path.txt").read_text().strip()
    return [str(frontend / "node_modules" / "electron" / "dist" / relative), str(frontend)]


def start_host(state: Path, *, executable: Optional[list[str]] = None,
               replay: Optional[dict] = None, show_notices: bool = False,
               timeout: float = 120.0) -> instance.Backend:
    """Start the app with ``--service`` over ``state``; wait until its engine answers.

    Its notifications are written to its log, not shown, unless ``show_notices``:
    a measurement should not put anything on the screen of the person at the
    Mac, and only a check of the notification itself needs to.
    """
    state.mkdir(parents=True, exist_ok=True)
    port = instance.free_port()
    if port == instance.SERVICE_PORT:
        raise RuntimeError("the free port was the installed service's; refusing")
    extra = {
        "RESMON_DAEMON_PORT": str(port),
        "PYTHONPATH": os.pathsep.join([str(HOOK), str(instance.SCRIPTS)]),
    }
    if executable is None:
        # The checkout's Electron runs the checkout's engine with this
        # interpreter; a packaged app is measured with the runtime it ships.
        extra["RESMON_PYTHON"] = sys.executable
    if not show_notices:
        extra["RESMON_NOTICES_TO_LOG"] = "1"
    if replay:
        extra["RESMON_PERF_REPLAY"] = replay["mode"]
        extra["RESMON_PERF_REPLIES"] = str(replay["dir"])
        extra["RESMON_PERF_LATENCY"] = str(replay.get("latency", "recorded"))
    env = instance.isolated_env(state, scheduler=True, extra=extra)
    args = [*(executable or checkout_executable()), "--service",
            f"--user-data-dir={state / 'electron-user-data'}"]
    log_path = state / f"host-{port}.log"
    log = open(log_path, "ab")
    started = time.perf_counter()
    proc = subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT)
    log.close()
    token_file = state / f"api-token-{port}"
    deadline = started + timeout
    while True:
        if proc.poll() is not None:
            raise RuntimeError(f"the app exited with {proc.returncode}:\n"
                               + log_path.read_text(errors="replace")[-3000:])
        if token_file.exists():
            token = token_file.read_text("ascii").strip()
            try:
                response = httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=1.0,
                                     headers={"Authorization": f"Bearer {token}"})
                if response.status_code == 200:
                    break
            except httpx.HTTPError:
                pass
        if time.perf_counter() > deadline:
            proc.kill()
            raise RuntimeError("the app's engine did not answer /api/health in time:\n"
                               + log_path.read_text(errors="replace")[-3000:])
        time.sleep(0.05)
    return instance.Backend(proc=proc, port=port, state=state, log_path=log_path,
                            started_at=started, healthy_at=time.perf_counter(), _token=token)


def _reading(root: int) -> dict:
    snap = resources.snapshot(root)
    footprint = resources.footprint_mb(root)
    by_role_fp: dict[str, float] = {}
    for proc in resources.tree(root):
        one = resources.footprint_of(proc["pid"])
        if one is not None:
            by_role_fp[proc["role"]] = by_role_fp.get(proc["role"], 0.0) + one
    return {"rss_mb": round(snap["total_mb"], 1),
            "rss_by_role_mb": {k: round(v, 1) for k, v in snap["by_role_mb"].items()},
            "footprint_mb": None if footprint is None else round(footprint, 1),
            "footprint_by_role_mb": {k: round(v, 1) for k, v in by_role_fp.items()},
            "processes": snap["processes"]}


def _one_run(backend: instance.Backend) -> dict:
    """One sweep through a routine, as the service runs one; its row when it ends."""
    routine = backend.post("/api/routines", {
        "name": "measure", "schedule_cron": "0 0 1 1 *",
        "parameters": dict(engine.SWEEP_BODY), "is_active": False, "notify_on_complete": True,
    })
    exec_id = backend.post(f"/api/routines/{routine['id']}/run")["execution_id"]
    row, _events = instance.wait_for_execution(backend, exec_id)
    return row


def measure(work: Path, corpus: Path, replies: Path, *, form: str,
            executable: Optional[list[str]] = None, python: Optional[str] = None,
            settle_seconds: float = 5.0, idle_seconds: float = 30.0, progress=None) -> dict:
    """One form of the service, ``engine`` (the bare daemon) or ``app`` (``--service``).

    ``python`` is the interpreter the bare engine runs on: a packaged app's own
    runtime, so the two forms differ by the app and nothing else.
    """
    state = instance.fresh_state(work, f"service-{form}", seed_db=corpus)
    replay = {"mode": "replay", "dir": replies, "latency": "zero"}
    if form == "engine":
        backend = instance.start_backend(state, python=python, daemon=True, scheduler=True, replay=replay)
    elif form == "app":
        backend = start_host(state, executable=executable, replay=replay)
    else:
        raise ValueError(f"unknown form {form!r}")
    try:
        time.sleep(settle_seconds)
        idle = _reading(backend.proc.pid)
        cpu = resources.idle_cpu(backend.proc.pid, idle_seconds)
        row = _one_run(backend)
        time.sleep(settle_seconds)
        after = _reading(backend.proc.pid)
        notices = [line for line in backend.log_path.read_text(errors="replace").splitlines()
                   if "[main] notice " in line]
    finally:
        backend.stop()
    result = {"form": form, "idle": idle, "cpu_idle_percent": round(cpu["percent_of_one_core"], 2),
              "after_run": after, "run_status": row.get("status"),
              "notices_logged": len(notices)}
    if progress:
        progress(f"service as {form}: idle {idle['footprint_mb']} MB footprint "
                 f"({idle['rss_mb']} MB resident), after a run {after['footprint_mb']} MB")
    return result


def summarize(rounds: list[dict]) -> dict:
    """Medians per form: total and by role, idle and after a run, footprint and resident."""
    from .stats import percentile

    def median(values: list[float]) -> Optional[float]:
        values = [v for v in values if v is not None]
        return round(percentile(values, 0.5), 1) if values else None

    out: dict = {}
    for form in ("engine", "app"):
        mine = [r for r in rounds if r["form"] == form]
        if not mine:
            continue
        entry: dict = {"rounds": len(mine),
                       "cpu_idle_percent": median([r["cpu_idle_percent"] for r in mine]),
                       "runs_completed": sum(1 for r in mine if r["run_status"] == "completed"),
                       "notices_logged": sum(r["notices_logged"] for r in mine)}
        for when in ("idle", "after_run"):
            entry[when] = {
                "footprint_mb": median([r[when]["footprint_mb"] for r in mine]),
                "rss_mb": median([r[when]["rss_mb"] for r in mine]),
                "footprint_by_role_mb": {role: median([r[when]["footprint_by_role_mb"].get(role) for r in mine])
                                         for role in sorted({k for r in mine for k in r[when]["footprint_by_role_mb"]})},
                "rss_by_role_mb": {role: median([r[when]["rss_by_role_mb"].get(role) for r in mine])
                                   for role in sorted({k for r in mine for k in r[when]["rss_by_role_mb"]})},
            }
        out[form] = entry
    return out


def describe(summary: dict) -> str:
    lines = []
    for form, entry in summary.items():
        lines.append(
            f"{form}: {entry['rounds']} rounds; idle {entry['idle']['footprint_mb']} MB footprint "
            f"({entry['idle']['rss_mb']} MB resident), after a run {entry['after_run']['footprint_mb']} MB "
            f"({entry['after_run']['rss_mb']} MB); CPU idle {entry['cpu_idle_percent']}% of a core; "
            f"{entry['runs_completed']} runs completed, {entry['notices_logged']} notices through the app")
    return "\n".join(lines)
