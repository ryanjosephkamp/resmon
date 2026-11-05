---
title: "What resmon is"
summary: "What resmon watches, what it promises about what it knows, how its screens fit together, and what stays on your computer."
order: 1
---
resmon is a desktop app that watches scholarly literature for you and tells you when its own watching has broken. You give it words to follow, or a person. It asks 25 open scholarly sources on a schedule or on demand, keeps every paper it finds in a database on your computer, and records what each source did on every run. A quiet week and a broken search never look the same.

There is no account, no resmon server, and no telemetry. The app is an Electron window over a Python engine that runs on your computer, and the window is a React interface called Atlas.

## What it does

- **Asks the sources.** A **Deep Dive** asks one source in depth. A **Deep Sweep** asks several at once. Before you ask, resmon lists each source's limits: how it combines your terms, how finely it can date a paper, how fast resmon may ask, and whether it needs a key. See [Search](/resmon/guide/search/).
- **Watches.** A watch is a search resmon runs on a schedule, keeping every paper it finds. It can follow words, a person's new papers, or retractions and corrections on a person's papers. See [Watches and people](/resmon/guide/watches/).
- **Shows what is new.** **Today** draws your whole collection as a map and rings the papers collected since you last marked them read. See [Today](/resmon/guide/today/).
- **Shows what broke.** **Health** has the **Source wall** (what every source did on each recent run), the **Watchdog** (what resmon can say is wrong with its watching), analytics, and a check for retractions and newer versions of papers you already hold. See [Health](/resmon/guide/health/).
- **Keeps your reading.** **Library** is one gallery: a reading queue, copies of PDF, TXT, MD, and TeX files in a folder you choose, and **Evidence** projects where you pin exact passages and ask questions of excerpts you pick. See [The Library](/resmon/guide/library/) and [Evidence](/resmon/guide/projects/).
- **Answers questions about itself.** **Ask** is an assistant that reads your watches, runs, papers, and sources through the same tools an outside program can use. See [Ask and the MCP server](/resmon/guide/assistant/).
- **Reaches outside the window.** A `resmon` command line, an MCP server, and a local HTTP API all talk to the running engine. See [Install and launch](/resmon/guide/install/), [Ask and the MCP server](/resmon/guide/assistant/), and the [HTTP API reference](/resmon/guide/api-reference/).

## What resmon will not claim

A field extracted from a document, a field matched against your collection, and a field guessed by a model are three different kinds of fact, and resmon labels which is which. Where it cannot know something, it says so instead of showing a plausible number. A few places this shows:

- **A source that returns nothing says why, or says "not recorded".** The Source wall draws seven states: answered, answered with zero papers, answered in part, could not be asked, failed, outcome not recorded, and not asked on this run. A failure and an empty answer never share a mark. See [Health](/resmon/guide/health/).
- **A match to a person says how it was made.** Each is an ORCID match, a name and affiliation match, or a name-only match. Only the first is evidence of identity. See [Watches and people](/resmon/guide/watches/).
- **The map says how it placed papers.** Positions come from your embedding model only once it has embedded 90% of the collection. Until then they come from the wording papers share, and the map says so. See [Today](/resmon/guide/today/).
- **A coverage audit says what it cannot see.** "Missed" means this watch never returned a paper that something else found, never that resmon missed it.
- **A retraction check says how much it checked.** An empty list over papers nobody asked about is not a clean result, so the count of papers checked is always beside the findings.
- **A cited answer says what a citation proves.** Every quote is checked to be the selected text at its exact range. Whether the quote supports the sentence it is attached to is not checked.

## The screens

The top bar holds the collection the window shows, seven sections, a **New search** menu, **Search commands**, and Settings. resmon can keep several collections in one database, one per field, say; each has its own Search, Today, map, and Analytics. See [Search](/resmon/guide/search/).

| Section | Tabs | What it is for |
|---|---|---|
| **Today** | | The collection as a map, and the papers that arrived since you last marked all read |
| **Watches** | Searches · Calendar · People | Your watches, when each is due, and the people resmon looks for on papers |
| **Search** | Your collection · Ask the sources · Saved · Shared wording | Searching what you hold, asking the sources for more, saved searches, and abstracts that share wording |
| **Runs** | | Every run: those going now, those waiting for a free slot, and the history |
| **Library** | To read · Read · Your files · Projects | Saved papers, kept files, and the projects built from them |
| **Ask** | | The assistant and every conversation kept with it |
| **Health** | Source wall · Watchdog · Analytics · This engine | What the sources did, what is wrong, what the collection holds, and which engine this window uses |
| **Settings** | Appearance · In the background · Email · Notifications · AI · Sources · Backup · Library · Tutorials · About resmon · Danger zone | Everything you can change |

