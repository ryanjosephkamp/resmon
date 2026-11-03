---
title: "The Library"
summary: "The reading queue, and copies of PDF, TXT, and MD files kept in a folder you choose, linked to papers by your own association."
order: 8
readmeLines: []
---
**Library** has three tabs: **Reading queue**, **Your files**, and **Evidence**. The queue is the list of papers you meant to read. **Your files** keeps copies of files in a folder of yours. [Evidence](/resmon/guide/projects/) works on those files.

The queue works everywhere. **Your files** and **Evidence** are unavailable on Windows; see [Install and launch](/resmon/guide/install/).

## Reading queue

Papers get here when you press **Save to read** on a paper's page or a run's **Papers** tab, or the bookmark on a paper in Today. The queue has two states, **To read** and **Read**, and **To read**, **Read**, and **All** show the papers in each, with counts. A page holds 200 papers; **Previous** and **Next** turn the pages.

- **Mark read** moves a paper to **Read**. **Mark unread** moves it back.
- **Remove** takes the paper out of the queue. The paper, its authors, and every run that found it are untouched. The only thing in resmon that deletes a paper is **Erase the paper corpus** in the Danger zone.
- Tick papers and export them as **BibTeX**, **RIS**, or **CSV**. The file holds exactly the papers ticked on the page in view, so a paper that has left that page cannot end up in the file.

A paper is in the queue by its stored id. Saving a paper again never moves one you have read back to **To read**, and when a later run finds the same record, its state is kept. Two records that look like the same work stay two entries, on the same rule that makes resmon link near-duplicates and never merge them.

The queue holds no notes, no PDFs, no reminders, and ranks nothing. For notes and PDFs, use [Evidence](/resmon/guide/projects/).

## Your files

The first time, **Your files** asks you to **Choose parent folder** and then **Create the library here**. resmon makes one new folder inside the one you choose, named `resmon-library-` followed by an id, holding a `vault.json` file and a `files` folder. Nothing is uploaded anywhere.

**Import files** takes PDF, TXT, and MD files. The limits are 64 MiB for a file, 20 files at a time, 10,000 files in all, and 1 GiB retained. Each file is kept exactly as given, under an id of its own, and never edited. Your original stays where it was. Importing the same bytes again reuses the first copy when the format agrees, and changed bytes become another file, even under the same name. A file's name never tells resmon what publication it is.

The list shows the newest 100 files and filters by file name. Choose a file to see it:

- **Open** asks your operating system's opener to open the stored copy, after resmon verifies it. **Show in Finder** (or **Show in its folder**) reveals it. An accepted request does not establish that another application rendered the document.
- **Read here** shows a TXT or MD file as literal text, with line numbers. Nothing is rendered as Markdown or HTML. The engine reads only what it verified against the recorded size and hash, and refuses a file over 256 KiB or 5,000 lines instead of showing part of it. A file that large stays kept; **Open** it instead.
- **Open in Evidence** carries this exact file version into a project. See [Evidence](/resmon/guide/projects/).
- **Compare with your collection** looks for shared wording. The engine reads the file page by page through its PDF reader and compares each page with your collection's abstracts and with the other files in this Library, and lists the pages that share a passage of 20 words or more, outside common phrasing. It names pages it could not read. It does not say why wording is shared. See [Search](/resmon/guide/search/).

The facts under a file are its kind, size, when it was kept, its SHA-256, its file id, its version id, and its place in the folder. The hash is the one recorded when the file was kept; this view does not read the bytes again.

### Linking a file to a paper

**Link to a paper by its number** associates the file with a paper in your collection. The number is on the paper's page ("Paper 12"). A link is your association, not verified publication identity: resmon says so when you make one, and never infers one from a file name or a hash. Deleting a paper removes its links, so a number reused later cannot inherit them.

### Saving an inventory

**Save an inventory** writes a JSON list of what the database records about each file, including files past the visible 100. It is not a copy of the files and not a fresh integrity scan, it names your original file names (review them before sharing), and it refuses, instead of truncating, an inventory over 8 MiB.

### When the folder cannot be used

If the library folder is not the one the database recorded, is on a disk that is disconnected or has moved, needs attention, or has an import still finishing, **Your files** says so and changes nothing. resmon never adopts, repairs, relocates, or replaces a library folder on its own.

### Backups and erasures

A backup holds the Library folder's files along with the database; see [Backup and restore](/resmon/guide/backup/). Erasing the collection, resetting settings, and the other erasures in the Danger zone keep the Library. Deleting papers removes only the links to them.
