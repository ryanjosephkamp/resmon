---
title: "AI summarization"
summary: "The provider whitelist, configuring a remote, custom or local provider, fallback chains, using your own subscription as a lane, and per-execution overrides."
order: 11
readmeLines:
  - "1255-1428"
---
## AI Summarization

AI summarization is optional and fully bring-your-own-key. When the provider is unset, every pipeline call is a silent no-op and the Markdown report falls back to plain abstract extraction. Settings live under **Settings → AI** (`#/settings/ai`) and are persisted through `PUT /api/settings/ai`; the API key for the active provider is stored separately in the OS keyring through `PUT /api/credentials/{name}`.

### Provider Whitelist

The AI panel enforces the following provider whitelist (IMPL-AI5 / AI9 / AI10); each provider has a suggested model placeholder for the `ai_model` field:

| `ai_provider` | Kind | Credential name | Suggested model placeholder |
|---|---|---|---|
| `openai` | Remote (BYOK) | `openai_api_key` | `gpt-4o-mini` |
| `anthropic` | Remote (BYOK) | `anthropic_api_key` | `claude-3-5-haiku-latest` |
| `google` | Remote (BYOK) | `google_api_key` | `gemini-2.5-flash` |
| `xai` | Remote (BYOK) | `xai_api_key` | `grok-4` |
| `meta` | Remote (BYOK) | `meta_api_key` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| `deepseek` | Remote (BYOK) | `deepseek_api_key` | `deepseek-chat` |
| `alibaba` | Remote (BYOK) | `alibaba_api_key` | `qwen-plus` |
| `local` | Local (ollama) | — | `llama3` (set through `ai_local_model`) |
| `custom` | Remote (BYOK, user-defined HTTPS endpoint) | `custom_llm_api_key` | user-specified |

### Configuring a Remote Provider (OpenAI, Anthropic, and the rest)

