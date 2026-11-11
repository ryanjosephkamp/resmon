---
title: "Watches and People"
summary: "Making a watch, its schedule and dates, where reports go, the coverage audit, and watching for a person."
order: 6
---
A **watch** is a search resmon runs on a schedule, keeping every paper it finds. **Watches** has three tabs: **Searches** (your watches), **Calendar** (when each is due), and **People** (the researchers resmon looks for on the papers it collects). The engine's HTTP API calls a watch a *routine*.

In a watch’s word editor, each added term offers up to six related terms from papers in the collection the window shows, even when the watch puts its results in another collection. Choose one to add it as its own term. Removing the original term removes its offer. With no paper using a term, the editor says there is nothing to suggest. Suggestions use titles and abstracts in that collection only; no outside service is asked.

## The List

**Watches › Searches** lists your watches, with a count of how many are watching and how many are paused. Each row gives its name, whether it is **Watching** or **Paused**, its schedule in words, when it is next due, what it asks ("(terms) in N sources", or "A person"), and when it last ran. Pointing at a watch lights its papers on the map beside the list.

A row can also say:

- **N fires missed while resmon was closed.** A scheduled run came due when nothing was running the schedule. resmon records the fact and runs nothing to catch up; whether to run a weekend of missed searches the moment a laptop opens is your decision. **Run Now** on the watch's page is how you make that decision.
- **N fires skipped: the run before was still going.** The engine refused each of these and does not run them later, so the watch runs less often than its schedule says.
- **Warnings** about what keeps a watch from finding new papers: it has no search terms, the fixed dates it asks for have ended, or it asks a source that ranks by relevance for papers with no date limit.
- A note that **nothing will run** the watches, or that resmon cannot confirm anything will, with the way to **Settings › In the Background**. A watch is run on schedule only by the background service. See [Install and Launch](/resmon/guide/install/).

## Making a Watch

Press **New Watch**, or start from a search with **Watch This Search** or from **Saved** with **Make It a Watch**, or from a person's page with **Watch for Their Papers**.

**Name.** Anything.

**What it follows.** One of three:

- **Words: papers that match its terms.**
- **A person: their new papers.** It asks each source for papers by that person.
- **A person: retractions and corrections on their papers.** It searches no source for new papers. Each run sends the DOIs of the papers already matched to the person to Crossref, and the arXiv and bioRxiv identifiers to arXiv and bioRxiv, for retraction, correction, and newer-version notices.

A watch on a person uses no terms, because narrowing a person's work by topic would silently hide the rest of it. A watch on words has **Terms to watch for**, entered as chips like a search, and **Match** under them: **Any Term**, the default, keeps a paper with any one of its terms, and **All Terms** only a paper with every one. Each term is one term, and a term of several words is searched as that phrase where the source can; [Sources](/resmon/guide/sources/) says how each source is asked. **What It Asks** says "any of" or "all of" the terms. A watch made with only a typed query, through the MCP tools or the command line, opens with that query's words and quoted phrases as its terms (common words such as "the" and "of" are left out), and with **All Terms**, which is how its runs ask.

**Sources.** The same catalog as Ask the Sources. A person's papers can only be asked of sources whose rows say they can be asked about an author. Of the 25 sources, 19 can. bioRxiv and medRxiv cannot, and resmon has not established whether CORE, GovInfo, NASA ADS, and Springer Nature can, so it does not ask them. If every chosen source is one that cannot, the editor warns that the watch will find nothing until you add one that can.

**When it runs.** Choose **Every Day**, **Weekdays**, **Once a Week**, **Once a Month**, or **Every Few Hours**. Weekly takes a day of the week, monthly takes a day of the month from 1 to 28 (later days are missing from some months, and those months would not run), and every few hours takes 1, 2, 3, 4, 6, 8, or 12 hours at a chosen minute. The others take a time of day. The default is every day at 8:00. Times are your computer's time. The editor stores each choice as a cron expression whose words are exact, and a schedule it cannot state in words is kept as it is and shown as **As It Is**.

**Which papers each run asks for.** Four choices:

| Choice | What a run asks for |
|---|---|
| **Papers Published Since the Previous Run** | Papers published since 3 days before the previous run started, because a source often lists a paper after the date it carries. A watch with no earlier run asks for the last 7 days. A paper already in your collection is not counted as new again. |
| **In the Last N Days** | Papers published in the N days before each run starts, from 1 to 3,650. |
| **Between Two Dates** | The same dates on every run. Once the end date has passed, each run asks again for papers an earlier run already asked for. |
| **No Date Limit** | Each source's own order. A source that ranks by relevance, not by date, can return the same top papers on repeated runs, and the editor says which sources use that order. |

