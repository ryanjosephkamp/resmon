#!/usr/bin/env python3
"""A stand-in for ``launchctl``, for the suites: a small launchd held in a JSON file.

The suites point ``RESMON_LAUNCHCTL`` at this file and ``RESMON_SERVICE_LABEL``
at a label of their own, so no test ever addresses the service a person runs.
``FAKE_LAUNCHCTL_STATE`` names the state file; without one, every label is
unloaded and nothing can be started or stopped, which is what the suite gets by
default. The state holds:

* ``loaded``: label to pid, for the jobs launchd holds;
* ``disabled``: labels macOS's Allow in the Background has turned off;
* ``stuck``: labels a bootout fails to stop;
* ``next_pid``: the pid the next start is given;
* ``calls``: every call made, in order.

It answers as launchctl does where the code reads the answer: ``print`` exits
113 for a label it does not hold, ``bootstrap`` of a held or disabled label
exits 5, and ``print-disabled`` lists a disabled label as ``=> disabled``.
"""
from __future__ import annotations

import json
import os
import plistlib
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    where = os.environ.get("FAKE_LAUNCHCTL_STATE")
    if not where:
        if argv[:1] == ["print"]:
            print("Could not find service in domain", file=sys.stderr)
            return 113
        if argv[:1] == ["print-disabled"]:
            print("disabled services = {\n}")
            return 0
        print("fake launchctl: no state file, nothing is started or stopped", file=sys.stderr)
        return 1
    path = Path(where)
    state = json.loads(path.read_text()) if path.exists() else {}
    loaded: dict[str, int] = state.setdefault("loaded", {})
    disabled: list[str] = state.setdefault("disabled", [])
    stuck: list[str] = state.setdefault("stuck", [])
    state.setdefault("calls", []).append(argv)
    state.setdefault("next_pid", 4242)

    def save() -> None:
        # Whole or not at all: a test reads the state while the app is still
        # asking, and a file caught half-written does not parse.
        written = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        written.write_text(json.dumps(state, indent=1))
        os.replace(written, path)

    def label_of(target: str) -> str:
        return target.rsplit("/", 1)[-1]

    command = argv[0] if argv else ""
    code = 0
    if command == "print":
        label = label_of(argv[1])
        if label in loaded:
            print(f"{argv[1]} = {{\n\tstate = running\n\tpid = {loaded[label]}\n}}")
        else:
            print("Could not find service in domain", file=sys.stderr)
            code = 113
    elif command == "print-disabled":
        rows = "".join(f'\t"{label}" => disabled\n' for label in disabled)
        print("disabled services = {\n" + rows + "}")
    elif command == "bootstrap":
        label = plistlib.loads(Path(argv[2]).read_bytes())["Label"]
        if label in disabled or label in loaded:
            print("Bootstrap failed: 5: Input/output error", file=sys.stderr)
            code = 5
        else:
            loaded[label] = state["next_pid"]
            state["next_pid"] += 1
    elif command == "bootout":
        label = label_of(argv[1])
        if label in stuck:
            print("Boot-out failed: 5: Input/output error", file=sys.stderr)
            code = 5
        elif label in loaded:
            del loaded[label]
        else:
            print("Boot-out failed: 3: No such process", file=sys.stderr)
            code = 3
    elif command == "kickstart":
        label = label_of(argv[-1])
        if label in loaded:
            loaded[label] = state["next_pid"]
            state["next_pid"] += 1
        else:
            code = 113
    else:
        print(f"fake launchctl: {command!r} is not one of its commands", file=sys.stderr)
        code = 64
    save()
    return code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
