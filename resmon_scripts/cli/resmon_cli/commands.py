"""The commands: one engine route or a few, and the engine's words in a terminal.

``--json`` on a data command prints the engine's own body, unchanged, so a
script reads exactly what resmon established and nothing this file added. The
commands that put several answers together -- ``service status``, ``watch add``
and ``export``'s report of what it wrote -- say so in their keys.

Nothing printed here is model-written. resmon keeps model-written summaries
only inside run reports, which no command prints; the text under a paper is the
opening of its abstract as the source gave it, and is labeled that way.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Mapping, Optional

from resmon_cli.engine import NOT_RUNNING, CliError, Engine, display_path, find
from resmon_cli.text import (NOT_RECORDED, Out, authors, count, duration, join, link,
                             plural, publication_date, when)

EXECUTION_KINDS = {"dive": "deep_dive", "sweep": "deep_sweep", "watch": "automated_sweep"}

# The app's own phrasing for why a run was interrupted (``ResultsList.tsx``).
INTERRUPTED_REASON_TEXT = {
    "owner_dead": "the process running it stopped",
    "daemon_restart": "resmon was shut down",
}

ADVANCED = "In Settings › In the background, turn Run resmon in the background"


# ---------------------------------------------------------------------------
# Shared readings
# ---------------------------------------------------------------------------

def _optional(engine: Engine, path: str, params: Optional[Mapping[str, Any]] = None) -> Any:
    """A route this command can do without on a resmon too old to have it."""
    try:
        return engine.get(path, params)
    except CliError as exc:
        if exc.code == "missing_route":
            return None
        raise


def source_names(engine: Engine) -> dict[str, str]:
    """``{slug: name}`` from the catalog the app's Repositories page reads."""
    catalog = _optional(engine, "/api/repositories/catalog") or []
    return {str(e["slug"]): str(e.get("name") or e["slug"])
            for e in catalog if isinstance(e, dict) and e.get("slug")}


def resolve_sources(engine: Engine, given: list[str]) -> list[str]:
    """Slugs for what a person typed: a slug, or a source's name in any case.

    An unknown name is refused rather than sent. The Explorer filters on the
    stored slug, so a misspelling would come back as "nothing matches", which
    is a claim about the corpus that a typo does not earn."""
    if not given:
        return []
    names = source_names(engine)
    if not names:
        return given
    by_word = {slug.lower(): slug for slug in names}
    by_word.update({name.lower(): slug for slug, name in names.items()})
    slugs, unknown = [], []
    for word in given:
        slug = by_word.get(word.strip().lower())
        (slugs if slug else unknown).append(slug or word)
    if unknown:
        raise CliError("invalid", f"No source called {join(repr(u) for u in unknown)}. "
                       f"Sources: {', '.join(sorted(names))}.", exit_status=2)
    return list(dict.fromkeys(slugs))


def _routine_names(engine: Engine) -> dict[int, str]:
    return {int(r["id"]): str(r.get("name")) for r in (_optional(engine, "/api/routines") or [])
            if isinstance(r, dict) and r.get("id") is not None}


def scheduler_notice(status: Mapping[str, Any]) -> Optional[str]:
    """The one sentence about scheduling, or None when every active watch will run.

    ``schedulerNotice`` in ``frontend/src/lib/schedulerStatus.ts``, in this
    command's words. Three verdicts, not two: ``will_fire`` is None where a
    service runs that no resmon so far can see into, and a sentence about a
    group containing one of those is the weaker one."""
    doubtful = [r for r in status.get("routines") or [] if r.get("will_fire") is not True]
    if not doubtful:
        return None
    n = len(doubtful)
    them = "this watch" if n == 1 else f"these {n} watches"
    lead = (f"Nothing will run {them}." if all(r.get("will_fire") is False for r in doubtful)
            else f"resmon cannot confirm anything will run {them}.")
    state = status.get("state")
    if state == "fires_here":
        return (f"{'An active watch has' if n == 1 else f'{n} active watches have'} no schedule "
                f"registered with the scheduler, so nothing will run {'it' if n == 1 else 'them'}. "
                f"Pause and resume {'it' if n == 1 else 'each one'} on its page under Watches to "
                "register it again.")
    if state == "no_service":
        return (f"{lead} The resmon this command reached does not run watches itself, and no "
                f"background service is installed. {ADVANCED} on.")
    if state == "service_stopped":
        return (f"{lead} The background service is installed but not running. {ADVANCED} off "
                "and on again to restart it.")
    if state == "service_other_version":
        return (f"{lead} The background service on this computer is resmon "
                f"{status.get('service_version') or 'of a version it did not report'}, and the "
                f"resmon this command reached is {status.get('app_version')}; the app works only "
                f"with a service of its own version. {ADVANCED} off and on again to replace that "
                "service. Whatever the old service was running stops.")
    if state == "service_elsewhere":
        return (f"{lead} A background service of this version is running, but the resmon this "
                "command reached is not connected to it.")
    if state == "service_unreachable":
        return (f"{lead} A background service is recorded on this computer but did not answer. "
                "Settings › In the background shows what it found.")
    if state == "scheduler_off":
        return f"{lead} This resmon was started with its scheduler turned off."
    return lead