The dates a run asks for are computed when it fires and recorded with the run. **Since the previous run** uses the latest completed run in which a source answered. A canceled, failed, running, or interrupted run does not advance that window, even if it kept papers. A watch's page shows the dates the next run would ask for. bioRxiv and medRxiv need a start date, and a watch on either is not saved without one.

**Up to N papers per source, each run.** From 1 to 1,000.

**Its papers land in** (when there is more than one collection). The collection its runs put their papers in, the one the window shows for a new watch. A run puts every paper it finds there, including one resmon already holds in another collection. Changing it changes where later runs put their papers; papers earlier runs found stay where they are.

**What it is really looking for** (optional). A sentence or two in your own words. The coverage audit compares what the watch finds with this sentence. Without one, the audit can only compare the results with the terms that found them, which is circular, and it says so.

**When a Run Finishes.** **Notify me**, **Email the report**, and **Attach its results to the email**. The email goes through the account under **Settings › Email**, and notifications follow **Settings › Notifications**. **Start watching when saved** is on by default for a new watch.

**PDFs.** **Get its new papers' open-access PDFs**, off unless you turn it on. After each run, resmon asks for the PDF of each new paper a source states an open license for, by the rules of [Get the PDF](/resmon/guide/library/#get-the-pdf), at most 20 a run and 100 in any 24 hours. The run's page lists what it got into the Library, what it skipped, and why. An arXiv PDF a watch gets comes from export.arxiv.org, the site arXiv asks tools that fetch on their own to use, at arXiv's pace of one request every three seconds; Get the PDF on a paper's page asks arxiv.org, as arXiv asks that people be sent there. A watch on retractions finds no new papers, so it has no PDFs to get.

**Summarize each paper.** Off, or on with the connection from **Settings › AI** or one just for this watch. See [AI Settings](/resmon/guide/ai-summarization/).

The **What It Will Do** panel restates the form as it stands, in sentences: when it runs, what it asks of which sources, what the catalog says about those sources for this question, and what happens when a run finishes. It does not guess how many papers a run will find. **Save Watch** (**Save Changes** on an existing watch; ⌘Enter) saves it. **Delete This Watch** removes its schedule, destinations, and record of missed fires; its runs stay in the run log and its papers stay in your collection.

The watch editor’s source picker has **Select All** and **Deselect All**. Select All includes sources hidden by the name filter, leaves out those without a required key, and, for a person watch, includes only sources that can be asked about an author. The plan updates as the selection changes.

The longer source notes in the plan start under **Source Limits and Keys**, collapsed. Open it to read them; this window remembers the choice, including Back and reload.

## A Watch's Page

The header has **Run Now**, **Pause** or **Resume**, and **Change**. **Run Now** runs the watch once whatever the schedule says, even when it is paused. If resmon is at its limit of runs at once, the run joins a queue and starts on its own when one finishes. Pausing keeps the watch and stops its schedule. Two switches, **Notify me when it finishes** and **Email the report**, change at a click. Under them, **Dates** and **Summaries** state what each run asks for and how it is summarized, each with a **Change** link.

When there is more than one collection, the header names the one its papers land in. Beside the header, a map shows where the watch's papers sit in the collection the window shows, with the papers from its latest run ringed. Below is its **Runs** strip: a bar for each of the last 30 runs, as tall as the papers new in that run, with a fault mark under any run in which a source did not answer, and a hollow square for a run that did not record how many papers were new. A first run can bring in many more papers than later ones; a run more than twice the next largest is drawn cut off, and the line under the strip says so. Pointing at a bar, or reaching it from the keyboard, says when the run started, how many papers were new and how many it found in all, and which sources did not answer; choosing it opens the run. The strip is one stop for **Tab**, and the arrow keys move between runs.

Three tabs hold the rest:

- **What It Finds** is the coverage audit.
- **Where Reports Go** holds its destinations and the record of every delivery.
- **Schedule** shows the schedule in words with its cron expression, the next 10 fires, and **Fires That Did Not Run**, each with its reason: it did not run because the run before it was still going; it came due while resmon was not running; or it ran late, when you asked for a run.

## Is This Finding What I Meant?

The **What It Finds** tab compares a watch's results with the sentence you wrote for it, using your embedding model. It lists two sets of papers, 25 at a time, with their distance from the intent (smaller is closer):

- **Furthest from the Intent.** The papers at the far end of this watch's own results. It is a prompt to look, not a verdict: the model has not read them.
- **Already Collected, Never Returned by This Watch.** Papers close to the intent that something else found. A keyword gap is the usual reason.

The audit draws its cutoff from the watch's own results, because a fixed distance means different things on different models and subjects, and with fewer than 12 embedded results it draws none and says so. It states what it cannot see: it can only compare against papers resmon already holds, so "missed" means missed by this watch and found by something else, never missed by resmon. It needs an embedding model; without one it says why. See [AI Settings](/resmon/guide/ai-summarization/).

