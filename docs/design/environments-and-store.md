# Environments, remote access and Glade's own conversation store

Status: **proposal** (2026-09-27). Nothing here is built yet. The work is queued as PLAN.md I-121–I-127 and waits for the user's "go".
Sources: user request 2026-09-27; research reports on T3 Code (github.com/pingdotgg/t3code, MIT, commit d15210c), on Tailscale (docs and source), and a survey of Glade's code.

## 1. What we want

- **Environments.** Every Glade server is an *environment*: a machine with its own files, agents, settings and chats. Out of the box you only use your own environment. A setting ("Remote access") lets this machine accept other devices, and lets this app connect to other environments. Example: the Mac Studio runs the agents; the MacBook and later the phone connect to it.
- **Transports are pluggable**, like harnesses. The first one is **Tailscale**, which handles encryption and connectivity. LAN, Cloudflare Tunnel or SSH can come later without changing the rest.
- **Pairing and revocation belong to Glade**, not Tailscale. The host creates an invite shown as a QR code (for the phone) and as a link or code to copy (desktop to desktop). The handshake is built into the invite. The host lists paired devices and can revoke any of them.
- **A project belongs to exactly one environment**, because it's that machine's files. This is chosen when the project is created and can't be changed. Existing projects are filled in as belonging to this Mac. Choosing a folder on another environment needs Glade's own folder browser.
- **The UI shows which environment you're on.** Main place: the chat header, next to the location badge. Secondary: a small label on project groups in the sidebar, only when more than one environment is connected.
- **Glade stores conversations itself**, in one SQLite database and in one normalized format for every harness (pi, ACP, later Claude Code or Codex). We keep each harness's own session id or file only to resume it.
- **Every change streams to every connected client.** If three devices are connected to the Mac Studio, all three see each token, tool call and title change live, and catch up after a drop.

## 2. What we learned

**T3 Code** (ideas, not code):
- Each server has a **permanent environment id**, separate from the addresses used to reach it. All references are `{environmentId, id}`.
- **Pairing** uses a one-time grant that lasts 5 minutes. It's sent as a URL with the secret in the `#fragment` (the fragment never reaches a server), shown as a QR code or link. The client exchanges it for a **revocable session** with a label, device type and last-seen time. Long-lived tokens never go into WebSocket URLs; the client gets a short-lived socket ticket over HTTP instead.
- Tailscale is **just another address** for normal pairing, set up through `tailscale serve`. LAN, SSH and their own tunnel are the same kind of thing.
- **SQLite** (built-in `node:sqlite`, WAL mode, versioned migrations).
  - An **event log** with a global `sequence`, plus projection tables (threads, messages, turns, pending approvals).
  - The event, its projections and the command receipt commit in one transaction; changes are published only after commit.
  - Streaming text is written at paragraph boundaries rather than per token.
  - Each adapter keeps an **opaque resume cursor** (`{resume: sessionId}`), and provider files are **only an import source**.
- **Sync:** the client subscribes with `afterSequence`. The server replays what was missed, or sends a snapshot if the gap is over 1,000 events, then marks "live". Clients drop duplicate sequence numbers. Live updates are batched every ~50 ms with a size limit per client.
- **Folder picking** is one `browse(partialPath)` call that returns directories only, used as autocomplete.
- **Their open bugs to learn from:**
  - Lists go stale after an unreliable Tailscale link.
  - Only one address per environment, so there's no LAN → Tailscale fallback.
  - Session lifetimes are inconsistent between credential types.
  - CORS broke remote desktops.
  - Settings changed on a client didn't reach the remote host.

**Tailscale:**
- For v1, use the Tailscale app the user already has.
  - Glade keeps listening on loopback only.
  - When the user enables remote access, Glade runs `tailscale serve --bg --https=<port> http://127.0.0.1:<glade>`. This gives real HTTPS at `https://<mac>.<tailnet>.ts.net`, reachable only from the tailnet.
  - Disabling runs `… off`. Glade reconciles the serve setting at startup and **never uses funnel**.
  - If the tailnet has HTTPS turned off, Glade falls back to the tailnet IP `100.x` over plain HTTP, which is fine for desktop clients but not for iOS.
- **Identity:** Tailscale's `Tailscale-User-Login` headers and `whois` are only *hints* to show and log. They identify a user, not a device, and are missing for tagged or shared devices.
- **Once serve is on, loopback no longer means "local owner"**: proxied remote requests also arrive from 127.0.0.1. Local requests need their own secret.
- Embedding Tailscale (tsnet) would mean a Go sidecar of about 20 MB+ and a second tailnet node. That's deferred, unless Glade is ever sandboxed or the user doesn't have Tailscale.
- **Risks:**
  - Machine names appear in public Certificate Transparency logs.
  - Chrome sometimes rejects brand-new certificates.
  - WebSockets through serve can drop, so we need pings and reconnect.
  - Anyone on the tailnet can reach the port, so **pairing is the real security boundary**.

