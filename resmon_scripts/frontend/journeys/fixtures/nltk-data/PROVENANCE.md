# `nltk-data/` — the one tokenizer the app looks for at import

## Why this is committed

`resmon_scripts/implementation_scripts/summarizer.py` calls
`nltk.data.find("tokenizers/punkt_tab")` **at import time** and, on a miss, calls
`nltk.download("punkt_tab", quiet=True)` — which fetches
`https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/index.xml` and then the corpus.

That module is imported inside the launched backend the moment a run has AI summarization enabled,
which in this suite is J17 and only J17. On a machine whose NLTK cache is warm — a developer's
laptop, usually — nothing happens. On a CI runner, or a fresh install, the app reaches the internet
during a user's run, the journeys launch guard refuses the connection, and J17's own
"nothing left this machine" assertion fires.

The guard is right and the row is right. So the suite gives the launched app the data instead:
`drivers/session.ts` copies this directory into the session's own state directory and points
`NLTK_DATA` at the copy, before the backend starts. The app then finds the tokenizer where it
already knows to look and never reaches out. Nothing is downloaded, in CI or anywhere else, and
the guard is not weakened by a single permitted exception.

**This is also a finding about the app, not only about the suite**, and J17 prints it on every run:
a local-first desktop application performs a network download at import when this data is absent.
An offline first run must not depend on it. That belongs to 3.0 and to the register, not to a
fixture directory.

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

256 KB. **English only**: `nltk.data.find("tokenizers/punkt_tab")` resolves the *directory*, so the
import-time check passes, and `nltk.sent_tokenize` defaults to English, which is the only language
this suite tokenizes. The other seventeen languages are 11 MB and none of them is exercised here.

`README` is upstream's and is not edited — it carries the models' attribution (Jan Strunk and Tibor
Kiss, and the per-language contributors and source corpora) and the citation for Kiss & Strunk
(2006). It is reproduced here exactly as NLTK ships it.

Punkt and the NLTK data collection are distributed under the Apache License 2.0, as NLTK's own
`nltk_data` repository states. No file here was modified.
