---
title: "Quick Start"
summary: "A first search, a first watch, and the one switch that makes a watch run on its own."
order: 2
---
This page takes you from a fresh install to a watch that runs by itself. It assumes resmon is installed and open; if not, start with [Install and Launch](/resmon/guide/install/).

## 1. Look at the First-Run Card

On a fresh install, **Today** shows a **Getting Started** card where the map will be. It appears while resmon holds no papers, runs, or watches, and it goes away for good when you press **Skip**.

The card lists three things. None is required, and resmon searches every source that needs no key with no AI at all.

| Step | Where it leads | What the mark means |
|---|---|---|
| Use an AI plan you already pay for | **Settings › AI** | **found** if the `claude` or `codex` command is on your computer |
| Or bring an API key | **Settings › AI** | **done** if a key is stored |
| Add a key for a source that wants one | **Settings › Sources** | **done** if a key is stored for any source |

The card reports **found** and **done**, and never "working". resmon cannot tell whether a command is signed in or a key is accepted until the first paper goes through it.

## 2. Ask the Sources Once

Press ⌘D (Ctrl+D on Windows and Linux), or open **New Search** in the top bar and choose **Deep Dive**. This opens **Search › Ask the Sources**.

1. Type a term and press Enter. Each term becomes a chip and is one term to every source; a term of several words is a phrase. Add more terms the same way. **Match** set to **Any Term** (the default) keeps a paper with any one of your terms, and **All Terms** keeps only a paper with every one. Each term you add offers up to six related terms from your collection.
2. Choose a source. A **Deep Dive** asks one source. The list shows how each source combines terms, how many requests resmon may make, and how finely it dates a paper. A source marked **needs an API key** is recorded as not asked until you store one in **Settings › Sources**.
3. Leave **Published** at **30 Days**, or choose **7 Days**, **A Year**, or **Any Time**, or set the **From** and **To** dates. **Up to 100 papers per source** is the default cap.
4. Press **Ask** followed by the source's name.

For several sources at once, press ⇧⌘D (Ctrl+Shift+D) or choose **Deep Sweep**, tick the sources, and press **Ask** followed by the number of sources.

Under the button, resmon says what it already knows about this particular ask: which chosen source sets the pace, which source cannot date papers as finely as your window, and which sources need a start date. It does not guess how many papers you will get.

The run opens on its own page. While it runs, each source's line changes as its answer arrives. When it ends, the page lists the **recorded outcome of each source** and a sentence summing them up. Below that are tabs: **Papers**, **Map**, **Report**, **Search Record**, **Log**, **Metadata**, and **Progress**. See [Search](/resmon/guide/search/).

Press **Save to Read** on a paper to put it in your **Library**, under **To Read**.

## 3. Make It a Watch

A watch asks the same question on a schedule. From **Ask the Sources**, press **Watch This Search**, or press **New Watch** in **Watches**. The editor asks for:

- **Name.**
- **What it follows.** Words, a person's new papers, or retractions and corrections on a person's papers.
- **Terms to watch for** (with **Match**: **Any Term** or **All Terms**) and **Sources.**
- **What it is really looking for.** Optional; the coverage audit compares the results with this sentence.
- **Its papers land in**, when there is more than one collection; a new watch starts with the collection this window shows.
- **When it runs.** **Every Day**, **Weekdays**, **Once a Week**, **Once a Month**, or **Every Few Hours**, with a time. The editor shows the schedule in words.
- **Which papers each run asks for.** The default is papers published since the previous run.
- **When a Run Finishes.** Whether to notify you, whether to email the report, and whether to attach its results to the email.
- **Summaries.** Whether this watch writes them.
- **PDFs.** Off by default; **Get its new papers' open-access PDFs** follows the [download rules](/resmon/guide/library/#get-the-pdf) and takes at most 20 per run.

The **What It Will Do** panel on the right restates the form as sentences, including warnings: a source with no key, a start date a source needs, a schedule the words cannot state. Press **Save Watch**. It starts watching when saved, unless you turned that off.

## 4. Turn on the Background Service

A resmon window does not run watches on its own. Only the background service does. Without it, once a watch is watching, **Today** says "Your watches will not run: no background service is set up."

Open **Settings › In the Background** and check **Running Now**. A packaged Mac launch starts an installed service when needed. If none is installed, turn on **Run resmon in the background**. resmon asks you to confirm, then writes a launch agent on macOS, a scheduled task on Windows, or a systemd user unit on Linux, and registers it with launchd, Task Scheduler, or systemd. The service starts when you log in and runs your watches with or without a window open.

A watch's page has **Run Now**, which runs it once whatever the schedule says.

## 5. Come Back to Today

**Today** shows the papers resmon collected since you last pressed **Mark All Read**. The first time, it shows the last seven days. The footer says when your next watch is due, and whether anything will run it.

If a source did not answer on a watch's last run, a line under that watch names the source and offers **Why**. A watch with nothing new is listed under **Nothing new from**, so a quiet watch and a broken one can be told apart.

For what each screen does in detail, see [Today](/resmon/guide/today/), [Search](/resmon/guide/search/), [Watches and People](/resmon/guide/watches/), and [Health](/resmon/guide/health/).