**Glade today** (survey), the assumptions that break:
1. The web app only ever talks to the server it was loaded from: relative `/api` and `/ws`, `window.location`.
2. Security is "loopback Host/Origin only". There's no login and no CORS.
3. Tauri's permissions are limited to loopback origins.
4. The folder picker, Open in VS Code, Show in Finder and export run on the server's Mac (osascript, `open -a`, `~/Downloads`).
5. Paths shown in the UI are the server's paths.
6. The socket has no sequence numbers or replay: a reconnect refetches whole chats.
7. pi message ids are positional (`h<i>` for history, `m<n>` live) and change between a live run and a reload.
8. JSON files, a mkdir lock and a file watcher (I-062) keep two servers on one data folder in sync.
9. Sub-agent reports live only as prompt text in pi's files.
10. localStorage and `GLADE_URL` assume one local origin.

## 3. Design

### 3.1 Glade's store (SQLite): `<dataDir>/glade.db`

- **Engine:** `node:sqlite` (built into Node; no native addon to bundle or sign), WAL mode, `busy_timeout`, and migrations numbered and compiled into the server. The minimum Node goes from 22 to **22.13** (where `node:sqlite` needs no flag); the user has 24.
- **Scope:** all app data lives here, not only conversations. That covers projects, workspaces, sessions, agents, summaries, the search index, devices and pairing. `settings.json` also moves in, with a JSON export. On first start the JSON files are imported once; the originals are kept as `*.json.bak`.
- **Conversations**, one normalized model for every harness:
  - `messages(id TEXT PK, session_id, seq, role, created_at, updated_at, status, payload_json)`: one row per `TranscriptMessage`, with **stable Glade ids** (ULIDs) assigned when a message starts. `payload_json` is the protocol type, versioned.
  - `sessions.harness`, `sessions.resume_json`: an opaque per-adapter resume cursor. pi stores `{sessionFile}`, ACP stores `{acpSessionId}`.
  - Sub-agent reports and messages get their own kind (`agent_message` with from, to and kind) instead of being parsed from prompt text. The text sent to the harness doesn't change.
- **Event log:** `events(seq INTEGER PK AUTOINCREMENT, at, scope, session_id?, type, payload_json)`. Every change a client could see is appended here, in the same transaction as its row changes, and published only after commit. That includes message starts, updates and ends, session, workspace and project upserts, settings, and devices.
  - Text deltas are merged before they're written: at most every ~250 ms, or at paragraph boundaries.
  - Old events are pruned after N days or M rows. Clients that fall further behind get a snapshot.
- **Write point:** `LivePool.handleEvent` after `applyAgentEvent`. Every harness already passes through it, so this is where messages get their ids and where rows and events are written.
- **Readers:**
  - Transcript, search, titles, Ask/`find_chats`/`read_chat`, dormant sub-agents and read-only-elsewhere views read from the store.
  - `AgentHarness.readTranscript`/`readSessionText`/`statSession` become **import-only**.
  - ACP's `acp-sessions/*.json` is folded in and removed.
- **Importing existing chats:** at first start, a background job imports every known session's pi JSONL through `transcriptFromPiSession`, oldest first. The UI works during the import: an old chat that hasn't been imported yet is imported when it's opened.
  - If pi's file changes outside Glade (for example after resuming it in a terminal), Glade notices by mtime and size and re-imports it: turns missing from the store are added, and Glade's ids are kept.
- **Several servers on one data folder (I-062)** keep working. SQLite handles concurrent access (WAL). Watching the JSON files is replaced by each server reading new rows from `events` (a cheap `seq > last` poll). Leases stay, because a pi process still owns its session file.

### 3.2 Sync to every client

- One socket per client per environment. On connect, the client sends `subscribe {afterSeq}`. The server replays `events` after that point, or sends `snapshot` if the gap is too big or the rows are pruned, then `live`. Every push carries `seq`. Clients ignore duplicates and ask for a replay if there's a gap.
  - The "shell" scope is always subscribed: projects, workspaces, session list, settings, agents.
  - Transcripts are per open chat (`subscribe session {id, afterSeq}`). Snapshots are paged by turn (the newest N turns, then "load earlier").
