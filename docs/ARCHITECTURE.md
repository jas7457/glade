# Architecture

```
┌──────────── apps/web (Preact) ────────────┐        ┌──────────── apps/server (Node) ─────────────┐
│ routes → features → ui primitives          │  REST  │ http/ (Hono routes, security)                │
│ state/ (signals) ← lib/socket (push)       │ ◄────► │ services/AppService (projects, workspaces,   │
│                                            │        │   sessions, process pool)                    │
│ applyAgentEvent() folds live events        │   WS   │ harness/<name>/ (pi, fake, …)                │
└────────────────────────────────────────────┘        │   └─ pi: one `pi --mode rpc` per session     │
                 ▲                                    └──────────────────────────────────────────────┘
                 └──────── packages/protocol (shared types + transcript reducer) ────────┘
```

## Packages

| Path                | Role                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------ |
| `packages/protocol` | Harness-agnostic types: models, transcript, `AgentEvent`, REST/WS payloads, reducer. |
| `apps/server`       | Node server. Owns agent processes and app data. Binds to 127.0.0.1:4317.             |
| `apps/web`          | Preact UI. Vite dev server on 127.0.0.1:5317 proxies `/api` and `/ws`.               |
| `apps/desktop`      | Tauri v2 macOS shell (`src-tauri/`): runs the bundled server, native chrome/menus.   |

