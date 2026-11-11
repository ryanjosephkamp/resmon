---
title: "What resmon Is"
summary: "What resmon watches, what it promises about what it knows, how its screens fit together, and what stays on your computer."
order: 1
---
resmon is a desktop app that watches scholarly literature for you and tells you when its own watching has broken. You give it words to follow, or a person. It asks 25 open scholarly sources on a schedule or on demand, keeps every paper it finds in a database on your computer, and records what each source did on every run. A quiet week and a broken search never look the same.

There is no account, no resmon server, and no telemetry. The app is an Electron window over a Python engine that runs on your computer, and the window is a React interface called Atlas.

## What It Does

- **Asks the sources.** A **Deep Dive** asks one source in depth. A **Deep Sweep** asks several at once. Before you ask, resmon lists each source's limits: how it combines your terms, how finely it can date a paper, how fast resmon may ask, and whether it needs a key. See [Search](/resmon/guide/search/).
- **Finds one paper.** **Look Up a Paper** looks up a DOI, arXiv id, PMID, or title and shows each source's answer and how its copy matched. **Get the PDF** keeps an openly licensed copy in the Library where the download rules permit it.
- **Watches.** A watch is a search resmon runs on a schedule, keeping every paper it finds. It can follow words, a person's new papers, or retractions and corrections on a person's papers. See [Watches and People](/resmon/guide/watches/).
- **Shows what is new.** **Today** draws your whole collection as a map and rings the papers collected since you last marked them read. See [Today](/resmon/guide/today/).
- **Shows what broke.** **Health** has the **Source Wall** (what every source did on each recent run), the **Watchdog** (what resmon can say is wrong with its watching), analytics, and a check for retractions and newer versions of papers you already hold. See [Health](/resmon/guide/health/).
- **Keeps your reading.** **Library** is one gallery: a reading queue, copies of PDF, TXT, MD, and TeX files in a folder you choose, and **Evidence** projects where you pin exact passages and ask questions of excerpts you pick. See [The Library](/resmon/guide/library/) and [Evidence](/resmon/guide/projects/).
- **Answers questions about itself.** **Ask** is an assistant that reads your watches, runs, papers, and sources through the same tools an outside program can use. See [Ask and the MCP Server](/resmon/guide/assistant/).
- **Reaches outside the window.** A `resmon` command line, an MCP server, and a local HTTP API all talk to the running engine. See [Install and Launch](/resmon/guide/install/), [Ask and the MCP Server](/resmon/guide/assistant/), and the [HTTP API Reference](/resmon/guide/api-reference/).

## What resmon Will Not Claim

A field extracted from a document, a field matched against your collection, and a field guessed by a model are three different kinds of fact, and resmon labels which is which. Where it cannot know something, it says so instead of showing a plausible number. A few places this shows:

- **A source that returns nothing says why, or says "not recorded".** The Source Wall draws eight states: answered, answered with zero papers, answered in part, could not be asked, rate-limited, failed, outcome not recorded, and not asked on this run. A failure and an empty answer never share a mark. See [Health](/resmon/guide/health/) and [What a Source's Answer Means](/resmon/guide/source-answers/).
- **A match to a person says how it was made.** Each is an ORCID match, a name and affiliation match, or a name-only match. Only the first is evidence of identity. See [Watches and People](/resmon/guide/watches/).
- **The map says how it placed papers.** Positions come from your embedding model only once it has embedded 90% of the collection. Until then they come from the wording papers share, and the map says so. See [Today](/resmon/guide/today/).
- **A coverage audit says what it cannot see.** "Missed" means this watch never returned a paper that something else found, never that resmon missed it.
- **A retraction check says how much it checked.** An empty list over papers nobody asked about is not a clean result, so the count of papers checked is always beside the findings.
- **A cited answer says what a citation proves.** Every quote is checked to be the selected text at its exact range. Whether the quote supports the sentence it is attached to is not checked.

## The Screens

The top bar holds the collection the window shows, seven sections, a **New Search** menu, **Search Commands**, and Settings. resmon can keep several collections in one database, one per field, say (the first is named **Main Collection**, and the collection menu ends with **New Collection** and **Manage Collections**, which open **Settings › Collections**); each has its own Search, Today, map, and Analytics. See [Search](/resmon/guide/search/). **Settings › Top Bar** puts the sections in the order you choose and hides any or all of them; the collection and Settings always stay in the bar.

| Section | Tabs | What it is for |
|---|---|---|
| **Today** | | The collection as a map, and the papers that arrived since you last marked all read |
| **Watches** | Searches · Calendar · People | Your watches, when each is due, and the people resmon looks for on papers |
| **Search** | Collection · Ask the Sources · Look Up a Paper · Saved · Shared Wording | Searching what you hold, asking the sources for more or for one paper, saved searches, and abstracts that share wording |
| **Runs** | | Every run: those going now, those waiting for a free slot, and the history |
| **Library** | To Read · Read · Your Files · Projects (gallery filters) | Saved papers, kept files, and the projects built from them |
| **Ask** | | The assistant and every conversation kept with it |
| **Health** | Source Wall · Watchdog · Analytics · This Engine | What the sources did, what is wrong, what the collection holds, and which engine this window uses |
| **Settings** | Appearance · Top Bar · Links · In the Background · Email · Notifications · AI · Sources · Collections · Backup · Library · Tutorials · About resmon · Danger Zone | Everything you can change |

Between the sections and **New Search** is the run monitor: the accent's ring and core while nothing runs, an orbit for each run going now (its arc is the share of the run's sources that have finished, and it stops and turns gray when the run has said nothing for 15 seconds), one spreading ring when a run finishes, and a struck red mark when a run has failed since you last opened it. Pointing at it, or reaching it from the keyboard, lists each running run with how many of its sources have finished. Click it, or press Enter on it, for its panel: the runs going now, with their sources, time, and **Stop**; those waiting; today's, with **Why** beside a failure; and **Open Runs**. Point at a source mark for its outcome above the panel, kept inside the window. Escape or a click elsewhere closes it. **Settings › Top Bar** can hide it.

The **Search Commands** button, or ⌘K (Ctrl+K on Windows and Linux), opens a palette that goes to any screen, starts a search or a conversation, and changes the theme or accent color. A run, a paper, a watch, and a person each have a page of their own, reached from the lists that name them.

View › Zoom In and Zoom Out resize the page while leaving space for the native window buttons. The sections can scroll across the bar when space is short; at high zoom, the command palette keeps every screen and command within reach.

### Windows

**File › New Window** (⌘N, or Ctrl+N on Windows and Linux) opens another window at the start page: **Today**, unless you choose another in **Settings › Top Bar**. To open a screen in a window of its own, ⌘-click (Ctrl-click) a section in the top bar or a link to it, right-click the link and choose **Open in New Window**, or press ⌘Enter on the screen in the command palette, which also offers **Open This Page in a New Window** (and, on macOS, **Open This Page in a New Tab**). Each window keeps its own page and its own back and forward, and is named by its page. All of them use the same engine, so what one window changes, another shows the next time it reads that page; a change to the theme, the accent color, or the top bar shows in every window at once. A notification about a run you started opens the run in the window you started it from; one about a watch's run opens it in the window in front.

On macOS the windows can be tabs. **File › New Tab** (⌘T) opens one, and the **Window** menu holds **Merge All Windows**, **Move Tab to New Window**, **Show Tab Bar** (**Hide Tab Bar** once tabs show), **Show All Tabs**, and **Show Next Tab** and **Show Previous Tab** (⌃⇥ and ⌃⇧⇥). While the windows are in tabs, the top bar sits below the tab bar.

### Web Links

A web link you click, such as a paper’s page at its source, opens in **resmon’s browser**: an independent window of its own. **Settings › Links** can send links to your default browser instead, and on macOS can open each one as a tab of resmon’s browser rather than a new window. Whichever you choose, a right-click on a link offers the other ways.

