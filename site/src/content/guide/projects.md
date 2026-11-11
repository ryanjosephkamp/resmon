---
title: "Evidence"
summary: "Projects of exact file versions, pinned passages, and cited answers from excerpts you choose."
order: 9
---
For the path from a collected paper through To Read and its PDF into a project, see [From a Run to a Project](/resmon/guide/library/#from-a-run-to-a-project).

**Evidence** is where you work on the files in **Your Files**; the Library's **Projects** shelf shows its projects, and **Open Evidence** there leads here. A **project** gathers exact versions of files. In a project you read pages, pin passages with notes, export what you chose, and ask a question of excerpts you pick. If no library exists yet, Evidence says so and links to **Your Files**. Evidence is unavailable on Windows; see [Install and Launch](/resmon/guide/install/).

## Projects

Type a name and press **Start** to make a project, or press **New Project** on the Library's **Projects** shelf, which names it and opens it here. You can have 100 of them. Choose a project in the list on the left to open it; **Rename** changes its name.

**Add Files** shows every file in your library that the project does not hold yet. The list scrolls inside its panel, so the button stays in view, and **Find a file or paper title** narrows it by file name or by the title of a paper the file is linked to. Tick some and press the button that names how many, such as **Add 2 Files**; a ticked file stays ticked when a find hides it, and the panel says how many are hidden. A project holds the **exact version** of each file you add, as many as you add. **Remove from Project** takes a file out and asks first; the records you made against it stay. From a file's page in **Your Files**, **Open in Evidence** brings it across, and Evidence asks before adding it. No name ever stands in for a paper or a version.

## Files and Passages

Choose a file in the project to read it. **Hide Files** folds the project and file lists, and **Hide Notes** folds the notes column. **Show Files** and **Show Notes** bring them back. **Fold Side Columns**, or Shift+⌘+\ (Ctrl+Shift+\ off macOS) outside focus mode, folds both; the same shortcut unfolds them. The reader takes the freed width. Each window remembers its choices while it stays open, including when you leave Evidence and return. Folding notes keeps an unsaved draft.

- **A PDF** opens on one page's text as resmon extracted it, with **Previous Page**, **Next Page**, and a page box. **Show the Pages as Drawn** draws the pages themselves, and adds zoom (**Fit Width**, **Fit Page**, or a percentage), find in the whole document (⌘F, or Ctrl+F), **All Pages** for a gallery, and **Focus**, which gives the pages the whole window. In focus mode **Notes** brings the notes back as a side panel, and Esc leaves. Text in the drawn pages can be selected and copied or used as a passage.
- **A TXT, MD, or TeX file** is one page of literal text.

To pin a **passage**, select text in the page's text, or find it with **Find on This Page's Text**, and press **Use Selected Passage**. Passages come from each page's text as the engine reads it, which can differ from the drawing. Where the engine's text runs words together (PDF text often loses the space beside a bold or italic word) or keeps a hyphen at a line's end, a selection made on the drawn page is matched letter for letter, ignoring spaces, line-end hyphens, and ligatures, and the passage keeps the engine's own text. If the same letters appear more than once on the page, the reader says so and keeps the first. The engine checks the exact quote against the stored file before it saves it. Add a note on it, or leave the note empty, and press **Save Passage**. **Cancel**, or Esc, lets the passage go and keeps what you typed as a plain note. A **plain note** needs no passage. A note body is at most 20,000 codepoints.

**Saved Records** lists every record in the project under a heading for its file, in the order the files sit in the project, newest record first. Records on a file since removed from the project come last, under a heading that says so. While a file is open, **This File Only** shows just its records, and **All Files** shows them all again.

A passage is pinned to one page's text by the file version, the extraction method, the text's hash, and the character range. **Reopen the Passage** reads that page again and checks all four. If the file or its text has changed, the saved quote and note stay visible and the passage is marked unresolved. **Edit the Body** changes the note and never moves the pin; **Cancel**, or Esc, stops editing and leaves the saved body as it was. If a save is refused, for example because the project changed since you opened it, your text stays in the box.

What the reader cannot do:

- A PDF is read up to 64 MiB (the Library's one limit, for keeping a file and for reading it), 200 pages, and 20 seconds a page. Encrypted, malformed, image-only, unsupported, and over-limit pages are named, not skipped silently. There is no OCR.
- Drawing and canonical text extraction are checked separately, page by page. A page that draws stays visible even when its text or links cannot be read. A font or encoding unsupported by the text reader is a limitation of that page’s text extraction; it does not mean the PDF is malformed. Other pages are still read when opened.
- Equations, tables, columns, and images may not survive text extraction. A drawn page is not a claim that the extracted text is complete or accurate.
- A project holds up to 5,000 saved records.

## Exporting Evidence

**Export Selected Evidence** builds a ZIP of 1 to 20 files you tick, with every record saved against those exact versions. Its list scrolls inside the panel, and **Find a file in this project** narrows it by name. Records only is the default. **Include the files themselves** adds their bytes, re-hashed against the recorded hash first. The archive is capped at 256 MiB of files, and 4 MiB each for the manifest and the notes. It is a portable copy of what you chose, not a backup: it is not encrypted, it names the files, and it carries your notes. Review it before sharing.

## Answers

The **Answers** view of a project asks a question of exact excerpts, or asks for a briefing from them. **New Answer** has four steps.

1. **What to send:** up to 5 files, 12 pages, and 24 excerpts in all. An excerpt is a whole page's text or a passage. Source text is at most 48 KiB and 24,000 codepoints, and nothing is silently cut: a selection over the limit is refused.
2. **Your notes, if any.** None is sent unless you tick it, up to 8 and 8 KiB of note text in all, as your own commentary. An answer cannot cite a note as a document.
3. **What to ask.** Under **Answer as**, choose **An Answer to a Question** or **A Structured Briefing**, and write the question or instruction (up to 4,000 characters).
4. **Where it goes.** Choose the **Connection**, **Model**, and **Effort**: Claude Code or an API key. Codex is not offered here.

Then press **Show Exactly What Will Be Sent**. Nothing leaves your computer until you have seen this and pressed **Send**. The check shows where it goes, each file and version, every excerpt's exact text, your notes, the exact instructions the app sends with it, the whole text as one string, and the request's SHA-256. It expires after 10 minutes. It also says what it cannot promise: source text may contain private material, and a request that is stopped may still be worked on, and charged for, by the provider.

Each **Send** makes one new, saved answer: one request, with no tools and no earlier conversation, stopped after 300 seconds. A project keeps at most 1,000 answers. Your Ask conversations and earlier answers are never sent. **Stop the Answer** asks for cancellation. Whether the provider finished, kept, or billed it can remain unknown, and the answer says so, with local cleanup shown as confirmed or not.

An answer is **Answered**, **Not enough in the selection** (the model said the excerpts were not enough), **Failed**, **Stopped**, or **Interrupted**, and while it is going, **Admitted, not started** or **Running**. It has sections: **Summary**, **Details**, **Limitations**, and **Open Questions**. Each item is labeled **From the sources**, **Interpretation**, **From your notes**, or **Open question**. An answer that does not match the required shape is shown under **Unvalidated Output**, not dressed up as a result.

Citations are buttons such as `S01 · paper.pdf · page 2`. Choosing one opens the quote exactly as the answer was given it, and reads the current page of the file again, checked against the same version, extraction method, hash, and range. If the library now holds another version of the file, nothing else is read in its place.

What a citation establishes is that the quote is the selected text at its exact range. It does not establish that the quote supports the sentence it is attached to, that the research is sound, or that the claim is true. Pages and files you did not select are unexamined.

Opening a saved answer reads what was saved. It calls no model and reads no original file until you open a citation. **Save as HTML** writes one offline document with the citations and their return links, source excerpts, the notes you chose, the coverage, and the requested and reported settings. Open it in a browser, with resmon closed if you like. It has no scripts, remote assets, or links to current originals, and text that looks like markup or a URL stays literal. **Save as ZIP** writes the answer and the selected text. Both hold your saved text, which may be private. See the [portable briefing guide](docs/portable-briefing.md) for the HTML file.
