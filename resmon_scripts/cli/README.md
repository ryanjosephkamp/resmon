# resmon command line

`resmon` asks the resmon that is already running what it has collected and how its watches are
doing: Today, a search of the whole collection, recent runs, the Source wall, reference exports,
and whether anything will run your watches. It talks to the background service, or to the engine
the app starts for its window, over the same local API and token the app uses. It never opens the
database and never starts resmon itself.

## Install

From a clone of the repository, with [pipx](https://pipx.pypa.io/):

```bash
pipx install ./resmon_scripts/cli
```

It needs Python 3.10 or later and nothing else: it uses only the standard library.

## Commands

| Command | What it shows |
|---|---|
| `resmon today` | The papers first collected since you last marked all read, by watch, with the sources that did not answer on each watch's last run. Reading it marks nothing. |
| `resmon today mark-read` | Mark all read: the next Today starts now. |
| `resmon search WORDS` | The app's Search › Your collection, over everything collected. `--source`, `--author`, `--category`, `--from` and `--to` narrow it; `--sort closest` ranks by meaning with the embedding model set in Settings → AI, and says so when none is set. |
| `resmon runs` | Recent runs: what each asked, what it found, and how many of its sources answered. `resmon runs ID` gives one run's whole account, source by source. |
| `resmon wall` | The Source wall: every source's recorded answer to each of the last runs, oldest to newest, and whether any has stopped answering. `--legend` says what each mark means. |
| `resmon export` | References as BibTeX, RIS, CSV or JSON for `--run ID`, `--today`, `--ids`, or `--search WORDS`. They go to standard output unless `-o FILE` names a file. |
| `resmon service status` | Which resmon the command reached, and whether anything will run your active watches. |
| `resmon watch list` | Every saved watch, and whether anything will run it. |
| `resmon watch add NAME` | A new watch: `--keyword` (repeatable), `--source` (repeatable), `--schedule` as five-field cron (default `0 8 * * *`), `--max-results`, `--intent`. Each run asks for papers published since the previous run, unless `--last-days N` (the N days before each run) or `--no-date-limit` (each source's own order). It is saved active, as the app's editor saves one, unless `--inactive`. |

Every command takes `--json`. On the commands that read one thing, that prints resmon's own answer
unchanged; `service status`, `watch add` and `export` print an object whose keys say what each part
is. Errors go to standard error, as JSON when `--json` was given.

Sources can be named as the app names them (`DBLP`) or by slug (`dblp`). A name resmon does not
know is refused rather than searched for.

## What it prints

Only what resmon recorded. A field resmon does not have reads "not recorded". The text under a
paper on Today is the opening of its abstract as the source gave it, and is labeled that way; resmon
keeps no summaries of single papers, and nothing this command prints is written by a model. Times
are shown on your computer's clock where resmon recorded their time zone, and as stored, marked
"time zone not recorded", where it did not.

## How it finds resmon

In this order:

1. `RESMON_PORT`, when set. Then it is the only place tried.
2. `daemon.lock` in the state folder: the background service, which runs the schedule.
3. `resmon.port`: the engine the app started for its window. It is read from `RESMON_PORT_FILE`, or
   beside `RESMON_DB_PATH`, or from the state folder, where the installed app keeps its database.

The state folder is `RESMON_STATE_DIR` when set, otherwise `~/Library/Application Support/resmon`
on macOS, `%LOCALAPPDATA%\resmon` on Windows, and `$XDG_STATE_HOME/resmon` (or
`~/.local/state/resmon`) on Linux. A candidate's token is read from `api-token-<port>` in that
folder; a port with no token there is not tried.

## When nothing is running

It says so, lists where it looked and what it found there, and exits with status 3. It does not
start resmon for the one command, because starting resmon's engine changes things: it applies a
staged restore, brings the database's schema to its own version, marks runs whose process is gone
as interrupted, and starts sending queued email and webhook deliveries. Open resmon, or turn on
**Settings › In the background › Run resmon in the background**.

Exit statuses: 0 done; 1 resmon refused or failed the request; 2 the command was not one resmon
can be asked; 3 no resmon is running, or it stopped answering.
