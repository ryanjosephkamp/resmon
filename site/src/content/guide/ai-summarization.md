---
title: "AI settings"
summary: "The three things in resmon that use a model: summaries, Ask, and embeddings. Connections, fallbacks, your own plan, and what each one sends."
order: 11
readmeLines: []
---
Three things in resmon use a model, and **Settings › AI** sets up all three:

- **Summaries** are written for the papers a run finds, when a search or a watch asks for them.
- **Ask** is the assistant. See [Ask and the MCP server](/resmon/guide/assistant/).
- **Embeddings** turn each paper's title and abstract into a vector, so Search can rank your collection by meaning, the map can place papers by meaning, and a watch's audit can compare what it finds with what you meant.

None of them runs until you set it up, and each works without the others. resmon bills nothing: you use a command you are signed into under your own plan, or a key you hold with a provider.

Each part says what resmon has checked about its connection. Finding a command is not knowing that anyone is signed into it, and a stored key is not one a provider has accepted.

## Connections

A connection is one of these:

| Connection | What it is |
|---|---|
| **Claude Code, on your Claude plan** | The `claude` command you installed and signed into |
| **Codex, on your ChatGPT plan** | The `codex` command you installed and signed into |
| **Anthropic**, **OpenAI**, **Google**, **xAI**, **DeepSeek**, **Alibaba** | A key you store for that provider |
| **Meta, through Together AI** | A Together AI key; the text goes to Together AI |
| **Local (Ollama)** | A model served on your computer, at `http://localhost:11434` unless you give another address |
| **A custom endpoint** | Any OpenAI-compatible base URL, and a key sent only there |

### The two commands

With **Claude Code** or **Codex** resmon runs the command you installed. It never embeds a provider sign-in, never sees your credential, and never signs in for you. The page checks whether the command is signed in by asking the command's own status command, with no model call and no cost. If it is not signed in, **Sign in** opens the command's own login in a terminal, or shows the command to run, and **Check again** asks again.

resmon looks for the command in this order, and stops at the first it finds:

1. The full path in the **Command** box, if you set one. If that path does not work, resmon says so and does not fall through to a different command. **Choose…** opens a file picker that shows hidden files and application bundles, which is where the commands live.
2. The places the installers put it.
3. Your `PATH`, last. An app launched from the Finder inherits a short `PATH` that holds neither command, so a `PATH`-first search would work in a terminal and fail in the app.

A command lane sends papers **5 at a time** in one call, and at most **50 papers per run**, unless you set **Papers per call** and **Most papers per run**. Reaching the limit is not an error: the papers past it go to the next fallback, and the run records why. This spends your own plan's usage, so a 200-paper sweep is worth routing somewhere else. Each call runs with its tools switched off and the sandbox read-only, because abstracts are untrusted text from the internet and a command can run things.

**Effort** and **Model** are offered for the commands. Codex reports a real catalog, with the effort levels each model supports, when you press **Load models**. Claude Code has no models-listing command, so resmon offers the aliases its help documents, labeled as exactly that: names the command accepts, not a list of what your account can use. Left blank, the command's own default applies, which for Codex is whatever your `~/.codex/config.toml` sets.

### Keys

