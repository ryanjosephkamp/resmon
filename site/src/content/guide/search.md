---
title: "Search"
summary: "Searching what you hold, asking the sources for more, finding one paper, runs, saved searches, and shared wording."
order: 5
---
**Search** has five tabs: **Your collection**, **Ask the sources**, **Find a paper**, **Saved**, and **Shared wording**. The two buttons at the top of Your collection, **Deep Dive** and **Deep Sweep**, open Ask the sources with that kind chosen.

## Your collection

This tab searches the collection the window shows, across all the runs and watches that put papers there; its name is the page's heading. Type words that appear in a title, an abstract, or an author's name.

**Filters** narrow by **Source**, **Category**, **Author**, and **Published**. Each value shows how many papers it would hold. The filters and your words are kept in the address of the page, so you can go back to a filtered view, and a chart on **Health › Analytics** opens exactly the papers it drew.

**Newest** orders by publication date. **Closest in meaning** appears when your embedding model can rank the collection, and it orders by how near each paper is to the phrase you typed rather than by date. Two things are true of it:

- **Your words do not filter.** The phrase is what distance is measured from, so it finds papers that contain none of your words. Your other filters still choose what is in scope.
- **Papers without a vector are listed last,** marked "not ranked", and the line under the box counts them ("N ranked, M not embedded yet and listed last"). They have not been judged distant. They have not been judged.

When resmon cannot rank, the control is not offered and a sentence says why: no model is set up, papers have no vectors yet (counted), the similarity index holds none of them, or the extension did not load. The sentence links to **Settings › AI › Embeddings** where something there is the next step. See [AI settings](/resmon/guide/ai-summarization/).

The count above the list is every paper that matches, however many. Counting has 1.5 seconds; if it runs out, the line says "At least N" and that counting stopped, and the list and the export still hold every match. Closest in meaning ranks every match too, not only the newest.

The list reads more papers as you scroll toward its end (**Show more** does the same from the keyboard), and it stays as quick at the ten-thousandth row as at the first. In the newest order, **Jump to** starts the list at a month of publication: the line above the list says how many newer matches come before it, the count does not change, and **Back to the newest** returns to the top. The month is kept in the address with your words and filters.

The **Export these papers as** buttons (**BibTeX**, **RIS**, **CSV**) write every paper that matches, not only the rows drawn, through the system's save dialog. There is no limit on how many: resmon writes the file as it reads the papers, and says how many the file holds once it is saved.

**Select**, at the end of that row, puts a box beside each result and turns the row into a selection bar. Click a box to pick a paper, Shift-click to pick every paper back to the last one picked, or use the keyboard: Space picks, the up and down arrows move between rows, and Shift with an arrow picks as it goes. **Select all** (or ⌘A, Ctrl+A on Windows and Linux) picks every match the count holds, not only the rows read so far, and a box ticked off afterward is left out. **Save to read** saves the papers picked to your **Library**, under **To read**; a paper already in your reading queue stays as it is, read or not. A save of more than 200 asks first, and one save takes at most 20,000 papers. The notice after it says how many were saved and how many were already there, and **Undo** takes back the ones it added for ten seconds. **Done** or Esc leaves.

Each result shows its title, any retraction or correction recorded against it, its authors, source, and publication date. Two more lines can appear:

- **Papers that look like the same work.** Each is labeled "also appears in (source)" with the reason resmon linked them: "same DOI" is an identifier, and "near-identical title" is an inference. resmon links and never merges: both records are kept, with what each source said. **Fold the same work into one row** hides the extra rows in this view only; the count does not change, and turning it off shows every row. Links are made by a scan started over the HTTP API (`POST /api/links/scan`); Atlas shows the links that exist.
- **People.** A paper matched to someone on your **People** list shows who, the string the source returned for the author, and the basis of the match. See [Watches and people](/resmon/guide/watches/).

The map beside the list marks where the matches sit in the collection.

### Collections

resmon can keep several collections in one database, one per field, say. The name beside the resmon mark in the top bar is the collection the window shows. Its menu lists every collection with how many papers it holds, switches to another, and has **New collection** and **Manage collections**, which open **Settings › Collections**. Each window shows its own collection: switching in one window changes only that window, a window opened from a link or the command palette shows the collection of the window it came from, and a new window (**New Window**, or the first at launch) opens on the collection last chosen.

