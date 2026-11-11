"""The recorded-reply transport, for a backend the harness does not start itself.

``perf.backend`` installs the transport before resmon imports anything, but it
can only do that for a process it is the entry point of. The app running as
the background service starts its engine itself, as
``python -m implementation_scripts.daemon``. Python imports ``sitecustomize``
from the path before the program's first line, so the harness puts this
directory first on that engine's ``PYTHONPATH`` and the transport is in place
just as early. With ``RESMON_PERF_REPLAY`` unset it does nothing.
"""

import os

if os.environ.get("RESMON_PERF_REPLAY"):
    from perf import replay

    replay.install_from_environment()
