---
title: "The Library"
summary: "Papers saved to read, copies of PDF, TXT, MD, and TeX files kept in a folder you choose, and the projects built from them, in one gallery."
order: 8
---
**Library** is one page: a gallery of covers, with a filter for **To Read**, **Read**, **Your Files**, and **Projects**, a find field, and an order. The reading queue is **To Read** and **Read**. **Your Files** keeps copies of files in a folder of yours. **Projects** are your [Evidence](/resmon/guide/projects/) projects; **New Project** there names a project, makes it, and opens it in Evidence.

The reading queue works everywhere. **Your Files** and **Projects** are unavailable on Windows; see [Install and Launch](/resmon/guide/install/).

## From a Run to a Project

Every paper a run finds is kept in the collection, including papers you do not save to read. The collection keeps the source's record, such as its title, authors, abstract, identifiers, and the runs that found it. Keeping that record does not download its PDF.

From a paper's actions, **Save to Read** puts a reference to the record in **To Read**. **Saved** removes it from the reading queue in place, with **Undo** to restore its shelf and recorded dates. On a Library card, a paper's page, or its map panel, **Mark Read** moves it to **Read**. These steps keep the collection record and any Library files.

**Get the PDF** asks for a copy under the existing [download rules](#get-the-pdf); a source must state an open license. When the Library holds one, **Read the PDF** opens it. Otherwise **Open at** opens the source, beside the reason resmon has no PDF to get. A refused download keeps the site's reason and offers **Open the Copy in Your Browser**. You can keep a PDF yourself and link it to the paper in **Your Files**; a link is your association, not resmon verifying the file's identity.

**Add to a Project** lists every project, most recently changed first, and **New Project…**. With more than 12 projects, **Find a project** narrows the list. Choose one: if the Library does not hold the PDF, resmon gets it first when the download rules permit, then adds its exact version. If it cannot, the menu says why, and no file is added. While the Library is briefly busy, the menu keeps your choices and checks again. Cancel waits while a new project is being created; if adding its file then fails, **Retry Add** uses the project just created. A file missing from the Library folder is refused. A project keeps that version and the notes and passages you save against it. Opening a paper, reading its PDF, and adding it to a project are separate choices; none marks it read automatically.

The paper's page links to its reading shelf, its linked files, and the projects holding those files. It checks those places again when you return to the page or the window, and keeps checking while the Library folder is not ready. A linked file that is missing or cannot be checked is labeled on its own; the other recorded places stay visible. A Library card and an Evidence file link back to the paper's page.

There is no control to delete individual papers from the collection. **Move To** moves selected papers to another collection, and **Copy To** keeps them in both; neither deletes the stored record. **Settings › Danger Zone › Erase the Paper Corpus** erases all collected papers, not just the ones selected. Removing a paper from **To Read** or **Read**, removing a Library file, or deleting a run does not remove the paper from the collection.

## Covers

Each card is a cover the shape of a page, then the title, one line (authors, source, and year, or a file's kind and size), one label, and its actions.

- **A paper with a PDF** in your Library, linked to it, shows that PDF's first page.
- **A paper without one** shows its piece of your collection's map: the grid cell it is in, its neighbors, its region's name, and the paper itself, crossed, over a title block with its title, authors, source, and year. A paper the map has not placed yet says so on its cover. Until the map has been drawn, the cover is the title block alone. Pointing at the cover names the paper's cell and region in a tip.
- **A text file** shows its first lines, with their numbers.
- **A project** shows its first PDFs fanned over its name, with **Open** (to Evidence) and **Ask About It** (which opens the project's Answers view).

A PDF's first page is drawn on your computer, by the same PDF reader the Library uses, and kept beside resmon's database; later visits show the kept picture. Only the cards near the view are drawn, and more are read as you near the end of the shelf.

Hover darkens a cover's edge and underlines its title. **Select** turns the toolbar into a selection bar: click covers to pick them, Shift-click to pick a run of them, **Select All**, and **Done** or Esc to leave. Picked papers can be marked read, exported, or removed together; picked files can be added to a project or removed together. With a cover focused, Left and Right move between cards, and Up and Down move by a row. In To Read, Read, and Your Files, ⌘A (Ctrl+A elsewhere) selects every card. Back returns focus to the control that opened the page.

The order is **Saved, Newest First**, **Published, Newest First**, **Title**, **Source**, or **Map Order**, which keeps papers that are neighbors on the map together. Your Files order by when they were added, their name, or their size; projects by when they changed or their name. The find field matches a paper's title, authors, or source, a file's name, or a project's name. Files and projects are shared across every collection.

## To Read and Read

Papers get here one at a time with **Save to Read** in a paper's actions. Search results, a run's **Papers**, Today's entries, and Library cards use one compact **Paper Actions** control; a paper's page and its map panel show the actions directly. A right-click on a link to a paper's page offers **Save to Read** too. You can save many at once from **Select** in Search › Collection, a run's **Papers**, and Today's list, from **Save This Run's N New Papers to Read**, and from **Save to Read** on a map's bar, which saves the papers its find or filters leave lit. A save of more than 200 papers asks first, and no save takes more than 20,000. A paper already in the queue stays as it is, and the notice after a save of many says how many were already there and offers **Undo**. The label under a paper names the run that first collected it (a watch's, by its name, or a search) and the day you saved it. The queue is one list, and each collection shows the saved papers it holds: **To Read** and **Read** list those of the collection the window shows, with their counts.

- **Read** opens the paper's PDF in the reader when one is linked to it, and the paper's page otherwise.
- **Mark Read** moves a paper to **Read**; **Mark Unread** moves it back. Marking one paper leaves every other card's controls as they are.
- **Get the PDF**, in the card's **Paper Actions**, appears where a source states an open license for a copy of the paper and the card has no PDF yet. While it downloads, the card's label says so; once it lands, the card is a PDF card with the first page as its cover. See [Get the PDF](#get-the-pdf).
- **Open at** the source's name (for example **Open at arXiv**), in the card's **Paper Actions**, opens the paper's own web address, or its DOI's.
- **Remove from To Read** or **Remove from Read** takes the paper out of the queue, with a notice that can **Undo** it for ten seconds. Undo puts it back with its own state and dates. The paper, its authors, and every run that found it are untouched. Papers are deleted only by the Danger Zone's corpus, app-data, or factory erasures.
- Picked papers export as **BibTeX**, **RIS**, or **CSV**: the file holds exactly the papers picked.

A paper is in the queue by its stored id. Saving a paper again never moves one you have read back to **To Read**, and when a later run finds the same record, its state is kept. Two records that look like the same work stay two entries, on the same rule that makes resmon link near-duplicates and never merge them.

## Your Files

The first time, **Your Files** asks you to **Choose Parent Folder** and then **Create the Library Here**. resmon makes one new folder inside the one you choose, named `resmon-library-` followed by an id, holding a `vault.json` file and a `files` folder. Nothing is uploaded anywhere.

**Import Files** takes PDF, TXT, MD, and TeX files, or drop them anywhere on the Library page. A file can be up to 64 MiB, and resmon reads every file it keeps, PDFs included, up to the same 64 MiB. There is no limit on how many files the Library keeps; an import that would leave less than 512 MB free on the folder's disk is refused. Each file is kept exactly as given, under an id of its own, and never edited. Your original stays where it was. Importing the same bytes again reuses the first copy when the format agrees, and changed bytes become another file, even under the same name. A file's name never tells resmon what publication it is.

A file's **Read** opens its own page:

- **A PDF** opens in the reader, read-only: its pages drawn in one scroll, the page number, zoom, find in the document, every page at once, and focus mode. To pin passages, open it in Evidence. Drawing is independent of canonical text extraction: unsupported text on one page does not hide its drawing or prevent other pages from being read.
- **A Markdown file** opens rendered, with its math drawn (between `$` and `$$`); **Plain Text** shows the literal text with line numbers. Nothing in a file runs, and a link opens only for a web address.
- **A TeX file** opens as its source, with commands, comments, and braces set apart and its math drawn in place; **Plain Text** shows it literally.
- **A text file** shows its literal text with line numbers.

The rich view draws a file's first 2,000 formulas and shows the rest as written, and says so. A formula that defines a macro (`\def`, `\newcommand`, and their kin) or runs over 2,048 characters is shown as written rather than drawn, and quotes and lists nested more than 16 deep are shown as written from there on. If a file's rich view cannot be drawn at all, its plain text is shown instead.

In a text, Markdown, or TeX reader, **Find in the File** or ⌘F (Ctrl+F elsewhere) searches the view shown. Enter moves to the next match, Shift+Enter to the previous one, and both wrap at the ends. Esc closes Find and returns focus.

The engine reads only what it verified against the recorded size and hash, and refuses a text file over 256 KiB or 5,000 lines instead of showing part of it. A file that large stays kept; open it in the system's viewer instead.

A file's page also has **Open in the System's Viewer**, **Show in Finder** (or **Show in Its Folder**), **Link to a Paper**, **Open in Evidence**, and **Compare with Your Collection** (**Compare with Every Collection** when there are several), which looks for shared wording: the engine reads the file page by page and compares each page with your collection's abstracts and with the other files in this Library, and lists the pages that share a passage of 20 words or more, outside common phrasing. Its record (kind, when it was kept, its SHA-256, file id, version id, and place in the folder) is at the bottom of the page.

### Linking a File to a Paper

**Link to a Paper** finds a paper in your collection by its title, authors, or words in it, and links the file to it. A link is your association, not verified publication identity: resmon says so, and never infers one from a file name or a hash. Deleting a paper removes its links, so a number reused later cannot inherit them. A paper with a linked PDF shows that PDF as its cover under **To Read** and **Read**.

### Removing a File, and Undo

**Remove from Your Files** takes a file out of Your Files. A file in an Evidence project, or with passages, notes, or paper links, asks first and lists what goes with it; nothing is removed until you confirm. A notice can **Undo** the removal for ten seconds, and puts back the file and everything that went with it as it was. When several are removed and one cannot be, the rest still go, and the notice names the one that stayed and why.

Removal moves the kept copy, whole, into a `removed` folder inside the Library folder, and **Settings › Library** lists it under **Removed Files**: **Put Back** restores the copy and its records later, and **Move to the Trash** hands its bytes to your system's Trash. Once its bytes have left the Library folder, resmon forgets the record; restoring bytes from the system's Trash does not restore that record. Your original imported file stays where it was.

A file deleted or moved outside resmon is said to be missing on its own card; the rest of the Library keeps working, and **Remove** takes the missing one off the list.

## Get the PDF

**Get the PDF**, on a paper's page, its Library card, and a Look Up a Paper result, downloads an open-access copy into the Library folder, linked to the paper, as if you had imported it. Make that folder under **Library › Your Files** first. It is offered for Creative Commons licenses (CC BY, BY-SA, BY-ND, BY-NC, BY-NC-SA, and BY-NC-ND), CC0, public domain, and arXiv's distribution license. For an arXiv copy, resmon reads the license from arXiv's record when you ask, including its assumed distribution license for 1991 to 2003; a record stating none is not downloaded. A copy only free to read, under a publisher's own terms, or under an unnamed open-access license is left at the source. Copies come from what sources report, including OpenAlex, EuropePMC, Semantic Scholar, bioRxiv, medRxiv, PLOS, and records carrying an arXiv id. A copy reported on another record with the same DOI or arXiv id can supply the PDF; the records stay separate. Earlier papers gain open-copy records when a source returns them again.

If a host answers 401, 403, or 429, the outcome says that the site refused a download from resmon. resmon does not retry that refusal or disguise itself as a browser. The paper’s page and Library card offer **Open the Copy in Your Browser** for the copy’s address.

resmon never downloads from NASA ADS, Springer, CORE, BMC, or nature.com, whatever license is stated, and never from Crossref's text-mining links. Their terms for keeping full text are not settled for resmon. BMC and nature.com are Springer Nature's journal sites, under the same terms as Springer, so a copy another source reports there is left at the source too, and a download that is redirected onto any of these sites stops there.

Each new request is recorded before a PDF is fetched. One that cannot go ahead says why: no open copy, no license stated, a refused source, no Library folder yet, or a cap reached. An arXiv license check can run before a download is refused. Downloads go over https only, to public addresses, with every address and redirect checked; a private or local address, plain http, or more than five redirects ends the fetch. Only a response labeled as a PDF and beginning with `%PDF-` is kept, up to 64 MiB, the Library's own limit. There is one download at a time from each host, three seconds between requests, up to three hosts at once, at most 20 for one watch run, and at most 100 queued or attempted downloads in any 24 hours; failed attempts count, skipped requests do not. A stored file records its final address, license, and time. Bytes the Library already holds are reused and linked to the paper.

A watch can get its new papers' PDFs after each run: see [Watches](/resmon/guide/watches/).

## Settings › Library

**Settings › Library** shows where the Library folder is, its counts, the removed files it holds, the rules Get the PDF keeps, and **Save an Inventory**: a JSON list of what the database records about each file. An inventory is not a copy of the files and not a fresh integrity scan, it names your original file names (review them before sharing), and it refuses, instead of truncating, an inventory over 8 MiB.

### Changing the Folder

- **Choose Where It Is Now** is for a folder you moved or renamed yourself, or one on a disk mounted under another name. Choose the folder, or the folder it is in: resmon checks that it is this Library's folder, by its `vault.json`, and changes nothing in it.
- **Move It to Another Folder** moves the Library folder for you, keeping its name. On the same disk it is one rename. On another disk every file is copied and checked against its recorded hash, the new place is recorded only once every byte is there, and the old folder is left where it was for you to delete when you are sure. A move to another disk is refused before anything is copied unless that disk has room for every file and 512 MB to spare.

Only one of the two runs at a time. While the folder is being moved, both buttons wait, on this page and when you come back to it, and **Your Files** says the folder is being moved.

If the Library folder is not where it was recorded (moved, renamed, deleted, or on a disk that is not connected), **Your Files** says so and offers **Choose Where It Is Now**; your reading queue keeps working meanwhile. If it was deleted, put it back from the Trash first. If the folder is not the one the database recorded, needs attention, or has an import still finishing, **Your Files** says so and changes nothing. resmon never adopts or repairs a Library folder on its own. Files your system writes into a folder it shows, such as the Finder's `.DS_Store`, are passed over.

## Backups and Erasures

A backup holds the Library folder's kept files along with the database; see [Backup and Restore](/resmon/guide/backup/). Removed files are not in a backup. Erasing the collection, resetting settings, and the other erasures in the Danger Zone keep the Library. Deleting papers removes only the links to them.
