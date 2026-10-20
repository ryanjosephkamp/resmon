---
title: "The assistant and MCP"
summary: "The in-app assistant, the tools it is given, and driving resmon from an external AI harness over MCP."
order: 5
readmeLines:
  - "224-398"
---
### The assistant

Every page has a **✦ Ask** button in the corner. It opens a panel that can do what you
could do in the interface — set up and adjust routines, run a sweep, find papers in the
corpus you already have, read what a run found and why, export references, change
settings — by being asked in words.

It runs the **`claude` command you already installed and signed into**, so it draws on
your existing plan rather than a metered key, and resmon never sees your credential. If
the command is not there, or is not signed in, the panel says so and says where to fix
it; it does not quietly disappear.

The panel has an opaque reading surface and a visible message field. When available, opening it puts
keyboard focus in the composer; closing it returns focus to Ask. Enter sends, Shift+Enter
adds a line, and Stop remains below the scrolling conversation. Earlier conversations
reopen from the header; Allow and Deny stay explicit on each permission card.

Choose **Connection**, **Model** and, for Claude Code, **Effort** before sending.
Choices are fixed for that conversation; **Change choices · new empty conversation**
starts with no copied messages or native session. Global Settings remain defaults for
future chats, and changing them cannot retarget an existing conversation or active turn.
Claude suggestions are aliases, not an account-verified compatibility list. Blank CLI
model/effort omits that flag and leaves the native default unknown. API effort is not
supported by the current adapter. Codex and Ollama assistant adapters are unavailable.
Readiness describes local prerequisites; authentication and model acceptance are checked
only when you send. A refusal does not switch to another model or connection.

Older chats have unknown historical choices. Their first continuation asks for explicit
confirmation: an API conversation sends saved user/assistant text to the chosen future
provider, whose predecessor is unknown; Claude starts a fresh native session without
sending the earlier local messages. Those messages remain readable and exportable.
Changing runtime kind starts an empty conversation. Requested choices and literal model
reports are shown separately in Ask, Chats and exports; reports do not prove execution,
effective effort, completion or billing. See the [choices contract](docs/api-contract/assistant-choices.md).

**Chats** in the sidebar finds saved conversations beyond the Ask history drawer.
Browse newest-created pages or filter saved titles; Refresh includes new chats.
Select a transcript, then **Continue in Ask** to open that same local conversation
without sending anything. While Ask answers, other chats remain readable/exportable;
finish or stop the active answer before continuing another chat.

**Export Markdown** and **Export JSON** explicitly download the selected persisted
transcript. These are point-in-time copies, possibly incomplete: live fragments and
pending approval cards are excluded, historical completion is unknown, and recorded
metadata may be absent. Recorded cost does not establish billed cost. Includes saved
messages and tool data; review before sharing. Each format refuses output above 8 MiB
without truncation. Reading/exporting saved chats does not require an available CLI.
See the [conversation read/export contract](docs/api-contract/assistant-conversations.md).

Four things about it are structural rather than promised:

- **Everything it tells you came from a tool call it made.** It has no other source. When
  a tool returns nothing, "nothing was returned" is the answer, with the recorded reason
  or a statement that none was recorded — the same distinction the rest of resmon draws.
- **Anything that changes something waits for you.** A write is shown as a card with the
  exact call on it and does not run until you press Allow. That is enforced outside the
  model: the assistant is given the read tools and no others, and every other call goes
  through a permission tool resmon serves and the model cannot invoke.
- **It cannot reach a credential.** No tool returns an API key, and no tool can name one.
  Delete, erase, factory reset, credential writes, service install and cloud linking are
  absent from its tools entirely; asked for one, it tells you to do it in the app.
- **A turn has a spending ceiling** the CLI enforces on itself, set from measuring ten
  canonical requests. A runaway answer is stopped and says so rather than quietly costing
  a usage window.

Paper text — titles, abstracts, anything fetched from the internet — is data it reports
on, never an instruction it follows. Its own rules arrive above the conversation on the
CLI's system channel rather than beside the text, and a test asserts that at the boundary
the command is actually built.

Conversations are kept, so closing resmon and coming back opens them where you left off.
If the CLI itself has lost a conversation — you cleared its history, or restored resmon's
database onto another machine — the next thing you send is answered in a fresh session and
the panel says so in place; your earlier messages stay on screen, and the assistant can no
longer see them.

Codex is **not** offered for the assistant: resmon can give a Codex session its own tools
but cannot take away Codex's shell, and there is no way for you to approve a command
before it runs. Codex remains available for summarising papers, where it is given no
tools at all.

**No CLI? Use a key instead.** Under Settings → AI → Assistant you can run the assistant on
an API key of your own — Anthropic, OpenAI, Google, xAI, Together, DeepSeek, Alibaba, or a
custom OpenAI-compatible endpoint. It is the same panel, the same tools, the same
confirmation card, and the same rules on the same system channel; resmon runs the tool loop
itself rather than handing it to a CLI. Three things differ, and resmon says all three:

- **It reports tokens, not money.** A provider API reports token counts and resmon does not
  maintain anyone's price list, so a turn shows what it consumed and not what it cost. A
  computed figure would be a number nobody measured.
- **A turn stops after eight tool steps or 100,000 tokens.** The CLI enforces a dollar
  ceiling on itself; here the ceiling is on the two things resmon can actually count. Both
  numbers are twice the largest of the ten requests measured for v2.0.0.
- **It remembers what was said, not what the tools returned.** A provider API keeps no
  session, so resmon replays the conversation — your messages and its replies. The raw tool
  output behind an earlier answer is not sent again, so a long conversation does not re-send
  a corpus and text from a paper does not follow you from turn to turn.

Whether each provider supports tool calling at all is recorded with the evidence that
established it, and a provider resmon could not establish an answer for says so rather than
guessing — the same three states the embedding lane uses.

### Driving resmon from your AI harness (MCP)

resmon ships an **MCP server**, so a harness you already work in — Claude Code, Codex, or
anything else speaking the Model Context Protocol — can read and control resmon without you
leaving it. The full tool surface is specified in
[`docs/api-contract/mcp.md`](docs/api-contract/mcp.md).

```bash
python3 resmon_scripts/mcp_server.py
```

It speaks MCP over stdio and is a **client of the running resmon backend**, reaching it over
`127.0.0.1`. It never opens the database directly: the backend owns its connections and its
scheduler, and going through the API means the tool surface cannot drift from what the app
itself does. **resmon must be running.** If it is not, every tool returns one clear error
rather than an empty result — a harness told "you have no papers" because the app is closed
would repeat that to you as fact.

To register it with Claude Code:

```bash
claude mcp add resmon -- python3 /full/path/to/resmon_scripts/mcp_server.py
```

Twenty-five tools cover search (keyword and semantic), similar papers, sources, routines,
executions, match transparency, paper lifecycle, analytics, the watchdog and reference
export, plus seven that change something: `run_sweep`, `create_routine`,
`create_watch_profile`, `run_routine`, `activate_routine`, `deactivate_routine` and
`update_settings`.
`create_routine` takes an optional `intent` — the sentence the coverage audit compares
against — and `get_routine` returns that audit's summary alongside the configuration.

**Every tool says whether it needs a person.** `tools/list` carries
`requires_confirmation` on all twenty-five — `true` on the seven above, `false` on the
eighteen reads — so a harness knows which calls to put in front of you before running
them, rather than inferring that an unmarked tool is safe.

**Nothing destructive is exposed** — no delete, no erase, no factory reset, and no tool
that reads or writes an API key. A routine created through a tool is created
**inactive**; putting something on a schedule on your machine is not a side effect a
tool call gets to have, which is why turning one on is its own confirmed tool.
`update_settings` can change seven groups of preferences and **cannot name a credential**:
a key called anything like `api_key`, `token`, `secret` or `password` is refused before a
request is even built, because resmon's keys live in your system keychain and are not
settings.

Finding the right resmon matters more than it sounds: the server checks `RESMON_PORT`, then
the port file the backend writes beside its database, and nothing else. A port that was named
and is not answering is reported as unavailable rather than widened — otherwise a harness can
silently attach to a different resmon installation and answer truthfully about the wrong
corpus. When neither names a port the server refuses in the same way, saying which two things
name one and that it did not guess; it used to fall back to resmon's default port, which on a
machine running resmon's background service meant answering about that service's corpus.

**The backend asks every caller for its local API token** (2.2), and the MCP server reads it
from the owner-only file the backend writes beside its daemon lock, `api-token-<port>` in
resmon's state directory. Nothing needs configuring for the installed app. For a development
instance with its own state directory, set `RESMON_STATE_DIR` for the MCP server too — and
`RESMON_PORT` or `RESMON_PORT_FILE` as well, because the port file follows the database
rather than the state directory, so naming one does not name the other. A named port whose
token cannot be found is reported as unavailable, naming that instance. See
[`docs/local-api-security.md`](docs/local-api-security.md).

**If you run the MCP server from a separate checkout, update it in the same sitting as the
app.** A pre-2.2 MCP server sends no `Authorization` header, and no route is exempt — not
even `/api/health` — so every call it makes to a 2.2 backend is refused with
`401 token_missing`.

### Running a routine on demand

`POST /api/routines/{id}/run` runs a saved routine immediately, outside its schedule. It is a
thin wrapper over the same dispatcher the scheduler uses, so a manual run and a scheduled fire
cannot drift apart, and the run is recorded against the routine like any other.

An **inactive** routine does run, and the response says so. `is_active` controls whether the
scheduler fires a routine on its own; it is not a statement that the routine may never run.