def firing_note(firing: Optional[Mapping[str, Any]]) -> str:
    if firing is None:
        return "whether anything will run it is not recorded"
    if firing.get("will_fire") is True:
        return "will run: this resmon holds its schedule"
    if firing.get("will_fire") is False:
        return "will not run"
    return "not confirmed to run"


SCHEDULE_STATES = {
    "fires_here": "This resmon runs the schedule.",
    "scheduler_off": "This resmon was started with its scheduler turned off, so it runs no schedule.",
    "no_service": "This resmon does not run the schedule, and no background service is installed.",
    "service_stopped": "This resmon does not run the schedule. The background service is installed "
                       "but not running.",
    "service_other_version": "This resmon does not run the schedule. The background service is "
                             "another version of resmon.",
    "service_elsewhere": "This resmon does not run the schedule. A background service of the same "
                         "version is running as another process.",
    "service_unreachable": "This resmon does not run the schedule. A background service is recorded "
                           "but did not answer.",
}


def coverage_line(coverage: Optional[Mapping[str, Any]], names: Mapping[str, str]) -> str:
    """``3 of 4 selected sources answered; 1 could not answer: DBLP``, from the
    run's own coverage account (``source_coverage.build``)."""
    if not coverage or not coverage.get("total"):
        return f"source outcomes {NOT_RECORDED}"
    counts = coverage.get("counts") or {}
    parts = [f"{counts.get('answered', 0)} of {coverage['total']} "
             f"{coverage.get('basis_label') or 'sources'} answered"]
    failed = [names.get(s["source"], s["source"]) for s in coverage.get("sources") or []
              if s.get("category") == "non_answer"]
    if failed:
        parts.append(f"{len(failed)} could not answer: {join(failed)}")
    if counts.get("unknown"):
        parts.append(f"{counts['unknown']} unknown")
    return "; ".join(parts)


def _parameters(row: Mapping[str, Any]) -> dict:
    """A run's or a watch's saved parameters: a JSON string in the row."""
    raw = row.get("parameters")
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _asked(row: Mapping[str, Any]) -> str:
    """What a run asked for, from its saved parameters."""
    words = row.get("keywords") or ([row["query"]] if row.get("query") else [])
    return ", ".join(f'"{w}"' for w in words)


def run_title(row: Mapping[str, Any], routines: Mapping[int, str], names: Mapping[str, str]) -> str:
    kind = row.get("execution_type")
    asked = _asked(row)
    if kind == "automated_sweep":
        rid = row.get("routine_id")
        if rid is None:
            return "Watch (no longer saved)"
        return f'Watch "{routines[int(rid)]}"' if int(rid) in routines else f"Watch #{rid}"
    label = {"deep_dive": "Deep Dive", "deep_sweep": "Deep Sweep"}.get(str(kind), str(kind))
    title = f"{label} {asked}" if asked else label
    if kind == "deep_dive" and row.get("repositories"):
        title += f" on {names.get(row['repositories'][0], row['repositories'][0])}"
    return title


# ---------------------------------------------------------------------------
# resmon today
# ---------------------------------------------------------------------------