A key goes to your system keychain (the macOS Keychain, Windows Credential Manager, or the desktop's keyring), never to resmon's database, and is sent only to its provider. **Store** and **Replace** write it, and the field is never filled in from the engine, because the engine never returns a key. **Test the stored key** asks the provider for its list of models: the answer says whether the key was accepted, refused, or could not be tested, which are three different things. Whether a provider lets a key use a given model shows on the first paper. **Load models** fills a picker from the provider's catalog; the model name is otherwise free text.

For a custom endpoint, the address must be `https://`. Plain `http://` is accepted only for `localhost`, `127.0.0.1`, and `::1`, so a key is never sent in the clear.

For Ollama, install and start it, pull a model, then choose **Local (Ollama)** and the model's tag. No key is needed.

## Summaries

The form chooses the **Provider** and **Model**, and below them **how each summary is written**:

- **Length:** Brief (about 40 to 80 words), Standard (about 120 to 180), or Detailed (about 250 to 450).
- **Tone:** Technical (the field's own terms), Neutral, or Accessible (jargon explained).
- **Temperature**, sent to OpenAI, Google, xAI, Meta's models, DeepSeek, Alibaba, and a custom endpoint. Anthropic, Ollama, and the two commands use their own.
- **What to draw out:** what to ask of each abstract, in your words, separated by commas. The default is key findings, methodology, contributions.

Every part is also what a run or a watch can override. **Summarize each paper** is off by default on a search and a watch. Turning it on offers **As in Settings › AI** or **One for this run** (or **this watch**), which has its own provider and model, and a section to change the wording for that run or watch alone. An override that names a provider runs that connection alone. A blank field means "as Settings › AI has it when the run starts".

Summaries are written for the papers of a run and live in that run's report. resmon keeps no summary on the paper itself, so Today, Search, and the reading queue show the opening of the abstract, labeled as such. A paper that cannot be summarized is kept without a summary, and the run's log says why.

### Fallbacks

Under the form, **Add a fallback** adds connections to try, in order, when the one above cannot summarize a paper. Not every failure means the same thing:

| Failure | Examples | What resmon does |
|---|---|---|
| Fatal to the connection | A rejected key, an exhausted quota, a model that does not exist | Sets that connection aside for the rest of the run and moves to the next |
| Local to one paper | An abstract longer than the model's window, content the provider declined | Tries the next connection for that paper only, and keeps the first one primary |

Re-presenting a rejected key for every paper would burn a whole run rediscovering one fact. Abandoning a working connection over one long abstract would quietly downgrade every summary after it.

Every attempt is recorded: which connection, the model, how many papers it summarized, and why it stopped. A connection never reached is recorded as skipped, not left out, because "not needed" and "not configured" are different facts. A run's page states all of this under **Summaries**. There is no summarizer beyond the connections you set up. If every connection fails, those papers have no summary and the run says why.

## Ask

This part holds what a **new** conversation starts with: **Connection** (Claude Code, Codex, or an API key), **Provider** for a key, **Model**, and **Effort**. A conversation keeps the choices it began with, so changing these changes no conversation already started. The two commands are checked for sign-in here too, and below the form each way the assistant can run is listed with whether it is available and why not.

With **An API key**, the default provider is the one summaries use. Codex gets resmon's read tools only; see [Ask and the MCP server](/resmon/guide/assistant/).

## Embeddings

**Embed papers so Search can rank them by meaning** turns the feature on. Once a model is saved, each run embeds the papers it collects. The papers already in your collection are embedded only when you start that.

Four facts are always shown, so the feature never claims more than it has:

- **Embedded:** how many papers have a vector from the model set.
- **Missing:** how many do not, and why where resmon knows. Missing papers stay searchable by their words and are listed last when the collection is ranked by meaning.
- **Similarity index:** whether the `sqlite-vec` extension loaded, and what it holds. Vectors live in a plain table any SQLite can read; the index is rebuildable and never the only copy.
- **In Search:** whether ranking by meaning is on, and if not, the reason you can act on.

The provider list says which can embed. **Local (Ollama)** comes first because it is free and sends nothing anywhere. OpenAI, Google, xAI, Meta's models through Together AI, and Alibaba serve embeddings. DeepSeek and a custom endpoint are listed as **unverified**: resmon could not establish whether they serve embeddings, so **Probe** them with a key. **Anthropic, Claude Code, and Codex cannot embed**: Anthropic offers no embeddings API, and neither command has a command for it, so a subscription that covers your summaries does not cover search by meaning. They are listed, disabled, with the reason, not quietly omitted. The default local model is `nomic-embed-text`; if the probe says your chosen model cannot embed, run `ollama pull nomic-embed-text` and choose that.

**Probe** asks the lane to embed one short string and reports what happened. **Save** refuses a provider that cannot embed.

For papers already collected, **Embed N papers** first shows the cost: the papers, the tokens, the money where resmon has a price, and the disk. It can be stopped and started again freely, because it resumes from what is missing rather than from where it stopped. A batch already sent is finished and kept. **Rebuild** remakes the similarity index from the vectors.

What is sent: each paper's title and abstract go to the embedding provider, after every run and during a backfill, and a search by meaning sends what you typed. With a local model nothing leaves the computer unless you gave resmon another address for it.
