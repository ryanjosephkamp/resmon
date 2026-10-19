---
title: "Projects and selected evidence"
summary: "Grouping work into projects and choosing the evidence an answer is allowed to rest on."
order: 4
readmeLines:
  - "166-223"
---
### Projects and selected evidence

From a Library item, choose **Open in Evidence / add to project**, create or
select a project, and explicitly add that exact retained version. **Choose from
Library** adds other files; the import link returns through the same explicit
file selection. Names never infer paper or version identity.

Evidence displays a bounded PDF page alongside canonical text, or literal TXT/MD
in one logical page. Find searches only the current canonical page. Select a
passage there and save it with an optional note; plain notes need no passage.
Reopening checks the same version, page, extraction contract, text hash and
Unicode codepoint range. A missing or changed source leaves the saved quote/body
visible and unresolved. Body edits never move the saved anchor. Conflicts preserve
unsaved text for an explicit refresh/retry.

PDF reading is limited to 16 MiB, 200 physical pages and 20 seconds per requested
page; text extraction allows 200,000 codepoints. Encrypted, malformed, image-only,
unsupported and over-limit pages are explicit. No OCR or full-text background
processing. Equations, tables, columns and images may not survive text extraction;
a rendered page is not a scientific accuracy or completeness claim. TXT/MD retain
the Library 256 KiB/5,000-line bounds. The visual canvas is bounded to four million
pixels/16 MiB, with reduced resolution when necessary. Parser limits and cleanup
do not prove a portable hard memory or OS-confinement guarantee.

Remove a collection member without deleting its originals, managed bytes, paper
provenance or notes. Re-add that exact identity to reconnect its saved records.
Projects and notes survive existing resets and corpus erasure. Limits are 100
projects, 1,000 current members and 5,000 saved records per project; note bodies
and selected passages are each at most 20,000 codepoints.

**Export selected evidence** creates a ZIP for 1–20 explicitly selected current
members and all their saved notes in that project. Metadata-only is the default;
optional retained-file mode rehashes selected bytes before offering a complete
archive. Limits are 256 MiB of retained files and 4 MiB each for manifest and
notes. Review names, notes and included originals before sharing. This is not an
encrypted backup/restore format, an AI briefing or a claim of redistribution
rights. Existing Library platform limitations remain; no new Windows support or
assistant/MCP tool is introduced. See the [Evidence contract](docs/api-contract/evidence.md).

Evidence also offers **selected-evidence questions and manual structured briefings**.
Explicitly choose up to 5 files, 12 pages or 24 passages and, optionally, up to
8 individual saved note bodies. Inspect the exact content, coverage and requested
connection/model/effort in the preview. Each **Send** creates one saved answer using
the existing CLI or API connection with tools off and no earlier conversation.
Source text is limited to 48 KiB and 24,000 Unicode codepoints; nothing is silently
truncated. Citation checks establish exact selected-text identity; they do not
establish semantic support, research quality or truth. Stop requests cancellation;
remote completion, retention and billing can remain unknown. Saved answers and
selected-text ZIPs remain available without the original files or a model call.
**Export HTML** separately saves one readable offline document with frozen
citations and return links, source excerpts, selected local notes, coverage and
requested/reported settings. Open the downloaded file in a browser after closing
resmon. It contains no scripts, remote assets, PDFs or current-original links;
URLs in source text stay literal. Partial and unknown states stay explicit.
The existing ZIP action and its three members are unchanged. See the
[portable briefing guide](docs/portable-briefing.md) for navigation and limits.
See the [selected-answer contract](docs/api-contract/selected-evidence.md).
