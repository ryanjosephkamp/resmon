"""resmon's command line: the running resmon's own answers, in a terminal.

It talks to the engine that is already running -- the background service, or
the app's own engine -- over the same loopback HTTP API, with the same token,
that the app and the MCP server use. It never opens the database and never
starts an engine; :mod:`resmon_cli.engine` says why.
"""

__version__ = "0.1.0"