Server core (I-094): `services/app-service.ts` is `AppService`, a thin facade and the only API
http/* and ws use. It creates one `AppContext` (`services/app/context.ts`: shared maps, registry,
leases, broadcast) and wires the modules in `services/app/`: records (lookups, summaries, save and
push) → live-pool (agent processes, events, exits, eviction) → lease-sync (multi-server leases,
external changes, orphaned runs) → titles → session-actions (prompt, shell, model, commands, dialogs,
attachments) → sessions (create, read, update, delete) → workspaces → projects, with agent-team (the
agent API and delivery queue) on top. Modules import only lower layers; the few upward calls (the
pool and sessions to the agent team, titles to workspaces) are hooks the facade wires.

## Harnesses

`apps/server/src/harness/types.ts` defines `AgentHarness` (`info` = label + capabilities, list
models, open/delete sessions, and optional extras: `readTranscript`, `statSession`/`readSessionText`
for search, `complete` for one-shot completions, `generateTitle`, `getUsageLimits`,
`listFolderCommands`) and `HarnessSession` (prompt, abort, model/thinking, dialogs, events). An
adapter translates its agent's native protocol to `@glade/protocol` `AgentEvent`s; the UI and
AppService never see harness-native data.

Harnesses are registered in a `HarnessRegistry` (`harness/registry.ts`) in `src/index.ts`. Each
session runs in the harness that created it (`Session.harness`); a chat whose harness isn't
installed returns a clear 409. New chats and app-level things (models, folder commands, defaults,
usage limits, search's fast model) use the default harness: the `agent.defaultHarness` setting when
installed, else the first registered. Sub-agents run in their parent's harness.
`GET /api/harnesses` lists `HarnessInfo` (default first); the web (`state/harnesses.ts`) hides
controls for missing capabilities and uses the harness label in copy. Shared helpers:
`SessionEvents` (session listener sets), `title.ts` (titles built on `complete`), and
`services/providers/anthropic-usage.ts` (subscription limits; the harness supplies the OAuth token).
Per-harness settings live in `Settings.harnesses.<id>` (pi: `piPath`, `extraArgs`,
`autoCompaction`, `autoRetry`); old `Settings.agent` keys are migrated by the store.

To add a harness: implement the two interfaces under `harness/<name>/`, give it `info`, add a
translator with fixture tests, register it in `src/index.ts`, and add its settings to
`Settings.harnesses` plus a settings panel.

**Tool calls (I-068).** The UI never switches on a harness's tool names or argument shapes. Each
adapter sets on every `ToolCallBlock` a canonical `kind` (`shell|read|write|edit|search|list|web|
task|other`, known when the call starts) and a normalized `input` (`command`, `path`,
`offset`/`limit`, `content`, `edits[{oldText,newText}]`, `pattern`, `glob`, `url`, `query`,
`description`). While arguments stream, the adapter may add the partial input (summary fields only)
to `block_delta.input`. Where the harness reports a diff, the adapter normalizes it into
`ToolResult.diff` (`DiffLine[]`: add/del/context/gap with old/new line numbers). `name`/`args`/
`details` stay raw: the web shows them only for `other` (and kinds it doesn't know). The web's
renderer and summary tables (`features/chat/tools/`) are keyed by kind. pi's mapping is in
`harness/pi/tools.ts`: bash/powershell→shell, read, write, edit (every edit argument shape;
`details.diff` → `diff`), grep/find→search, ls→list, extension tools→other.

**User shell commands (I-076).** `!cmd` / `!!cmd` in the composer call `POST /sessions/:id/shell
{ command, shareWithAgent }` (abort: `/shell/abort`), which runs `HarnessSession.runShell` (capability
`shell`). Output streams as `shell_start` / `shell_update` / `shell_end` events into a user shell
message (`shared` = whether the agent sees it). pi: RPC `bash` with `excludeFromContext` for `!!`
(no timeout; `abort_bash` stops it); the result is stored as a `bashExecution` message and reaches
the model with the next prompt.

### pi adapter

- Spawns `pi --mode rpc [--session <file>] [--model p/id] [--thinking lvl]` with `cwd` = the
  workspace's folder (its project's, or the scratch folder for standalone workspaces).
- Child environment (I-038, `harness/pi/child-env.ts`): the server's env minus `CMUX_*` and
  `PI_AGENT_TEAMS_*`, so a server started from a cmux terminal doesn't make pi extensions
  (agent-teams) drive that terminal, and minus the agent identity / server listening config
  (`GLADE_URL`, `GLADE_TOKEN`, `GLADE_PORT`, `GLADE_SERVER_KIND`, …) under both the `GLADE_` and
  the pre-rename `PI_UI_` prefix; the data folder variable is kept. Applies to RPC processes and
  one-shot `complete` runs.
- `statSession`/`readSessionText` read session files directly (`session-reader.ts`); `complete` =
  `pi -p --no-session --no-tools --no-skills --no-context-files`; `getUsageLimits` = the Anthropic
  usage client with the token from `~/.pi/agent/auth.json` (`anthropic-auth.ts`).
- Strict LF-delimited JSONL (not `readline`; it breaks on U+2028).
- pi messages have no ids; `PiEventTranslator` assigns them (`m<n>` live, `h<n>` history).
- Tool results are folded into `transcript.toolResults[toolCallId]` rather than shown as messages.
- Extension UI: `select/confirm/input/editor` → `ui_request` dialogs; `notify` → toast;
  `setStatus/setWidget/setTitle` are ignored for now.
- Context usage: `get_session_stats` after init, `turn_end`, `agent_settled`, `compaction_end` and
  model changes (one request in flight, extra triggers coalesce) → `state` with `contextUsage` +
  `sessionStats`. `compaction_end` adds a transcript notice ("Compacted context: 150k → 32k tokens").
- `listCommands` = `get_commands` (cached per process), `compact` = RPC `compact` (5-min timeout),
  `exportHtml` = `export_html` into `~/Downloads` (pi's default would write into the project).

## Slash commands

Typing `/` at the start of the composer opens a menu (filtered on name + description, grouped
Built-in / Extensions / Skills / Prompts). Two kinds of command:

- **Built-ins** are Glade's own and are defined in one registry,
  `packages/app-core/src/features/chat/slash/builtins.ts` (name, description, args hint, and a `run`
  function). They run in the browser via the API or navigation and never reach the agent as text:
  `/compact [instructions]`, `/new`, `/name <title>`, `/model [query]`, `/thinking [level]`,
  `/export`, `/stats`, `/settings`. pi's own TUI commands aren't available over RPC, which is
  why these exist.
- **Harness commands** come from `GET /api/sessions/:id/commands` (pi: `get_commands`), are cached
  in the session store (`commands` signal, fetched once per session when it opens) and are sent
  as a normal prompt; pi expands skills/templates and runs extension commands itself.

The server returns harness commands only and the web merges them after its built-ins (a harness
command with a built-in's name is hidden). Each group is sorted A→Z (case-insensitive, ignoring
the `skill:` prefix); with a query, match quality ranks first and ties fall back to A→Z (I-049,
`slash/match.ts`). The new-chat composer has no agent yet (I-043): it offers the built-ins that
don't need a chat (`/model`, `/thinking`, `/settings`) plus the **folder's** harness commands from
`GET /api/commands?projectId=` (a short-lived `pi --mode rpc --no-session` in the project/scratch
folder answering `get_commands`; cached 60 s per folder on the server, refreshed on mount/window
focus when older than 30 s in `slash/folder-commands.ts`). Picking one sends it as the first message.

Keyboard-navigated lists (slash menu, `@` menu, ⌘K palette) keep the highlighted row visible with
`ui/list-scroll.ts`, which scrolls only the list container (I-047; `scrollIntoView` also scrolled
the transcript behind the menu) and reveals a group's header when its first row is selected.

## File mentions (I-044)

Typing `@` at the start or after whitespace opens a file menu above the composer
(`features/chat/mentions/`). `GET /api/files?projectId=&q=` lists the chat's folder
(`git ls-files -co --exclude-standard` in a git work tree, else a bounded walk skipping
`node_modules`/`.git`/`dist`…; capped at 50k files, cached 10 s per folder) and ranks on the
server (`services/file-index.ts`: basename exact/prefix/substring, then path, then fuzzy; shorter
basenames and shallower paths win ties; path queries like `src/ap` match from the root). Enter/Tab
inserts `@relative/path ` (quoted when it has spaces); folders insert `@dir/` and keep the menu
open. The agent reads the files itself; nothing is inlined. Only project/scratch folders are
listed (callers pass a project id, never a path).

## Default model (I-050)

Glade's "Default" model setting (`settings.models.defaultModel = null`) means the **harness's**
default: `GET /api/models/default` → `HarnessDefaults` (pi: `get_state` of the model-listing
utility process, cached with the model list; `?refresh=1` refreshes both). The new-chat composer
preselects it (and its thinking level) and sends `model: null`, so pi applies its own settings.

## Workspaces and sessions (I-035)

A **workspace** is one sidebar row (what the UI still calls a "chat"): title, project (or
standalone), pin/pinOrder, created date, rolled-up status and a saved layout. Workspaces are
independent of each other, even in the same folder. A workspace contains **sessions**, each one
agent conversation (one pi session file) running in the workspace's folder:

- `main` sessions are the tabs of the main area. The first one is created with the workspace; the
  user opens more (`POST /api/workspaces/:id/sessions`). A workspace always keeps at least one.
- `subagent` sessions (`parentSessionId`, `agentName`) are spawned by another session of the same
  workspace (agent API, I-037). Closing a session also closes the sub-agents it spawned.

Sessions never get sidebar rows. Everything per conversation lives on the session: transcript,
live process, model/thinking, title, unread, `runInProgress`/`interrupted`, `lastRunFailed`,
context meter, slash commands, dialogs. Ordering, pinning and project membership are per
workspace. `WorkspaceSummary` rolls its sessions up (`rollupWorkspace` in
`packages/protocol/src/workspaces.ts`): `status` = most urgent session status, and `running`,
`unread`, `lastRunFailed`, `interrupted` = any session; `pendingInputs` = sum.

Titles: each session has its own (quick title from the first message, then a generated one;
`user` titles are never replaced). An `auto` workspace title follows its **first main session**
(oldest `main`). Renaming a workspace also renames its tab while it has only one main session.

Tab order and the focused tab come from `Workspace.layout` (`mainOrder`, `activeMainSessionId`,
stored verbatim by the server for I-036), falling back to creation order and the first tab
(`mainSessionsOf` / `activeMainSessionId`). The web shows the tab in `?tab=<sessionId>`, else that
default.

New sessions use the request's model/thinking, else the settings defaults (like new workspaces).

## Agent API (I-037)

Agents running in Glade can spawn sub-agents (the ext-kit agent-teams extension's Glade backend).
Every agent process gets `GLADE_URL`, `GLADE_SESSION_ID`, `GLADE_TOKEN` (random, per process,
memory only, revoked when the process stops) and, for sub-agents, `GLADE_AGENT_NAME`
(`AGENT_ENV` in `packages/protocol/src/agents.ts`), plus the same values under the pre-rename
names `PI_UI_URL`, … (`LEGACY_AGENT_ENV`) for agent-teams versions from before the rename. The
server never passes its own copies of these on (`child-env.ts`). Routes (`http/agents.ts`, mounted at `/api/agents`, `Authorization:
Bearer <token>`; the token names the calling session):

| Method | Path | Body → result |
| --- | --- | --- |
| GET | `/agents` | → `ListAgentsResponse` (a main session's sub-agents, or a sub-agent's teammates) |
| POST | `/agents/spawn` | `SpawnAgentRequest` → `SpawnAgentResponse`; main sessions only (403), unique active name per parent (409), ≤ `MAX_ACTIVE_AGENTS` (4) active per workspace (429). Model/thinking: the request's → `settings.models.subagentModel`/`subagentThinkingLevel` (if the parent's harness lists the model) → the parent's (I-078) |
| POST | `/agents/message` | `{ to, text }` → 204; `to: "main"` = the parent |
| POST | `/agents/close` | `{ name }` → `{ closed, alreadyClosed? }` (now if idle, else at the end of its turn, 30 s max); closing a closed agent is not an error (`alreadyClosed: true`), 404 only for unknown names |
| POST | `/agents/report-done` | `{ summary, keepOpen? }` → `{ closing }`; sub-agents only |

A sub-agent is a `subagent` session of the caller's workspace (same folder), started with the
role prompt (`--append-system-prompt`, like agent-teams' role.md, plus the agent definition's
instructions), optional `--tools`, the caller's model/thinking unless the definition sets them,
and the task as its first prompt. Messages and results reach sessions **as prompts**:
`[agent-teams] message from <name>:` (steer) and `[agent-teams] <name> finished: …` /
`… exited: …` (follow-up if the parent is running), queued in order per target.

**Closing = the tab disappears (I-055).** A sub-agent is closed after report_done when its turn
ends (auto-close), by `close_agent`, or after 10 idle minutes when it was kept open; ones the user
typed in are never closed automatically. Closing stops its process and **deletes its session**
(tab + conversation, `session_removed`), like closing a cmux pane; its result is already in the
parent chat. The record stays (`closed`, `removed`) so `list_agents` shows it as closed
(`tabOpen: false`) and `close_agent` is idempotent; records go with their parent session or
workspace. A sub-agent whose process crashes is `closed` but keeps its tab so the error is
readable; viewing it reads the transcript from the session file (`AgentHarness.readTranscript`,
slash commands from the folder) **without restarting it**; typing in it starts it again.
Sub-agents get a fun display name and a colour at spawn (`services/agent-names.ts`, I-084), unique
among the workspace's active agents, stored on the session and the agent record. The parent session
lists every agent it spawned in `SessionSummary.spawnedAgents` (kept after close). The web turns the
parent's `task` tool calls into agent cards (`linkAgentSpawns`, matched per name from the end),
folds that agent's finished / message / exited prompts into the card, and falls back to
`AgentMessageCard` when there's no card. Colours are `--pi-agent-<key>` tokens applied with
`data-agent-color`.

Records (role, tools, state) live in `<dataDir>/agents.json` so a sub-agent reopened after a
restart keeps its role.

The browser sees sub-agent state on `SessionSummary.agent` (`SessionAgentState`: status, closing,
task, keepOpenReason, userEngaged, doneAt, result), pushed with every `session_upsert`. Sub-agent
tabs show ✓ when done (⊘ when stopped) with the task and result in the tooltip, and a bar above
the conversation with the status and the expandable result (`features/workspace/AgentBar`).

Whenever the server stops a session's process (`closeLive`: closing a tab or agent, idle
eviction), it first sends `run_end` (if running) and `state {isRunning:false}`, so no client stays
on "Working…" (events after that point are no longer forwarded). Server shutdown doesn't, so
cut-off runs still show as interrupted on the next start.

## Data on disk

| What | Where |
| --- | --- |
| Everything Glade owns (I-121): projects, workspaces, sessions (with `session_ref` / `resume_json`), sub-agent records, settings, summaries, **conversations** (`messages`, `tool_results`, `transcripts`), `events`, `meta` | `<dataDir>/glade.db` (SQLite via `node:sqlite`, WAL; migrations in `apps/server/src/store/db/`) |
| Harness session files (import and resume only) | pi: `~/.pi/agent/sessions/--<cwd>--/…` (never written by Glade) |
| Settings export (read by the desktop app for the pi path) | `<dataDir>/settings.export.json` |
| Pre-I-121 JSON files (`projects.json`, `workspaces.json`, `settings.json`, `agents.json`, `session-summaries.json`, `search-index.json`, `chats.json`, `acp-sessions/`) | imported once, then deleted after 3 successful starts with no older server around |
| Scratch cwd for non-project chats | `<dataDir>/scratch/` |
| Running servers (registry, with `storeSchema`) | `<dataDir>/servers/<pid>.json` |
| Session leases | `<dataDir>/leases/<sessionId>.json` |

**Glade's store (I-121).**
- `LivePool.handleEvent` replaces each harness message id with a ULID (`MessageIds`) before folding, so live events, stored rows and reloads agree.
- `TranscriptWriter` writes a session's changed messages at most every 250 ms, immediately at message, tool or run end, and flushes on close.
- Every reader uses the store: transcripts (live, dormant and elsewhere), search (plain text per row), titles, and the chat tools.
- The harness readers (`readTranscript` etc.) are import-only. pi JSONL is imported in the background at first start (oldest first) or on demand when a chat is opened.
- A pi file that changed outside Glade is merged in (`mergeTranscripts`: missing turns added, ids kept, matched by role and timestamp). Only a merge records the file signature.
- **Older-server guard:** a registered server without `storeSchema` is an older Glade. The new server then doesn't open the database and serves "Quit the older Glade first" (API 503) until that server is gone.

`dataDir` = `~/Library/Application Support/Glade` on macOS (override with `GLADE_DATA_DIR`).

**Environment variables** are `GLADE_*` (`GLADE_DATA_DIR`, `GLADE_PORT`, `GLADE_HOST`,
`GLADE_HARNESS`, `GLADE_SERVER_KIND`, `GLADE_STATIC_DIR`, `GLADE_EXIT_ON_STDIN_CLOSE`,
`GLADE_SANDBOX`, `GLADE_DEBUG`, `GLADE_WEB_PORT`, `GLADE_SANDBOX_ROOT`, `GLADE_APP_IDENTIFIER`).
The pre-rename `PI_UI_*` names are still read as fallbacks, through one helper per language:
`env(name)` in `apps/server/src/config.ts` (and copies in `apps/web/vite.config.ts`,
`scripts/sandbox/lib.mjs`), `server::env_var` in Rust.

**Rename migration (I-059, pi-ui → Glade)**: at startup, when the data folder is the default one
(no `GLADE_DATA_DIR`/`PI_UI_DATA_DIR`), `…/Glade` doesn't exist and `…/pi-ui` does, the server
**copies** the old folder into the new one (`store/migrate-data-dir.ts`, before the registry or
store touch it) and logs it once. Everything is copied except other servers' runtime state
(`servers/`, `leases/`, `*.lock`, `*.tmp`); standalone workspaces whose `cwd` was the old
`scratch/` are pointed at the copy. The copy is staged in `Glade.migrating-<pid>` and renamed
into place, so a crash leaves nothing half-done (the next start retries). The old folder stays as
a backup and keeps working for a pre-rename build. Until the copy exists the desktop app reads
the old folder's `settings.json` (for the pi path). The web app's `localStorage` keys moved from
`pi-ui.*` to `glade.*` (read once as a fallback, `state/ui.ts`).
Only sessions created by Glade are listed; sessions started in the terminal are not imported.
Because transcripts stay in pi's own format, a Glade session can still be resumed with `pi --session`.

**Migration (I-035)**: when `workspaces.json` doesn't exist and `chats.json` does, the store turns
every chat into a workspace with exactly one main session, **both keeping the chat's id**
(`workspace.id = session.id = session.workspaceId = chat.id`), so `/chats/:id` URLs and the pi
session files (`sessionRef`, untouched) keep working. Workspace gets projectId, title/titleSource,
cwd, pinned/pinOrder, createdAt, lastActivityAt (`layout: null`); the session gets title/titleSource,
harness, sessionRef, unread, lastRunFailed, runInProgress, interrupted, createdAt, lastActivityAt,
model, thinkingLevel. `workspaces.json` is written immediately; since the migration only runs
while it's missing, it runs once. An unreadable `chats.json` is left alone (retried next start).
New workspaces get fresh ids for the workspace and its first session (they differ).

### Several servers on one data folder (I-062)

`pnpm dev` and the installed app each run **their own server on the same data folder** (and so
can any number of servers). Nothing is borrowed; each server owns only the agent processes it
started. Four mechanisms keep them from stepping on each other:

1. **One SQLite database** (`glade.db`, WAL, busy_timeout). Writes are transactions, so there's no file locking. Record tables keep the protocol object as JSON; sub-agent records are patched per field.
2. **The `events` table** replaces file watching. Every change appends a row (`seq`, `server_id`, scope, entity). Each server polls `seq > last` every 150 ms, re-reads the records named by other servers' events and pushes `project_*` / `workspace_*` / `session_*` / `settings` to its own clients (`StoreChange`, as before). Events are pruned after 7 days or 100k rows.
3. **Session leases** (`services/leases.ts`). Only one server may run a session's pi process
   (two processes on one session file would interleave writes). Before starting it, a server
   claims `<dataDir>/leases/<sessionId>.json` `{ sessionId, serverId, serverKind, pid, since,
   running, pendingInputs, updatedAt, takeover? }` (under that file's lock) and releases it when
   the process stops (store flushed first). The owner keeps `running` / `pendingInputs` current,
   so the other servers show the session's status without streaming it: while the owner is
   working or waiting for input, their `SessionSummary` gets `activeElsewhere: { serverKind,
   since }` and status `working`/`blocked`; `GET /sessions/:id` reads the transcript from the
   session file without starting anything (`readTranscript`; the web reloads it when the session
   starts or stops running there); prompts, abort and delete answer **409** "Running in Glade
   (dev) — open it there or wait until it's idle" (`activeElsewhereMessage`), and the composer is
   read-only with that hint. **Take-over**: a server that needs a session whose owner is idle
   (prompt, model change, delete…) writes a `takeover` request into the lease; the owner (watching
   the leases folder) stops its idle process, which releases the lease, and the requester claims it
   (~0.1s). An owner that is busy (or just sent a prompt) clears the request instead → 409. A
   lease whose server is gone is **stale**: replaced on claim, removed by the scan (every 1s and on
   folder events), and a run still flagged `runInProgress` that no server runs any more is marked
   interrupted after 1.5s. At startup, runs leased by a live server aren't marked interrupted.
   Queued agent-teams deliveries to a session busy elsewhere retry every 2s (up to 30 min).
4. **Server registry** (`services/server-registry.ts`, replaces the I-022 `server.lock`). Each
   server writes `<dataDir>/servers/<pid>.json` `{ id, pid, kind, host, port, startedAt,
   heartbeatAt }` (`kind` = `GLADE_SERVER_KIND`: `dev` by default, `desktop` for the app),
   rewrites it every 2s and deletes it (and its leases) on shutdown and in an `exit` hook. A server
   is gone when its file is missing, its pid is dead, or its heartbeat is older than 60s (hangs, pid
   reuse); right after the machine wakes up (our own heartbeat is old too) nobody is judged stale.
   Dead servers' files are pruned. Leases name servers by id. There is no exit code 3 any more.

Per server (not shared): the live process pool, viewers/unread marking of runs it owns, agent
tokens (`GLADE_TOKEN`), title generation, the usage poller, the search index
(`search-index.json` is a cache each server rewrites), exported-file allowlist. Sub-agents run
in the server that runs their parent (their `GLADE_URL` points there).

### Ordering

Projects are ordered manually by `Project.sortOrder` (ascending; new projects get min − 1, i.e.
the top). Project pinning is gone. Chats are never re-sorted by activity: unpinned chats sort by
`createdAt` (newest first, client-side); pinned chats sit at the top of their own list (a project,
or standalone) ordered by `Workspace.pinOrder`. (Here "chat" = workspace, the sidebar row.) The server never uses `lastActivityAt` for ordering.
Older data is migrated when the store loads: projects get `sortOrder` from their previous order
(pinned first, then most recent activity) and lose `pinned`; pinned chats without `pinOrder`
get one per list (most recent activity first).

## Server API

REST under `/api` (JSON). Errors: `{ "error": string }` with 4xx/5xx. Anything that needs a
session's agent (prompt, abort, model, thinking, compact, export, delete) answers 409 while
another server on the data folder runs it (`SessionSummary.activeElsewhere`, I-062).

| Method | Path                          | Body / notes                                   |
| ------ | ----------------------------- | ---------------------------------------------- |
| GET    | `/projects`                   | → `Project[]` sorted by `sortOrder`            |
| POST   | `/projects`                   | `CreateProjectRequest` → `Project` (added at the top: `sortOrder` = min − 1) |
| PATCH  | `/projects/:id`               | `UpdateProjectRequest` (`{ name? }`) → `Project` |
| PUT    | `/projects/order`             | `ReorderProjectsRequest` `{ ids }` → `Project[]` sorted; `ids` must be exactly the set of projects (400 otherwise); sets `sortOrder` 0..n−1, `project_upsert` per changed project |
| POST   | `/projects/:id/open`          | `OpenProjectRequest` `{ app: "vscode" }` → 204; opens the project folder (`open -a "Visual Studio Code" <path>`). 404 unknown project, 400 unknown app, 424 app not installed, 501 off macOS |
| DELETE | `/projects/:id`               | removes project + its workspaces → 204         |
| GET    | `/workspaces`                 | → `WorkspaceSummary[]` (rolled-up status)      |
| POST   | `/workspaces`                 | `CreateWorkspaceRequest` `{ projectId, prompt?, images?, model?, thinkingLevel? }` → `CreateWorkspaceResponse` `{ workspace, sessions, session: SessionDetail }` (first main session started, prompt sent) |
| GET    | `/workspaces/:id`             | → `WorkspaceDetail` `{ workspace, sessions }` (main first, then sub-agents; doesn't start agents) |
| PATCH  | `/workspaces/:id`             | `UpdateWorkspaceRequest` `{ title?, pinned?, layout? }` → `WorkspaceSummary`. `pinned: true` puts it at the top of its list's pinned group (`pinOrder` = min − 1); `pinned: false` clears `pinOrder`; `layout` is stored as given (`null` clears) |
| PUT    | `/workspaces/pin-order`       | `ReorderPinnedWorkspacesRequest` `{ projectId, ids }` → `WorkspaceSummary[]` (that list's pinned workspaces, in order); `ids` must be exactly the pinned workspaces of that list (400), unknown project 404; sets `pinOrder` 0..n−1, `workspace_upsert` per changed one |
| DELETE | `/workspaces/:id`             | → 204 (all its session files permanently deleted) |
| GET    | `/workspaces/:id/sessions`    | → `SessionSummary[]`                           |
| POST   | `/workspaces/:id/sessions`    | `CreateSessionRequest` `{ prompt?, images?, model?, thinkingLevel? }` (body optional) → `SessionDetail`: a new **main** session (tab), started |
| GET    | `/chats`                      | legacy alias of `GET /workspaces` |
| GET    | `/sessions`                   | → `SessionSummary[]` (all workspaces)          |
| GET    | `/sessions/:id`               | → `SessionDetail` `{ session, transcript, state, pendingUiRequests }` (starts the agent if needed) |
| PATCH  | `/sessions/:id`               | `UpdateSessionRequest` `{ title?, unread?, interrupted?: false }` → `SessionSummary`; `interrupted: false` (only value accepted) dismisses the interrupted state |
| DELETE | `/sessions/:id`               | → 204: closes a tab (stops the agent, deletes its file, plus sub-agents it spawned); 409 for a workspace's last main session |
| POST   | `/sessions/:id/prompt`        | `PromptRequest` → 204 (empty text OK with images) |
| POST   | `/sessions/:id/abort`         | → 204                                          |
| PUT    | `/sessions/:id/model`         | `ModelRef` → 204                               |
| PUT    | `/sessions/:id/thinking`      | `{ level }` → 204                              |
| POST   | `/sessions/:id/ui-response`   | `UiResponse` → 204                             |
| POST   | `/sessions/:id/title/generate` | → `GenerateTitleResponse { title, session }`: names the chat from its conversation with the small model (I-074); 409 no messages yet, 501 harness can't |
| GET    | `/sessions/:id/commands`      | → `SlashCommand[]`: the harness's commands only (extensions, skills, prompts); built-ins live in the web app |
| POST   | `/sessions/:id/compact`       | `{ instructions? }` (body optional) → `CompactResult`; 409 while a reply is running |
| POST   | `/sessions/:id/export`        | `{ reveal? }` (body optional) → `{ path }` (HTML file; pi: `~/Downloads/pi-session-….html`) |
| POST   | `/fs/reveal`                  | `{ path }` → 204; reveals a file this server exported in Finder (404 for other paths, 501 off macOS) |
| GET    | `/models[?refresh=1]`         | → `ModelInfo[]`                                |
| GET    | `/models/default[?refresh=1]` | → `HarnessDefaults` `{ model, thinkingLevel }`: what the harness uses when no model is given (I-050) |
| GET    | `/commands?projectId=[&refresh=1]` | → `SlashCommand[]`: harness commands for a project's folder (no `projectId` = scratch); 404 unknown project |
| GET    | `/files?projectId=&q=[&limit=]` | → `FileSearchResponse` `{ entries: FileEntry[], truncated }`, ranked, default 50 (max 200); 404 unknown project |
| GET    | `/settings`                   | → `Settings`                                   |
| PATCH  | `/settings`                   | `DeepPartial<Settings>` → `Settings`           |
| POST   | `/fs/pick-folder`             | `{ prompt?, defaultPath? }` → `PickFolderResponse`; native macOS dialog (osascript), 501 elsewhere |

WebSocket `/ws`: server pushes `ServerMessage`:

| Message | Payload / when |
| --- | --- |
| `session_event` | `{ sessionId, workspaceId, event: AgentEvent }`, live agent events of one session |
| `session_upsert` | `{ session: SessionSummary }`, any change to a session (created, status, title, model…) |
| `session_removed` | `{ sessionId, workspaceId }`, a tab/sub-agent was closed |
| `workspace_upsert` | `{ workspace: WorkspaceSummary }`, after every workspace change **and every session change** (rolled-up status) |
| `workspace_removed` | `{ workspaceId }`, its sessions are gone too (no `session_removed`s) |
| `project_upsert` / `project_removed`, `settings`, `models`, `usage_limits`, `hello` | as before |

Client sends `{ type: "viewing", sessionIds: string[] }` (every session on screen in a visible
window, replacing the previous list) so runs finishing there aren't marked unread. The web
reports them with `socket.watch(sessionId)` (counted per view, released on unmount).

## Chat status

Every `SessionSummary` carries a derived `status` (`packages/protocol/src/status.ts`), computed on
the server and pushed via `session_upsert` on every change; each `WorkspaceSummary` carries the
most urgent status of its sessions (pushed via `workspace_upsert`). Precedence, most urgent first:

| Status    | Meaning                                                                   | Source                               |
| --------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `blocked` | Agent is paused waiting for the user (confirm/select/input/editor dialog) | pending `ui_request`s (deterministic) |
| `working` | Agent is running                                                          | session `isRunning`                  |
| `unread`  | A run ended while the chat wasn't on screen in a visible window           | `run_end` with no viewers            |
| `idle`    | Nothing new                                                               | —                                    |

`lastRunFailed` marks runs that ended in an error or crash (user aborts don't count).

**Interrupted runs**: the session record carries `runInProgress` (set at `run_start`, cleared at
`run_end`/abort) and is persisted, so it survives the server dying. On startup, any session still
flagged gets `interrupted: true` plus `unread` + `lastRunFailed` (the sidebar shows the failed
marker without special-casing). An agent process exiting mid-run sets `interrupted` too. Any new
prompt (e.g. the UI's "Continue") or `PATCH { interrupted: false }` clears it. A model
asking a question in plain text can't be detected reliably; it ends the run and shows as
`unread`. The client tells the server which sessions are on screen (`viewing`), but only while the
document is visible, so sessions finishing behind a hidden window still become unread.
Project rows, the window title and the desktop Dock badge use workspace statuses with
`aggregateChatStatus` / `needsAttention` (one count per workspace, not per session).

## Security

The server binds to `127.0.0.1` and rejects requests whose `Host` isn't a loopback name
(DNS-rebinding protection) and WebSocket upgrades / mutating requests whose `Origin` isn't
loopback. Remote access (a later phase) will add a token and configurable bind address.

## Web app

- `src/app/` — router (`createBrowserRouter`), layout, `routes.ts` path helpers.
- `src/ui/` — primitives (only place with raw styling decisions).
- `src/features/<feature>/` — sidebar, chat, settings, projects. Each exposes an `index.ts`.
- `src/state/` — signals: `store.ts` (projects, `workspaces`, `sessions`, models, settings;
  `workspacesForProject`, `mainSessionsFor`, `resolveSessionId`), `chat-session.ts` (per-session
  transcript/state, `useChatSession(sessionId)`), `actions.ts`, `toasts.ts`.
- The transcript and composer take only a session id (prop still named `chatId`), so they can be
  embedded anywhere (tabs, panes).

Routes: `/` (new chat), `/chats/:chatId`, `/projects/:projectId` (new chat in project),
`/projects/:projectId/chats/:chatId`, `/settings/:section`. `:chatId` is a **workspace** id; an
optional `?tab=<sessionId>` picks its main tab (a refresh restores it; unknown tabs redirect
without it). `ChatRoute` resolves the session with `resolveSessionId` and renders
`<WorkspaceView workspaceId sessionId>`.

**Workspace layout (I-036, `features/workspace/`)**: the header, then the workspace's main
sessions as tabs (`ui/TabStrip`, "+" / ⌘T opens a new conversation in the same folder) and, in a
resizable right pane (`ui/SplitView`), the sub-agents of the **active** main tab as tabs; the
pane is absent when that tab has none. Each group shows one `<ChatPane sessionId>` (transcript +
composer); only the visible sessions are mounted, so only they are "viewing". Double-click a tab
(or its context menu) maximizes its group; that is per window, not saved. Everything else is
saved in `Workspace.layout` via `updateWorkspace` (applied to the signal first): `mainOrder`
(new tabs appended), `activeMainSessionId` (on click/⌃Tab/new/close; the URL's `?tab=` wins),
`activeSubagentSessionId[mainId]`, `subagentPaneSize` (on drag end). Closing a tab deletes its
conversation (and its sub-agents); it asks first when it has history or sub-agents, the last
main tab has no close button (the server answers 409 anyway), and focus moves to the right
neighbour. Shortcuts (`TAB_SHORTCUTS` in `app/shortcuts.ts`, bound by the view): ⌘T, ⌘W, ⌃Tab,
⌃⇧Tab; ⌘W/⌃Tab act on the group holding keyboard focus (else the main group). Browsers keep
⌘T/⌘W/⌃Tab for themselves, so these are for the desktop app (whose menu must not claim ⌘W).

## Desktop app (`apps/desktop`)

- `pnpm tauri:build` runs `scripts/bundle-server.mjs` (web build + esbuild bundle of the server
  into one `server.mjs`), staged in `dist-bundle/` and shipped as the `app/` resource.
- On launch (`src-tauri/src/server.rs`) the app resolves `node`/`pi` via `$SHELL -ilc` (falling
  back to nvm/Homebrew dirs), starts `node server.mjs` on a free loopback port with the login
  shell's PATH, `GLADE_STATIC_DIR` and `GLADE_EXIT_ON_STDIN_CLOSE=1`, waits for `GET /api/settings`,
  then navigates the window there (same origin, so the loopback Host/Origin checks pass). Quit
  sends SIGTERM; if the app dies, the closed stdin pipe stops the server. Log:
  `~/Library/Logs/io.github.jas7457.glade/server.log`. Missing node/pi → native error dialog.
- The app **always runs its own server** (`GLADE_SERVER_KIND=desktop`), also while `pnpm dev`
  uses the same data folder (I-062: they share it safely, see "Several servers on one data
  folder"). There is no borrowing; quitting the app stops only its server. `GLADE_APP_IDENTIFIER`
  gives any build another bundle identifier at launch (single-instance socket, window state and
  log dir are keyed on it), so an agent can run a release build next to the installed app with
  `GLADE_DATA_DIR` pointing at a temp folder.
- Quit confirmation (`src-tauri/src/quit.rs`): ⌘Q / Dock Quit / AppleScript `quit` go through
  `-[NSApplication terminate:]`, which tao can't veto, so the app adds
  `applicationShouldTerminate:` to tao's app delegate. It asks its server `GET /api/sessions`
  and counts workspaces with a session `working`/`blocked` **on that server** (sessions with
  `activeElsewhere` run in another server and survive the quit); if any, it cancels and shows "N
  chats are still working. Quitting stops them." [Quit] [Cancel]. No prompt when the server
  can't be reached.
- `pnpm tauri:dev` loads the Vite dev server instead and starts no bundled server
  (`scripts/dev-servers.mjs` reuses or starts `:4317`/`:5317`).
- Dev identity (I-031): `src-tauri/.cargo/config.toml` sets `scripts/dev-app-runner.sh` as the
  cargo runner, so `cargo run` / `tauri dev` start the debug binary from inside a minimal
  `target/debug/Glade (dev).app` (hard link + Info.plist + `icons/dev/icon.icns`, the icon with a
  DEV band made from `icon/icon-dev.svg`) via `exec`, keeping the pid for hot-reload. A bare
  executable has no bundle, so the Dock and switchers (AltTab reads `NSRunningApplication.icon`)
  showed the generic exec icon. Dev builds also use their own identifier
  `io.github.jas7457.glade.dev` (`src-tauri/src/dev.rs`): the single-instance socket is keyed on it,
  and with a shared id opening `/Applications/Glade.app` while `tauri dev` ran only focused the
  dev window. `dev.rs` also undoes Tauri's dev-time Dock icon override so the Dock shows the DEV
  icon. `pnpm tauri:install` re-registers the installed bundle with LaunchServices (`lsregister
  -f`). Check what macOS reports with `swift apps/desktop/scripts/check-app-icon.swift`.
- Install (`apps/desktop/scripts/install.mjs`): installs `/Applications/Glade.app`; a running
  pre-rename `/Applications/pi-ui.app` is asked to quit like the installed app (by path), and
  removed after Glade.app is in place (I-059). The icon (`icon/icon.svg`, a leaf in a soft
  green–teal rounded square; `icon/icon-dev.svg` adds the DEV band) is turned into
  `src-tauri/icons/` with `tauri icon` (`icons/dev/icon.icns` from the DEV variant).
- Web side: `lib/desktop.ts` is the only bridge (dynamic `@tauri-apps/*` imports, no-ops in a
  browser); `<html data-desktop>` switches the page/sidebar to transparent over the window's
  vibrancy. Menu items emit `glade:menu` events handled by `useGlobalShortcuts`.
- Closing the window hides it (agents keep running); the Dock icon reopens it; ⌘Q quits.
- No Writing Tools button (I-042, `src-tauri/src/writing_tools.rs`): Apple Intelligence puts a
  floating "Write with Siri" button next to focused multi-line fields. The app hides it by making
  the web view (wry's `WryWebView` class) answer NO to `-allowsWritingToolsAffordance`. On
  macOS 27, `WKWebViewConfiguration.writingToolsBehavior = .none` (even set at creation) and the
  HTML `writingsuggestions="false"` / `autocorrect="off"` attributes did not hide it. Typing,
  spellcheck and copy/paste are unaffected, and Writing Tools should still be reachable from the
  context menu. If a future macOS ignores the override, the only fallback is system-wide: turn
  off Writing Tools under System Settings › Apple Intelligence & Siri. Browsers don't show the
  button at all.

## Decisions

- **Installing never quits the app** (2026-09-26, I-082, user decision): `pnpm tauri:install`
  builds, copies the bundle to `/Applications/.Glade.app.incoming` and swaps it in with renames;
  a running Glade keeps its loaded files and the next launch is the new version. The desktop
  server (`GLADE_SERVER_KIND=desktop`) serves the web app from an in-memory snapshot taken at
  startup (`http/static-snapshot.ts`), so a reload in the old app never gets the new web code.
  `--when-idle` and the auto-quit are gone.
- **Several harnesses per server** (2026-09-26, I-064…I-069): interfaces + optional methods +
  `info.capabilities`, no abstract base class; routing by `Session.harness` through a
  `HarnessRegistry`; the default harness serves new chats and app-wide features (sub-agents inherit
  their parent's); per-harness settings under `Settings.harnesses.<id>` with a store migration;
  search/titles use `readSessionText`/`complete` instead of harness-specific imports; provider
  clients (Anthropic usage) live in `services/providers/` and get credentials from the harness.
- **Renamed pi-ui → Glade** (2026-09-26, I-059, user decision): new product name, bundle ids
  (`io.github.jas7457.glade`, `.glade.dev`), data folder, `GLADE_*` env vars and `@glade/*`
  packages. Old names keep working where users or other tools may still use them: `PI_UI_*`
  env vars are fallbacks (and the agent API env is set under both names), the old data folder is
  **copied** (not moved) on first start so an old build and a rollback still find their data.

- **Agent sandboxes** (2026-09-26, I-052): agents test against `pnpm dev:agent` sandboxes (one per name,
  shared via an owner list, cleaned up by a detached supervisor when the last owner leaves), never the
  user's servers or data folder.

- **Custom tab strip + split instead of dockview-core** (2026-09-26, I-036): the layout is
  derived from server data (main tabs = the workspace's main sessions; right pane = the active
  tab's sub-agents, swapped whenever the main tab changes, hidden when empty), which maps poorly
  onto dockview's imperative, user-arranged panels (we'd sync add/remove on every change and
  disable its drag-and-drop to keep the model intact) and it brings its own theme to override.
  `ui/TabStrip` + `ui/SplitView` are ~300 lines, native-styled with our tokens. Groups are a
  `TabGroupId` union so extra panes can be added; revisit dockview for drag-to-dock (I-039).

- **Workspaces contain sessions** (2026-09-26, I-035): a sidebar row is a workspace; each
  conversation is a session (kind `main` = tab, `subagent` = spawned). Per-conversation state and
  the live process pool are keyed by session id; order/pin/project by workspace. Status rolls up
  on the server so every client (and the desktop quit check) agrees. Migrated chats keep their id
  for both the workspace and its session; new workspaces use distinct ids so nothing relies on
  them being equal. Old `/api/chats/:id/*` routes were replaced (only `GET /api/chats` stays, as
  an alias). `workspaces.json` holds both lists in one file so writes stay atomic.

- **pi processes don't inherit multiplexer/agent-teams env** (2026-09-26, I-038): `CMUX_*` and
  `PI_AGENT_TEAMS_*` are stripped when spawning pi.

- **Sidebar grid** (2026-09-26, I-041): rows align with section headers; project chats align with the
  project name; status lives on the right and swaps to hover actions (the left status column from
  I-006/I-030 was tried and reverted).

- **Several servers per data folder** (2026-09-26, I-062, user decision): the installed app always
  runs its own server next to `pnpm dev` on the same data. Shared JSON files are changed by
  locked read-modify-write operations and watched; session leases keep each session's pi process
  in one server (take-over when idle, stale leases replaced); a per-server registry
  (`servers/<pid>.json`) replaces `server.lock`. Chosen over a single shared server because
  `tsx watch` restarts of the dev server must not kill chats running in the app (dogfooding,
  I-058). Plain file locks + `fs.watch` instead of a database or IPC between servers: the data is
  small, the servers stay independent, and a crashed server only leaves files that go stale.
- ~~**One server per data folder**~~ (2026-09-26, superseded by the entry above): a lock file
  (`server.lock`) guaranteed a single owner; a second server exited with code 3 and the desktop
  app borrowed a live server instead of starting its own.

- **Manual project order, no project pinning** (2026-09-26, I-019): rows never jump on activity.

- **Subscription usage limits read pi's Anthropic OAuth token read-only** (2026-09-26) from
  `~/.pi/agent/auth.json` and never refresh it (refreshing rotates the token and could log pi out).
  The endpoint (`/api/oauth/usage`) is undocumented; failures hide the gauge.

- **Desktop runs the user's own Node** (2026-09-26): the server ships as one esbuild bundle run
  with the `node` found through the login shell (pi needs Node anyway), keeping the app small.
  Alternative if we ever drop the Node requirement: a compiled sidecar (Node SEA / bun).

- **No archiving; deletes are permanent** (2026-09-26). A chat is either in the sidebar or gone.
  Deleting stops its agent (waiting for the process to exit so it can't rewrite the file) and
  removes the session file outright rather than moving it to the Trash.

- ~~**Session storage stays harness-owned, in the harness's default location** (2026-09-26).~~ Superseded by I-121 (below). Every
  harness must keep its own session format to resume conversations, so Glade stores only an index
  (`chats.json`) with an opaque `sessionRef`. Considered and rejected for now: moving pi sessions
  under our data dir (`--session-dir`), since terminal resume isn't needed, and keeping our own
  normalized transcript copy, to avoid duplicated data. Revisit if loading history without
  starting an agent, or search across harnesses, becomes important.

- **pi flags**: never pass `--no-extensions` to pi; extensions can provide providers and auth
  (e.g. Anthropic OAuth), and model listing / title generation break without them.

- **pi RPC over the SDK**: process isolation per chat, crash containment, and the same shape a
  future Claude Code adapter will have (subprocess + JSON stream).
- **React Router 7, not 8**: v8 requires React ≥19.2 APIs that preact/compat doesn't provide.
- **UI kit**: own components on Radix primitives (via preact/compat), styled like macOS.
- **Markdown**: Streamdown (handles incomplete markdown while streaming) + `@streamdown/code`.
- **Titles**: instant title from the first message, then (if enabled) replaced by a model-generated
  title via the harness's one-shot `complete` (`harness/title.ts`). User-edited titles are never
  overwritten. `/name` without a title (`POST /sessions/:id/title/generate`, I-074) names the chat
  from a conversation excerpt with the same prompt and marks it user-set. One **small model** does
  all quick tasks (titles, `/name`, summaries, the ⌘K finder): `settings.models.smallModel`, or when
  unset `anthropic/claude-haiku-4-5` if the harness lists it, else the chat's model (a default, not a
  stored value; the old `titleModel` key is migrated).
- **Tool grouping** is a pure function with options (e.g. whether thinking breaks a group) so the
  behaviour can be changed in one place.
- **Closed sub-agents are deleted** (I-055, user decision 2026-09-26): closing a sub-agent removes
  its tab and conversation, like a cmux pane; its report_done summary lives on in the parent chat.
  There is no "finished agents" list. Only crashed ones keep their tab (shown without restarting).

### Attachments, chat tools and search jumps (I-090–I-093)

- Non-image attachments are uploaded (`POST /sessions/:id/attachments?name=`) to
  `<dataDir>/attachments/<sessionId>/` and referenced by path with `Attached file:` lines (format in
  `protocol/attachments.ts`); the web turns them into chips. New chats with files are created
  first, then prompted. Attachments are deleted with their session.
- Agent API `POST /agents/chats/find|read|open` (I-091): find = the ⌘K Ask pipeline plus keyword
  hits, the caller's own chat excluded unless `includeSelf`; read = summary + last N user/assistant
  messages, bounded (`CHAT_TOOLS_LIMITS`), starts no agent; open = pushes `open_chat` and windows
  navigate to it like a ⌘K pick. ext-kit's agent-teams exposes them as `find_chats`, `read_chat`,
  `open_chat` (Glade backend only).
- Search hits locate messages by role + timestamp (`MessageAnchor`), not by transcript message id:
  harness ids are positional and change between streaming, reloads and compaction. The web resolves
  the anchor against the loaded transcript (`features/chat/jump-to-message.ts`).

### Worktrees, changes panel, saved prompts (I-096–I-098, I-102)

- Worktrees live in `<dataDir>/worktrees/<repo>/<slug>` on `glade/<slug>` branches
  (`services/worktrees.ts`); `Workspace.worktree` records them and `Workspace.cwd` points inside.
  Deleting always removes the folder; merge runs first and only into a clean project folder on the
  base branch; the default is keep.
- Changes panel: `services/git-changes.ts` runs git at the repo root, limited to the workspace folder,
  with literal pathspecs; clients may only name paths `status` reports (`http/changes.ts`). In the web
  the panel replaces the right pane while `layout.changesPanelOpen` is set; the sub-agent pane's flag
  is kept.
- Saved prompts: `Settings.prompts`; slash-menu source `saved`; picking inserts the text; a project's
  prompt beats a global one with the same name; commands beat both.
- `SessionDetail.offline` marks file-based views (a chat held by another server); clients reload them
  when the session updates.
- New-chat context bar (I-105, `features/chat/context-bar/`): project, Local/New worktree and branch.
  `services/project-git.ts` lists branches and uncommitted files and does checkout/create in the
  project folder. A Local checkout is refused while the folder is dirty (commit first; the dialog
  reuses `CommitDialog` via `/projects/:id/changes/commit`) or while a Local chat of the project is
  running. Worktree mode takes a `baseRef` (a local branch) and an optional `branch` name.
  `ui/SearchPopover` is the searchable menu primitive.
- Open-in in a chat targets the workspace (`POST /workspaces/:id/open` → `cwd`); the project endpoint
  is only for the new-chat screen. The header's location line (`ChatLocation`, I-107) reads
  branch/HEAD from the changes status, so it has no endpoint of its own.
- Cursors (I-113): controls keep the default arrow (native look); the one exception is images that open
  in the lightbox, which use `cursor-zoom-in` as macOS does for enlargeable images. Sub-agent chips above the
  composer use `cursor-pointer` (I-118, user request).
- Agent tools (I-116): Glade loads its own pi extension (`harness/pi/extension/glade-tools.ts`, `-e`,
  bundled as `app/pi-extension/`) into agent sessions, sets `GLADE_TOOLS=1` (ext-kit's agent-teams then
  steps aside) and `GLADE_SUBAGENTS=off` when `settings.agent.subagents` is false (no
  spawn/message/close/list tools; `/agents/spawn` returns 403).
- Bringing uncommitted changes (I-117): `CreateWorkspaceRequest.carryChanges` (only from the project
  folder's current branch) runs `git stash create` in the folder and `git stash apply --index <sha>` in
  the new worktree, then copies untracked, non-ignored files. The folder is left untouched; if
  anything fails, the worktree and branch are removed.
- Dialogs (I-114): one grid in `ui/Dialog` (20px padding, a single column, buttons on its right edge);
  confirms have no icon; destructive actions are red text on a plain button, Cancel is the default.
- ACP harness (I-119): each ACP agent in `Settings.harnesses.acp.agents` is a harness `acp-<id>`
  resolved live by `HarnessRegistry({ dynamic })`; the process starts on the first prompt; Glade keeps
  the transcript in `<dataDir>/acp-sessions` (`session/load` / `session/resume` only restore the
  agent's context; replayed updates are ignored); fs access is confined to the chat's folder;
  `capabilities.models === false` hides the model/thinking pickers. New sessions in a workspace
  inherit its focused tab's harness. Plans are a harness-neutral `NoticeMessage.kind: "plan"`.
- **Glade owns conversations** (2026-09-27, I-121, user decision). Everything lives in one SQLite database, `glade.db` (`node:sqlite`, so the minimum Node is 22.13), in one normalized format for every harness: stable ULID message ids assigned in `LivePool`, and an opaque per-adapter resume cursor. Harness files are for import and resume only. The JSON files are imported once and deleted after 3 starts; an older-server guard uses `storeSchema`. The `events` table is the base for I-122 (sequenced sync). Design: `docs/design/environments-and-store.md`.
- **Sequenced sync (2026-09-27, I-122).** The `events` seq is the only sequence.
  - **Shell scope:** coalesced entity pushes (`*_upsert`/`*_removed`) tagged `seq`/`prev`. Live-only pushes (status, leases) carry `seq` only.
  - **Transcripts:** stream as `session_event`s tagged with their base seq. The log keeps message snapshots at most every 250 ms. `session_sync` marks rows the client already has from the live stream; `transcript_patch` carries rows from other servers or imports.
  - **Subscribing:** replay or snapshot (over 1000 rows, pruned, or no `afterSeq`), then `live`. The shell's `live` lists every id, and the client prunes or refetches against it. Session snapshots hold the newest 50 turns; earlier turns load via `GET /sessions/:id/transcript?before=`.
  - **Transport:** 50 ms batches per client with a 4 MB budget (over it, the client gets snapshots). Pings every 20 s; silent peers are dropped after 45 s.
  - **Idempotency:** `X-Glade-Command-Id`/`commandId` receipts live in `command_receipts` for 24 h.
  - Code: `services/sync/hub.ts`, `packages/protocol/src/sync.ts`, `packages/app-core/src/state/sync.ts`.
- **Environments (2026-09-27, I-123/I-124).**
  - **Identity:** every server is an environment with a permanent ULID (`meta.environment_id`) and an editable name (the Mac's computer name by default). `GET`/`PATCH /api/environment`.
  - **Projects** carry `environmentId`: backfilled by migration 003, set at creation, never changed.
  - **The web app is a multi-environment client.** Each environment gets an `EnvironmentConnection` (`state/env-registry.ts`, `environments.ts`, `env-api.ts`): an absolute base URL, its own socket and I-122 sync state, status, and shell data. It works with no local environment at all (the future iPhone app, F-022).
  - **Sidebar:** one merged, ungrouped list with a per-device order (`envId:id` keys). Remote rows and the chat header carry `ui/RemoteBadge`.
  - **Routes:** `/e/:envId/…` for remote environments; plain routes mean this machine.
  - **Pickers and host settings** (Models, Agents, Slash commands, Prompts) follow the environment. Appearance and General stay on the client.
  - **The remote switch** (per device, off by default) hides and restores remote environments.
  - **Connecting:** until pairing (I-126), a loopback-only "Connect to Environment…" by URL. The server allows CORS and WebSocket from loopback origins only; I-125 replaces this with device auth.
  - **Host-only actions** (Open in, Reveal, native picker) show only for this machine; remote exports download through the browser.
  - **Folder browser:** `GET /api/fs/browse` and `POST /api/fs/mkdir`, limited to home and `/Volumes` (symlinks resolved), and `ui/FolderBrowser` (environment-agnostic `browse`/`mkdir` props), used by Add Project.
- **Device auth and pairing (2026-09-27, I-125/I-126).**
  - **Who is local:** the "local owner" is a request with a loopback peer and Host, no proxy headers (`Forwarded`, `X-Forwarded-*`, `Tailscale-User-*`), and an Origin that is absent or the server's own (Host port, listen port or web dev port). No separate local-app secret is needed: `tailscale serve` always adds proxy headers.
  - **Everyone else** needs the host switch on (`meta.remote_access`; otherwise 403 `remote_disabled`) and a bearer device token (otherwise 401). The WebSocket takes a single-use 60 s ticket. There's a Host allow-list (loopback plus the configured addresses). Preflights are always answered; CORS goes only on authenticated responses, auth errors and `/pair`. No cookies.
  - **Storage:** tokens and grants are SHA-256 hashes (migration 004: `devices`, `pairing_invites`, `pairing_pending`, `auth_audit`). Tokens expire after 90 days unused. One invite at a time, valid 5 minutes and used up when a pair request arrives; 5 wrong codes kill it. Rate limits: 5/min per address, 30/min overall. The pair request long-polls for up to 2 minutes for the host's Allow or Deny.
  - **Revoking** closes that device's sockets (4401); turning remote access off closes all remote sockets (4403). Other servers pick up the change within 1 s. Host-only actions and `/api/agents/*` are local-only.
  - **Client:** the web client (`lib/pairing-link.ts`, `state/pairing.ts`, `state/saved-environments.ts`) parses `glade://pair` links or code plus address, checks the environment id, waits for Allow, and stores the token (localStorage for now, Keychain later). A 401 puts the environment into "Needs pairing".
- **Transports (2026-09-27, I-127).** `services/transports/`: a `Transport` interface (detect, status, enable, disable, reconcile, identify, discover) with an injectable command runner.
  - **Tailscale:** Serve on 443 (`tailscale serve --bg --https=443 http://127.0.0.1:<port>`; off with `--https=443 --set-path=/ off`). HTTPS is required (no plain-HTTP fallback), and Funnel is never used (Glade refuses to start while a Funnel is on 443).
  - **Touching only its own handler:** Glade replaces or removes only a `/` handler pointing at a Glade port. It finds the CLI via `GLADE_TAILSCALE_CLI`, /usr/local/bin, /opt/homebrew or the app binary (`TAILSCALE_BE_CLI=1`).
  - **Ownership:** only the desktop app manages serve (`GLADE_TAILSCALE_OWNER` overrides; `GLADE_TAILSCALE=off` disables it). The owner reconciles at startup, within 2 s of a switch change and every 30 s.
  - **Addresses and discovery:** `https://<dns>` becomes the address, a Host allow-list entry and the pairing URL. Discovery probes online peers' `/api/environment`.
- **Notifications are back (2026-09-27, I-135, reverses I-028).** They're on by default for needs input, finished and failed, only while Glade is in the background, for top-level chats, from live sync only.
  - The Mac app uses its own UNUserNotificationCenter module (`src-tauri/src/notifications.rs`), because the Tauri plugin can't route clicks or detect a denied permission on macOS.
  - Browsers use the Notification API.
  - Paired-device tokens live in the Keychain (`src-tauri/src/secrets.rs`, I-134) behind `lib/secret-store.ts`.
- **Radix layers inside dialogs under Preact** (I-139): Preact portals don't bubble through the component tree, so Radix can't tell a nested Select/Menu/popover click from an outside click. `ui/Dialog` ignores outside clicks and focus changes that land in `[data-radix-popper-content-wrapper]`. Any new floating primitive must render inside such a wrapper, or be added to that check.
- **Code-free tailnet pairing** (I-143): numeric comparison, not an invite code. Accepted only when sharing is on and the request comes through Tailscale Serve (a loopback peer carrying `Tailscale-User-Login`) with the host's own login. One pending request, a cooldown after Deny, and an audit log. It lives in existing tables (`pairing_pending` with `invite_id='tailnet'`, plus `meta`) so no schema bump was needed. `POST /api/auth/pair/wait` long-polls the outcome.
- **Keep-awake and the menu bar** (I-147, I-150): the server decides *why* to stay awake (`services/power.ts`) and publishes it, along with the menu bar state, via `GET /api/desktop/state` (long poll). The Mac shell only holds or releases the IOKit assertion and draws the tray. Only the desktop server reports "held". ⌘Q (our menu item only) closes to the menu bar and switches to accessory mode; every other quit (Dock, AppleScript, installer) really quits after the running-chats check, and logout/restart/shutdown quit at once.
- **Build stamp** (I-149): esbuild `define` injects `__GLADE_BUILD__` into the bundled server; `pnpm dev` reads live git. The behind check is read-only `git ls-remote` only; it never fetches or writes to the repo.
- **Update Now and relaunch** (I-154): the desktop server runs the update job (guards, then pull/install/`tauri:install` in a login shell). The shell relaunches by recording its own `.app` path at startup, saving the route to reopen, and spawning a detached helper that waits for the old process to exit and then runs `open -n <bundle>`. It then quits completely. Because the installer swaps the bundle in place, the relaunched app is the new version.
- **Each device owns its settings** (I-155): a device offers only its installed + enabled agents (`HarnessRegistry`, `settings.agents`). Settings writes from paired devices are refused (403 `local_only`, except appearance), so other devices see a device's AI settings read-only. Models, commands and prompts are per device; there is no merged cross-device list.
- **Images are files** (I-157): content-addressed blobs in `<dataDir>/blobs`. The DB and wire carry `blob:"sha256:…"` refs, and harnesses get the data resolved back. Migration 005 is only a version bump; the actual move is a batched, compare-and-set pass after open (write the blob, then update the row), followed by a VACUUM only when no other server shares the folder. GC has a grace period, and a re-save touches the mtime, so two servers can share the store. Browsers can't send a bearer token on `<img>`, so paired-remote images are fetched with the token and shown as `blob:` URLs; local ones are plain URLs.
- **One folder per chat** (I-163, supersedes the content-addressed store of I-157): `<dataDir>/chats/<sessionId>/{images,files}`, with no sharing between chats and no GC. Deleting a chat removes its rows, its non-deletion `events` rows and its folder. Schema 006 plus a compare-and-set pass migrated the old hash blobs and attachment folders.
- **The iPhone app** (I-164, plan in `docs/design/iphone-app.md`): `apps/iphone` is its own Vite + Preact bundle in a Tauri 2 iOS shell (`io.github.jas7457.glade.iphone`). It shares the client core with the desktop web app through `packages/app-core` (see the app-core entry below); its own code is `~/…`. It boots the core with `startEnvironments({ localBaseUrl: null })` (zero local environments), the remote-access master switch always on (device backend), and `setSecretStore` → the iOS Keychain (`secret_*` commands copied from the Mac shell, plus a `device:id` key: the phone's stable id, sent as `clientEnvironmentId` with `deviceKind: "phone"`). `window.__GLADE_IPHONE__` makes `isDesktop()` false so no Mac-app bridge runs. Hash routes. The shared components size in rem; the iPhone sets the base to 16px (desktop 13px). Addresses: https, or http to loopback only (the simulator + sandbox); the app enforces it because iOS ATS lets plain http to bare IPs through. The WebView's origin is `tauri://localhost`, so a sandbox sees it as a remote device even on 127.0.0.1 (no server change needed).
- **Tool paths** (I-158): one-line tool paths go through `lib/paths.ts` `displayPath` (relative to the chat's folder without "./", the folder itself as `.`, else `~`-shortened, else absolute; the full path in `title`). The home folder is inferred from the chat's folder (`/Users/<name>` or `/home/<name>`), so a folder outside home gets no `~`.
- **Side-question threads** (I-156): follow-ups have their own ids but live inside the parent card's stored message (`followUps`); Stop takes a follow-up's id, Dismiss the card's. The side call's context is capped at 100k chars: start (15k) + the user's middle messages (15k) + recent tail, flagged `partialContext` when cut. Tell the Agent / Add to Queue send the whole thread.
- **Folders** (I-165): records in their own table per environment (migration 007); membership lives on the member (`Project.folderId`, `Workspace.folderId`), one level only. Top-level folders and projects share one `sortOrder` space (`PUT /projects/order` accepts folder ids). Moving in puts an item at the top of the folder, moving out right after it; deleting a folder puts its contents in its place. Open/closed state reuses the per-device `closedProjects` set.
- **Shared client core** (I-164 step 7): `packages/app-core` (`@glade/app-core`) holds the UI primitives, state, the chat feature (transcript, composer, tool cards, pickers) and the shared `lib` (api, socket, secret store, pairing links, paths), plus `styles.css` (design tokens). Imports are `@glade/app-core/<path under src>` (alias `appCoreAlias` + tsconfig `paths`; shared Vite/Vitest settings in `packages/app-core/vite.shared.ts`: dedupe preact/signals/react-router, react → preact/compat in tests). `apps/web` keeps the desktop layout (`@/…`: app shell, sidebar, workspace/tabs, settings, palette, projects, changes, environments UI, Mac-only bridges); `apps/iphone` the phone layout (`~/…`). The core never imports from an app. Each app's CSS imports the core's `styles.css` and adds its own `@source`.
- **iPhone sheets render into `document.body`** (I-166): the glass composer uses `backdrop-filter`, which makes it the containing block for `position: fixed` descendants, so sheets opened from inside it were trapped in the box. The phone's New Chat reuses the shared new-chat composer (`replace`, `lockedReason`, the agent as a sheet section via `agentSheetSection`).
- **iPhone search** (I-167): full-text search and Ask go to every connected Mac through the shared `lib/api-search.ts` (app-core); results are interleaved (scores aren't comparable across Macs), unreachable Macs are skipped quietly, and a confident Ask pick is never opened automatically.
- **Menu icons** (I-168): menu icons are muted, red on destructive items; a check item with an icon puts its checkmark on the right so check and icon items share a column. Dropdown and context menus ignore "outside" pointer events that land in a submenu (`keepOpenForSubmenus`): Preact portals don't bubble through the component tree, so Radix otherwise closed the menu before a submenu item's onSelect ran.
- **A paired device renames only itself** (I-171): `PATCH /api/auth/me` with its own token; host-side device routes stay local-only, and both use the same name cleanup. The iPhone's name lives on the phone and is pushed to each Mac (again on reconnect); a rename on the Mac stays until the phone is renamed.
- **iPhone unreachable wording is phone-only** (I-170, `apps/iphone/src/lib/mac-status.ts`): it never says "offline" (no Tailscale peer list on the phone) and always offers Retry; desktop wording is unchanged.
- **Chats load from a sync snapshot** (I-169): when the environment's connection is live and sequenced, a chat opens from a snapshot of its newest turns, otherwise over HTTP; earlier turns load on scroll with a manual scroll-position fix (no CSS scroll anchoring in WebKit), and search jumps page back until the message is found. A chat's model/thinking actions live in `features/chat/chat-model.ts`.
- **Claude Code harness** (I-173, `harness/claude/`): the official Claude Agent SDK driving the user's own `claude` (`pathToClaudeCodeExecutable`), so its login and settings apply and Glade stores no keys. Id `claude`, always registered (fake mode too), offered when `claude` is on the PATH and enabled; the ACP catalog no longer lists Claude Code. The resume cursor is Claude's session id (Glade picks a UUID, later processes `resume` once it's on disk). One process per live chat on streaming input: mid-run messages steer, follow-ups wait, a turn ends at `result`; model/thinking changes restart it when idle. Models are `anthropic/<SDK value>` with Claude Code's default first; thinking off = disabled, effort models map to adaptive thinking + `effort`, others to fixed budgets. `GET /api/models` lists every offered harness's models tagged `harness`; pickers use `modelsForHarness`. Permissions follow Claude Code's settings; its asks go through `canUseTool` to the permission card. Titles, completions and side questions are one-shot Haiku runs (no tools, one turn, nothing saved, `settingSources: []`). Glade's sub-agent/chat tools are an in-process MCP server `glade` (same specs and client as the pi extension; the agent-API token never enters Claude's env, `CLAUDECODE` stripped). Knobs: `GLADE_CLAUDE_MAX_BUDGET_USD`, `GLADE_CLAUDE_MAX_TURNS`, `GLADE_CLAUDE_TRACE=<file>`.
- **Permission modes are harness-neutral** (I-174): capability `permissionModes`, session state `permissionMode`/`permissionModes`, optional `HarnessSession.setPermissionMode`, `PUT /api/sessions/:id/permission-mode`; the UI shows only what the state lists. A chat's mode is its own (saved per session, resumed, never inherited); a new Claude chat takes Claude's `permissions.defaultMode`, and Claude's own reports win. Bypass is allowed on every Claude process unless its settings disable it. Permission requests can be `numbered`, carry a `defaultOptionId`, and mark an option `focusComposer`; Claude's wording copies the CLI (`harness/claude/permissions.ts`). `ModelInfo.description` / `group` let a harness supply a detail line and a group header (I-175).
- **Codex harness** (I-177, `harness/codex/`): `codex app-server` over stdio (JSONL JSON-RPC), one shared app-server per Glade server; each chat is a thread (thread id = resume cursor; a new chat `thread/start`s on open, a reopened one `thread/resume`s with `excludeTurns`; a thread Codex lost starts fresh). Model, effort, approval policy and sandbox go with every `turn/start`. Models are `codex/<id>` so they never mix with pi's `openai/…`. Permission modes are Codex's presets (Read only, Auto, Full access), per chat. Glade's tools are Codex dynamic tools (`experimentalApi`), run inside Glade so the session token never reaches Codex. Usage limits are checked before a turn and turned into "Codex usage limit reached — resets <date>". No one-shot Codex runs for titles or side questions (they would spend usage). Glade's own env and a parent Codex's `CODEX_SANDBOX*`/`CODEX_THREAD_ID` are stripped; `CODEX_HOME` is kept.
- **Which agent a chat runs on** (I-176, `state/chat-agent.ts`): named on every chat when its environment offers two or more agents; with one, only chats on an agent that's no longer offered are named (so the user sees why they can't send).
- **Codex commands** (I-178): slash commands are Codex's `/review` (`review/start`, inline) plus the folder's skills (`skills/list`, cached until `skills/changed`; `/<skill> rest` → `$<skill> rest` + a skill item); `/compact` is Glade's built-in and Codex's picker commands are Glade's pickers. `!cmd` uses `command/exec` (`$SHELL -lc`, chat folder, unsandboxed like Codex's own `!`, output routed by process id); shared output is Codex's `<user_shell_command>` record, injected with `thread/inject_items` when idle, else sent as text before the next message. `command/exec` over `thread/shellCommand`, which may emit turn notifications.
- **Codex details from the real pass** (I-179): Stop terminates the stopped turn's still-running commands (Codex keeps them in the background), earlier background commands are left alone. Threads start/resume with `features.multi_agent=false`, but GPT-6 models force Codex's own multi-agent v2, so Glade's tools sit in a `glade` dynamic-tool namespace with a developer note; Codex's own sub-agents render as a card + end notice. Commands display without the login-shell wrapper. Knob: `GLADE_CODEX_TRACE=<file>` (JSONL of every app-server message).
- **iPhone conversation mode** (I-180): `apps/iphone/src/voice/engine.ts` is the contract; the native engine is a Swift Tauri mobile plugin (`src-tauri/plugins/voice`), the fake one drives tests and the simulator. Replies are synthesized with `AVSpeechSynthesizer.write` and played through a voice-processing `AVAudioEngine`, so echo cancellation covers them and the mic can stay open for barge-in; words are timed from markers against playback. Recognition is on-device only, one task per utterance. Voice mode is hosted at the app root (a `voiceMode` signal) so a conversation begun on New Chat survives the switch to the chat; a pure state machine + `Conversation` runner sit on a `VoiceChat` interface; app-core only gains `sendAccessory` / `startRef` props.
- **Speech markers per chunk** (I-181): `AVSpeechSynthesizer.write` renders long text in chunks; each ends with an empty buffer and `byteSampleOffset` restarts at 0, so markers are mapped against the frames scheduled before their chunk, and a reply ends at `didFinish`, not at an empty buffer.
- **Codex Plan mode** (I-186): Codex's Plan collaboration mode, sent on `turn/start` only while planning (and once when leaving), keeping the approvals/sandbox of the mode it came from; approving returns to that mode. A proposed plan is a plan notice without entries (markdown in `text`), rendered as a "Proposed plan" card; the implement question is asked after `run_end`. `commands_changed` is a harness-neutral event telling clients to reload loaded slash commands.
- **New chats ask the picked agent** (I-184/I-185): folder commands (`GET /api/commands?harness=`) and starting modes (`GET /api/permission-modes`, `AgentHarness.getPermissionModes`) come from the agent chosen in the new-chat composer; only `/models/default` still uses the default agent. The starting mode is sent only when it differs from the agent's default and is saved on the new main session only.
- **Terminal tabs** (I-187): they belong to the workspace (`WorkspaceLayout.terminals`, sharing `mainOrder`), not an agent. The shell (node-pty, `$SHELL -l`, the agents' env stripping) lives only in the server that started it and runs until its tab closes, the workspace is deleted or the server stops; elsewhere the tab shows "Session ended". Each tab has its own WebSocket (`/ws/terminal/:id`, same device auth + one-time tickets) so heavy output can't eat the sync socket's budget. Scrollback is raw output replayed into a reset xterm. The desktop bundle ships node-pty's N-API prebuilds (execute bit on `spawn-helper` fixed at runtime too). Paired devices get terminals (same trust as agents).
- **Voice reads as it streams** (I-183): `planTurn(transcript, ended)` yields final pieces with stable keys (message, block, markdown start) plus the unfinished tail; the machine keeps `state.reading` and queues each new piece (`SpeakOptions.queue`, offsets shifted into the whole reply). Barge-in, Stop or the user talking ends reading that turn; a reply already there when voice mode opens isn't read. The native engine synthesizes the next queued item while the current plays, each with its own marker timeline and start frame.
- **Native sub-agents** (I-188): an agent's own sub-agents (Claude's Task, Codex's spawn_agent) are Glade `subagent` sessions marked `native`, fed by the optional `HarnessSession.onNativeSubagent` (separate from `onEvent`) with no process of their own: events folded through `LivePool.inject`, the run owned by the server with a lease, read-only (409), outside the agent API, never restarted, ended when the parent's process stops or exits. Spawn cards link by `SpawnedAgentRef.toolCallId` before name matching.
- **Glade runs the sub-agents** (user, 2026-09-30): harnesses are steered to Glade's sub-agent tools (e.g. the `glade` namespace + developer note for Codex); a harness's own sub-agents are still shown (I-188) when it uses them anyway.
- **Reading highlight in the chat** (I-193): the word being read reaches app-core only as the harness-neutral `readingHighlight` signal (message id, block index, markdown range); `Markdown` marks it with a rehype step in that block only, passing the range as plugin options (Streamdown caches processors by plugin name + options). Minimizing voice mode keeps the conversation alive; closing ends it.
- **Usage limits per agent and per Mac** (I-191): one entry per offered agent in the `usage_limits` push; a harness may set its own polling interval (`usageLimitsPolling`) when reading is expensive. Claude Code's come from the SDK's experimental `/usage` via a short-lived process (`null` if the SDK changes). The context ring stays context-only; the popover lists the chat's own agent first.
- **Tool outcomes are flags, not text** (I-190): unsuccessful calls use the harness-neutral `rejected`, `stopped` (new) and `status: "error"`; a call the run cut off counts as stopped whatever ended the run; the UI never reads output text (except a legacy "Stopped" fallback). Claude's plan approval (I-189) copies the CLI's "Ready to code?" rows, without its clear-context / Ultraplan / bypass rows.
