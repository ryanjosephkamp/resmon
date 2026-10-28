"""``resmon``: the argument parser, and what a failure prints and returns.

Exit statuses: 0 done; 1 resmon refused or failed the request; 2 the command
was not one resmon can be asked (argparse's own status for a usage error);
3 no resmon is running, or it stopped answering.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Mapping, Optional, Sequence, TextIO

from resmon_cli import __version__, commands
from resmon_cli.engine import CliError, find
from resmon_cli.text import Out, terminal_width

_DATE = re.compile(r"\d{4}(-\d{2}(-\d{2})?)?")


def _date(value: str) -> str:
    if not _DATE.fullmatch(value):
        raise argparse.ArgumentTypeError(f"{value!r} is not a date: use 2026, 2026-10 or 2026-10-28")
    return value


def _positive(limit: int):
    def parse(value: str) -> int:
        try:
            n = int(value)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{value!r} is not a number") from None
        if not 1 <= n <= limit:
            raise argparse.ArgumentTypeError(f"choose a number from 1 to {limit}")
        return n
    return parse


def _json_flag(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true",
                        help="print resmon's own answer as JSON instead of sentences")


def _corpus_filters(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--source", action="append", metavar="SOURCE",
                        help="only this source, by name or slug (repeatable)")
    parser.add_argument("--author", action="append", metavar="NAME", help="only this author (repeatable)")
    parser.add_argument("--category", action="append", metavar="CATEGORY",
                        help="only this subject category (repeatable)")
    parser.add_argument("--from", dest="date_from", type=_date, metavar="DATE",
                        help="published on or after DATE")
    parser.add_argument("--to", dest="date_to", type=_date, metavar="DATE",
                        help="published on or before DATE")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="resmon",
        description="Ask the running resmon what it has collected and how its watches are doing. "
                    "It talks to the background service, or to the app's own engine, and never "
                    "starts resmon itself.",
    )
    parser.add_argument("--version", action="version", version=f"resmon command line {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    p = sub.add_parser("today", help="the papers first collected since you last marked all read",
                       description="Today: the papers resmon first collected since you last marked "
                                   "all read, by watch. Reading it marks nothing.")
    p.add_argument("action", nargs="?", choices=["mark-read"],
                   help="mark-read: Mark all read, so the next Today starts now")
    p.add_argument("--limit", type=_positive(1000), default=20, help="papers to show (default 20)")
    p.add_argument("--all", action="store_true", help="show every paper Today lists")
    _json_flag(p)

    p = sub.add_parser("search", help="search the whole collection, as the Explorer does",
                       description="Search everything resmon has collected: free text across "
                                   "titles and abstracts, narrowed by the filters.")
    p.add_argument("query", nargs="*", help="words to look for")
    _corpus_filters(p)
    p.add_argument("--sort", choices=["newest", "closest"], default="newest",
                   help="newest publication date first (default), or closest to your search, which "
                        "asks the embedding model set in Settings → AI to embed your words")
    p.add_argument("--limit", type=_positive(200), default=20, help="papers per page (default 20)")
    p.add_argument("--cursor", help="the next page, as the previous page printed it")
    p.add_argument("--abstracts", action="store_true", help="print each paper's abstract")
    _json_flag(p)

    p = sub.add_parser("runs", help="recent runs, or one run's whole account",
                       description="Recent runs with what each found and which sources answered, "
                                   "or, given an id, one run's whole account.")
    p.add_argument("id", nargs="?", type=int, help="a run's number")
    p.add_argument("--limit", type=_positive(500), default=20, help="runs to show (default 20)")
    p.add_argument("--kind", choices=sorted(commands.EXECUTION_KINDS),
                   help="only Deep Dives, Deep Sweeps or watch runs")
    _json_flag(p)

    p = sub.add_parser("wall", help="the Source wall: every source's answer to each recent run",
                       description="The Source wall: what every source recorded on each of the "
                                   "last runs, and whether any has stopped answering.")
    p.add_argument("--runs", type=_positive(50), default=12, help="how many runs (default 12, at most 50)")
    p.add_argument("--legend", action="store_true", help="say what each mark means")
    _json_flag(p)

    p = sub.add_parser("export", help="references for a run, Today, a search or chosen papers",
                       description="Export references in the formats the app exports: BibTeX, "
                                   "RIS, CSV or JSON. They go to standard output unless -o names "
                                   "a file.")
    which = p.add_mutually_exclusive_group(required=True)
    which.add_argument("--run", type=int, metavar="ID", help="the papers one run found")
    which.add_argument("--today", action="store_true", help="the papers Today lists")
    which.add_argument("--ids", type=int, nargs="+", metavar="ID", help="these papers, by id")
    which.add_argument("--search", dest="query", metavar="WORDS",
                       help="everything matching a search (with the filters below)")
    p.add_argument("--new-only", action="store_true", help="with --run: only the papers new to the collection")
    _corpus_filters(p)
    p.add_argument("--format", choices=sorted(commands.FORMAT_NAMES), default="bibtex",
                   help="default bibtex")
    p.add_argument("-o", "--output", metavar="FILE", help="write to FILE instead of standard output")
    _json_flag(p)

    p = sub.add_parser("service", help="whether resmon is running, and what runs the schedule")
    service = p.add_subparsers(dest="service_command", metavar="<what>")
    s = service.add_parser("status", help="which resmon this command reaches, and whether watches will run")
    _json_flag(s)

    p = sub.add_parser("watch", help="the watches (routines): list them, or add one")
    watch = p.add_subparsers(dest="watch_command", metavar="<what>")
    s = watch.add_parser("list", help="every saved watch and whether anything will run it")
    _json_flag(s)
    s = watch.add_parser("add", help="add a watch",
                         description="Add a watch: the keywords it searches for, the sources it asks, "
                                     "and when. It is active unless --inactive, as the app's editor "
                                     "saves it.")
    s.add_argument("name", help="what to call it")
    s.add_argument("--keyword", action="append", required=True, metavar="WORDS",
                   help="a keyword or phrase (repeatable)")
    s.add_argument("--source", action="append", required=True, metavar="SOURCE",
                   help="a source to ask, by name or slug (repeatable)")
    s.add_argument("--schedule", default="0 8 * * *", metavar="CRON",
                   help="five-field cron, as the editor stores it (default '0 8 * * *')")
    s.add_argument("--max-results", type=_positive(10000), default=100, metavar="N",
                   help="most results per source per run (default 100)")
    s.add_argument("--intent", metavar="SENTENCE",
                   help="what you are really looking for, in your words; the coverage audit uses it")
    s.add_argument("--inactive", action="store_true", help="save it without putting it on its schedule")
    _json_flag(s)
    return parser


def main(argv: Optional[Sequence[str]] = None, *, env: Optional[Mapping[str, str]] = None,
         stdout: Optional[TextIO] = None, stderr: Optional[TextIO] = None) -> int:
    env = os.environ if env is None else env
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    parser = build_parser()
    args = parser.parse_args(argv)
    width = terminal_width(env)
    out, err = Out(stdout, width), Out(stderr, width)

    if args.command is None:
        parser.print_help(stdout)
        return 0
    if args.command == "service" and args.service_command is None:
        parser.parse_args(["service", "--help"])
    if args.command == "watch" and args.watch_command is None:
        parser.parse_args(["watch", "--help"])

    try:
        if args.command == "service":
            return commands.service_status(env, args, out)
        engine = find(env)
        if args.command == "today":
            return commands.today(engine, args, out)
        if args.command == "search":
            return commands.search(engine, args, out)
        if args.command == "runs":
            return commands.runs(engine, args, out)
        if args.command == "wall":
            return commands.wall(engine, args, out)
        if args.command == "export":
            return commands.export(engine, args, out, err)
        if args.watch_command == "list":
            return commands.watch_list(engine, args, out)
        return commands.watch_add(engine, args, out)
    except CliError as exc:
        if getattr(args, "json", False):
            stderr.write(json.dumps(exc.payload(), ensure_ascii=False) + "\n")
        else:
            stderr.write(exc.message + "\n")
        return exc.exit_status


def run() -> None:
    """The console script's entry point."""
    try:
        status = main()
        sys.stdout.flush()
    except KeyboardInterrupt:
        status = 130
    except BrokenPipeError:
        # Piped into ``head``: the reader left. Point stdout at nothing so the
        # interpreter's own flush at exit does not raise a second time.
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, sys.stdout.fileno())
        status = 0
    sys.exit(status)