1. Open **Settings → AI**.
2. Select a provider from the **Provider** dropdown (e.g. `openai` or `anthropic`). The **Model** placeholder updates to the provider's suggested id.
3. Enter the model id in **Model** (free text; the **Load models** button can populate a picker from the provider's catalog via `POST /api/ai/models`).
4. Enter the API key in the password field; press **Store key** to write it to the OS keyring as `<provider>_api_key`. The key is never returned to the frontend — subsequent loads only see a presence boolean from `GET /api/credentials`.
5. Click **Test key** to issue `POST /api/credentials/validate`, which performs a minimal round-trip against the provider.
6. Tune `ai_summary_length`, `ai_tone`, `ai_temperature`, and `ai_extraction_goals` to shape the prompt scaffolding in `prompt_templates.py`.
7. Click **Save** (`PUT /api/settings/ai`).

### Configuring the Custom Provider

The `custom` provider targets any HTTPS endpoint that accepts an OpenAI-compatible chat-completions request shape. Two extra fields apply:

- `ai_custom_base_url` — the endpoint root. The Save button is disabled unless the URL is HTTPS or the host is loopback (`localhost`, `127.0.0.1`, `::1`), enforced both by the frontend guard `validateCustomBaseUrl` and by the backend `llm_factory` as a hard check.
- `ai_custom_header_prefix` — the auth-header prefix applied to the stored `custom_llm_api_key` credential (e.g. `Bearer `).

### Configuring the Local Provider (ollama)

The `local` provider bypasses the key flow entirely and dispatches through `implementation_scripts/llm_local.py` against a local [ollama](https://ollama.com) daemon over its REST API (`/api/generate`, `/api/tags`).

1. Install ollama and start it (`ollama serve`).
2. Pull at least one model (for example `ollama pull llama3`, `ollama pull gemma3`, or `ollama pull qwen2`).
3. In **Settings → AI**, set **Provider** to `local`.
4. Enter the model tag (e.g. `llama3`) in the **Local model** field — this writes to the separate `ai_local_model` key introduced by IMPL-AI11 so the model id cannot drift into `ai_tone`. A one-shot migration heuristic (`looksLikeModelId`) moves a misplaced value from `ai_tone` into `ai_local_model` on first load.
5. Click **Load models** to pull the available-models list from the running ollama instance, or enter the tag manually.
6. Click **Save**.

No API key is required for `local`; `Test key` and `Store key` are hidden for this provider.

### Fallback Chains

One provider failing no longer costs you the run. Under **Settings → AI**, the
`If that fails, try…` section adds ordered fallback providers beneath the one you
selected. Leave it empty and resmon behaves exactly as it did before chains existed —
the stored chain is written only once you add a fallback, and a single-provider
configuration is read as a one-lane chain.

What separates a chain from a retry loop is that **not every failure means the same
thing**:

| Failure | Examples | What resmon does |
|---|---|---|
| **Lane-fatal** | rejected key, exhausted quota, model does not exist, provider unreachable | Retires that provider **for the rest of the run** and moves to the next |
| **Document-local** | abstract past the context window, content declined, a one-off `5xx` | Falls through **for that paper only**; the provider stays primary |

Both mistakes are expensive in opposite directions. Re-presenting a rejected key once per
paper burns an entire run rediscovering the same fact; abandoning a working provider
because one abstract was too long silently downgrades every summary after it.

Every attempt lands in `execution_ai` — one row per lane, with the provider, the model,
the credential **alias** (never the value), how many papers it summarized, and the
classified reason it stopped. A lane that was never reached is recorded as `skipped`
rather than omitted, because "not needed" and "not configured" are different facts. The
report header names the provider that **actually produced** the summaries, not the one
configured first.

### Your own subscription as a lane

resmon can run the agent CLI you already installed and signed into, so AI work is billed
to your existing **Claude Max** or **ChatGPT** plan instead of a metered API key. Add
`Claude Code (your Claude plan)` or `Codex (your ChatGPT plan)` in the `If that fails, try…`
chain. resmon drives the command; it never embeds provider sign-in, never sees your
credential, and never authenticates on your behalf. If the CLI is not signed in, the lane
reports that and stands down — it is not worked around.

**Where resmon looks for the command**, in order:

1. **A full path you set** in the lane's command-path box. Always wins.
2. **Known install locations** for your platform — `~/.local/bin/claude`, and for Codex
   the copy inside `ChatGPT.app`.
3. **`PATH`**, last.

That order is deliberate and the reason is worth stating. A macOS app launched from the
Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin`, because `launchctl getenv PATH` is unset
— and neither CLI is there. `claude` lives under a user-local prefix and `codex` lives
*inside* an application bundle, on no `PATH` at all. A `PATH`-first search works perfectly
in a terminal and fails in the installed app, so `PATH` is the last resort rather than the
first. Settings → AI shows which of the three found your command, and lists the paths it
searched when it found nothing.

**Two things to know before you select it.**

**It is the recommended route as of 1.8.5**, because batching made it affordable. Papers go
**five at a time in one call** rather than one session each, and measured against the same
abstracts one at a time, a paper costs **0.33× as much and 0.23× the input-side tokens** —
the constitution and the prompt scaffold are about 5,600 tokens paid once per call instead
of once per paper.

It still spends the same usage window you use for your own work, so the lane carries a
**per-run limit of 50 papers** by default, editable per lane. Reaching the limit is not an
error: the lane stands down, the remaining papers go to the next lane, and `execution_ai`
records the cap as the reason. A 200-paper sweep is still worth routing somewhere else.

Summaries are extracted through each CLI's structured output — `--output-format json` for
Claude Code, `-o` for Codex — rather than by scraping console prose. A batched call adds a
schema (`--json-schema` for Claude Code, `--output-schema` for Codex) describing one entry
per paper. The schema deliberately does **not** pin the number of entries: both CLIs
enforce an exact count by making the model *invent* the missing summary, which was
measured rather than assumed. resmon checks the count and the numbering itself, and a
paper the batch did not answer for is simply re-sent on its own. If the numbering is
inconsistent — the same paper answered twice, or a number outside the batch — the whole
batch is discarded and re-sent one paper at a time, because a summary attached to the
wrong paper is a quieter failure than none at all.

When the structured route yields nothing usable, resmon says *the CLI returned something
we could not use* and moves on. It never stores a salvaged fragment as though it were a
real summary.

Each call runs in a fresh empty directory with tools switched off (`--tools ""`) or the
sandbox pinned read-only (`-s read-only`). Abstracts are untrusted text fetched from the
internet and an agent CLI can run commands, so the summarizer is given nothing to run and
nothing to read.

**Choosing a model and an effort level.** A subscription lane offers both, and
the two commands can honestly offer different things. `codex debug models`
reports a real catalog — the models it lists, and per model the reasoning
levels that model supports — so resmon shows that catalog and offers only the
levels codex says each model takes. `claude` has no models-listing command, so
what resmon offers is the aliases its `--help` documents (`fable`, `opus`,
`sonnet`, `haiku`), labelled as exactly that: names the command accepts, not a
list of models your account can reach, which resmon has not checked. Both
dropdowns keep a saved value reachable even when the catalog does not list it,
because either command may accept names resmon cannot enumerate.

**Effort is offered only where effort exists.** The two agent CLIs take a
reasoning-effort level (`--effort` for Claude Code, `model_reasoning_effort`
for Codex). None of the eight API-key providers has an equivalent, so no
effort control is shown for them — a knob that silently did nothing for most
providers would be worse than no knob. Where a provider does have a thinking
control, it will be offered per provider once each has been verified. Leaving
effort unset means the command's own default, which for Codex is whatever your
`~/.codex/config.toml` sets: resmon will not override a preference you set for
yourself.

**"Where is the command?" is behind Advanced**, and opens by itself when
detection failed — which is the only time it matters. **Browse…** beside it
opens a file picker rather than asking you to type a path from memory. It shows
hidden files and lets you open an application bundle, because that is where both
commands live: `claude` under `~/.local`, which the Finder hides, and `codex`
inside `ChatGPT.app`, which macOS treats as a single file.

Ollama is the natural last lane: it needs no key and costs nothing. Note honestly that
**resmon has no summarizer beyond the lanes you configure.** If every lane fails, those
papers have no AI summary and the execution says why — there is no hidden extractive
fallback underneath.

A routine can carry its own chain through the `chain` key in its per-execution AI
override, exactly like `provider` or `model`.

### Per-Execution Overrides

Deep Dive and Deep Sweep expose an **Override AI settings for this run** disclosure that accepts per-execution overrides for length, tone, and model. Empty override fields fall through to the persisted `ai_*` settings. Overrides flow through the request body of `POST /api/search/dive` / `POST /api/search/sweep` and are consumed by `SweepEngine` for that one execution only.
