---
title: "Shared Wording"
summary: "How exact passages are found, how recurring statements are separated, and what a comparison establishes."
order: 22
---
**Search › Shared Wording** compares the abstracts resmon holds, across every collection. **Scan the Collection** starts a scan. Each pair has two record titles, publication dates, its figures, and any reason it was set aside. Choose a pair to read both texts with matching passages highlighted. Point at a highlight to locate the same passage in the other text.

## What Is Compared

resmon decodes character references, removes markup, normalizes Unicode forms, and compares runs of letters, digits, and their combining marks in lowercase. Punctuation and case do not break a match. A leading “Abstract” label is removed. An abstract under 40 words is counted as not compared. Matching and recurrence indexing use at most the first 3,000 words of each abstract.

Every run of eight consecutive words is a phrase. An index of those phrases proposes pairs, and the proposed passages are checked word by word against both texts. Hashes make the index fast; a hash match alone never establishes a shared passage. The highlighted text comes from the normalized text that was compared, with its exact character ranges.

A comparison is listed when, outside common phrasing, it shares at least 20 consecutive words, or at least 20% of the shorter abstract's eight-word phrases with at least 13 shared phrases. These thresholds find substantial exact overlap while leaving short expressions out. They do not establish intent, originality, or misconduct. An edited passage can fall below the threshold, and paraphrase or translation can escape this method entirely.

## Reading the Figures

**Longest Passage** counts consecutive matching words. **Share** counts positions of eight-word phrases in the shorter abstract that also occur in the other, divided by all phrase positions in that shorter abstract. A displayed percentage is rounded down. The figures include common phrasing; the threshold for listing a substantive comparison excludes it.

**Authors in Common** matches ORCID where both records carry one, otherwise surname and first initial, with accents folded. It can confuse people with the same surname and initial, and a record without authors cannot establish whether the papers share one. The earlier date determines reading order, not who originated the words.

Pairs are grouped by their recorded authors. Records with the same DOI, a link between them, equal normalized titles, or versions of one arXiv identifier are set aside with that specific reason. A title indicating a correction or other notice is also set aside. Equal titles are a matching rule, not proof of identity.

## Charts and Filters

**Pairs by How Much They Share** counts listed pairs in four bands: under 25%, 25% to under 50%, 50% to under 75%, and 75% to 100% of the shorter abstract’s phrases. **Pairs by Kind** counts **Substantive Passages** (listed pairs outside Standard Statements, including the same-work and notice groups set aside below) against **Standard Statements**. Both count only the pairs listed in the response, because each group can be capped. They do not count all possible pairs or estimate omitted pairs.

Each chart states its numbers in text. Choose a bar with the pointer or keyboard to filter the list below; a share band and a kind can be combined. The filter line says what is shown, and **Show All Pairs** clears both filters. Opening a comparison and returning keeps the filters. The charts keep counting the full listed set so another bar remains available.

## Standard Statements

A phrase appearing in more than three distinct works is common phrasing and cannot by itself create a substantive comparison. Duplicate records of one work do not count as separate works.

**Standard Statements** separately shows representative pairs for recurring sentences, including wording such as funding disclaimers, license lines, and data-availability statements. Detection does not depend on a list of those phrases. A complete sentence of eight to 160 words must recur in at least four distinct works whose recorded authors do not match. Outside that sentence, the sets of words at least four characters long must overlap by no more than 15% of their union, for every pair of those four works.

These are explicit tests for recurrence across otherwise different records. They do not prove that the papers are unrelated or that the sentence serves a particular legal or editorial purpose. A substantive comparison stays in its original group even if it also shares a recurring statement. Up to 500 representative pairs are added, rather than every combination of every occurrence. A new scan replaces these representatives.

## Exports and Saved Scans

**Export Page CSV** saves every pair currently listed, with its record identifiers, titles, dates, sources, figures, and reason. **Export Page Markdown** includes those pairs, definitions, qualifications, group counts, and scan information. These page exports do not fetch the full texts of unopened comparisons. Each group can list at most 500 pairs, and the page says when more exist.

Inside a comparison, **Export Pair CSV** and **Export Pair Markdown** include both complete compared abstracts, the shared passage ranges, the measured figures, and the limitations. Spreadsheet cells that could be interpreted as formulas are prefixed with an apostrophe. Review the exported text before sharing it.

The scan records the method version and each compared text's fingerprint. Changed or removed texts are withheld from the list, and a scan from an older method is named as such until you scan again. New papers are compared after a run. The original papers, their full texts, figures, and data are outside an abstract comparison. A shared passage establishes shared wording under the stated normalization, and a person judges what it means.