def today(engine: Engine, args: argparse.Namespace, out: Out) -> int:
    if args.action == "mark-read":
        body = engine.post("/api/today/looked")
        if args.json:
            out.json(body)
            return 0
        out.line(f"Marked all read at {when(body.get('looked_at'), long=True)}.")
        out.line("The next Today starts there.")
        return 0

    data = engine.get("/api/today")
    if args.json:
        out.json(data)
        return 0
    names = source_names(engine)
    status = _optional(engine, "/api/scheduler/status")

    total = int(data.get("total") or 0)
    papers = data.get("papers") or []
    since = when(data.get("since"), long=True)
    found = f"{count(total)} {plural(total, 'paper')}"
    if data.get("window") == "since_last_look":
        out.para(f"Today: {found} first collected since you last marked all read, {since}.")
    else:
        out.para(f"Today: nothing has been marked read yet, so Today starts at {since}. "
                 f"{found} first collected since then.")
    out.para("First collected means this resmon found the paper in that time; it may have been "
             "published long before.")

    watches = data.get("watches") or []
    watch_names = {int(w["id"]): str(w["name"]) for w in watches}
    if watches:
        out.line()
        out.line("Watches")
        for w in watches:
            name = str(w.get("name")) + ("" if w.get("is_active") else " (inactive)")
            text = f"{name} · {count(w.get('new_count', 0))} new"
            run = w.get("last_run")
            if run is None:
                text += " · no run recorded"
            else:
                moment = (f"ended {when(run.get('ended_at'))}" if run.get("ended_at")
                          else f"started {when(run.get('started_at'))}")
                text += f" · last run #{run.get('execution_id')}, {run.get('status')}, {moment}"
                if run.get("sources_total"):
                    text += (f" · {run.get('sources_answered')} of {run.get('sources_total')} "
                             "sources answered")
                else:
                    text += f" · source outcomes {NOT_RECORDED}"
            out.para(text, indent=2, hang=4)
            for note in (run or {}).get("sources_not_answered") or []:
                source = names.get(note.get("source"), note.get("source"))
                out.para(f"{source}: {note.get('label')}. {note.get('note')}", indent=4, hang=6)
            if w.get("next_fire_at"):
                out.para(f"next run on its schedule: {when(w['next_fire_at'])}", indent=4)
        notice = scheduler_notice(status) if status else None
        if notice:
            out.para(notice, indent=2, hang=2)
    if data.get("from_searches"):
        n = int(data["from_searches"])
        out.line()
        out.para(f"{count(n)} of them came from your own searches (Deep Dive and Deep Sweep), "
                 "not from a watch.")

    shown = papers if args.all else papers[: args.limit]
    if shown:
        out.line()
        out.line("Papers, most recently collected first")
    for i, paper in enumerate(shown, 1):
        out.line()
        out.para(f"{i}. {paper.get('title') or 'title ' + NOT_RECORDED}", indent=2, hang=5)
        out.para(" · ".join([
            authors(paper.get("authors")),
            names.get(paper.get("source"), str(paper.get("source"))),
            f"published {publication_date(paper.get('publication_date'))}",
        ]), indent=5)
        detail = [f"first collected {when(paper.get('first_seen_at'))}"]
        if paper.get("watches"):
            detail.append("watch: " + ", ".join(watch_names.get(int(w), f"#{w}") for w in paper["watches"]))
        if paper.get("queue_status"):
            detail.append(f"reading queue: {paper['queue_status']}")
        out.para(" · ".join(detail), indent=5)
        if paper.get("abstract_lede"):
            out.para(f"Abstract (its opening, as the source gave it): {paper['abstract_lede']}",
                     indent=5)
        else:
            out.para(f"Abstract {NOT_RECORDED}.", indent=5)
        href = link(paper)
        if href:
            out.line(f"     {href}")

    out.line()
    if len(shown) < len(papers):
        out.line(f"Showing {len(shown)} of the {count(len(papers))} listed. "
                 "resmon today --all shows every one.")
    if total > len(papers):
        out.line(f"Today lists the {count(len(papers))} most recently collected of {count(total)}; "
                 "the rest are counted, not listed.")
    if total:
        out.line("resmon today mark-read marks them all read.")
    return 0


# ---------------------------------------------------------------------------
# resmon search
# ---------------------------------------------------------------------------

def _query(words: Any) -> Optional[str]:
    text = " ".join(words) if isinstance(words, list) else (words or "")
    return text.strip() or None


def _filters(engine: Engine, args: argparse.Namespace) -> dict:
    return {
        "query": _query(args.query),
        "sources": resolve_sources(engine, args.source or []),
        "authors": args.author or [],
        "categories": args.category or [],
        "date_from": args.date_from,
        "date_to": args.date_to,
    }


