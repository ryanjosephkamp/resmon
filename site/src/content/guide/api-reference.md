---
title: "HTTP API Reference"
summary: "The local HTTP API, route by route. The generated contract for every route is in the reference section."
order: 17
---
**The machine-readable contract is [`docs/api-contract/`](docs/api-contract/).** `openapi.json` there describes every one of the 250 routes: method, path, parameters, and request body. `http.md` indexes them against the user journeys they serve, with each route's auth class, whether it streams, the response model it declares, and a one-line purpose. Both are generated from the running app, and a test fails when they drift, so they cannot describe an engine that no longer exists. The tables below are the guided tour of the same surface. Where the two differ, the contract is the one that was checked.

## Using It

The engine serves HTTP on `127.0.0.1` only. The background service uses port 8742 unless you set `RESMON_DAEMON_PORT`; the engine a window starts for itself uses a free port chosen at start. **Health › This Engine** shows the address the window is using, and the port file a running engine writes beside its database names it for a program.

Requests need the engine's local API token in `Authorization: Bearer <token>` and a loopback `Host`. A request carrying an `Origin` must name resmon's own renderer. The one token exception is the delivery-bundle route below, which checks its signed link instead. The token is in an owner-only file named `api-token-<port>` in resmon's state directory. Refusals are `401 token_missing`, `401 token_invalid`, `403 host_refused`, and `403 origin_refused`. See [`docs/local-api-security.md`](docs/local-api-security.md).

Requests and responses are JSON unless a route says otherwise. An error response is FastAPI's standard `{"detail": "..."}`. A search asked for while the engine runs as many runs as it allows waits its turn: the answer is `202` with no run id yet, `queued: true`, its place, and a ticket. Only when as many more are waiting as the engine queues is it refused, with `429` and a `Retry-After: 5` header. Most routes declare a response model, and `http.md` says which. Three routes use server-sent events: a run's progress, a selected-evidence answer's events, and a message to the assistant. Reference exports stream bytes in their chosen format.

Credentials never travel back: a route reports whether one is stored, as `present`, `absent`, or `unreadable`, and never its value.

## Health and Identity

Who the engine is, and whether this window may talk to it.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/health` | Liveness, process identity (the runtime id, process id, and start time), the version and build, the database schema, and whether the similarity index loaded. |
| `POST` | `/api/renderer/heartbeat` | A ping from the window, so the engine knows one is present. |
| `POST` | `/api/auth/renderer-origin` | Allow one more exact renderer origin on this engine. |

## Asking the Sources

Starting a Deep Dive or a Deep Sweep, and the catalog they choose from. Both start routes take an optional `request_id`: two requests with the same one are one submission, and the second is answered with the first's run and `duplicate: true`. Both start routes also take `match`: `any` (a paper with any of the terms, the default) or `all` (a paper with every term).

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/search/dive` | Start a Deep Dive on one source. Answers with the run's id at once, or, at the run limit, with its place in the queue. Its papers land in `collection` (an id or a name), or the default collection. |
| `POST` | `/api/search/sweep` | Start a Deep Sweep on several sources. The cap on papers applies to each source. Its papers land in `collection`, as a Deep Dive's do. |
| `GET` | `/api/search/repositories` | The slugs of the sources this copy of resmon can ask. |
| `GET` | `/api/repositories/catalog` | The source catalog: each source's coverage, key requirement, pace, how it combines terms and dates papers, credit, whether it can be asked about an author, and what it can be asked for one paper by. It never returns a secret. |

<a id="find-a-paper"></a>

### Look Up a Paper

One paper, by DOI, arXiv id, PMID, or title, asked of every source that can look it up. A find is a run: it is listed with the others, its papers land in `collection`, and Health counts each source's answer.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/find/plan` | What `q` reads as (a DOI, an arXiv id, a PMID, or a title) and which sources a find would ask, with why each other source would not be asked. |
| `POST` | `/api/find` | Start a find. `repositories` names the sources to ask (absent, every source that can look up that kind). Answers like a Deep Sweep: the run's id, or its place in the queue. |
| `GET` | `/api/executions/{exec_id}/find` | What each source said: found or not, how its copy matched (by DOI, arXiv id, PMID, exact title, or close title), what differs from the reference copy, and its open copy with its license. |

## Runs

