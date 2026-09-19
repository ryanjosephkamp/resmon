# Local API security model

resmon's renderer, its MCP server and its assistant all talk to the Python backend over HTTP on
`127.0.0.1`. Since 2.2 that API answers only requests that prove they belong to this app. This
page says what that defends against and — just as plainly — what it does not.

## What a request must carry

Every request, on every route, is checked by one raw ASGI guard (`LocalApiGuard` in
`resmon_scripts/implementation_scripts/api_auth.py`) that runs before CORS, before any request
body is read and before any route code:

1. **Host** must be `127.0.0.1:<the backend's own port>` or `localhost:<the backend's own port>`.
   Anything else is refused `403 host_refused`, even with a valid token. This is the
   DNS-rebinding defence: a page that rebinds its own hostname to 127.0.0.1 still sends its own
   name in `Host`.
2. **Origin**, when the request has one, must be exactly this app's renderer origin
   (`http://127.0.0.1:<renderer port>`, chosen at launch). Anything else is refused
   `403 origin_refused`, with no `Access-Control-Allow-Origin` on the answer. Requests with no
   Origin — the MCP server, curl, Electron's main process — are not browser requests and are
   judged on the token alone.
3. **`Authorization: Bearer <token>`** must carry this backend's secret: 32 bytes from the
   operating system's CSPRNG, compared in constant time. Missing is `401 token_missing`; wrong is
   `401 token_invalid`.

There are no exempt routes. `/api/health` needs the token too: every client that probes it reads
the token first. The exemption list is an explicit, empty constant, and a test fails if it grows.

A CORS preflight (`OPTIONS` with `Access-Control-Request-Method`) carries no credentials by
specification, so it is answered without the token — but only for the renderer's origin.
`Access-Control-Allow-Private-Network: true` is sent only on such a preflight that asked for it.
Before 2.2 it was on every response, alongside `Access-Control-Allow-Origin: *`.

Refusals use the app's usual shape: `{"detail": {"reason": "...", "message": "..."}}`.

## Where the token lives

- **Electron-spawned backend.** Electron mints the token and hands it to the backend in the
  child's environment, never in argv (argv is visible to every user through `ps`). The backend
  removes it from its own environment at start, so nothing it spawns inherits it. The renderer
  receives it from the preload over a synchronous IPC answered only to the main window's own
  frame; it travels only in the `Authorization` header, never in a URL.
- **Background daemon.** The daemon mints its own on every start.
- **`python resmon.py <port>`** with no token supplied (development, tests) mints its own.

In every case the backend writes the token to `<state dir>/api-token-<port>`, beside
`daemon.lock`, created owner-only (`0600`), and removes it on a clean shutdown. That file is how
clients that did not start the backend find it: Electron attaching to a daemon, and the MCP
server under your harness. The state directory is `RESMON_STATE_DIR` when set, otherwise
`~/Library/Application Support/resmon`, `$XDG_STATE_HOME/resmon` or `%LOCALAPPDATA%\resmon`.

A token file left behind by a crash never lets anything in: each start mints a fresh token, and
the backend accepts only the one it holds. A client reading a stale file gets `token_invalid`.

**The daemon and the renderer's origin.** A daemon starts before any window exists, so it cannot
be told the renderer's origin at spawn. When Electron attaches, its main process — holding the
token, sending no Origin — registers its renderer's exact origin with
`POST /api/auth/renderer-origin`. A browser request (one carrying an Origin) cannot register an
origin. The daemon keeps the eight most recent. A daemon that has published no token file (for
example one from before 2.2) is never attached to; the app starts its own backend and leaves the
daemon alone, exactly as it does for a daemon of a different version.

## The MCP server and the assistant

`mcp_server.py` finds the port as before (`RESMON_PORT`, then the port file, then the default
only when nothing named a port), then reads that port's token file. A named port whose token
cannot be found is reported as unavailable, naming the instance — it never falls through to
another port. If your harness runs resmon's MCP server against an instance with a non-default
state directory, set `RESMON_STATE_DIR` in the server's environment.

When the assistant starts the MCP servers through an agent CLI, the configuration it writes
names the port and the state directory — never the token. Tool results and relayed errors are
scrubbed of the token as a second layer.

## What this does not defend

- **Your own user account.** A process running as you can read the token file and the
  environment of the backend Electron spawned. It could also read the database directly. The
  token keeps out *other principals* — web pages in any browser, other users on the machine —
  not your own processes.
- **Windows file permissions.** The file is created with mode `0600`, which Windows largely
  ignores; there it relies on `%LOCALAPPDATA%` being private to your profile. No explicit ACL is
  set.
- **A token read out of memory or the renderer.** Anything that can run code inside the app's
  renderer can call the API as the app. Pages resmon shows but does not own — the blog
  `<webview>` and link windows — get no preload and cannot ask for the token.
- **Traffic on the wire.** The API is plain HTTP on the loopback interface. Loopback traffic does
  not leave the machine, but any local process with packet-capture privileges could read it.