## Where Reports Go

Each run's report stays in resmon. A **destination** sends it on. On a watch's **Where Reports Go** tab, **Add a destination** and choose a kind:

| Kind | What it does |
|---|---|
| **Email** | Sends the report to an address, or to the address in **Settings › Email** if you leave it blank, while the watch's **Email the report** switch is on. |
| **Folder** | Writes each report's files into a folder on your computer. A folder your cloud drive syncs carries them on, with nothing of resmon's on the wire. |
| **Webhook** | Sends a signed JSON envelope to an `https` address you own, with a link to the report's files that is good for 24 hours, or the files themselves inside the envelope if you tick that. It needs a shared secret, which goes to your system keychain, before resmon will send to it. |
| **Feed** | Writes an Atom file into a folder, keeping the newest 50 reports, which a feed reader or a static site can read. |

Each destination is either **Sent when a run finishes** or **Waits for you to release it**. A report waiting for review stays waiting through restarts until you press **Deliver**, or **Skip** to decide not to send it. After a failure, **Retry** starts the attempts again. Each destination can be turned on or off, and removed.

Below the destinations is the record of deliveries: for each, the run, the kind, where it went, and its state. The record says what resmon did: it handed the report to your mail server, wrote it to the folder, or got a success reply from your receiver. Whether the message reached an inbox, whether the folder finished syncing, and what the receiver did afterward are things it cannot see.

## Calendar

**Watches › Calendar** is the month ahead: five weeks from this week's Sunday, with a mark on each day for every fire a schedule promises, named with its time and watch, in your computer's time. Pointing at a mark lights that watch's marks and names it, its day, and its time, and choosing one opens the watch. A day with more than five fires counts the rest, and pointing at the count lists them. The page shows only fires still to come.

The opening sentence says "will run" only when every watching watch will. A watch that nothing will run draws faint marks and says "nothing will run it", or "not confirmed to run" where resmon cannot tell.

## People

**Watches › People** lists the researchers resmon looks for on the papers it collects, with the chip each carries: **ORCID**, **name + affiliation**, or **name only**.

**New Person** asks for:

- **Name, as published.** The name resmon asks the sources for. A source's author search takes one string.
- **ORCID** and **Where that ORCID came from.** The ORCID is the only thing that makes a match evidence of identity. If you leave its source blank, the person's page says "source not recorded".
- **Affiliations**, **Other spellings of the name**, **Fields they work in**, and **Notes.** Other spellings are not asked for; they are used to check the papers that come back.

While you type, the form shows the sentence the saved person will carry: with no ORCID, every match is by name and affiliation or by name alone, and two researchers with the same name at the same institution would both match.

**Starter Set** lists people shipped with resmon as examples, not endorsements. Each ORCID was checked against the public ORCID record on the day it was added, and its citation says so. **Add** copies one into your people, and the copy is yours to change or remove. **Import a File** reads a person exported from here or from another copy of resmon.

### What a Match Means

resmon matches a paper to a person with a stated basis, shown as a chip on the paper in Search, on the person's page, and in a run's report:

| Basis | Meaning |
|---|---|
| **ORCID match** | The source returned this person's ORCID on this paper. This is evidence of identity. |
| **name + affiliation** | A name matched, and an affiliation on the record matched one of the person's. That is not identity: another researcher with this name at this institution would match too. |
| **name only** | This name is on the paper. That is the entire claim; resmon cannot tell you it is this person. |

The string the source actually returned for the author is shown beside the match, so you can judge it yourself. Matching keeps initials and surname particles. An initial can match a given name ("J. Smith" and "John Smith"), and the evidence records that as the weaker guess it is. Affiliations are compared as whole words, so MIT does not match SUMMIT. A conflicting ORCID is shown as evidence against the match and stops an affiliation from raising it. A name of one word stays visibly ambiguous.

A source's author search is a candidate generator, never a verdict. resmon re-checks every record it gets back against the person, and only what survives becomes a match.

### A Person's Page

The page shows the person's identifiers and affiliations, **Papers Matched** with a count by basis, and a map marking where they sit in the collection. **Retractions and Updates** lists the notices recorded against those papers, with a coverage sentence first: how many of the matched papers have been checked. A notice on a paper matched by name alone is a notice on a paper with this name on it, and the row says so rather than putting it on the person. **Check from the Watchdog** goes to the check described in [Health](/resmon/guide/health/).

From the page you can **Watch for Their Papers**, **Change** them, **Export** them as JSON, and **Remove** them. Removing a person removes their matches; the papers stay. A watch pointed at a removed person is named in the sentence that comes back, not silently orphaned.
