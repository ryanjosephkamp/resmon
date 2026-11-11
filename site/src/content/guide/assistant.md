---
title: "Ask and the MCP Server"
summary: "The assistant, what it can and cannot do, and driving resmon from another program over MCP."
order: 10
---
**Ask** is an assistant for questions about your own monitoring: what a watch found, why a paper is in your collection, which sources failed last night. It answers from resmon itself, through the same tools an outside program can use over MCP. Anything that would change something waits for you.

## Conversations

The rail on the left of **Ask** lists your conversations, newest first, with **Older Conversations** below. **Filter by title** narrows the list. **New Conversation** (⇧⌘N) starts a fresh one. Every conversation is kept, so closing resmon and coming back opens it where you left off.

The message box at the bottom takes your question. Enter sends it, Shift+Enter adds a line, and ⌘/ (Ctrl+/) puts the cursor in the box from any screen. **Stop** ends an answer in progress. One answer runs at a time in a window, and leaving Ask does not stop it. A conversation answers one message at a time wherever it is open: open in another window while it answers, it says so, holds **Send**, and shows the answer when it ends.

### Choosing a Connection

Before you send the first message of a new conversation, three choices appear: the **Connection**, the **Model**, and the **Effort**. They are fixed when the first message is sent, and they stay with that conversation whatever the defaults do afterward. Changing them in **Settings › AI** changes only conversations you start later.

- **Connection** is **Claude Code** (the `claude` command), **Codex** (the `codex` command), or an API key for a provider you have stored a key for. A connection that is not set up is marked "needs setting up", and the box says why and links to **Settings › AI**.
- **Model** is sent as you type it. The Claude names offered are aliases the command accepts, not a list of what your account can use, and Codex's are what its own catalog lists once you press **Load Models**. Left blank, the command's default is used, and resmon says it does not know which that is.
- **Effort** applies to the two commands. An API key connection has no effort setting, and the form says so.

For the two commands, resmon runs the command you installed and signed into. It never sees your sign-in. The panel checks whether the command is signed in and, if it is not, offers **Sign In**, which opens the command's own login. See [AI Settings](/resmon/guide/ai-summarization/).

Each answer shows what was requested and what the runtime reported, as two separate claims. A report of the model that answered is not proof of what ran, of the effort used, of completion, or of billing. Where the runtime names no model, the answer shows the one resmon asked for, said as a request ("gpt-5.5-codex as requested; Codex did not report the model"), or that the runtime's own default answered. For an API key or Codex, the answer reports tokens, not money, because a provider reports tokens and resmon does not keep anyone's price list.

### What It Can Do, and What Waits for You

Everything the assistant tells you comes from a tool call it made. It has no other source. When a tool returns nothing, "nothing was returned" is the answer, with the recorded reason or a statement that none was recorded. Paper text, such as titles and abstracts, is data it reports on and never an instruction it follows.

The tools are the 26 below, and one more inside a conversation with an attached file. Nineteen read: health, listing your collections, searching a collection (by words or by meaning), finding similar papers, listing sources, watches, and runs, reading a run and its results and its search record, explaining why a paper matched, a paper's retractions and updates, analytics, the Watchdog's findings, exporting references, and reading people and their matches. The twentieth read, `read_attached_file`, reads the text of a Library file attached to the conversation, and is offered only there. Seven change something: `run_sweep`, `create_routine`, `create_watch_profile`, `run_routine`, `activate_routine`, `deactivate_routine`, and `update_settings`. The assistant and the HTTP API call a watch a *routine*.

Ask works in the collection of the window you ask from. A search, a summary of analytics, or a person's matches reads that collection unless you name another, and a sweep it starts puts its papers there. Each answer names the collection it read. From a program outside resmon, a tool that names no collection reads the default one.

When the assistant wants to use one of the seven, a card appears with the exact call, and **Allow** and **Deny** buttons. Nothing runs until you answer, and the card cannot be dismissed without an answer, because the assistant is waiting on it. This is enforced outside the model: on Claude Code the read tools are pre-approved by name and every other call goes through a permission tool that resmon serves and the model cannot invoke, and on an API key resmon runs the tool loop itself and pauses at the same card.

**Codex gets the read tools only.** `codex exec` has no way to hold a call for your approval, so a Codex conversation cannot create, run, or change anything, and resmon tells Codex to run its read tools without asking. Its shell, web search, sub-agents, and the rest of its own tools are switched off, it runs in a read-only sandbox, and resmon stops a turn the moment Codex runs a command, changes a file, calls a tool from any other server, or takes any step resmon does not know. When Codex says it has none of resmon's tools for a turn (its code mode, which its models use to call every tool, failing closed; a call held for an approval nobody can give; or resmon's server not starting), resmon stops the turn and says so in plain words as a problem with the connection, with what to do, rather than show an answer written without them. resmon's options for Codex were checked against codex-cli 0.167.0; a Codex that does not accept one is asked to be updated. Make changes in resmon itself, or in Ask on Claude Code or an API key.

Some things are not tools at all. There is no delete, no erase, no factory reset, no credential tool, and no service install. Asked for one, the assistant tells you to do it in the app. No tool returns an API key or can name one.

