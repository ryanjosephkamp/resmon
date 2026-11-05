---
title: "Configuration"
summary: "Saved searches and watch copies, moving them between computers, and what each Settings group holds."
order: 15
---
resmon keeps two kinds of reusable configuration, saved searches and watches, and a set of settings. Saved searches and the copies of watches are listed in **Search › Saved**. Everything else is in **Settings**.

## Saved searches and watch copies

Each saved configuration is a named row in resmon's database, and names are not unique: two can share one. There are three kinds:

| Kind | Made by | What it holds |
|---|---|---|
| Deep Dive | **Save this search** on a Deep Dive, or **Save as a search** on a run's page | One source (`repository`), `keywords`, `date_from`, `date_to`, `max_results`, and `ai_enabled` |
| Deep Sweep | **Save this search** on a Deep Sweep, or **Save as a search** | The same, with `repositories`, a list of sources |
| Watch | Making or changing a watch | A copy of the watch: `linked_routine_id`, `schedule_cron`, `intent`, its `parameters`, and whether it is active, emails, summarizes, and notifies |

A saved search keeps its dates exactly as you set them. **Watch this search** and **Make it a watch** leave the dates out, because dates fixed today would be asked again on every run of the watch; the watch editor chooses a window that moves.

The copy of a watch follows the watch. The engine rewrites it on every change, so you change the watch in its own editor and never the copy. Deleting a watch removes its copy. Erasing configurations in the Danger zone removes every saved search and every watch linked to a saved configuration.

### Moving them to another computer

On **Search › Saved**, tick rows and press **Export to a file**. The save dialog asks where the ZIP goes, named `resmon-saved-` and a time stamp. It holds one JSON file for each saved search or watch. On the other computer, press **Import a file** and choose the ZIP, or the JSON files from inside one. Several can be chosen at once.

Imports are always additive. Every entry becomes a new row with a new id, and resmon never merges an import with what you have, so a name already in use lands as a second row under that name. A watch imported from a file arrives **paused**, whatever the file says. An export holds no credentials, and a watch's copy does not carry its destinations, so add a watch's destinations again on the new computer and enter its webhook secrets there.

People can be moved the same way: **Export** on a person's page, **Import a file** on **Watches › People**.

## Settings

**Settings** is one group at a time, chosen from the list on the left. Each group has its own address, so a link from a watch, a notification, or the command palette can open the one it means.

| Group | What it holds |
|---|---|
| **Appearance** | Theme and accent color |
| **Top bar** | The sections' order and which are shown, the start page, where the resmon name goes, and the run monitor |
| **In the background** | The background service, and how many runs go at once |
| **Email** | The mail account watches send reports through |
| **Notifications** | When resmon posts a desktop notification |
| **AI** | Summaries, Ask, and embeddings |
| **Sources** | Every source's limits, the keys some of them want, and the credits their licenses require |
| **Collections** | Making, renaming, showing, and deleting collections; see [Search](/resmon/guide/search/) |
| **Backup** | Where backups go, backing up, and restoring |
| **Tutorials** | Short recordings of Atlas in use |
| **About resmon** | Who made it, which copy this is, the license, what it keeps and sends, and where to report a problem |
| **Danger zone** | Erasures, each behind its own confirmation |

### Appearance

**Theme** is **Follow the system**, **Light**, or **Dark**. **Accent color** is used for the rings around new papers, the current tab, links, and the main button on each screen. Any color works. Where one would be hard to read, resmon draws it lighter or deeper in that theme and shows you the contrast it measured for links, rings, and button text. Both are kept in resmon's database, so they are the same on every launch and come back with a backup. The command palette changes both too.

### Top bar

**Sections** lists the seven sections in the bar's order, from the left. Drag one by its handle, or move it with its arrows. ⌘1 to ⌘7 follow the bar, then go on to the hidden sections. A section's switch hides it, which only takes it out of the bar: its shortcut, the command palette, and links to it still open it, and so does its address. You can hide every section; Settings stays at the bar's right end, and ⌘, opens it.

**Start page** is the page a launch and a new window open on: any section, or a tab within one, such as **Search › Saved**. **The resmon name**, "research monitor" at the bar's left end, goes to the start page unless you choose another page for it. **Reset the top bar** shows every section again, in the first order, and opens on **Today**. All of it is kept in resmon's database, so every window and every launch has the same bar, and it comes back with a backup.

**Show the run monitor in the top bar** shows or hides the run monitor. Hidden, runs still notify you, and the **Runs** tab still lists them. The switch is kept in resmon's database too.

### In the background

The switch **Run resmon in the background** installs or removes the background service. Below it, **Service**, **Running now**, and **This window** state three separate facts: whether the unit is installed, whether the service is running, and which engine this window uses. An installed unit is not a running service, and a running service is not necessarily the one a window uses.

**How many runs at once** has two numbers. At most **1 to 8** runs go at once (3 unless you change it). While that many are running, a search you start, a Restart, a Run again, and a watch's run each wait for a turn, under **Waiting** on the **Runs** tab. At most **1 to 64** runs wait (16 unless you change it), and a waiting run starts when one finishes. A search asked while that many already wait is refused with a sentence saying so, and a watch's run that comes due then is skipped and runs at its next scheduled time. The queue is held in the engine's memory, so what is waiting when that engine stops does not run.

### Sources

**Settings › Sources** lists all 25, with their limits as each states them. Choose a source's name for its details: its description, resmon's pace, the source's published policy, how it dates papers, how it combines terms, its endpoint, and its website. A source that takes a key has a field to **Store** one, and a stored key is shown as a fixed 12-character mask whatever its length. See [Sources and their terms](/resmon/guide/sources/).

### The Danger zone

Each erasure opens a warning that says what it removes and what it does not. The ones that delete what resmon collected also need the word `CONFIRM` typed, and the engine checks it again. Every one of them keeps your Library.

| Action | What it removes |
|---|---|
| **Erase all AI API keys** | Every AI provider key saved in this computer's keychain |
| **Erase all source API keys** | Every source key saved in this computer's keychain |
| **Erase all saved searches** | Every saved search, and every watch whose copy is in Search › Saved |
| **Erase run history** | Every run, and the run counter. The papers they found are kept |
| **Erase the paper corpus** | Every paper resmon has collected, in every collection, with its retraction and version records. Runs, watches, collections, settings, and keys are kept |
| **Erase all run data** | **Erase all saved searches** and **Erase run history** together. Papers, settings, and keys are kept |
| **Erase all app data** | Every key, saved search, run, and paper. Settings other than AI are kept |
| **Reset all settings** | Every setting back to its default, and every key and the email password erased. Runs and saved searches are kept |
| **Factory reset** | Every key, saved search, run, paper, collection, and setting on this computer. The default collection stays, empty, under its first name, and the Library is kept |

**Erase the paper corpus**, **Erase all app data**, and **Factory reset** also delete the copy of the database resmon kept before its last update, because it holds the papers. The other erasures leave it.

Erasures cannot be undone from inside resmon. A backup made before one can bring back what the backup holds, which never includes keys or passwords. See [Backup and restore](/resmon/guide/backup/).
