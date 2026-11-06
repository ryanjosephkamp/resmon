# `nltk-data/` — English sentence-tokenizer data

## Why this is committed

The packaged runtime includes punkt_tab from its build step. A source install without the data
uses the summarizer's simple sentence splitter, without downloading anything when the module loads.

J17 exercises punkt's sentence boundaries. `drivers/session.ts` copies this directory into the
session's own state directory and points `NLTK_DATA` at the copy before the backend starts.
The copy dies with the session, nothing is downloaded, and the network guard stays intact.
This fixture means J17 does not observe the fallback used when tokenizer data is absent.

## What is here, and where it came from

Copied verbatim from NLTK's own `punkt_tab` package as installed by
`python -m nltk.downloader punkt_tab` (the command `summarizer.py`'s own error message tells a user
to run):

```
tokenizers/punkt_tab/README                       the upstream's own README, byte-identical
tokenizers/punkt_tab/english/abbrev_types.txt
tokenizers/punkt_tab/english/collocations.tab
tokenizers/punkt_tab/english/ortho_context.tab
tokenizers/punkt_tab/english/sent_starters.txt
```

256 KB. **English only**: `nltk.sent_tokenize` defaults to English, which is the only language
this suite tokenizes. The other seventeen languages are 11 MB and none of them is exercised here.

`README` is upstream's and is not edited — it carries the models' attribution (Jan Strunk and Tibor
Kiss, and the per-language contributors and source corpora) and the citation for Kiss & Strunk
(2006). It is reproduced here exactly as NLTK ships it.

The downloaded `punkt_tab.zip` contains this README and model data, but no license file or explicit
license grant. Its [package metadata](https://github.com/nltk/nltk_data/blob/gh-pages/packages/tokenizers/punkt_tab.xml)
has no license attribute. NLTK's [dataset license table](https://github.com/nltk/nltk_data/blob/gh-pages/DATASET-LICENSES.md)
classifies `punkt_tab` as unclarified, unknown, ambiguous, or citation-only. The repository's
Apache License 2.0 does not establish a license for each data package; its
[licensing overview](https://github.com/nltk/nltk_data/blob/gh-pages/LICENSE-OVERVIEW.md) explicitly
distinguishes them. No tokenizer data here was modified.