def search(engine: Engine, args: argparse.Namespace, out: Out) -> int:
    body = {**_filters(engine, args), "limit": args.limit, "cursor": args.cursor,
            "sort": "similarity" if args.sort == "closest" else "newest"}
    data = engine.post("/api/explorer/search", body)
    if args.json:
        out.json(data)
        return 0
    names = source_names(engine)
    results = data.get("results") or []
    total = int(data.get("total") or 0)
    if total == 0:
        out.line("No paper in this resmon's collection matches.")
    else:
        capped = bool(data.get("total_is_capped"))
        text = f"{count(total)}{'+' if capped else ''} {plural(total, 'paper')} {'matches' if total == 1 and not capped else 'match'}"
        if capped:
            text += f" (resmon stops counting at {count(data.get('count_cap'))})"
        out.line(text + ".")
    if data.get("similarity_unavailable"):
        out.para(str(data["similarity_unavailable"]))
    if data.get("sort") == "similarity":
        out.para(f"Ranked by closeness to your search with {data.get('model') or 'a model ' + NOT_RECORDED}: "
                 f"{count(data.get('ranked_count'))} ranked; {count(data.get('unranked_count'))} not yet "
                 "embedded, listed after them, newest first.")
    elif results:
        out.line("Newest publication date first.")

    for i, paper in enumerate(results, 1):
        out.line()
        out.para(f"{i}. {paper.get('title') or 'title ' + NOT_RECORDED}", indent=2, hang=5)
        out.para(" · ".join([
            authors(paper.get("authors")),
            names.get(paper.get("source_repository"), str(paper.get("source_repository"))),
            f"published {publication_date(paper.get('publication_date'))}",
            f"first collected {when(paper.get('first_seen_at'), assume_utc=True)}",
        ]), indent=5)
        if data.get("sort") == "similarity":
            distance = paper.get("distance")
            out.line(f"     distance {distance:.3f}" if isinstance(distance, (int, float))
                     else "     not yet embedded, so not ranked")
        if args.abstracts:
            abstract = (paper.get("abstract") or "").strip()
            out.para(f"Abstract, as the source gave it: {abstract}" if abstract
                     else f"Abstract {NOT_RECORDED}.", indent=5)
        href = link(paper)
        if href:
            out.line(f"     {href}")
    if data.get("has_more") and data.get("next_cursor"):
        out.line()
        out.line(f"More: run the same command with --cursor '{data['next_cursor']}'.")
    return 0


# ---------------------------------------------------------------------------
# resmon runs
# ---------------------------------------------------------------------------

def runs(engine: Engine, args: argparse.Namespace, out: Out) -> int:
    if args.id is not None:
        row = engine.get(f"/api/executions/{args.id}")
        if args.json:
            out.json(row)
            return 0
        _run_detail(engine, row, out)
        return 0
    rows = engine.get("/api/executions", {"limit": args.limit, "type": EXECUTION_KINDS.get(args.kind)})
    if args.json:
        out.json(rows)
        return 0
    if not rows:
        out.line("No runs are recorded.")
        return 0
    names = source_names(engine)
    routines = _routine_names(engine)
    for row in rows:
        took = duration(row.get("start_time"), row.get("end_time"))
        status = str(row.get("status"))
        if status == "running" and row.get("current_stage"):
            status += f" ({row['current_stage']})"
        head = (f"#{row.get('id')} · {run_title(row, routines, names)} · {status} · "
                f"started {when(row.get('start_time'))}" + (f", took {took}" if took else ""))
        out.para(head, hang=4)
        found = row.get("result_count")
        found_text = (f"{count(found)} {plural(found, 'result')}" if isinstance(found, int)
                      else f"results {NOT_RECORDED}")
        out.para(f"{found_text}, {count(row.get('new_result_count'))} new · "
                 f"{coverage_line(row.get('coverage'), names)}", indent=4, hang=6)
    out.line()
    out.line(f"The {len(rows)} most recent. resmon runs <id> gives one run's whole account.")
    return 0


