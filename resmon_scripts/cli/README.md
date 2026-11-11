# resmon command line

`resmon` asks the resmon that is already running what it has collected and how its watches are
doing: Today, a search of the whole collection, recent runs, the Source Wall, reference exports,
and whether anything will run your watches. It talks to the background service, or to the engine
the app starts for its window, over the same local API and token the app uses. It never opens the
database and never starts resmon itself.

## Install

**With the app.** resmon carries its command line inside it. Choose **Install "resmon" Command in PATH**
(in the resmon menu on macOS, in the Help menu on Windows and Linux), then open a new terminal:

```bash
resmon --version
```

It runs the app's own Python in isolated mode, so your Python settings and packages never apply.

| | What the menu item writes |
|---|---|
| macOS | A small shell launcher at `/usr/local/bin/resmon`. It asks for your administrator password, through the system's own prompt, only when that folder is not writable. |
| Windows | `resmon.cmd` in `%LOCALAPPDATA%\resmon\bin`, and that folder on your user `PATH`. |
| Linux | `~/.local/bin/resmon`, and a copy of the command line at `~/.local/share/resmon/resmon.pyz`, refreshed each time the app starts. It runs with your system's `python3` (the command line uses only the standard library). If `~/.local/bin` is not on your `PATH`, the confirmation says so. |

**Uninstall "resmon" Command** removes only a launcher resmon wrote, which it recognizes by a marker line.
A `resmon` installed any other way, such as with pipx, is never touched. If the app has moved or been
deleted, the launcher says where it looked and how to reinstall the command.

**From source,** with [pipx](https://pipx.pypa.io/):

```bash
pipx install ./resmon_scripts/cli
```

It needs Python 3.10 or later and nothing else: it uses only the standard library.

Both can be installed at once, and whichever is first on your `PATH` answers. `resmon --version` says
which one it is: the app's, with the app's version and where it sits, or one installed from source.

## Commands

| Command | What it shows |
|---|---|
| `resmon today` | The papers that arrived in a collection since you last marked its Today all read, by watch, with the sources that did not answer on each watch's last run. Reading it marks nothing. |
| `resmon today mark-read` | Mark All Read: the collection's next Today starts now. |
| `resmon search WORDS` | The app's Search › Collection, over a collection. `--source`, `--author`, `--category`, `--from` and `--to` narrow it; `--sort closest` ranks by meaning with the embedding model set in Settings → AI, and says so when none is set. |
| `resmon runs` | Recent runs: what each asked, what it found, and how many of its sources answered. `--kind dive`, `sweep`, `find`, or `watch` narrows them; `find` is **Look Up a Paper**. `resmon runs ID` gives one run's whole account, source by source. |
| `resmon wall` | The Source Wall: every source's recorded answer to each of the last runs, oldest to newest, and whether any has stopped answering. `--legend` says what each mark means. |
| `resmon export` | References as BibTeX, RIS, CSV or JSON for `--run ID`, `--today`, `--ids`, or `--search WORDS`. They go to standard output unless `-o FILE` names a file. |
| `resmon service status` | Which resmon the command reached, and whether anything will run your active watches. |
| `resmon watch list` | Every saved watch, and whether anything will run it. |
| `resmon collections` | Every collection, with how many papers and watches each has, which the app shows, and the default one. |
| `resmon watch add NAME` | A new watch: `--keyword` (repeatable), `--source` (repeatable), `--schedule` as five-field cron (default `0 8 * * *`), `--max-results`, `--intent`. Each run asks for papers published since the previous run, unless `--last-days N` (the N days before each run) or `--no-date-limit` (each source's own order). It is saved active, as the app's editor saves one, unless `--inactive`. Its papers land in `--collection`, or the default collection. |

Every command takes `--json`. On the commands that read one thing, that prints resmon's own answer
unchanged; `service status`, `watch add` and `export` print an object whose keys say what each part
is. Errors go to standard error, as JSON when `--json` was given.

Sources can be named as the app names them (`DBLP`) or by slug (`dblp`). A name resmon does not
know is refused rather than searched for.

Search counts use `total_is_exact` and `count_budget_ms`: when counting runs out of its
1.5-second budget, the count is a lower bound, and the text says "At least". It does not cap
the matches or a search export. `--limit` sets the page size, and `--cursor` reads the next page.

`today` prints 20 papers unless `--limit` or `--all` is given. It reads only the newest page,
up to 1,000 papers, even with `--all`; `export --today` exports that page too and says when
older new papers were left out. The app can read the older pages. `export --run ID --new-only`
exports only papers that run was the first to store in the database, regardless of collection;
it is different from Today's collection-specific arrivals.

`--collection`, on `today`, `search`, `export --today` and `--search`, and `watch add`, names a
collection by its name or number; without it they use the default collection, which holds every
paper a resmon had before it had collections. A name that is no collection is refused, with the
names there are.

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
**Settings › In the Background › Run resmon in the background**.

Exit statuses: 0 done; 1 resmon refused or failed the request; 2 the command was not one resmon
can be asked; 3 no resmon is running, or it stopped answering.
