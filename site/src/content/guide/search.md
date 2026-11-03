---
title: "Search"
summary: "Searching what you hold, asking the sources for more, runs, saved searches, and shared wording."
order: 5
readmeLines: []
---
**Search** has four tabs: **Your collection**, **Ask the sources**, **Saved**, and **Shared wording**. The two buttons at the top of Your collection, **Deep Dive** and **Deep Sweep**, open Ask the sources with that kind chosen.

## Your collection

This tab searches every paper resmon has collected, across all runs and watches. Type words that appear in a title, an abstract, or an author's name.

**Filters** narrow by **Source**, **Category**, **Author**, and **Published**. Each value shows how many papers it would hold. The filters and your words are kept in the address of the page, so you can go back to a filtered view, and a chart on **Health › Analytics** opens exactly the papers it drew.

**Newest** orders by publication date. **Closest in meaning** appears when your embedding model can rank the collection, and it orders by how near each paper is to the phrase you typed rather than by date. Two things are true of it:

- **Your words do not filter.** The phrase is what distance is measured from, so it finds papers that contain none of your words. Your other filters still choose what is in scope.
- **Papers without a vector are listed last,** marked "not ranked", and the line under the box counts them ("N ranked, M not embedded yet and listed last"). They have not been judged distant. They have not been judged.

When resmon cannot rank, the control is not offered and a sentence says why: no model is set up, papers have no vectors yet (counted), the similarity index holds none of them, or the extension did not load. The sentence links to **Settings › AI › Embeddings** where something there is the next step. See [AI settings](/resmon/guide/ai-summarization/).

The count above the list stops at 10,000 and says so. The **Export these papers as** buttons (**BibTeX**, **RIS**, **CSV**) write every paper that count counts, not only the rows drawn, through the system's save dialog. An export holds at most 10,000 papers; past that, the file holds the newest 10,000 and the screen says so before you save.

Each result shows its title, any retraction or correction recorded against it, its authors, source, and publication date. Two more lines can appear:

- **Papers that look like the same work.** Each is labeled "also appears in (source)" with the reason resmon linked them: "same DOI" is an identifier, and "near-identical title" is an inference. resmon links and never merges: both records are kept, with what each source said. **Fold the same work into one row** hides the extra rows in this view only; the count does not change, and turning it off shows every row. Links are made by a scan started over the HTTP API (`POST /api/links/scan`); Atlas shows the links that exist.
- **People.** A paper matched to someone on your **People** list shows who, the string the source returned for the author, and the basis of the match. See [Watches and people](/resmon/guide/watches/).

The map beside the list marks where the matches sit in the collection.

### A paper

A paper's page shows the record as resmon holds it, and in this order:

1. **Save to read**, or its place in the reading queue with **Mark read** and **Remove**.
2. Any retraction, concern, correction, newer version, or journal publication recorded against it, with the notice's link.
3. The **Abstract**, labeled "as (source) gave it".
4. **Why it is here**: which of the keywords from the runs that found it appear in it, and in which field (title, abstract, subject categories, or author list). Matching is on whole words, so `AI` does not match `said`, and a quoted phrase must appear as a phrase. Beneath it, **What resmon cannot see** states the limits. resmon stores no full text, and most sources rank by relevance rather than filtering by keyword, so a paper that contains none of your keywords is expected, not a fault.
5. **Shared wording** with other abstracts, and **The same work elsewhere**, where there are any.
6. Beside it, the paper and its eight nearest neighbors on the map.

The paper's number, such as "Paper 12", is its number in this collection only. It is what a file in the Library is linked with.

## Ask the sources

This is where Deep Dives and Deep Sweeps start.

- **Search terms.** Press Enter to add each term. The terms go to the sources together, and each source combines them its own way.
- **Source** or **Sources.** A Deep Dive asks one source, a Deep Sweep several. Each row states how that source combines terms, how many requests resmon may make, how finely it can date a paper, and whether it can be asked about an author. A source marked **needs an API key** is recorded as not asked until you store its key.
- **Published.** Choose 7 days, 30 days, A year, or Any time, or set **From** and **To**. A fresh form asks for the last 30 days.
- **Up to N papers per source.** From 1 to 1,000, 100 by default. The cap applies to each source, so a sweep of five sources can store up to five times that.
- **Summarize each paper.** Off by default. See [AI settings](/resmon/guide/ai-summarization/).