def _run_detail(engine: Engine, row: Mapping[str, Any], out: Out) -> None:
    names = source_names(engine)
    routines = _routine_names(engine)
    out.para(f"Run #{row.get('id')}: {run_title(row, routines, names)}")
    status = str(row.get("status"))
    if status == "interrupted":
        why = INTERRUPTED_REASON_TEXT.get(str(row.get("interrupted_reason") or ""), "reason not recorded")
        status += f" ({why})"
    fields = [("Status", status), ("Started", when(row.get("start_time"), long=True))]
    ended = row.get("end_time")
    took = duration(row.get("start_time"), ended)
    fields.append(("Ended", (when(ended, long=True) + (f" ({took})" if took else "")) if ended
                   else NOT_RECORDED))

    params = _parameters(row)
    asked = [_asked(row) or "no keywords"]
    if isinstance(params, dict):
        if params.get("max_results"):
            asked.append(f"up to {count(params['max_results'])} per source")
        if params.get("date_from") or params.get("date_to"):
            asked.append(f"published {params.get('date_from') or 'any time'} to {params.get('date_to') or 'now'}")
    fields.append(("Asked for", " · ".join(asked)))
    computed = params.get("date_window_computed") if isinstance(params, dict) else None
    if isinstance(computed, dict) and computed.get("sentence"):
        fields.append(("Dates", str(computed["sentence"])))
    # bioRxiv and medRxiv, asked in a run that set no start date, were given one.
    starts = params.get("default_starts") if isinstance(params, dict) else None
    for start in (starts.values() if isinstance(starts, dict) else ()):
        if isinstance(start, dict) and start.get("sentence"):
            fields.append(("Start given", str(start["sentence"])))
    fields.append(("Results", f"{count(row.get('result_count'))}, of which "
                   f"{count(row.get('new_result_count'))} were new to the collection"))
    if row.get("error_message"):
        fields.append(("Error", str(row["error_message"])))
    if row.get("restarted_from"):
        fields.append(("Restarted from", f"#{row['restarted_from']}"))
    if row.get("restarted_into"):
        fields.append(("Restarted into", ", ".join(f"#{r.get('id', r) if isinstance(r, dict) else r}"
                                                   for r in row["restarted_into"])))
    for label, value in fields:
        out.para(f"  {label:<15}{value}", hang=17)

    coverage = row.get("coverage") or {}
    out.line()
    out.para(f"Sources: {coverage.get('summary') or 'source outcomes ' + NOT_RECORDED}")
    for source in coverage.get("sources") or []:
        name = names.get(source.get("source"), str(source.get("source")))
        # A count only where the source answered with records. A non-answer's
        # stored zero is not a zero -- the note beside it says so -- and
        # "0 records" next to "did not answer" would say it anyway.
        records = source.get("result_count")
        recs = (f" · {count(records)} {plural(records, 'record')}"
                if source.get("category") == "answered" and isinstance(records, int) and records > 0
                else "")
        out.para(f"{name}: {source.get('label')}{recs}. {source.get('note')}", indent=2, hang=4)
    for source in coverage.get("additional_sources") or []:
        name = names.get(source.get("source"), str(source.get("source")))
        out.para(f"{name} (outside the saved selection): {source.get('label')}. {source.get('note')}",
                 indent=2, hang=4)
    notes = coverage.get("notes") or []
    if notes:
        out.line()
        out.line("About this account")
        for note in notes:
            out.para(f"- {note}", indent=2, hang=4)


# ---------------------------------------------------------------------------
# resmon wall
# ---------------------------------------------------------------------------

MARKS = {"answered": "●", "answered_empty": "○", "could_not_be_asked": "⊘",
         "failed": "✕", "not_recorded": "·", "not_selected": "–"}
ASCII_MARKS = {"answered": "#", "answered_empty": "o", "could_not_be_asked": "/",
               "failed": "x", "not_recorded": ".", "not_selected": "-"}


def wall(engine: Engine, args: argparse.Namespace, out: Out) -> int:
    data = engine.get("/api/coverage/source-wall", {"limit": args.runs})
    if args.json:
        out.json(data)
        return 0
    marks = MARKS if out.unicode else ASCII_MARKS
    legend = {e["state"]: e for e in data.get("state_legend") or [] if isinstance(e, dict)}
    runs_ = data.get("runs") or []
    window = data.get("window") or {}
    out.para(f"Source wall: what every source did on the last {len(runs_)} "
             f"{plural(len(runs_), 'run')} of {count(window.get('runs_available'))} recorded.")
    verdict = data.get("verdict") or {}
    if verdict.get("headline"):
        out.line()
        out.para(str(verdict["headline"]))
        for line in verdict.get("detail") or []:
            out.para(f"- {line}", indent=2, hang=4)
    sources = data.get("sources") or []
    if not runs_ or not sources:
        return 0

    width = max(len(str(s.get("name"))) for s in sources) + 2
    out.line()
    arrow = "→" if out.unicode else "->"
    out.line(" " * width + f"#{runs_[0].get('execution_id')} {arrow} #{runs_[-1].get('execution_id')}, "
             "oldest to newest")
    for source in sources:
        # A state this command has no mark for is drawn as "not recorded":
        # failing toward "resmon does not know", as ``knownState`` does in the app.
        cells = " ".join(marks.get(c.get("state"), marks["not_recorded"]) for c in source.get("cells") or [])
        tally = [f"{n} {legend.get(state, {}).get('label', state)}"
                 for state, n in (source.get("counts") or {}).items() if n]
        name = str(source.get("name")) + ("" if source.get("in_catalog", True) else " (not in the catalog)")
        # " · " between counts, because one of the engine's labels ("answered,
        # zero") carries a comma of its own.
        out.line(f"{name:<{width}}{cells}   {' · '.join(tally)}")
    out.line()
    out.packed([f"{marks[s]} {legend.get(s, {}).get('label', s)}" for s in data.get("states") or MARKS
                if s in marks])
    if args.legend:
        for state in data.get("states") or []:
            entry = legend.get(state)
            if entry:
                out.para(f"{marks.get(state, '?')} {entry.get('label')}: {entry.get('meaning')}", indent=2, hang=4)
    notes = data.get("notes") or []
    if notes:
        out.line()
        for note in notes:
            out.para(f"- {note}", hang=2)
    return 0