A turn has a ceiling so a loop cannot run away. On Claude Code the command enforces a dollar limit of $0.75 on itself. On an API key a turn stops after 8 tool steps or 100,000 tokens. Both are stops for runaways, not quotas.

An API key connection also does not remember tool output. A provider keeps no session, so resmon replays your messages and the assistant's replies, not the raw results of earlier tool calls. That keeps a long conversation from re-sending your collection, and keeps text from a paper from following you from turn to turn.

### Ask About This Paper

**Ask About This Paper**, on a paper’s page and in the Evidence reader, opens a new conversation with an editable question about that record or exact file version. The conversation names the title and, where one is known, the file. **Send** creates the named conversation, attaches the file at the version you saw, and sends the question as edited; opening it sends no message and starts no model. Without an available connection, the control points to **Settings › AI**.

**An attached file is the only file Ask can read.** In a conversation with an attached file, the assistant reads it with `read_attached_file`: one page at a time, up to 12,000 characters per call, by the same page text Evidence uses. A PDF has up to 200 pages; a text, Markdown, or TeX file is one page. Text read from a PDF can leave out or reshape tables, equations, columns, and images, and there is no OCR, so the question asks the assistant to say which pages it read and what it could not. Every other file in your Library stays out of reach: the tool refuses a file that is not attached, and a file whose version changed since it was attached is not read. The conversation's header names the attached file. A paper with no Library file is answered from its record, and the composer says so before you send. The file's text is data the assistant reports on, like a paper's abstract, never an instruction it follows. A program connected through the MCP server is not offered the tool.

### Saved Conversations

A conversation's header offers **Export Markdown**, **Export JSON**, and **Delete**. An export holds the saved messages only: a point-in-time copy, which can be incomplete (live fragments and pending cards are not in it), and which does not establish whether the conversation completed. It is refused above 8 MiB instead of being truncated, and it includes tool data, so review it before sharing. Reading and exporting saved conversations needs no available command. See the [conversation read and export contract](docs/api-contract/assistant-conversations.md).

## The MCP Server

resmon ships an MCP server, so a program you already work in can read and control resmon. The server speaks MCP over standard input and output, with the 26 tools above, and the full surface is specified in [`docs/api-contract/mcp.md`](docs/api-contract/mcp.md).

It is a client of the running resmon, reaching it over `127.0.0.1`, and it never opens the database. **resmon must be running.** When it is not, every tool returns one structured error rather than an empty result, because a program told "you have no papers" because the app is closed would repeat that to you as fact.

The server needs Python with the packages in `requirements.txt`. From a clone, that is the virtual environment's interpreter. The installed app carries its own: on macOS, inside the app, the interpreter is `resmon.app/Contents/Resources/backend/python/bin/python3` and the server is `resmon.app/Contents/Resources/backend/resmon_scripts/mcp_server.py`.

**Naming the resmon to talk to is required.** The server tries `RESMON_PORT` first, then the port file a running resmon writes. It has no default-port candidate and does not read the service's lock file. To keep it on one instance, make the environment port and `RESMON_PORT_FILE` name that same instance: an unanswered environment port does not prevent trying the file's port. **Health › This Engine** and **Settings › In the Background** show the address the window is using. A typical entry for a program that reads an `mcpServers` list is:

```json
{
  "mcpServers": {
    "resmon": {
      "command": "/full/path/to/resmon/.venv/bin/python",
      "args": ["/full/path/to/resmon/resmon_scripts/mcp_server.py"],
      "env": { "RESMON_PORT": "8742" }
    }
  }
}
```

Replace `8742` with the port the window shows. The backend asks every caller for its local API token, and the server reads it from the owner-only file `api-token-<port>` in resmon's state directory, so nothing needs configuring for an installed app. For an instance with its own state directory, set `RESMON_STATE_DIR` for the server too. See [`docs/local-api-security.md`](docs/local-api-security.md).

**Every tool says whether it needs a person.** `tools/list` carries `requires_confirmation` on all 26: true on the seven that change something, false on the nineteen reads. A program that does not enforce it is running writes the contract says a person approves first; the server itself applies no gate.

- **Nothing destructive is exposed.** No delete, no erase, no factory reset, and no tool that reads or writes an API key.
- **A watch created through a tool is created inactive.** Putting something on the schedule on your machine is not a side effect a tool call gets to have, so turning one on is its own confirmed tool.
- **`update_settings` can change only 20 settings.** They are an allowlist, in six groups (AI, assistant, email, embeddings, storage, and notifications); every other setting is refused by name. A tool may change what resmon says (which model, which ceilings, what is retained, what is notified), and may not change where resmon sends things, what it runs, where it writes, what it is told, or whether you are told how a result was produced. A key named like `api_key`, `token`, `secret`, or `password` is refused before any request is built.

`health` and `get_execution` also accept an optional `expected_runtime_id`. Read the runtime id from **Health › This Engine** (or from `health`'s `identity.runtime_id`), pass it in, and a mismatch refuses the read. That confirms the program is talking to the process you meant, which a port number alone does not. It does not authenticate a hostile local service.

## The Command Line

The `resmon` command is a second way in, with no model involved. It prints what resmon recorded, in the app's words, and never opens the database. See [Install and Launch](/resmon/guide/install/).