Between the sections and **New search** is the run monitor: the accent's ring and core while nothing runs, an orbit for each run going now (its arc is the share of the run's sources that have finished, and it stops and turns gray when the run has said nothing for 15 seconds), one spreading ring when a run finishes, and a struck red mark when a run has failed since you last opened it. Click it, or press Enter on it, for its panel: the runs going now, with their sources, time, and **Stop**; those waiting; today's, with **Why** beside a failure; and **Open Runs**. Escape or a click elsewhere closes it. **Settings › Appearance** can hide it.

The **Search commands** button, or ⌘K (Ctrl+K on Windows and Linux), opens a palette that goes to any screen, starts a search or a conversation, and changes the theme or accent color. A run, a paper, a watch, and a person each have a page of their own, reached from the lists that name them.

### Windows

**File › New Window** (⌘N, or Ctrl+N on Windows and Linux) opens another window at **Today**. To open a screen in a window of its own, ⌘-click (Ctrl-click) a section in the top bar or a link to it, right-click the link and choose **Open in New Window**, or press ⌘Enter on the screen in the command palette, which also offers **Open this page in a new window**. Each window keeps its own page and its own back and forward, and is named by its page. All of them use the same engine, so what one window changes, another shows the next time it reads that page. A notification about a run you started opens the run in the window you started it from; one about a watch's run opens it in the window in front.

On macOS the windows can be tabs. **File › New Tab** (⌘T) opens one, and the **Window** menu holds **Merge All Windows**, **Move Tab to New Window**, **Show Tab Bar**, and **Show Next Tab** and **Show Previous Tab** (⌃⇥ and ⌃⇧⇥). While the windows are in tabs, the top bar sits below the tab bar.

### Keyboard

The shortcuts use ⌘ on macOS and Ctrl elsewhere. All of them work while you type in a field except `?`.

| Keys | What it does |
|---|---|
| ⌘1 to ⌘6 | Go to Today, Watches, Search, Library, Ask, or Health |
| ⌘7 | Go to Runs |
| ⌘, | Settings |
| ⌘K | Search commands |
| ⌘D and ⇧⌘D | New Deep Dive and new Deep Sweep |
| ⌘N | New window (⌘T for a new tab, on macOS) |
| ⇧⌘N | New conversation in Ask |
| ⌘/ | Message the assistant |
| ⌘[ and ⌘] | Back and forward (also ⌘← and ⌘→ on macOS, Alt+← and Alt+→ elsewhere) |
| ⌘Enter | Save or send what you wrote, in a field that offers it |
| ? | The full list, outside a text field |

On a trackpad, a two-finger swipe goes back and forward.

## What stays on your computer

Everything resmon collects and makes is stored on your computer: the papers, the runs with their reports and logs, your watches and saved searches, the reading queue, your conversations with the assistant, and the files you add to the Library. Keys and passwords (source keys, AI provider keys, the email password, and webhook secrets) go to your operating system's keychain, never to the database. A backup carries none of them.

Data leaves your computer only for a feature you use:

- **Searches** send their terms, dates, and limits to each source they ask, and to no other. A source's key goes only to that source. A watch on a person sends the person's name, and any identifier you gave, to its sources.
- **Summaries and search by meaning** send each paper's title and abstract to the provider or command you set up in **Settings › AI**, and nowhere before you do.
- **Ask** sends your messages, and what its tools read from your collection, to the connection the conversation uses.
- **Retraction checks** send DOIs, and arXiv and bioRxiv identifiers, to Crossref, arXiv, and bioRxiv, only when you start a check or a watch set to check runs.
- **Reports** leave only where you send them: a watch's email and webhook destinations, or a folder or feed on your own disk.
- **Updates.** An installed copy on Windows or Linux asks GitHub for a newer version about 15 seconds after it opens, and every 6 hours after that. macOS does not check.

Nothing is billed through resmon. For AI, you use a signed-in Claude Code or Codex command under your own plan, or your own provider key.