# ---------------------------------------------------------------------------
# resmon export
# ---------------------------------------------------------------------------

FORMAT_NAMES = {"bibtex": "BibTeX", "ris": "RIS", "csv": "CSV", "json": "JSON"}


def export(engine: Engine, args: argparse.Namespace, out: Out, err: Out) -> int:
    # A filter beside --run would be ignored by the route it goes to, and an
    # export that quietly ignored a filter would hold papers the person excluded.
    filtered = any([args.source, args.author, args.category, args.date_from, args.date_to])
    if filtered and args.query is None:
        raise CliError("invalid", "--source, --author, --category, --from and --to go with --search.",
                       exit_status=2)
    if args.new_only and args.run is None:
        raise CliError("invalid", "--new-only goes with --run.", exit_status=2)
    note = None
    if args.run is not None:
        reply = engine.request("GET", f"/api/executions/{args.run}/references",
                               params={"format": args.format, "only_new": "true" if args.new_only else None})
    elif args.today:
        data = engine.get("/api/today")
        ids = [int(p["id"]) for p in data.get("papers") or []]
        total = int(data.get("total") or 0)
        if not ids:
            if args.json:
                out.json({"format": args.format, "document_count": 0, "filename": None,
                          "written_to": None, "note": "Nothing is on Today.", "content": None})
            else:
                err.line("Nothing is on Today, so nothing was exported.")
            return 0
        if total > len(ids):
            note = (f"Today lists the {count(len(ids))} most recently collected of {count(total)}; "
                    f"those {count(len(ids))} were exported.")
        reply = engine.request("POST", "/api/export/references",
                               body={"document_ids": ids, "format": args.format})
    elif args.ids:
        reply = engine.request("POST", "/api/export/references",
                               body={"document_ids": args.ids, "format": args.format})
    else:
        reply = engine.request("POST", "/api/explorer/export",
                               body={**_filters(engine, args), "format": args.format})

    raw_count = reply.headers.get("x-resmon-document-count", "")
    documents: Optional[int] = int(raw_count) if raw_count.isdigit() else None
    match = re.search(r'filename="([^"]+)"', reply.headers.get("content-disposition", ""))
    filename = match.group(1) if match else None
    kind = FORMAT_NAMES.get(args.format, args.format)
    refs = (f"{count(documents)} {plural(documents, 'reference')}" if documents is not None
            else f"references (how many: {NOT_RECORDED})")

    if args.output and args.output != "-":
        path = Path(args.output).expanduser()
        path.write_bytes(reply.body)
        if args.json:
            out.json({"format": args.format, "document_count": documents, "filename": filename,
                      "written_to": str(path.resolve()), "note": note})
        else:
            out.line(f"Wrote {refs} ({kind}) to {display_path(path.resolve())}.")
            if note:
                out.para(note)
        return 0
    if args.json:
        out.json({"format": args.format, "document_count": documents, "filename": filename,
                  "written_to": None, "note": note, "content": reply.text()})
        return 0
    out.stream.write(reply.text())
    if not reply.text().endswith("\n"):
        out.stream.write("\n")
    err.line(f"{refs} ({kind}).")
    if note:
        err.para(note)
    return 0


# ---------------------------------------------------------------------------
# resmon service status
# ---------------------------------------------------------------------------

