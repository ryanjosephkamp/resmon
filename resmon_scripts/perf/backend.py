"""Start resmon's backend, or its background service, under the harness.

``python -m perf.backend <port>`` runs exactly what Electron runs
(``resmon.py``'s ``main``); ``--daemon`` runs what launchd runs
(``implementation_scripts.daemon``). The only difference from either is that
the recorded-reply transport is installed first when ``RESMON_PERF_REPLAY`` is
set, before resmon imports a single source client.
"""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from perf import replay  # noqa: E402


def main() -> int:
    replay.install_from_environment()
    argv = sys.argv[1:]
    if argv and argv[0] == "--daemon":
        from implementation_scripts import daemon

        return daemon.run(["implementation_scripts.daemon", *argv[1:]])
    import resmon

    sys.argv = ["resmon.py", *argv]
    resmon.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
