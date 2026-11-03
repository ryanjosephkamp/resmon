---
title: "Evidence"
summary: "Projects of exact file versions, pinned passages, and cited answers from excerpts you choose."
order: 9
readmeLines: []
---
**Library › Evidence** is where you work on the files in **Your files**. A **project** gathers exact versions of files. In a project you read pages, pin passages with notes, export what you chose, and ask a question of excerpts you pick. If no library exists yet, Evidence says so and links to **Your files**. Evidence is unavailable on Windows; see [Install and launch](/resmon/guide/install/).

## Projects

Type a name and press **Start** to make a project. You can have 100 of them. Choose a project in the list on the left to open it; **Rename** changes its name.

**Add files** shows the files in your library that the project does not hold yet. Tick some and press **Add**. A project holds the **exact version** of each file you add, up to 1,000 files. **Remove from project** takes a file out and asks first; the records you made against it stay. From **Your files**, **Open in Evidence** brings one file across, and Evidence asks before adding it. No name ever stands in for a paper or a version.

## Files and passages

Choose a file in the project to read it.

- **A PDF** opens on one page's text as resmon extracted it, with **Previous page**, **Next page**, and a page box. **Show the pages as drawn** draws the pages themselves, and adds zoom (**Fit width**, **Fit page**, or a percentage), find in the whole document (⌘F, or Ctrl+F), **All pages** for a gallery, and **Focus**, which gives the pages the whole window. In focus mode **Notes** brings the notes back as a side panel, and Esc leaves. Text in the drawn pages can be selected and copied or used as a passage.
- **A TXT or MD file** is one page of literal text.

To pin a **passage**, select text in the page's text, or find it with **Find on this page's text**, and press **Use selected passage**. Passages come from each page's text as the engine reads it, which can differ from the drawing. The engine checks the exact quote against the stored file before it saves it. Add a note on it, or leave the note empty, and press **Save passage**. A **plain note** needs no passage. A note body is at most 20,000 codepoints.

A passage is pinned to one page's text by the file version, the extraction method, the text's hash, and the character range. **Reopen the passage** reads that page again and checks all four. If the file or its text has changed, the saved quote and note stay visible and the passage is marked unresolved. **Edit the body** changes the note and never moves the pin. If a save is refused, for example because the project changed since you opened it, your text stays in the box.

What the reader cannot do:

- A PDF is read up to 16 MiB, 200 pages, and 20 seconds a page. Encrypted, malformed, image-only, unsupported, and over-limit pages are named, not skipped silently. There is no OCR.
- Equations, tables, columns, and images may not survive text extraction. A drawn page is not a claim that the extracted text is complete or accurate.
- A project holds up to 5,000 saved records.

## Exporting evidence

**Export selected evidence** builds a ZIP of 1 to 20 files you tick, with every record saved against those exact versions. Records only is the default. **Include the files themselves** adds their bytes, re-hashed against the recorded hash first. The archive is capped at 256 MiB of files, and 4 MiB each for the manifest and the notes. It is a portable copy of what you chose, not a backup: it is not encrypted, it names the files, and it carries your notes. Review it before sharing.

## Answers

The **Answers** view of a project asks a question of exact excerpts, or asks for a briefing from them. **New answer** has three steps.

1. **Choose what to send:** up to 5 files, 12 pages, and 24 excerpts in all. An excerpt is a whole page's text or a passage. Source text is at most 48 KiB and 24,000 codepoints, and nothing is silently cut: a selection over the limit is refused.
2. **Your notes, if any.** None is sent unless you tick it, up to 8, and a note's text goes as your own commentary. An answer cannot cite a note as a document.
3. **What to ask.** Choose **Question** or **Briefing**, write the question or instruction (up to 4,000 characters), and choose the **Connection**, **Model**, and **Effort**: Claude Code or an API key. Codex is not offered here.

Then press **Show exactly what will be sent**. Nothing leaves your computer until you have seen this and pressed **Send**. The check shows where it goes, each file and version, every excerpt's exact text, your notes, the exact instructions the app sends with it, the whole text as one string, and the request's SHA-256. It expires after 10 minutes. It also says what it cannot promise: source text may contain private material, and a request that is stopped may still be worked on, and charged for, by the provider.

Each **Send** makes one new, saved answer: one request, with no tools and no earlier conversation, stopped after 300 seconds. Your Ask conversations and earlier answers are never sent. **Stop the answer** asks for cancellation. Whether the provider finished, kept, or billed it can remain unknown, and the answer says so, with local cleanup shown as confirmed or not.

An answer is **Answered**, **Not enough in the selection** (the model said the excerpts were not enough), **Failed**, **Stopped**, or **Interrupted**. It has sections: **Summary**, **Details**, **Limitations**, and **Open questions**. Each item is labeled **From the sources**, **Interpretation**, **From your notes**, or **Open question**. An answer that does not match the required shape is shown under **Unvalidated output**, not dressed up as a result.

Citations are buttons such as `S01 · paper.pdf · page 2`. Choosing one opens the quote exactly as the answer was given it, and reads the current page of the file again, checked against the same version, extraction method, hash, and range. If the library now holds another version of the file, nothing else is read in its place.

What a citation establishes is that the quote is the selected text at its exact range. It does not establish that the quote supports the sentence it is attached to, that the research is sound, or that the claim is true. Pages and files you did not select are unexamined.

Opening a saved answer reads what was saved. It calls no model and reads no original file until you open a citation. **Save as HTML** writes one offline document with the citations and their return links, source excerpts, the notes you chose, the coverage, and the requested and reported settings. Open it in a browser, with resmon closed if you like. It has no scripts, remote assets, or links to current originals, and text that looks like markup or a URL stays literal. **Save as ZIP** writes the answer and the selected text. Both hold your saved text, which may be private. See the [portable briefing guide](docs/portable-briefing.md) for the HTML file.