- Pushes are batched per client (~50 ms), with a size limit, and there's a ping every 20 s.
- The "connected" state only counts as ready after the first snapshot or replay. After reconnecting, the list is always checked again (T3 Code bug #5742).
- REST stays for commands. Commands carry a client `commandId`, so a retry after a dropped connection can't send a prompt twice.

### 3.3 Environments

- Each server has a permanent `environmentId` (a ULID created on first start) and a name (the machine name by default, editable). `GET /api/environment` returns the id, name, version, capabilities (`remoteAccess`, `openIn`, `reveal`, `shell`, …) and platform.
- `projects.environmentId`: existing projects are filled in with this server's id. It can't be changed after creation. Workspaces and sessions inherit it through their project.
- **The client:** the app's window is a multi-environment client. The local server is simply the first environment.
  - An `EnvironmentConnection` per environment: base URL, credentials, socket, supervisor, status (connecting / live / offline / revoked), and its own copy of the shell state.
  - Every API call and route becomes environment-scoped (`/e/:env/projects/:id/chats/:id`; routes without `/e/` mean the local environment, so old links still work).
  - localStorage keys are namespaced by environment id.
- **Which address to use:** an environment keeps a *list* of addresses (Tailscale HTTPS, tailnet IP, later LAN), tried in order, with the last one that worked first.
- **Sidebar:** projects from every connected environment, grouped by environment when there's more than one. Each group has the environment name and a status dot, and offline environments are greyed out but still browsable if cached.
- **Header:** an environment badge (computer icon plus name) next to the location badge, shown when more than one environment is known.
- **Settings are per environment.** Agent, model, harness and ACP settings belong to the host that runs the agents and are edited through that environment. Look and feel (theme, font size, shortcuts) stays on the client. The Settings sidebar gets an environment switcher for the host-side sections.
- **Things the host does on its own machine:**
  - Open in VS Code, Show in Finder and the `osascript` folder picker only when the environment is this machine (capability plus same `environmentId` as the app's local server). Otherwise they're hidden.
  - Export downloads through the browser.
  - Paths are shown as `<env>:<path>`.

### 3.4 Folder browser (all environments)

- `GET /api/fs/browse?path=` returns `{path, parent, entries:[{name, path, isGitRepo, hidden}]}`: directories only, `~` expanded, hidden folders only when asked, permission errors shown as an empty list with a note. It's restricted to the host user's home folder plus `/Volumes` by default.
- New `ui/FolderBrowser`:
  - a path field with autocomplete
  - breadcrumbs, a list with git-repo markers, and Recent / Home / Favorites
  - "New Folder"
  - keyboard navigation
  
  It's used by Add Project. The local environment still offers "Choose in Finder…" as an extra.

### 3.5 Auth and pairing

- **Credentials:**
  - `devices(id, name, kind, tailscale_login?, created_at, last_seen_at, last_ip, revoked_at, token_hash)`.
  - Device tokens are 256-bit random values, stored as a SHA-256 hash, with sliding expiry (refreshed on use; unused for 90 days means expired).
  - Sockets use short-lived tickets (`POST /api/auth/ws-ticket`, 60 s, single use).
  - The **local app** gets its own secret: Tauri reads it from the server's startup handshake and passes it to its own webview. Loopback alone is no longer trusted once remote access is on.
- **Invite:**
  - The host clicks **Add device**. That creates a one-time grant (128-bit, 5 minutes, one active invite at a time) and shows:
    - a QR code of `https://<host>.<tailnet>.ts.net/pair#g=<grant>&e=<envId>&fp=<host key fingerprint>` (a phone camera opens it in Safari, and the web UI completes pairing);
    - the same link to copy, for another Mac: Glade → Connect to environment → paste;
    - a short code (e.g. `ABCD-EFGH`) plus the host name, for typing in.
  - The client posts the grant, its name and kind to `/api/auth/pair`. The host shows "Allow ‘Jason's MacBook' (jason@…)?" and only issues the token after you confirm. The client checks that the host's `/api/environment` fingerprint matches `fp`.
- **Devices list** (Settings → Remote access): name, kind, Tailscale login, last seen, **Revoke**. Revoking closes that device's sockets at once. There's also **Revoke all** and **Stop remote access**.
- **Checks on every request:**
  - `Host` allow-list (loopback plus the configured tailnet names and IPs), against DNS rebinding;
  - Origin checked for requests that change things;
  - CORS only for paired app origins;
  - limits on `/pair` (5 per minute per IP; the invite is destroyed after 5 failures);
  - an audit log of pairing, revocation and failed attempts.
- **Permissions:** v1 has a single "full access" level. The schema keeps a `scopes` column so read-only devices can come later.

### 3.6 Transports

```ts
interface Transport {
  id: "tailscale" | "lan" | …;
  detect(): Promise<{ available: boolean; reason?: string }>;
  status(): Promise<{ enabled: boolean; addresses: string[]; https: boolean; identity?: string }>;
  enable(port: number): Promise<void>;   // e.g. tailscale serve --bg --https=…
  disable(): Promise<void>;
  reconcile(port: number): Promise<void>; // at startup: fix or remove stale config
  identify?(req): Promise<{ login?: string; device?: string }>; // hint only
  discover?(): Promise<Array<{ name: string; address: string }>>; // peers running Glade
}
```

- **The Tailscale transport** finds the CLI at `/usr/local/bin/tailscale` or inside the app (with `TAILSCALE_BE_CLI=1`) and reads `tailscale status --json`. It turns serve on and off, and refuses to start if funnel is set for Glade's port.
  - `discover()` probes online peers' `/api/environment` so "Connect to…" can list Glade hosts it found. The QR code or link is still what establishes trust.
- **Settings → Remote access** (off by default):
  - an on/off switch with transport status ("Tailscale is not installed / signed out / HTTPS off: using 100.x over HTTP");
  - this environment's name and addresses;
  - Add device (QR code);
  - the devices list;
  - "Connect to another environment…" for the client side.

### 3.7 Phone

v1: the phone uses the host's web UI at `https://<host>.ts.net` (installable to the home screen), paired by scanning the QR code. The layout needs a small-screen pass. A native iOS app is later work (a new F-item). The same pairing and sync design makes it possible.

## 4. Phases (PLAN.md)

| Phase | Item | Depends on |
| --- | --- | --- |
| 1 | I-121 SQLite store and one normalized conversation format; import from JSON and pi JSONL | none |
| 2 | I-122 Sequenced sync: event log, replay/snapshot, batching, command ids | I-121 |
| 3 | I-123 Environments: ids, `projects.environmentId`, multi-environment client, scoped routes, sidebar and header badges, per-environment settings | I-122 |
| 3 | I-124 Folder browser and environment-aware host actions | I-123 (the API part can be done alongside) |
| 4 | I-125 Auth: device tokens, local-app secret, socket tickets, Host/Origin/CORS, audit | I-123 |
| 4 | I-126 Pairing: invite QR/link/code, confirm, devices list, revoke; the client's "Connect to environment" | I-125 |
| 5 | I-127 Transports: interface plus Tailscale (serve, reconcile, discover), Settings → Remote access; phone layout pass | I-126 |

Phases 1–2 are worth doing on their own: stable ids, one format for pi and ACP, faster search, and no more lost updates on reconnect. Nothing reaches the network until phase 5, and remote access stays off by default.

## 5. Decisions (user, 2026-09-27)

These replace the proposals above where they differ.

1. **One window, not grouped.** Projects and chats from every environment sit in one list, in whatever order the user drags them (ordering stays free across environments; the order is kept on the client). Anything remote carries a small **remote icon**, in the sidebar and in the chat header. Hovering or clicking it shows which environment it is (name, address, status). There are no environment groups.
2. **Phone:** build the pairing QR code and link now. Phone use will be designed later as its own bigger project (F-022), so the QR code may not be testable end to end yet.
3. **Settings and pickers follow the host.** Agent, model and harness settings live on the environment that runs the agents. Every picker only offers what *that* environment has:
   - **Chats in a project** use the project's environment (chosen when the project was created). The agent, model and thinking pickers list that environment's agents and models.
   - **New chats without a project** get an environment picker first (Local / each remote), then the agent, then model and thinking, all filtered to the chosen environment.
   - **Remote options only appear when remote access is turned on** (Settings → Remote access). Turning it off *hides* everything that isn't on this machine: remote projects, chats and environment choices, and their connections close. Nothing is deleted, and turning it back on brings it all back.
4. **All app data goes into `glade.db`.** No lasting `*.json.bak`. Migration must be safe while the user's current app is running:
   - Import the JSON files on the new version's first start, then leave them untouched (not deleted) until the migration is confirmed. Delete them automatically after the new version has started successfully a few times and no older Glade server is registered on the data folder.
   - A new-version server that sees an **old-version server** on the same data folder (`servers/<pid>.json` carries the version) doesn't import on top of it. It shows "Quit the older Glade first", because the old server would keep writing JSON that the database no longer reads.
   - **Existing conversations, including the one that planned this work,** are imported from pi's session files. pi keeps its file for resume, so a chat that was running before the update continues after it.
5. **Import all existing chats in the background at first start.** A chat that hasn't been imported yet is imported when it's opened.
6. **Full access only in v1**, with a `scopes` column kept for read-only devices later.
7. **Remote indicator:** an icon in the sidebar row and the chat header. Clicking it shows the environment's full name. Local items show nothing.
8. The Node 22.13 minimum wasn't objected to.