def service_status(env: Mapping[str, str], args: argparse.Namespace, out: Out) -> int:
    try:
        engine = find(env)
    except CliError as exc:
        if exc.code != "not_running":
            raise
        if args.json:
            out.json({"running": False, **exc.detail})
        else:
            out.line(exc.message)
        return NOT_RUNNING
    status = _optional(engine, "/api/scheduler/status")
    health = engine.health
    identity = health.get("identity") if isinstance(health.get("identity"), dict) else {}
    reached = {
        "how": engine.how, "is_service": engine.is_service, "description": engine.describe(),
        "port": engine.port, "pid": engine.pid, "lock_pid": engine.lock_pid,
        "version": health.get("version"), "started_at": health.get("started_at"),
        "runtime_id": identity.get("runtime_id"), "state_dir": str(engine.state),
    }
    if args.json:
        out.json({"running": True, "reached": reached, "health": health, "scheduler": status})
        return 0

    out.para(f"resmon is running: {engine.describe()}.")
    out.para(f"resmon {engine.version} · pid {engine.pid if engine.pid is not None else NOT_RECORDED} · "
             f"port {engine.port} · up since {when(health.get('started_at'), long=True)}", indent=2, hang=4)
    out.para(f"State folder: {display_path(engine.state)}", indent=2, hang=4)
    out.line()
    if status is None:
        out.para("Whether this resmon runs the schedule is not recorded: it has no scheduler "
                 "status route.")
        return 0
    out.para(SCHEDULE_STATES.get(str(status.get("state")),
                                 f"Schedule state: {status.get('state')}."))
    if status.get("state") == "service_other_version" and status.get("service_version"):
        out.para(f"The background service is resmon {status['service_version']}; this resmon is "
                 f"{status.get('app_version')}.", indent=2, hang=2)
    active = status.get("routines") or []
    notice = scheduler_notice(status)
    if notice:
        out.para(notice, indent=2, hang=2)
    elif len(active) == 1:
        out.para("The one active watch has its schedule here.", indent=2)
    elif active:
        out.para(f"All {len(active)} active watches have their schedule here.", indent=2)
    else:
        out.para("No watch is active.", indent=2)
    out.para(f"Background service: {'installed' if status.get('service_installed') else 'not installed'}"
             ", as this resmon reports it.")
    return 0


# ---------------------------------------------------------------------------
# resmon watch
# ---------------------------------------------------------------------------

_CRON_FIELD = re.compile(r"[0-9*/,\-A-Za-z?LW#]+")


def _watch_line(routine: Mapping[str, Any], names: Mapping[str, str]) -> str:
    params = _parameters(routine)
    repos = [names.get(s, s) for s in params.get("repositories") or []]
    words = params.get("keywords") or ([params["query"]] if params.get("query") else [])
    parts = [", ".join(repos) if repos else f"sources {NOT_RECORDED}"]
    if words:
        parts.append(", ".join(f'"{w}"' for w in words))
    elif isinstance(params.get("entity"), dict):
        parts.append(f"follows watch profile #{params['entity'].get('profile_id')}")
    parts.append(f"schedule {routine.get('schedule_cron')}")
    parts.append(_window_words(params))
    if params.get("max_results"):
        parts.append(f"up to {count(params['max_results'])} per source")
    return " · ".join(parts)


def watch_list(engine: Engine, args: argparse.Namespace, out: Out) -> int:
    routines = engine.get("/api/routines") or []
    if args.json:
        out.json(routines)
        return 0
    if not routines:
        out.line("No watches are saved.")
        return 0
    names = source_names(engine)
    status = _optional(engine, "/api/scheduler/status")
    firing = {int(r["id"]): r for r in (status or {}).get("routines") or []}
    for routine in routines:
        rid = int(routine["id"])
        active = bool(routine.get("is_active"))
        head = f"#{rid} {routine.get('name')} · {'active' if active else 'inactive'}"
        if active and status is not None:
            head += f" · {firing_note(firing.get(rid))}"
        out.para(head, hang=4)
        out.para(_watch_line(routine, names), indent=4, hang=6)
        last, last_status = routine.get("last_execution"), routine.get("last_status")
        if last or last_status:
            out.para(f"last run {when(last)}, {last_status or 'status ' + NOT_RECORDED}", indent=4)
        else:
            out.para("no run recorded", indent=4)
        missed = routine.get("missed_fires") or {}
        if missed.get("count"):
            out.para(f"{count(missed['count'])} scheduled {plural(missed['count'], 'run')} did not "
                     f"happen while resmon was closed; the last was due "
                     f"{when(missed.get('last_due_at_utc'))}", indent=4, hang=6)
        if missed.get("overlap_skipped"):
            out.para(f"{count(missed['overlap_skipped'])} scheduled {plural(missed['overlap_skipped'], 'run')} "
                     "were skipped because the one before was still going", indent=4, hang=6)
    notice = scheduler_notice(status) if status else None
    if notice:
        out.line()
        out.para(notice)
    return 0