Search › Your collection, Today, the map, Analytics, a run's and a watch's papers on their maps, a person's matches, and the reading queue's lists all show the collection the window shows. Each collection has its own map, fitted over its own papers, and its own Today with its own **Mark all read**. A paper is stored once and can be in more than one collection; your Library's files and projects belong to no collection.

Every number those screens give counts the collection shown, and where there is more than one collection they name it: "2 papers in Photonics", and Search's note on ranking by meaning counts that collection's papers with a vector. The tab keeps its name, **Your collection**, whichever collection it shows. A few things cover every paper resmon holds, whatever the collection: the embedding backfill in Settings › AI › Embeddings, the check for retractions and corrections, and Shared wording. With more than one collection, their numbers say "in every collection".

Papers arrive in a collection from the runs that land there. A Deep Dive or a Deep Sweep lands in the collection the window shows, and Ask the sources says which when there is more than one. A watch lands in the collection its editor names. A run puts every paper it finds in its collection, including one resmon already holds in another.

On the selection bar that **Select** opens (see Search › Your collection above), **Move to** and **Copy to** sit beside **Save to read** and put the papers picked in another collection: a copy adds them there and keeps them where they were, and a move also takes them out of the collection shown. With **Select all**, resmon reads the search again when you move or copy, leaves out the boxes ticked off, and refuses if the search now matches more papers than the bar said. Neither deletes a paper, and the notice that follows has **Undo** for ten seconds, which puts every paper back where it was; **Done** or Esc right after leaves the notice and its Undo.

In **Settings › Collections** you make, rename, show, and delete collections. Deleting one asks first when it holds papers or a watch puts papers there, and says what happens: papers only it holds are kept in the default collection, papers also in another collection stay there, and its watches put their papers in the default collection. The default collection, named Your collection until you rename it, is never deleted. A read or a run that names no collection, from the command line or the MCP server, uses it.

### A paper

A paper's page shows the record as resmon holds it, and in this order:

