---
title: "Your local library"
summary: "Managed vaults, importing PDF, TXT and MD files, and the rules for what counts as the same document."
order: 3
readmeLines:
  - "119-165"
---
### Your local Library

Open **Library**, choose an existing parent folder, then select **Create managed
vault**. resmon creates one new child folder and pairs its marker with this app's
database. Import selected PDF, TXT or MD files to retain immutable copies. Originals
stay where they were; repeating the exact bytes reuses the first file and version
only when the format agrees. Changed bytes become another item, even under the same
filename. Library never infers a publication identity from a filename or hash.

Search filenames and page beyond the first 50 items. Paging keeps its initial
catalog ceiling; **Refresh Library** includes later imports. Select an item to inspect
its metadata and optionally associate an existing corpus-local paper ID. An
association means you selected that record, not that resmon verified the publication.

**Read text** shows exact retained TXT/MD as literal UTF-8 with line numbers, local
find and previous/next matches. CRLF and CR display as LF without changing retained
bytes. Reading is limited to 256 KiB, 5,000 logical lines and a 2 MiB serialized
response. Markdown, HTML, links and embedded images are never executed. For PDFs, **Read PDF in Evidence** carries the selected file/version to Evidence;
choose a project and explicitly add it to open the reader (an existing membership
is reused). Larger text remains retained. **Open externally** verifies the selected stored version
and requests the existing OS opener. An accepted Open request does not establish
that another application rendered the document. The Library reader adds no PDF extraction, OCR or AI analysis; the separate
Evidence workspace provides bounded PDF pages and saved passages.

Imports are limited to 64 MiB per file, 20 files processed sequentially per selection,
1 GiB of retained bytes and 10,000 items per vault. Missing or mismatched storage,
unexpected files and stale import locks produce a refusal; there is no automatic
adoption, repair, relocation, removal or replacement. Filesystem operations require
no-follow, descriptor-relative primitives and fail visibly where unavailable.

**Export complete JSON inventory** downloads recorded metadata for every catalog
item, including items beyond the visible page. Its 8 MiB limit refuses oversized
inventories without truncation. Review original filenames before sharing. The
inventory contains no retained file bytes and is not a backup or fresh integrity
scan. A database backup alone does not preserve the vault's files, and no automatic
Library cloud backup is added.

Existing settings resets and corpus erasure retain Library catalog entries and files.
Deleting a paper removes only its Library associations, so a reused local ID cannot
inherit them. See the [Library storage and API contract](docs/api-contract/library.md)
for identity, migration and verification details.

Completed exports appear in **Downloads** at the bottom of the app, with filename,
actual saved path and **Show in folder**. Saving, cancelled and interrupted items
remain distinct from completed files. This is the last 20 downloads in the current
app session; the save dialog and existing export formats are unchanged.