Under the button, resmon states what it already knows about this selection and nothing it would have to guess: which chosen source sets the pace, which cannot date papers as finely as your window, and which need a start date. It does not estimate how many papers you will get.

**bioRxiv and medRxiv** cannot be asked for words. resmon reads the preprints they list for your dates, newest first, for up to 45 seconds, and matches your terms itself. So both need a start date, and while either is chosen the form fills one in and **Any time** is off. A longer window may not be read back to its start. A search that runs out of time, or reaches the run's cap, has read the newest part of the range and is **answered in part**. That is not an answer for the whole window, and it is not a failure of the source.

If resmon is already running as many runs as **Settings › In the background** allows, it refuses a new search and says so. Try again when one finishes.

**Save this search** keeps the sources, terms, dates, and cap together under **Saved**. **Watch this search** opens the watch editor with the sources, terms, and cap filled in. It leaves the dates out, because dates fixed today would be asked again on every run.

Below the form is the log of every run.

## Runs

The **Runs** log lists runs newest first, 20 at a time, grouped by day. A manual search is named by its terms and a watch's run by the watch's name. Each row says when it started, whether it was a **Deep Dive**, **Deep Sweep**, or **Watch run**, and one line of what happened: how many of its sources answered, and how many papers it found and how many of those were new.

A run ends **completed**, **failed**, **cancelled**, or **interrupted**. Interrupted means the process running it went away before it finished, for example because the app was force-quit. It is not failed, because nothing went wrong with the search, and the row says what resmon observed and when it last saw the run working. A run fails when every source selected for it was asked and none answered. It is not recorded as completed, because "completed" over a dead source would state an empty field where a failure happened. A source resmon never asked, such as one with no key, is not a failure and never makes a run one.

Tick runs to work on them together:

- **BibTeX**, **RIS**, or **CSV** exports the papers of every ticked run as one file, with one entry per paper however many runs found it.
- **Bundle** saves each run's report, with a PDF and LaTeX where they could be made, its log, its metadata, and its search record, in one archive.
- **Delete** removes the run's record, what each source answered, which papers it found, and where its report was sent. The papers stay in your collection, and the report and log files stay in the reports folder. A run still going cannot be deleted.

**Restart…** appears on a run that was interrupted, failed, or cancelled. Before anything starts it says what Restart will do: it asks the same sources with the same terms, dates, and cap as a new run, never resumes the old one, summarizes only if the old run tried to, using what **Settings › AI** holds now, and emails and delivers only if the run belonged to a watch, as the watch is set when the run finishes.

### A run's page

A run's page opens when you start a search, from the Runs log, from a watch's history, and from a notification.

- **Header.** **Stop** (while it runs; a stop is cooperative, so the run ends at its next checkpoint), **Restart**, export buttons, **Bundle**, **Save as a search**, and **Delete this run**. The line under the name gives the kind, when it started, how long it took, its status, and the saved search or earlier run it is linked to. **Dates** states the dates the run asked for; for a watch whose window moves, they are the dates computed when it fired.
- **Summaries** says whether the run summarized, with which connection, and what each connection it tried did.
- **Sources.** While the run goes, one line per source changes as its answer arrives. Afterward, the page shows the **recorded outcome of each source**, led by a sentence summing up the run: which sources answered, which recorded a non-answer, and which are unknown. A filled mark is an answer, a half mark an answer in part, a ring an unknown, and a fault mark a non-answer. Each source gives a result count, or "count not recorded".
- **The map.** A small map of where this run's papers sit in the collection.

The tabs below hold the run's own record:

| Tab | What it holds |
|---|---|
| **Papers** | The papers the run stored, each with **Save to read** |
| **Map** | The run's papers on the collection map, with find, filters, and colors |
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