Every run, whether you started it or a watch fired it. A run's progress is read as a list of events or as a server-sent stream.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/executions` | One page of runs, newest first, with each run's coverage. Filter by `type` and `status` (one value or several, comma-separated) and by `q` (a run's terms, sources, watch, saved search, or number); the `X-Resmon-Total` header says how many match. |
| `GET` | `/api/executions/active` | The runs going now, each with its search and its events so far; the runs waiting for a free slot, next first; and the runs that failed since the run monitor's panel was last opened. |
| `DELETE` | `/api/executions/waiting/{ticket}` | Take a run you asked for out of the queue before it starts. A watch's run is not taken out here. |
| `POST` | `/api/executions/seen` | The run monitor's panel was opened: runs that failed until now are seen, and `failed_unseen` on `/api/executions/active` is empty until another fails. |
| `GET` | `/api/executions/{exec_id}` | One run: its kind, status, parameters, times, counts, coverage, and the summary connections it tried. |
| `DELETE` | `/api/executions/{exec_id}` | Delete a run's record. Its report and log files stay where they were written, and its papers stay in the collection. |
| `POST` | `/api/executions/{exec_id}/cancel` | Ask a running run to stop at its next checkpoint. |
| `POST` | `/api/executions/{exec_id}/stop-sources` | Stop named unfinished sources with `{"sources": ["plos"]}`, or every unfinished source with `{"all": true}`, and let the run continue. Exactly one choice is required. Malformed bodies and unknown source names receive 422; an unknown run receives 404; a finished source or finishing run receives 409. |
| `POST` | `/api/executions/{exec_id}/restart` | Repeat the search, never resume it. A watch still saved uses its current settings and delivery, without a restart link, and refuses while already running; another run copies its saved search and links back to this one. With `again: true` a completed run can run again. At the run limit it waits in the queue. |
| `GET` | `/api/executions/{exec_id}/report` | The run's Markdown report. |
| `GET` | `/api/executions/{exec_id}/log` | The run's log text. |
| `GET` | `/api/executions/{exec_id}/search-record` | The complete, dated account of one search, as JSON or Markdown. |
| `GET` | `/api/executions/{exec_id}/documents` | One page of the papers the run found, each with its stored id and its place in the reading queue. `only_new=true` keeps those it was the first to store in the database. `q` finds as the Library does, in a title, the authors, or the source; `total` is then how many match and `searched` how many it looked through. |
| `GET` | `/api/executions/{exec_id}/document-ids` | Every paper the run stored that is in the collection named (`?collection=`, the default one when none is), by id. |
| `GET` | `/api/executions/{exec_id}/references` | Export one run's papers as BibTeX, RIS, CSV, or JSON. JSON can include stored ids with `include_ids=true`. |
| `GET` | `/api/executions/{exec_id}/progress/events` | The run's events so far, live or as saved after it ended; `since` skips the ones already read. |
| `GET` | `/api/executions/{exec_id}/progress/stream` | The same events as server-sent events, with resumption from a cursor. |
| `GET` | `/api/executions/{exec_id}/deliveries` | Where this run's report was sent, and the state of each delivery. |
| `GET` | `/api/executions/{exec_id}/bundle` | One run's bundle as bytes, in folders that a README.txt explains: the report (HTML, Markdown, and a PDF with its LaTeX source where XeLaTeX or LuaLaTeX is installed), its papers as BibTeX, RIS, and CSV, the search record, the metadata, and the log. |
| `POST` | `/api/executions/export` | Write the selected runs' bundle into the export folder and answer with its path. |
| `POST` | `/api/executions/archive` | The same archive, as bytes. |

The progress events include `source_controls`: a `sources` object keyed by source slug, each with `stoppable`, and `can_stop_unfinished` for the bulk control. These facts are computed under the engine's stop gate. The bulk control requires an answered source and a source that can still be stopped; a skipped or stopped source alone does not qualify as an answer.

## Watches and the Schedule

A watch is called a routine in the API. Deactivating one keeps it and stops its schedule; a routine can be run once whatever its state. Each watch's papers land in its collection (`collection_id`); `collection` (an id or a name) on making or changing one chooses it, and without one a new watch's papers land in the default collection.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/routines` | Every watch. |
| `POST` | `/api/routines` | Make a watch. The answer includes `entity_warning` when it follows a person through sources that cannot be asked about one. |
| `GET` | `/api/routines/{routine_id}` | One watch, with its next computed dates and its record of missed fires. |
| `PUT` | `/api/routines/{routine_id}` | Change a watch: its name, schedule, parameters, switches (including `download_full_text`, off by default), summaries, intent, or collection. Papers its earlier runs filed stay where they are. |
| `DELETE` | `/api/routines/{routine_id}` | Delete a watch and its schedule. Its runs and papers stay. |
| `POST` | `/api/routines/{routine_id}/activate` | Put the watch on the schedule. |
| `POST` | `/api/routines/{routine_id}/deactivate` | Take the watch off the schedule without deleting it. |
| `POST` | `/api/routines/{routine_id}/run` | Run once, now, outside the schedule. At the run limit it is queued and the answer says so; only when the queue is full is it refused. |
| `GET` | `/api/routines/{routine_id}/coverage` | The coverage audit: is this watch finding what its intent says, and what is it missing. |
| `GET` | `/api/routines/{routine_id}/documents` | The papers this watch's runs collected that the collection holds. |
| `GET` | `/api/routines/{routine_id}/delivery-targets` | The watch's destinations. |
| `POST` | `/api/routines/{routine_id}/delivery-targets` | Add a destination: email, folder, webhook, or feed. |
| `PUT` | `/api/routines/{routine_id}/delivery-targets/{target_id}` | Change a destination's mode (automatic or review) or turn it on or off. |
| `DELETE` | `/api/routines/{routine_id}/delivery-targets/{target_id}` | Remove a destination. |
| `GET` | `/api/routines/{routine_id}/deliveries` | The delivery record for a watch. |
| `GET` | `/api/scheduler/status` | Whether each active watch will actually fire, and what decides it. |
| `GET` | `/api/scheduler/jobs` | The jobs registered with the scheduler. |
| `GET` | `/api/calendar/events` | Past runs and the fires each active watch's schedule promises, between two instants. |

## Delivery

Where a report went, and the three decisions the queue is not allowed to make for you: release, skip, and retry.

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/deliveries/{delivery_id}/deliver` | Release a delivery that was waiting for review. The only way out of that state. |
| `POST` | `/api/deliveries/{delivery_id}/skip` | Decide not to send a delivery. |
| `POST` | `/api/deliveries/{delivery_id}/retry` | Start the attempts again after the backoff has given up. |
| `GET` | `/api/deliveries/{delivery_id}/bundle` | The report bundle a webhook envelope linked to, for whoever holds the signed link. The one route served without the local API token. |

## The Background Service

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/service/status` | Whether the service's unit is installed, where, what it runs, and whether the app is available to run it. |
| `GET` | `/api/service/daemon-status` | Whether the service is actually running, read from its lock file. |
| `POST` | `/api/service/install` | Write the unit for this platform and, if asked, register it with the system. |
| `POST` | `/api/service/uninstall` | Remove the unit, and deregister it first if asked. |

## Saved Searches

Saved Deep Dives, saved Deep Sweeps, and the copy kept of every watch. Imports always add rows.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/configurations` | Every saved configuration. |
| `POST` | `/api/configurations` | Save a search. `link_to_execution_id` links it to the run it came from. |
| `PUT` | `/api/configurations/{config_id}` | Change a saved search. |
| `DELETE` | `/api/configurations/{config_id}` | Delete one. A watch's copy takes its watch with it. |
| `POST` | `/api/configurations/export` | Write the chosen rows as a ZIP into the export folder and answer with its path. |
| `POST` | `/api/configurations/archive` | The same archive, as bytes. |
| `POST` | `/api/configurations/import` | Read ZIP or JSON files and add every entry as a new row. A watch arrives paused. |

## Collections

Several collections inside the one database: a paper is stored once and can be in more than one. Every route that reads "the collection" (Today, the map, Search › Collection, Analytics, a watch's papers, a person's matches, and the reading queue) takes `collection`, an id or a name, in its query or body; without one it reads the default collection, which holds every paper a database had before collections. The default collection can be renamed and never deleted. Nothing here deletes a paper.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/collections` | Every collection with how many papers and watches each has, the one the app shows, and the default one. |
| `POST` | `/api/collections` | Make an empty collection. Names are unique without regard to case. |
| `PUT` | `/api/collections/current` | Remember the collection the app shows, by id or name. |
| `GET` | `/api/collections/{collection_id}` | One collection, and what deleting it would do: how many of its papers are in no other collection, and which watches put their papers there. |
| `PUT` | `/api/collections/{collection_id}` | Rename a collection. |
| `DELETE` | `/api/collections/{collection_id}` | Delete a collection. Papers only it held are kept in the default collection, papers also elsewhere stay there, its watches put their papers in the default collection, and its map goes with it. |
| `POST` | `/api/collections/{collection_id}/papers` | Move or copy papers into the collection, by id or by a search of the collection they come from. A copy adds them; a move adds them and then takes them out of the collection they came from. The answer is what an undo sends back. |
| `POST` | `/api/collections/{collection_id}/papers/undo` | Undo a move or a copy, from what it answered: the papers it added leave, and the places it took them from are put back as they were. |

## Today and the Map

Each collection has its own Today, with its own last look, and its own map.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/today` | The papers a run put in the collection since its Today was last marked read, by watch, with each watch's last run: the first 1,000, newest first, and a cursor to the rest. |
| `GET` | `/api/today/papers` | The next 1,000 of Today's new papers, after the cursor the page before gave. |
| `POST` | `/api/today/looked` | Mark All Read: the collection's next window starts now. |
| `GET` | `/api/collection/related-terms` | Up to six distinctive terms from titles and abstracts of papers in the named collection that use `term`, with the number of matching papers. Read-only and collection-only. |
| `GET` | `/api/map` | Where every paper of the collection sits on its plate, the basis it was placed on, and the regions. Each collection's map is fitted over its papers alone. |
| `GET` | `/api/map/facets` | What the map's filters and colors read about every paper of the collection: source, dates, reading state, whether it is new, and its watches. |
| `GET` | `/api/map/find` | Papers of the collection whose title or authors contain a string of at least two characters, newest first. |
| `GET` | `/api/map/views/{name}` | The filters and colors a map (`today` or `run`) was last left with. |
| `PUT` | `/api/map/views/{name}` | Keep a map's filters and colors. |
| `POST` | `/api/documents/briefs` | A line about each paper asked for: title, authors, source, and dates. |
| `GET` | `/api/onboarding` | What the first-run card shows, as facts. |
| `POST` | `/api/onboarding/dismiss` | Put the first-run card away for good. |

<a id="your-collection"></a>
## Collection

Searching what resmon holds, one paper, links between records of the same work, the reading queue, and reference exports.

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/explorer/search` | Search a collection by words or by meaning, with filters, counting every match (a count that runs out of time says so) and, in the newest order, starting at a date. POST because the filter set is a structure. |
| `POST` | `/api/explorer/facets` | The filter values available under the current filters, with counts. |
| `POST` | `/api/explorer/export` | Export everything matching the current filters, not only the page shown, however many: the file is sent as it is written. |
| `GET` | `/api/documents/{doc_id}` | One paper as stored, its place in the reading queue, and every collection it is in, with when and how it arrived in each. |
| `GET` | `/api/documents/{doc_id}/why` | What is locally verifiable about why a paper is in the collection, and what resmon cannot see. |
| `GET` | `/api/documents/{doc_id}/lifecycle` | Retractions, concerns, corrections, and newer versions recorded against one paper. |
| `GET` | `/api/documents/{document_id}/similar` | The papers nearest one paper, with distances and sources. |
| `GET` | `/api/documents/{document_id}/links` | What else in the collection looks like the same work. |
| `POST` | `/api/links/for-documents` | Links for a page of results in one round trip. |
| `POST` | `/api/links/collapse-preview` | Which of these ids a fold would hide, without folding anything. |
| `POST` | `/api/links/scan` | Find records that look like the same work across the collection. Returns at once. |
| `POST` | `/api/links/scan/cancel` | Stop the scan after the paper in flight. Links already written are kept. |
| `GET` | `/api/links/status` | How many links exist, by method, and the scan's state. |
| `GET` | `/api/reading-queue` | One page of the saved papers a collection holds, filtered by `to_read`, `read`, or all, found by title, authors, or source, in an order (saved, published, title, source, or the map's), each with its linked PDF and the run that found it. |
| `POST` | `/api/reading-queue` | Save a paper. Saving one already saved returns it unchanged. |
| `PUT` | `/api/reading-queue/{document_id}` | Mark a saved paper read or unread. |
| `DELETE` | `/api/reading-queue/{document_id}` | Take a paper out of the queue, answering with the entry as it was. The paper is not touched. |
| `POST` | `/api/reading-queue/{document_id}/restore` | Undo a removal: the entry back with the state and dates it had. |
| `POST` | `/api/reading-queue/batch` | Save many papers at once, up to 20,000: each one not in the queue is added, each one in it is left as it is, and the answer counts both and lists what it added, for Undo. |
| `POST` | `/api/reading-queue/batch/all` | Save every paper of a search, a run (or only its new papers), or Today, without listing them, up to 20,000. Refused when the set holds more than the number the person was asked about. |
| `POST` | `/api/reading-queue/batch/undo` | Undo a save of many: the entries it added go, unless they were marked read or saved again since. |
| `POST` | `/api/export/references` | Render a selection of papers as BibTeX, RIS, CSV, or JSON, with one entry per stored paper. |
| `GET` | `/api/shared-wording` | The last scan, the scan in progress, and the pairs it found by group. |
| `POST` | `/api/shared-wording/scan` | Compare every abstract with every other, in the background. Returns at once. |
| `POST` | `/api/shared-wording/scan/cancel` | Stop the scan. The answer stored before it is kept. |
| `GET` | `/api/shared-wording/pairs/{a}/{b}` | Two abstracts side by side, the passages they share, and the numbers. |
| `GET` | `/api/shared-wording/papers/{document_id}` | The pairs one paper is in. |

## People

Watch profiles, which the app calls people. Every match records its basis.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/profiles` | Every person. |
| `POST` | `/api/profiles` | Add a person. |
| `GET` | `/api/profiles/{profile_id}` | One person. |
| `PUT` | `/api/profiles/{profile_id}` | Change a person. |
| `DELETE` | `/api/profiles/{profile_id}` | Remove a person and their matches. The papers stay. |
| `GET` | `/api/profiles/{profile_id}/matches` | Papers of the collection matched to a person, each with the basis it matched on. |
| `GET` | `/api/profiles/{profile_id}/lifecycle` | Retractions and other notices on that person's papers, with coverage. |
| `GET` | `/api/profiles/{profile_id}/export` | A person as JSON. |
| `POST` | `/api/profiles/import` | Import exported people. |
| `GET` | `/api/profiles/starter` | The curated people that ship with the app, not yet anyone's profile. |
| `POST` | `/api/profiles/matches/for-documents` | Which people matched a page of papers, and on what basis. |

## Health

The Source Wall, the Watchdog, retractions and updates, and analytics.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/coverage/source-wall` | Every source's recorded answer to each of the last `limit` runs. |
| `GET` | `/api/watchdog` | Findings, what could not be judged yet, and the thresholds used. |
| `POST` | `/api/watchdog/mute` | Acknowledge a finding so it stops counting toward the alarm total. |
| `POST` | `/api/watchdog/unmute` | Return a finding to the alarm total. |
| `GET` | `/api/lifecycle` | Recorded notices, how much of the collection they cover, and the state of a check. |
| `POST` | `/api/lifecycle/check` | Start a bounded check of the least recently checked papers. |
| `POST` | `/api/lifecycle/stop` | Ask a running check to stop before its next request. |
| `POST` | `/api/lifecycle/for-documents` | Notices for a page of results in one round trip. |
| `GET` | `/api/analytics/overview` | Everything Analytics needs about one collection, in one round trip. |
| `GET` | `/api/analytics/summary` | The collection's summary counts. |
| `GET` | `/api/analytics/source-contribution` | Per source: papers delivered, and how many nothing else found. |
| `GET` | `/api/analytics/keyword-contribution` | Per keyword: papers it found that no other keyword did. |
| `GET` | `/api/analytics/discovery-lag` | Median days between publication and resmon first seeing each paper. |
| `GET` | `/api/analytics/routine-health` | Per watch: new results per run, and whether it has gone quiet. |
| `GET` | `/api/analytics/publication-volume` | Papers per publication month, by source or by subject category. |

## Embeddings

Ranking by meaning and placing papers on the map by meaning.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/embeddings/status` | How many papers are embedded with which model, the state of a backfill, the index, and the extension. The counts are every paper resmon holds; with `?collection=`, `collection_coverage` counts that collection's papers too. |
| `GET` | `/api/embeddings/estimate` | What a backfill would cost, before it starts. |
| `POST` | `/api/embeddings/probe` | Ask the configured or supplied lane to embed one short string. |
| `POST` | `/api/embeddings/backfill` | Embed every paper without a vector for the active model. |
| `POST` | `/api/embeddings/backfill/cancel` | Stop after the batch in flight. Vectors already written are kept. |
| `POST` | `/api/embeddings/rebuild` | Rebuild the similarity index from the stored vectors. |
| `GET` | `/api/settings/embeddings` | The stored settings, with everything the Settings group needs to describe each provider honestly. |
| `PUT` | `/api/settings/embeddings` | Store the settings. A provider that cannot embed is refused. |

## The Library

Every Library route needs the header `X-Resmon-Library: 1`; operations on an existing vault also name its expected id. File storage and Evidence are unavailable on Windows; the reading-queue routes above still work.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/library` | Whether a Library exists, where its folder is, whether resmon can use it now, counts, and limits. |
| `POST` | `/api/library/vault` | Make the Library folder inside a folder you name. |
| `POST` | `/api/library/vault/relink` | Record where the Library folder is now, after checking it is this Library's own. Nothing in it changes. |
| `POST` | `/api/library/vault/move` | Move the Library folder into another folder: one rename on a disk, a checked copy across disks that leaves the old folder. |
| `GET` | `/api/library/papers/{document_id}/places` | One paper’s recorded shelf and dates, linked files, and current projects, using indexed lookups. |
| `GET` | `/api/library/files` | Files, filtered by name, in an order (added, name, or size), a page at a time. |
| `POST` | `/api/library/files` | Import a file, as raw bytes. |
| `GET` | `/api/library/files/{file_id}` | One file's record. |
| `DELETE` | `/api/library/files/{file_id}` | Remove a file: its bytes are held in the Library folder, and its record kept for Undo and Restore. |
| `GET` | `/api/library/files/{file_id}/removal` | What would go with a file if it were removed: its links, and the projects it is in or has notes in. |
| `POST` | `/api/library/files/{file_id}/open` | Verify the stored copy and answer with the path to open. |
| `POST` | `/api/library/files/{file_id}/paper-links` | Link a file to a paper in your collection. |
| `GET` | `/api/library/files/{file_id}/text` | A TXT, MD, or TeX file as literal text, within its bounds; with `lines`, only its first lines. |
| `GET` | `/api/library/files/{file_id}/pdf` | A kept PDF's bytes, verified, for the reader. |
| `GET` | `/api/library/files/{file_id}/picture` | The first-page picture kept for a PDF. |
| `PUT` | `/api/library/files/{file_id}/picture` | Keep the first-page picture the app drew of a PDF. |
| `GET` | `/api/library/removed` | Removed files still on record, and whether their bytes are still held. |
| `POST` | `/api/library/removed/{file_id}/restore` | Put a removed file back, with everything that went with it. |
| `POST` | `/api/library/removed/{file_id}/release` | A held file's path, for the desktop to send to the Trash. |
| `DELETE` | `/api/library/removed/{file_id}` | Forget a removed file once its bytes have left the Library folder. |
| `GET` | `/api/library/files/{file_id}/shared-wording` | The last comparison of this file since the engine started, or that there is none. |
| `POST` | `/api/library/files/{file_id}/shared-wording` | Compare this file, page by page, with the abstracts and the other Library files. |
| `GET` | `/api/library/export` | A JSON inventory of what the database records about each file. |

### Get the PDF

Open-access PDFs into the Library. These routes need no Library header. A PDF is fetched only where a source states an open license for the copy, never from NASA ADS, Springer, CORE, BMC, or nature.com.

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/documents/{doc_id}/full-text` | Ask for a paper's PDF. Recorded before anything is fetched; a request that cannot go ahead comes back `skipped` with its reason and sends nothing. |
| `POST` | `/api/full-text/for-documents` | For each paper: its open copies, the one resmon would get or why there is none, its latest request, and the PDF the Library holds for it. |
| `GET` | `/api/executions/{exec_id}/full-text` | Every PDF a watch's run asked for, and what came of each: stored (and whether the Library holds the file still), skipped, or failed, with why. |
| `GET` | `/api/full-text/rules` | The limits (a watch run's cap, the day's cap, one download at a time from a site and its pace, and the size limit), the license rule, and the sources and sites never downloaded from. |

## Evidence

Projects of exact file versions, notes and passages, exports, and selected-evidence answers. These routes use the same Library header.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/evidence/projects` | Projects. |
| `POST` | `/api/evidence/projects` | Start a project. |
| `GET` | `/api/evidence/projects/{project_id}` | One project and its revision. |
| `PATCH` | `/api/evidence/projects/{project_id}` | Rename a project. |
| `GET` | `/api/evidence/projects/{project_id}/files` | The exact file versions a project holds. |
| `POST` | `/api/evidence/projects/{project_id}/files` | Add a file version to a project. |
| `DELETE` | `/api/evidence/projects/{project_id}/files/{file_id}` | Remove a file from a project. Its saved records stay. |
| `GET` | `/api/evidence/projects/{project_id}/notes` | The project's notes and passages. |
| `POST` | `/api/evidence/projects/{project_id}/notes` | Save a note or a passage. The engine checks the exact quote against the stored file first. |
| `PATCH` | `/api/evidence/projects/{project_id}/notes/{note_id}` | Edit a note's body. The pin never moves. |
| `GET` | `/api/evidence/projects/{project_id}/reader/{file_id}` | One page of a file, as canonical text. |
| `POST` | `/api/evidence/projects/{project_id}/bundle` | Export 1 to 20 chosen files and their records as a ZIP. |
| `POST` | `/api/evidence/projects/{project_id}/answer-previews` | Assemble and show exactly what a selected-evidence answer would send. Calls no model. |
| `GET` | `/api/evidence/projects/{project_id}/answers` | The project's saved answers. |
| `POST` | `/api/evidence/projects/{project_id}/answers` | Send a confirmed preview: one new saved answer. |
| `GET` | `/api/evidence/projects/{project_id}/answers/{answer_id}` | One saved answer. |
| `POST` | `/api/evidence/projects/{project_id}/answers/{answer_id}/cancel` | Stop a running answer. |
| `GET` | `/api/evidence/projects/{project_id}/answers/{answer_id}/events` | A running answer's events, as server-sent events. |
| `GET` | `/api/evidence/projects/{project_id}/answers/{answer_id}/export` | A saved answer as an offline HTML document or a ZIP. |

## Ask

The assistant, its saved conversations, and the command sign-in checks.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/assistant/status` | Whether the assistant can run, and if not, why in one sentence. Also the choices a new conversation offers. |
| `GET` | `/api/assistant/sessions` | Saved conversations. |
| `GET` | `/api/assistant/sessions/browse` | Saved conversations, a page at a time, with a title filter. |
| `POST` | `/api/assistant/sessions` | Start a conversation. |
| `GET` | `/api/assistant/sessions/{session_id}` | One conversation with its messages. |
| `DELETE` | `/api/assistant/sessions/{session_id}` | Delete a conversation and its messages. |
| `POST` | `/api/assistant/sessions/{session_id}/messages` | Send a message. The answer streams back as events. |
| `POST` | `/api/assistant/sessions/{session_id}/cancel` | Stop the running turn. |
| `GET` | `/api/assistant/sessions/{session_id}/export` | A saved conversation as Markdown or JSON. |
| `GET` | `/api/assistant/sessions/{session_id}/file-text` | Part of one page of a Library file attached to this conversation, and of no other file. This is the route Ask's `read_attached_file` tool calls. |
| `POST` | `/api/assistant/permissions` | Ask the person, and hold the request open until they answer. This is the assistant's permission tool. |
| `POST` | `/api/assistant/permissions/{request_id}` | The panel's Allow or Deny. |
| `GET` | `/api/ai/cli/sign-in` | Ask the `claude` or `codex` command itself whether it is signed in. No model call, no cost. |
| `POST` | `/api/ai/cli/sign-in` | Start the command's own login in a terminal, or say the command to run. |
| `GET` | `/api/ai/last-answered` | Which model last answered each requested alias, from answers already kept. |
| `POST` | `/api/ai/models` | The model ids a provider's credential can access. |

## Settings and Credentials

A credential's value is never returned. The engine reports only whether one is stored.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/appearance` | The theme, the accent, and whether the top bar shows the run monitor. |
| `PUT` | `/api/appearance` | Store the theme and accent, and the run monitor's switch when it is sent. |
| `GET` | `/api/top-bar` | The top bar's sections in order, the hidden ones, the start page, and where the resmon name goes. |
| `PUT` | `/api/top-bar` | Store all four. A section left out of the order goes back where it goes by default. |
| `GET` | `/api/web-links` | Where a web link opens (resmon's browser or yours), whether resmon's browser opens it in a window or a tab, and what its address field searches with. |
| `PUT` | `/api/web-links` | Store all three. |
| `GET` | `/api/settings/ai` | Summary settings, including the connection chain. |
| `PUT` | `/api/settings/ai` | Store them. |
| `GET` | `/api/settings/ai/cli-status` | Whether each command can be found, and where. |
| `GET` | `/api/settings/assistant` | What a new conversation starts with. |
| `PUT` | `/api/settings/assistant` | Store it. |
| `GET` | `/api/settings/email` | The mail account, without its password. |
| `PUT` | `/api/settings/email` | Store it. |
| `POST` | `/api/settings/email/test` | Send a test email with the stored settings. |
| `GET` | `/api/settings/notifications` | When desktop notifications are posted. |
| `PUT` | `/api/settings/notifications` | Store it. |
| `GET` | `/api/settings/storage` | The export folder, where backups go. |
| `PUT` | `/api/settings/storage` | Store it. |
| `GET` | `/api/settings/sources` | The contact address resmon gives Crossref and OpenAlex, if you set one, and the sources it goes to. |
| `PUT` | `/api/settings/sources` | Store it, or clear it with `null`; with none, nothing is sent. |
| `GET` | `/api/settings/execution` | How many runs go at once, and how many manual searches and watch runs may wait in their shared queue. |
| `PUT` | `/api/settings/execution` | Store them. |
| `GET` | `/api/credentials` | Per credential name: `present`, `absent`, or `unreadable`. |
| `PUT` | `/api/credentials/{key_name}` | Store a credential in the system keychain. |
| `DELETE` | `/api/credentials/{key_name}` | Remove a credential. |
| `POST` | `/api/credentials/validate` | Try a key against its provider: accepted, refused, unanswered, unreachable, or untestable. |

## Backup and Restore

A restore is staged and runs the next time an engine starts.

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/backup` | Write one bundle: the snapshotted database, the Library's bytes, and optionally the reports. |
| `GET` | `/api/backup/last` | The last bundle, the last restore's outcome, a staged restore, whether a restore's undo copy exists, and `pre_upgrade_copy`, the database copy kept before a schema upgrade, or `null`. |
| `POST` | `/api/backup/verify` | Recompute every hash in a bundle and report what a restore would and would not do. |
| `POST` | `/api/backup/drive-upload-notice/acknowledge` | Dismiss the Backup page's one-time notice about Google Drive. |
| `POST` | `/api/restore` | Verify a bundle and stage it. |
| `POST` | `/api/restore/cancel` | Forget a staged restore. Nothing had been moved. |
| `POST` | `/api/restore/acknowledge` | Dismiss the one-time card listing the credentials to enter again. |
| `POST` | `/api/restore/undo-copy/delete` | Delete the copies a restore set aside. Irreversible, so it needs `CONFIRM`. |

## The Danger Zone

Each takes `{"confirm": "CONFIRM"}` except the two that erase only keys.

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/admin/erase-ai-keys` | Erase every AI provider key. |
| `POST` | `/api/admin/erase-repo-keys` | Erase every source key. |
| `POST` | `/api/admin/erase-configs` | Erase every saved search and every watch linked to one. |
| `POST` | `/api/admin/erase-executions` | Erase every run and the run counter. Papers are kept. |
| `POST` | `/api/admin/erase-corpus` | Erase every paper. Runs, watches, settings, and keys are kept. |
| `POST` | `/api/admin/erase-execution-data` | Erase all configs and all runs. Settings and keys are kept. |
| `POST` | `/api/admin/erase-app-data` | Erase the papers, saved searches, runs, and every key. |
| `POST` | `/api/admin/reset-settings` | Reset every setting and erase every key. Saved searches and runs are kept. |
| `POST` | `/api/admin/factory-reset` | Erase every key, saved search, run, paper, and setting. The Library is kept. |
