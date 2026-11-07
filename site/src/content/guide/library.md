---
title: "The Library"
summary: "Papers saved to read, copies of PDF, TXT, MD, and TeX files kept in a folder you choose, and the projects built from them, in one gallery."
order: 8
---
**Library** is one page: a gallery of covers, with a filter for **To read**, **Read**, **Your files**, and **Projects**, a find field, and an order. The reading queue is **To read** and **Read**. **Your files** keeps copies of files in a folder of yours. **Projects** are your [Evidence](/resmon/guide/projects/) projects.

The reading queue works everywhere. **Your files** and **Projects** are unavailable on Windows; see [Install and launch](/resmon/guide/install/).

## Covers

Each card is a cover the shape of a page, then the title, one line (authors, source, and year, or a file's kind and size), one label, and its actions.

- **A paper with a PDF** in your Library, linked to it, shows that PDF's first page.
- **A paper without one** shows its piece of your collection's map: the grid cell it is in, its neighbors, its region's name, and the paper itself, crossed, over a title block with its title, authors, source, and year. A paper the map has not placed yet says so on its cover. Until the map has been drawn, the cover is the title block alone. Pointing at the cover names the paper's cell and region in a tip.
- **A text file** shows its first lines, with their numbers.
- **A project** shows its first PDFs fanned over its name.

A PDF's first page is drawn on your computer, by the same PDF reader the Library uses, and kept beside resmon's database; later visits show the kept picture. Only the cards near the view are drawn, and more are read as you near the end of the shelf.

Hover darkens a cover's edge and underlines its title. **Select** turns the toolbar into a selection bar: click covers to pick them, Shift-click to pick a run of them, **Select all**, and **Done** or Esc to leave. Picked papers can be marked read, exported, or removed together; picked files can be added to a project or removed together.

The order is **Saved, newest first**, **Published, newest first**, **Title**, **Source**, or **Map order**, which keeps papers that are neighbors on the map together. Your files order by when they were added, their name, or their size; projects by when they changed or their name. The find field matches a paper's title, authors, or source, a file's name, or a project's name. Files and projects are shared across every collection.

## To read and Read

Papers get here one at a time when you press **Save to read** on a paper's page or a run's **Papers** tab, or the bookmark on a paper in Today or on the map, and many at once from **Select** in Search › Your collection, a run's **Papers**, and Today's list, from **Save this run's new papers**, and from **Save to read** on a map's bar, which saves the papers its find or filters leave lit. A paper already in the queue stays as it is, and the notice after a save of many says how many were already there and offers **Undo**. The label under a paper names the run that first collected it (a watch's, by its name, or a search) and the day you saved it. The queue is one list, and each collection shows the saved papers it holds: **To read** and **Read** list those of the collection the window shows, with their counts.

- **Read** opens the paper's PDF in the reader when one is linked to it, and the paper's page otherwise.
- **Mark read** moves a paper to **Read**; **Mark unread** moves it back. Marking one paper leaves every other card's controls as they are.
- **Get the PDF** (the download mark) appears where a source states an open license for a copy of the paper and the card has no PDF yet. While it downloads, the card's label says so; once it lands, the card is a PDF card with the first page as its cover. See [Get the PDF](#get-the-pdf).
- **Open at the source** opens the paper's own web address, or its DOI's.
- **Remove from To read** or **Remove from Read** takes the paper out of the queue, with a notice that can **Undo** it for ten seconds. Undo puts it back with its own state and dates. The paper, its authors, and every run that found it are untouched. Papers are deleted only by the Danger zone's corpus, app-data, or factory erasures.
- Picked papers export as **BibTeX**, **RIS**, or **CSV**: the file holds exactly the papers picked.

A paper is in the queue by its stored id. Saving a paper again never moves one you have read back to **To read**, and when a later run finds the same record, its state is kept. Two records that look like the same work stay two entries, on the same rule that makes resmon link near-duplicates and never merge them.

## Your files

The first time, **Your files** asks you to **Choose parent folder** and then **Create the library here**. resmon makes one new folder inside the one you choose, named `resmon-library-` followed by an id, holding a `vault.json` file and a `files` folder. Nothing is uploaded anywhere.

**Import files** takes PDF, TXT, MD, and TeX files, or drop them anywhere on the Library page. A file can be up to 64 MiB, and resmon reads every file it keeps, PDFs included, up to the same 64 MiB. There is no limit on how many files the Library keeps; an import that would leave less than 512 MB free on the folder's disk is refused. Each file is kept exactly as given, under an id of its own, and never edited. Your original stays where it was. Importing the same bytes again reuses the first copy when the format agrees, and changed bytes become another file, even under the same name. A file's name never tells resmon what publication it is.

A file's **Read** opens its own page:

- **A PDF** opens in the reader, read-only: its pages drawn in one scroll, the page number, zoom, find in the document, every page at once, and focus mode. To pin passages, open it in Evidence.
- **A Markdown file** opens rendered, with its math drawn (between `$` and `$$`); **Plain text** shows the literal text with line numbers. Nothing in a file runs, and a link opens only for a web address.
- **A TeX file** opens as its source, with commands, comments, and braces set apart and its math drawn in place; **Plain text** shows it literally.
- **A text file** shows its literal text with line numbers.

The rich view draws a file's first 2,000 formulas and shows the rest as written, and says so. A formula that defines a macro (`\def`, `\newcommand`, and their kin) or runs over 2,048 characters is shown as written rather than drawn, and quotes and lists nested more than 16 deep are shown as written from there on. If a file's rich view cannot be drawn at all, its plain text is shown instead.

The engine reads only what it verified against the recorded size and hash, and refuses a text file over 256 KiB or 5,000 lines instead of showing part of it. A file that large stays kept; open it in the system's viewer instead.

A file's page also has **Open in the system's viewer**, **Show in Finder** (or **Show in its folder**), **Link to a paper**, **Open in Evidence**, and **Compare with your collection**, which looks for shared wording: the engine reads the file page by page and compares each page with your collection's abstracts and with the other files in this Library, and lists the pages that share a passage of 20 words or more, outside common phrasing. Its record (kind, when it was kept, its SHA-256, file id, version id, and place in the folder) is at the bottom of the page.

### Linking a file to a paper

**Link to a paper** finds a paper in your collection by its title, authors, or words in it, and links the file to it. A link is your association, not verified publication identity: resmon says so, and never infers one from a file name or a hash. Deleting a paper removes its links, so a number reused later cannot inherit them. A paper with a linked PDF shows that PDF as its cover under **To read** and **Read**.

### Removing a file, and Undo

**Remove from Your files** takes a file out of Your files. A file in an Evidence project, or with passages, notes, or paper links, asks first and lists what goes with it; nothing is removed until you confirm. A notice can **Undo** the removal for ten seconds, and puts back the file and everything that went with it as it was. When several are removed and one cannot be, the rest still go, and the notice names the one that stayed and why.

Removal moves the kept copy, whole, into a `removed` folder inside the Library folder, and **Settings › Library** lists it under **Removed files**: **Put back** restores the copy and its records later, and **Move to the Trash** hands its bytes to your system's Trash. Once its bytes have left the Library folder, resmon forgets the record; restoring bytes from the system's Trash does not restore that record. Your original imported file stays where it was.

A file deleted or moved outside resmon is said to be missing on its own card; the rest of the Library keeps working, and **Remove** takes the missing one off the list.

## Get the PDF

**Get the PDF**, on a paper's page, its Library card, and a find's result, downloads an open-access copy into the Library folder, linked to the paper, as if you had imported it. Make that folder under **Library › Your files** first. It is offered for Creative Commons licenses (CC BY, BY-SA, BY-ND, BY-NC, BY-NC-SA, and BY-NC-ND), CC0, public domain, and arXiv's distribution license. For an arXiv copy, resmon reads the license from arXiv's record when you ask, including its assumed distribution license for 1991 to 2003; a record stating none is not downloaded. A copy only free to read, under a publisher's own terms, or under an unnamed open-access license is left at the source. Copies come from what sources report, including OpenAlex, EuropePMC, Semantic Scholar, bioRxiv, medRxiv, PLOS, and records carrying an arXiv id. A copy reported on another record with the same DOI or arXiv id can supply the PDF; the records stay separate. Earlier papers gain open-copy records when a source returns them again.

resmon never downloads from NASA ADS, Springer, CORE, BMC, or nature.com, whatever license is stated, and never from Crossref's text-mining links. Their terms for keeping full text are not settled for resmon. BMC and nature.com are Springer Nature's journal sites, under the same terms as Springer, so a copy another source reports there is left at the source too, and a download that is redirected onto any of these sites stops there.

Each new request is recorded before a PDF is fetched. One that cannot go ahead says why: no open copy, no license stated, a refused source, no Library folder yet, or a cap reached. An arXiv license check can run before a download is refused. Downloads go over https only, to public addresses, with every address and redirect checked; a private or local address, plain http, or more than five redirects ends the fetch. Only a response labeled as a PDF and beginning with `%PDF-` is kept, up to 64 MiB, the Library's own limit. There is one download at a time from each host, three seconds between requests, up to three hosts at once, and at most 100 queued or attempted downloads in any 24 hours; failed attempts count, skipped requests do not. A stored file records its final address, license, and time. Bytes the Library already holds are reused and linked to the paper.

A watch can get its new papers' PDFs after each run: see [Watches](/resmon/guide/watches/).

## Settings › Library

**Settings › Library** shows where the Library folder is, its counts, the removed files it holds, the rules Get the PDF keeps, and **Save an inventory**: a JSON list of what the database records about each file. An inventory is not a copy of the files and not a fresh integrity scan, it names your original file names (review them before sharing), and it refuses, instead of truncating, an inventory over 8 MiB.

### Changing the folder

- **Choose where it is now** is for a folder you moved or renamed yourself, or one on a disk mounted under another name. Choose the folder, or the folder it is in: resmon checks that it is this Library's folder, by its `vault.json`, and changes nothing in it.
- **Move it to another folder** moves the Library folder for you, keeping its name. On the same disk it is one rename. On another disk every file is copied and checked against its recorded hash, the new place is recorded only once every byte is there, and the old folder is left where it was for you to delete when you are sure. A move to another disk is refused before anything is copied unless that disk has room for every file and 512 MB to spare.

Only one of the two runs at a time. While the folder is being moved, both buttons wait, on this page and when you come back to it, and **Your files** says the folder is being moved.

If the Library folder is not where it was recorded (moved, renamed, deleted, or on a disk that is not connected), **Your files** says so and offers **Choose where it is now**; your reading queue keeps working meanwhile. If it was deleted, put it back from the Trash first. If the folder is not the one the database recorded, needs attention, or has an import still finishing, **Your files** says so and changes nothing. resmon never adopts or repairs a Library folder on its own. Files your system writes into a folder it shows, such as the Finder's `.DS_Store`, are passed over.

## Backups and erasures

A backup holds the Library folder's kept files along with the database; see [Backup and restore](/resmon/guide/backup/). Removed files are not in a backup. Erasing the collection, resetting settings, and the other erasures in the Danger zone keep the Library. Deleting papers removes only the links to them.