def _window_parameters(args: argparse.Namespace) -> dict[str, Any]:
    """The dates a new watch asks for: since the previous run unless told otherwise."""
    if getattr(args, "no_date_limit", False):
        return {}
    if getattr(args, "last_days", None):
        return {"date_window": {"last_days": args.last_days}}
    return {"date_window": {"since": "previous_run"}}


def _window_words(params: Mapping[str, Any]) -> str:
    """A watch's dates in words, as it stores them."""
    window = params.get("date_window")
    if isinstance(window, dict) and window.get("since") == "previous_run":
        return "papers since the previous run"
    if isinstance(window, dict) and isinstance(window.get("last_days"), int):
        return f"papers from the last {count(window['last_days'])} {plural(window['last_days'], 'day')}"
    start, end = params.get("date_from"), params.get("date_to")
    if start and end:
        return f"published {start} to {end}, the same dates every run"
    if start:
        return f"published from {start} on, the same start every run"
    if end:
        return f"published up to {end}, the same end every run"
    return "no date limit"


def watch_add(engine: Engine, args: argparse.Namespace, out: Out) -> int:
    fields = args.schedule.split()
    if len(fields) != 5 or not all(_CRON_FIELD.fullmatch(f) for f in fields):
        raise CliError("invalid", f"--schedule takes a five-field cron expression, such as "
                       f"'0 8 * * *'; {args.schedule!r} is not one.", exit_status=2)
    keywords = [k.strip() for k in args.keyword if k.strip()]
    if not keywords:
        raise CliError("invalid", "A watch needs at least one --keyword.", exit_status=2)
    slugs = resolve_sources(engine, args.source)
    registered = set(_optional(engine, "/api/search/repositories") or [])
    unusable = [s for s in slugs if registered and s not in registered]
    if unusable:
        raise CliError("invalid", f"This resmon cannot search {join(unusable)}.", exit_status=2)
    body: dict[str, Any] = {
        "name": args.name.strip(),
        "schedule_cron": " ".join(fields),
        # The keys the app's watch editor sends: ``keywords`` is what a run
        # reads first, ``query`` the joined form older rows carry, and the
        # window the editor offers first, papers since the previous run.
        "parameters": {"repositories": slugs, "keywords": keywords, "query": " ".join(keywords),
                       "max_results": args.max_results, **_window_parameters(args)},
        "is_active": not args.inactive,
    }
    if args.intent and args.intent.strip():
        body["intent"] = args.intent.strip()
    created = engine.post("/api/routines", body) or {}
    rid = created.get("id")
    # ``POST /api/routines`` answers with ``{id, name}``. Reading the record back
    # makes what is printed the stored watch, not the request that was sent.
    routine = engine.get(f"/api/routines/{rid}") if rid is not None else created
    status = _optional(engine, "/api/scheduler/status")
    firing = next((r for r in (status or {}).get("routines") or [] if r.get("id") == rid), None)
    if args.json:
        out.json({"routine": routine, "created": created, "firing": firing,
                  "scheduler_state": (status or {}).get("state")})
        return 0
    names = source_names(engine)
    active = bool(routine.get("is_active"))
    out.para(f'Added watch #{rid} "{routine.get("name")}", {"active" if active else "inactive"}.')
    out.para(_watch_line(routine, names), indent=2, hang=4)
    out.para("How the keywords combine is up to each source; Settings › Sources says how each "
             "one does.", indent=2, hang=2)
    if created.get("entity_warning"):
        out.para(str(created["entity_warning"]), indent=2, hang=2)
    if not active:
        out.para("Nothing will run it until it is resumed on its page under Watches.", indent=2, hang=2)
    elif status is None:
        out.para("Whether anything will run it is not recorded: this resmon has no scheduler "
                 "status route.", indent=2, hang=2)
    elif firing is None:
        out.para("Whether anything will run it is not recorded.", indent=2, hang=2)
    elif firing.get("will_fire") is True:
        out.para("This resmon holds its schedule, so it will run.", indent=2, hang=2)
    else:
        out.para(scheduler_notice({**status, "routines": [firing]}) or "", indent=2, hang=2)
    return 0

