---
title: "Health"
summary: "The Source Wall, the Watchdog, retraction checks, analytics, and which engine a window uses."
order: 7
---
A literature monitor fails silently. A source that stopped answering and a field that went quiet produce the same empty list, and most tools leave you to tell them apart. **Health** is where resmon tells you. It has four tabs: **Source Wall**, **Watchdog**, **Analytics**, and **This Engine**.

## The Source Wall

The Source Wall shows every source's recorded answer to each of the last runs, newest on the right. A source that stopped answering reads as a line that breaks, not as one more empty inbox. The page reads again every 15 seconds.

At the top is a verdict in a sentence or two, such as whether any source has stopped answering. Beneath it is the legend, with a count of each mark, and **Runs shown**, which you can set to 12, 24, or 48 runs. In the grid each row is a source, each column is a run (the column heading links to the run), and each cell is a mark. A cell that answered carries the number of papers. The last column, **When last asked**, gives the most recent recorded reading, including a source you stopped. A source stopped by you is left out of the verdict.

Every cell is in one of eight states. The backend names them, and every other screen uses the same words. [What a Source's Answer Means](/resmon/guide/source-answers/) says what each outcome behind them means, with the HTTP codes a source can send.

| Mark | What it means |
|---|---|
| **answered** | The source replied and returned records |
| **answered, zero** | The source replied and genuinely had nothing: a quiet field, not a fault |
| **answered in part** | The source answered every page resmon asked for, and resmon stopped at its own time budget or the run's cap |
| **could not be asked** | No key, retired, no author query, or a window the source cannot answer |
| **rate-limited** | The source was asked and told resmon to slow down (HTTP 429). It is up; the cell says when to try again where the source said |
| **failed** | The source was asked and the exchange broke: it did not reply, or replied with something resmon could not read |
| **outcome not recorded** | resmon did not observe an outcome. This is not a success and not a failure |
| **not asked on this run** | This run's saved selection did not name this source, so nothing was asked of it |

Each state has its own mark, so a failure and an empty answer can never look alike, and a source that asked resmon to slow down is a ring with a pause in it, never the struck mark of a failure. Three rules decide the borders:

- A reply whose records resmon declined to store, because their rights statement is not one resmon may store, is **answered**. The source replied and returned records; calling it a quiet field would be a claim about someone else's corpus that the row disproves.
- A run you stopped is **outcome not recorded**. resmon observed its own cancellation, not an outcome from the source, so the source is not blamed for your keystroke.
- A source with no row for a run whose saved selection cannot be read is **outcome not recorded**, not **not asked on this run**. An unreadable selection is not evidence that you declined to ask.

Choose a cell to read it: the source, the run and its time, the cell's label and the engine's sentence about what happened, the papers it returned (shown only for an answer), and whether the source was in the run's selection. The sentence names the reason for a zero, and **Open run** goes to the run.

Pointing at a cell, or reaching it from the keyboard, shows a tip beside it with the source, the run and its time, the label, the engine's sentence, and the number of papers in full. Pointing at a column heading names its run. The grid is one stop for **Tab**: it lands on the cell you chose last, or on the first source's newest run, and the arrow keys move one cell at a time (**Home** and **End** go to the ends of a row).

## The Watchdog

The Watchdog compares every source and every watch with baselines drawn from your own run history, and reports where reality has departed from them. The tab carries a count of its alarms. Findings are graded, because an alarm that is wrong gets muted, and a muted watchdog misses the real failure:

| Grade | What it rests on |
|---|---|
| **Broken** | resmon recorded this happening. It is not an inference. |
| **Looks unusual** | A departure from your own history. There may be an innocent reason, and the finding says it. |
| **Advice** | Not an alarm. Something resmon measured, and what the measurement does not show. |
| **Withdrawn** | resmon stopped asking this source, by decision. Not a fault, and not an alarm. |

What it checks, and when:

- A source is **broken** after 3 failed runs in a row. A failure includes a query that raised, an endpoint that could not be reached, a reply resmon could not read, and a source that rate-limited resmon. For a source whose last run was rate-limited, **What to do** says to wait, with the time to run again where the source gave one, or to have fewer watches ask it at once, rather than to check a key. A window a source cannot answer at all is not a failure. A source that needs a key you have not stored is also broken, if an active watch selects it or it was asked in the last 30 days.
- A source that used to return papers **looks unusual** after 4 empty runs in a row, once it has 5 runs of history and at least 3 of them returned papers. Runs where the source did not answer, or answered in part, are left out of that baseline: a baseline built from runs where the source never answered would not be one.
- A watch **looks unusual** after 5 runs in a row with nothing new, if it used to find papers.
- A watch is **broken** when it is overdue: quiet for more than 3 times its usual gap between runs, and for at least a day, once it has 3 completed runs to measure the gap from. That is what catches the background service being down. A watch is also broken when a scheduled run did not happen in the last 7 days because the run before it was still going.
- **Advice** appears when a source answered in part on 3 runs in a row, because a window that is never read to its start is a choice you can change, and when a source's median discovery lag is more than twice a watch's polling interval, with the caveat that the lag was measured through your own polling interval.

Each finding shows what it means, the detail, **What to do**, and the evidence behind it, such as failed runs in a row, the last answer on record, or the credential needed. **Mute** acknowledges a finding so it stops counting toward the alarm total. A muted finding stays on the screen, in its own section with an **Unmute** button, and goes when its reason does, so a recurrence is reported afresh.

**Not Judged Yet** lists what the Watchdog watches but cannot yet judge, with how many runs it has and how many it needs. A watchdog silent for want of data is never a clean bill of health, and with no history at all the page says there is nothing to check yet. **What It Judges By** states the thresholds in effect. They are conservative on purpose.

## Papers That Changed After You Found Them

Below the Watchdog is the check for what happened to papers you already hold. It looks for:

- **Retractions and expressions of concern,** through Crossref, which carries the Retraction Watch database.
- **Preprints that have since reached a journal,** through bioRxiv.
- **Newer versions** of what you hold, on arXiv and bioRxiv.

Every finding is the service's own notice, linked, in its own words. resmon never asserts one on its own authority: a notice it cannot link to is refused, not recorded. The marks come in three grades, and only the first is an alarm:

| Mark | What it means |
|---|---|
| **Withdrawn from the record** | A retraction, withdrawal, or removal. The paper has been taken out of the scholarly record. Read the notice. |
| **Concern registered** | An expression of concern. It is explicitly not a retraction. |
| **Changed since you found it** | A correction, a newer version, or a preprint that reached a journal: normal scholarly upkeep, not a warning. |

The marks show on a paper wherever it is listed: Today, Search, a person's page, and a paper's own page.

Asking tells Crossref, arXiv, and bioRxiv which papers you hold, so the check runs only when asked, from **Check for Retractions and Updates**, or on a schedule by a watch set to look for a person's retractions. One check asks about up to 1,000 papers, those never checked first and then the least recently checked. Papers with a DOI go to Crossref, 40 to a request at no more than one request a second. Papers held at an arXiv version number go to arXiv, 50 to a request, at most one request every three seconds. A bioRxiv preprint goes to bioRxiv, one request each, at no more than 2 a second. These checks share the search clients' own rate limiters. **Check Everything** repeats until every paper has been asked about, and **Stop** finishes the request already out and asks nothing more. A paper is asked about again after 30 days. The check covers every collection.

Coverage is always shown beside the findings, because no retractions found means nothing if only a fifth of the collection has been checked. The sentences count the papers checked, those not yet asked about, those with no DOI and no arXiv version number (counted apart, never as clear), and those a service failed on (asked about again later). A paper is recorded as checked only when every service it needed answered. Crossref's record of corrections and expressions of concern is less complete than its record of retractions, so no concern recorded means less than no retraction recorded.

## Analytics

**Analytics** counts what the collection the window shows holds, using only papers already stored: its papers, the runs that put papers in it, and the watches whose papers land there. It makes no requests to any source and costs no quota. A view with too little to go on shows a sentence saying so instead of a chart, and a share over too small a sample is a dash, never a zero.

- **Collection Overview** shows papers, distinct works (two records of one paper count once), authors, sources used, runs completed, and the share of papers with a DOI.
- **Which Sources Earn Their Place** shows, for each source, how many of its papers no other source supplied. A source whose every paper also arrives from elsewhere costs a run and adds nothing. A row opens that source's papers in **Search › Collection**.
- **Which Keywords Earn Their Place** shows, for each of your terms, how many of its papers no other term matched, so a term that only duplicates another becomes visible. It reads every paper in your collection once, so it runs only when you press **Measure Keyword Yield**. Yield includes subject category matches, which Search’s text query does not.
- **How Quickly Each Source Surfaces a Paper** shows the days from a paper's stated publication date to resmon first seeing it: the median, between the fastest and the slowest. No source publishes this about itself. It is measured through your own polling interval, and withheld for a source until the sample is large enough to mean anything. Only a paper dated to the day can be measured: one whose stated date is a year or a month alone is left out, and the view says how many.
- **Watch Health** draws each watch's completed runs by how many new papers each found, oldest on the left. A run that did not record how many papers were new is drawn as a hollow square and said so, never as none, and a watch whose latest runs did not all record a count is not judged rather than called stale.
- **Papers by Publication Month** shows the latest twelve months that have any, split by source or by subject category. A month's column counts exactly the papers its click opens, those dated to a day of that month; a paper whose stated date is a year or a month alone is left out, and the view says how many. By category, a paper with several categories is counted once in each, so a month's total there is not a count of papers.

Every bar, range, tick, and column has a tip with the engine's numbers in full (a share to every decimal place the engine gives), shown when you point at it or reach it from the keyboard. A click goes to what the mark counts:

- a source's bar, or its range of days, opens that source's papers in **Search › Collection**;
- a keyword's bar searches your collection for its words (a term with search operators opens nothing, because the collection's search would read the operators as words);
- a tick in **Watch Health** opens that run;
- a month's column opens the papers published that month.

Each chart in Analytics is one stop for **Tab**, and the arrow keys move between its marks; **Enter** opens the one you are on.

## This Engine

**This Engine** says which engine this window is talking to: the address, the **Runtime** id (new each time an engine starts), the process id and when it started, the **Version**, the **Build**, the **Database** schema (29 in this build), and the **Similarity index** (whether the `sqlite-vec` extension loaded, and why not if it did not). Build is the id the engine reports, or "not reported by this engine". The runtime id identifies one running process, not a collection; this screen names no collection.

If the engine behind a window changes while it is open, a line under the top bar says so and offers **Reload**. It never reloads on its own, so what is on the screen stays until you choose.