The browser’s bar has **Back**, **Forward**, **Reload** (**Stop** while a page loads), and an address field that always shows where you are. Type an address there, with or without `https://`, or a DOI such as `10.1038/nphys1170`, which opens at doi.org; anything else is searched for with the search chosen in **Settings › Links**: DuckDuckGo unless you pick another, such as Google Scholar or Semantic Scholar. ⌘L (Ctrl+L) puts the keyboard in the address field, Escape puts back the address an edit replaced, and ⌘R (Ctrl+R) reloads. The History menu, ⌘[ and ⌘], ⌘← and ⌘→, and a two-finger swipe also move through the window’s own pages. **Open in Your Browser** opens the same address in your default browser.

On macOS, ⌘T in resmon’s browser opens an empty tab there, and the **Window** menu merges, moves, and shows its tabs, apart from resmon’s own windows. Each tab is named by its page’s title.

### Right-Click

A right-click offers what fits where you clicked. On a link to a resmon screen: **Open in New Window**, and on macOS **Open in New Tab**; on a link to a paper's page, **Save to Read** too. On a web link: **Open Link in New Window** (resmon’s own browser), on macOS **Open Link in New Tab** (a tab of it), **Open Link in Your Browser**, **Copy Link**, and, for a doi.org link, **Copy DOI**. On selected text: **Copy**, and on macOS **Look Up**. In a text field: **Undo**, **Redo**, **Cut**, **Copy**, **Paste**, and **Select All**, with spelling suggestions first for a misspelled word. In a web link’s window, the page also offers **Back**, **Forward**, **Reload**, **Copy Page Link**, and **Open Page in Your Browser**.

### Keyboard

The shortcuts use ⌘ on macOS and Ctrl elsewhere. All of them work while you type in a field except `?`.

| Keys | What it does |
|---|---|
| ⌘1 to ⌘7 | Go to the sections in the top bar's order, from the left (Today, Watches, Search, Runs, Library, Ask, and Health, unless you change it); a hidden section keeps a key, after the shown ones |
| ⌘, | Settings |
| ⌘K | Search Commands |
| ⌘D and ⇧⌘D | New Deep Dive and new Deep Sweep |
| ⌘N | New window (⌘T for a new tab, on macOS) |
| ⇧⌘N | New Conversation in Ask |
| ⌘/ | Message the Assistant |
| ⌘[ and ⌘] | Back and forward (also ⌘← and ⌘→ on macOS, Alt+← and Alt+→ elsewhere) |
| ⌘Enter | Save or send what you wrote, in a field that offers it |
| ? | The full list, outside a text field |

On a trackpad, a two-finger swipe goes back and forward. Back and forward return the Runs tab, the Library, the results of a search in Search › Collection (in the order you chose), and a run's page (on the tab you were on, with **Papers** where you left it) to where you left them; a page you open anew, and a new search, start at their top.

## What Stays on Your Computer

Everything resmon collects and makes is stored on your computer: the papers, the runs with their reports and logs, your watches and saved searches, the reading queue, your conversations with the assistant, and the files you add to the Library. Keys and passwords (source keys, AI provider keys, the email password, and webhook secrets) go to your operating system's keychain, never to the database. A backup carries none of them.

Data leaves your computer only for a feature you use:

- **Searches** send their terms, dates, and limits to each source they ask, and to no other. A source's key goes only to that source. A watch on a person sends the person's name, and any identifier you gave, to its sources.
- **PDFs** are fetched only when you press **Get the PDF** or turn on a watch's PDFs switch. The download goes to the copy's host, with redirects checked, and an arXiv copy's license is read from arXiv first. See [the download rules](/resmon/guide/library/#get-the-pdf).
- **Summaries and search by meaning** send each paper's title and abstract to the provider or command you set up in **Settings › AI**, and nowhere before you do.
- **Ask** sends your messages, and what its tools read from your collection, to the connection the conversation uses.
- **Retraction checks** send DOIs, and arXiv and bioRxiv identifiers, to Crossref, arXiv, and bioRxiv, only when you start a check or a watch set to check runs.
- **Reports** leave only where you send them: a watch's email and webhook destinations, or a folder or feed on your own disk.
- **Updates.** An installed copy on Windows or Linux asks GitHub for a newer version about 15 seconds after it opens, and every 6 hours after that. macOS does not check.

Nothing is billed through resmon. For AI, you use a signed-in Claude Code or Codex command under your own plan, or your own provider key.