1. **Save to read**, or its place in the reading queue with **Mark read** and **Remove**.
2. Its PDF: **Read the PDF** when the Library holds one linked to it; **Get the PDF** when a source states an open license for a copy of it (see [the Library](/resmon/guide/library/#get-the-pdf)); otherwise **Open at** its source, with the reason there is nothing to get.
3. Any retraction, concern, correction, newer version, or journal publication recorded against it, with the notice's link.
4. The **Abstract**, labeled "as (source) gave it".
5. **Why it is here**: which of the keywords from the runs that found it appear in it (a paper only a find holds says that Find a paper looked it up, and how the record matched), and in which field (title, abstract, subject categories, or author list). Matching is on whole words, so `AI` does not match `said`, and a quoted phrase must appear as a phrase. Beneath it, **What resmon cannot see** states the limits. resmon stores no full text, and most sources rank by relevance rather than filtering by keyword, so a paper that contains none of your keywords is expected, not a fault.
6. The collections it is in, how it arrived in each (found by a run, moved, copied, or there since before collections), and **Move to** and **Copy to**. A paper not in the collection the window shows can be copied there.
7. **Shared wording** with other abstracts, and **The same work elsewhere**, where there are any.
8. Beside it, the paper and its eight nearest neighbors on the map.

The paper's number, such as "Paper 12", is its number in this resmon, the same in every collection it is in. It is what a file in the Library is linked with.

## Ask the sources

This is where Deep Dives and Deep Sweeps start.

- **Search terms.** Press Enter to add each term. The terms go to the sources together, and each source combines them its own way.
- **Source** or **Sources.** A Deep Dive asks one source, a Deep Sweep several. Each row states how that source combines terms, how many requests resmon may make, how finely it can date a paper, and whether it can be asked about an author. A source marked **needs an API key** is recorded as not asked until you store its key.
- **Published.** Choose 7 days, 30 days, A year, or Any time, or set **From** and **To**. A fresh form asks for the last 30 days.
- **Up to N papers per source.** From 1 to 1,000, 100 by default. The cap applies to each source, so a sweep of five sources can store up to five times that.
- **Summarize each paper.** Off by default. See [AI settings](/resmon/guide/ai-summarization/).

The run's papers land in the collection the window shows; when there is more than one, the bar beside the button names it. Under the button, resmon states what it already knows about this selection and nothing it would have to guess: which chosen source sets the pace, which cannot date papers as finely as your window, and which need a start date. It does not estimate how many papers you will get.

**bioRxiv and medRxiv** cannot be asked for words. resmon reads the preprints they list for your dates, newest first, for up to 45 seconds, and matches your terms itself. So both need a start date, and while either is chosen the form fills one in and **Any time** is off. A longer window may not be read back to its start. A search that runs out of time, or reaches the run's cap, has read the newest part of the range and is **answered in part**. That is not an answer for the whole window, and it is not a failure of the source.

If resmon is already running as many runs as **Settings › In the background** allows, a new search waits its turn: the **Runs** tab lists it under **Waiting**, and it starts on its own when a run finishes. Only when as many more are waiting as resmon queues is a search turned away.

**Save this search** keeps the sources, terms, dates, and cap together under **Saved**. **Watch this search** opens the watch editor with the sources, terms, and cap filled in. It leaves the dates out, because dates fixed today would be asked again on every run.

Beside the form are the five newest runs, with a link to the **Runs** tab.

## Find a paper

One paper, asked of every source that can look it up. Type or paste a DOI (with or without `https://doi.org/`), an arXiv id (`arXiv:1706.03762`, `1706.03762v5`, or its address), a PMID, or a title. Under the field resmon says what it reads it as, which sources can look it up, and why each other source is not asked: some can be asked only by some kinds (arXiv by its id or a title, never a DOI), bioRxiv and medRxiv hold only DOIs that begin `10.1101/`, and a few have not been checked (CORE, NASA ADS, and Springer Nature need a key, DBLP answered with a challenge page, and PubMed's search answered errors when it was checked). Click a source to leave it out of this find, and again to put it back. Each source's capability, and the live check it rests on, is in its row of the catalog.

**Find** asks them all at once. A find is a run: the **Runs** tab lists it as **Find a paper**, **Health** counts each source's answer, and a copy it keeps lands in the collection the window shows. While it goes, each source is drawn as being asked or answered. Then the page shows the paper as its reference copy has it (a registration agency's record first: Crossref, then DataCite, PubMed, arXiv, and the rest), **Get the PDF** where an open copy exists, and a row for every source:

- **Found**, and how: by its DOI, arXiv id, or PMID, by its exact title, or by a close title, with the share of words the titles share. A source's answer is a list of candidates, and resmon keeps a record only when it carries the identifier asked for, or when its title is the title asked for or close to it (85 percent of the meaningful words, and never for a title of fewer than three). Every other record is counted and dropped.
- **What differs** from the reference copy: the title, the year, the DOI, the first author, or the number of authors.
- **Its open copy**: where, and under what license, or that no source reported one.
- **Not found** (it answered, and none of its records is this paper), **Did not answer**, or **Not asked**, with why.

Copies that carry the same DOI are linked as one paper, and each one's page lists the others under **The same work elsewhere**. **Open the run** opens the find's run page, and a find's run page links back to its answers. Earlier finds are listed under the form.

## Runs

The **Runs** tab (⌘4, in the top bar's first order) holds every run.

- **Running now.** Each run going now, with each of its sources in the Source wall's marks, how long it has run, what it is doing (how many sources have finished and which it is asking, or the stage after that), and **Stop**. A run the engine has said nothing about for 15 seconds says so. Pointing at a source's mark, or reaching it from the keyboard (the marks are one stop, the arrow keys between them), says what that source has done so far, and choosing it opens the run.
- **Waiting.** Runs waiting for a free slot, in the order they start, with the time each joined the queue. A search you asked for can be taken out with **Don't run**; a watch's run is stopped by pausing the watch.
- **History.** Every run, newest first, grouped by day, with how many there are. **All**, **Searches** (Deep Dives, Deep Sweeps, and finds), **Watches**, and **Failed** narrow it, and the field finds a run by its terms, its sources, its watch or saved search, or its number. Older runs are read as you scroll.

A manual search is named by its terms and a watch's run by the watch's name. Each row says when it started, whether it was a **Deep Dive**, **Deep Sweep**, or **Watch run**, and one line of what happened: how many of its sources answered, and how many papers it found and how many of those were new.

A run also keeps which of its papers were new: the ones resmon had not stored before. Its new-only filter lists just those: `resmon export --run N --new-only`, and `only_new=true` on the run's papers and references in the HTTP API. Until November 5, 2026, a run marked the papers it stored on the day it started (in UTC) as not new, so the filter left them out. The first start of resmon 1.0 corrected the filter of earlier runs, once, from when each paper was first stored, and wrote a line saying how many runs and links it changed, beginning `Recounted which papers were new to earlier runs`, in the same place as the line about the copy kept before an update (see [Backup and restore](/resmon/guide/backup/)).

A run ends **completed**, **failed**, **cancelled**, or **interrupted**. Interrupted means the process running it went away before it finished, for example because the app was force-quit. It is not failed, because nothing went wrong with the search, and the row says what resmon observed and when it last saw the run working. A run fails when every source selected for it was asked and none answered. It is not recorded as completed, because "completed" over a dead source would state an empty field where a failure happened. A source resmon never asked, such as one with no key, is not a failure and never makes a run one.

Tick runs to work on them together, or **Select all** to tick every run listed:

- **BibTeX**, **RIS**, or **CSV** exports the papers of every ticked run as one file, with one entry per paper however many runs found it.
- **Bundle** saves each run's report, with a PDF and LaTeX where they could be made, its log, its metadata, and its search record, in one archive.
- **Save as searches** saves each ticked Deep Dive or Deep Sweep as a saved search, named by its terms, with its own sources, terms, dates, and cap, summarizing as its run was set to, and linked back to the run. A watch's run is not saved: its search is the watch's, and **Saved** keeps a copy of every watch.
- **Run again** starts each ticked run again now. A search runs with its own terms, dates, limit, and sources, as a new run linked back to it, and summarizes only if its run was set to. A watch's run is its watch's **Run now**: the watch's current settings (its terms, sources, dates, and summaries), emailed and delivered as the watch is set, and refused while the watch is already running, so two runs of one watch never overlap. It asks first, saying how each summarizes and how many wait for a free slot. A run still going is left alone.
- **Delete** removes the run's record, what each source answered, which papers it found, and where its report was sent. The papers stay in your collection, and the report and log files stay in the reports folder. A run still going cannot be deleted. The question is asked on the page first; **Not now** or Escape leaves everything as it was.

**Restart…** appears on a run that was interrupted, failed, or cancelled. Before anything starts it says what Restart will do. It never resumes the old run. A Deep Dive or Deep Sweep asks the same sources with the same terms, dates, and cap as a new run, is never emailed or delivered, and summarizes only if the old run was set to, as it recorded when it started, using what **Settings › AI** holds now. A run that was set to summarize and failed before any paper was summarized is restarted with summaries on. A watch's run is its watch's **Run now**, as with **Run again**: the watch's current settings, emailed and delivered as the watch is set, and refused while the watch is already running.

### A run's page

A run's page opens when you start a search, from the Runs tab, from a watch's history, and from a notification. **← Runs** goes back to the Runs tab.

- **Header.** **Stop** (while it runs; a stop is cooperative, so the run ends at its next checkpoint), **Restart**, export buttons, **Bundle**, **Save as a search**, and **Delete this run**. The line under the name gives the kind, when it started, how long it took, its status, and the saved search or earlier run it is linked to. **Dates** states the dates the run asked for; for a watch whose window moves, they are the dates computed when it fired.
- **Summaries** says whether the run summarized, with which connection, and what each connection it tried did.
- **Sources.** While the run goes, the page says the stage it is at, a bar shows how many of its sources have finished, and the heading's clock ticks. Each source is drawn in the Source wall's marks; one being asked says how long, from the engine's heartbeat every two seconds, the requests sent and any retries, and what it is waiting for (the source's pace, a pause the source asked for, or the pause before asking again). Afterward, the page shows the **recorded outcome of each source**, led by a sentence summing up the run: which sources answered, which recorded a non-answer, and which are unknown. A filled mark is an answer, a half mark an answer in part, a ring an unknown, and a fault mark a non-answer. Each source gives a result count, or "count not recorded". Pointing at the bar names the sources still being asked and those not asked yet, and pointing at a source's mark gives its outcome and count in a tip.
- **The map.** A small map of where this run's papers sit in the collection.

The tabs below hold the run's own record:

| Tab | What it holds |
|---|---|
| **Papers** | The papers the run stored, each with **Save to read**; **Save this run's new papers** saves every paper the run was the first to find, and **Select** saves the papers you pick, or with **Select all** every paper it stored |
| **Map** | The run's papers on the collection map, with find, filters, and colors; a paper is named under the pointer and when chosen from the keyboard |
| **Report** | The Markdown report as resmon wrote it, with **Save as Markdown** |
| **Search record** | The dated, reproducible account of the search: the terms as typed, what each source's requests carried, the dates and cap, what each source returned, deduplication, and caveats, with **Save as Markdown** |
| **Log** | The run's log |
| **Metadata** | Everything the engine keeps about the run, each field under a label, with each source by name |
| **Progress** | The timeline of events as they arrived |

The search record is careful about what it claims. Each figure names the PRISMA 2020 flow-diagram box it belongs in, or says it has none, because resmon's counters do not all map onto those boxes. resmon flags papers that look like duplicates across sources and keeps both rows, so it reports duplicates found, never duplicates removed. A figure that was never measured reads "not recorded", never `0`, because a reviewer reads `0` as a measurement. Sources selected but not asked, for a missing key or a failing endpoint, stay in the record, because a strategy that listed them as searched would overstate its coverage.

## Saved

**Saved** lists the searches you saved and, under **Watches**, the copy resmon keeps of each watch.

For a saved search:

- **Ask again** opens Ask the sources filled in. A run started from it records which saved search it came from.
- **Change** edits its name, terms, sources, dates, and cap.
- **Make it a watch** opens the watch editor with its sources, terms, and cap.
- **Delete** removes it. Runs it started are kept and stop naming it.

A watch's copy follows the watch, so you change it in the watch's own editor.

**Export to a file** writes the ticked rows as a ZIP with one JSON file per saved search or watch, through the save dialog. **Import a file** reads a ZIP, or the JSON files from one. Every entry is added as a new one and resmon never merges an import with what you have, so a name already in use lands as a second row. A watch imported from a file arrives paused, whatever the file says. Credentials are never in an export.

## Shared wording

**Shared wording** lists abstracts in your collection that share passages word for word. resmon measures the passages and lists the pairs. It does not say why two texts share wording, and it uses no model to look. Shared wording has innocent causes: a template, a quoted definition, a dataset's stock description, a correction notice, two records of the same paper.

Press **Scan the collection**. A scan runs in the background with progress, and **Scan again** compares everything now. After a run that brings in new papers, resmon compares those papers against the collection when the run finishes; the page says how many papers arrived since the last scan and have not been compared yet.

For each pair resmon reports three numbers, each defined beside the numbers on the screen:

- **Longest passage:** the longest run of consecutive words that appears in both texts.
- **Share:** of every run of 8 consecutive words in the shorter text, the share that also appears in the other.
- **Authors in common:** the same ORCID where both records carry one, otherwise the same surname and first initial.

A pair is listed when it shares a passage of at least 20 words, or at least 20% of the shorter abstract's 8-word phrases. A run of 8 words found in the abstracts of more than three works is common phrasing, such as a template or a stock sentence, and cannot make a pair on its own. An abstract under 40 words is not compared, and the scan counts those papers rather than leaving them out silently.

Pairs fall in groups by authors:

| Group | Meaning |
|---|---|
| **No author in common** | Both records list their authors, and no author appears in both |
| **Text reuse by the same authors** | At least one author appears in both |
| **Authors not listed** | One record lists none, so resmon cannot say |
| **Set aside: records of the same work** | A shared DOI, a link resmon made, titles identical word for word, or two versions of one arXiv paper |
| **Set aside: a notice** | One of the two is an erratum, corrigendum, correction, retraction notice, or expression of concern, as its title says |

A set-aside pair is listed with its reason, not dropped. Choosing a pair shows both abstracts side by side with the shared passages marked, the numbers with their definitions, and **What resmon cannot see**: paraphrase, translation, figures, data, and any wording outside the abstracts. A person judges.

A file in your Library can be compared the same way, page by page, with your collection's abstracts and your other files. See [The Library](/resmon/guide/library/).
