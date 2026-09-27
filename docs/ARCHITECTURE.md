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

## Harnesses

`apps/server/src/harness/types.ts` defines `AgentHarness` (list models, open/delete sessions,
generate titles) and `HarnessSession` (prompt, abort, model/thinking, dialogs, events). An adapter
translates its agent's native protocol to `@pi-ui/protocol` `AgentEvent`s. The UI and AppService
never see harness-native data. To add a harness: implement the two interfaces under
`harness/<name>/`, add a translator with fixture tests, and register it in `src/index.ts`.

### pi adapter

- Spawns `pi --mode rpc [--session <file>] [--model p/id] [--thinking lvl]` with `cwd` = the
  workspace's folder (its project's, or the scratch folder for standalone workspaces).
- Child environment (I-038, `harness/pi/child-env.ts`): the server's env minus `CMUX_*` and
  `PI_AGENT_TEAMS_*`, so a server started from a cmux terminal doesn't make pi extensions
  (agent-teams) drive that terminal. Applies to RPC processes and one-shot title runs.
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

- **Built-ins** are pi-ui's own and are defined in one registry,
  `apps/web/src/features/chat/slash/builtins.ts` (name, description, args hint, and a `run`
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

pi-ui's "Default" model setting (`settings.models.defaultModel = null`) means the **harness's**
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

Agents running in pi-ui can spawn sub-agents (the ext-kit agent-teams extension's pi-ui backend).
Every agent process gets `PI_UI_URL`, `PI_UI_SESSION_ID`, `PI_UI_TOKEN` (random, per process,
memory only, revoked when the process stops) and, for sub-agents, `PI_UI_AGENT_NAME`
(`AGENT_ENV` in `packages/protocol/src/agents.ts`). The server never passes its own copies of
these on (`child-env.ts`). Routes (`http/agents.ts`, mounted at `/api/agents`, `Authorization:
Bearer <token>`; the token names the calling session):

| Method | Path | Body → result |
| --- | --- | --- |
| GET | `/agents` | → `ListAgentsResponse` (a main session's sub-agents, or a sub-agent's teammates) |
| POST | `/agents/spawn` | `SpawnAgentRequest` → `SpawnAgentResponse`; main sessions only (403), unique active name per parent (409), ≤ `MAX_ACTIVE_AGENTS` (4) active per workspace (429) |
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

| What                            | Where                                                        |
| ------------------------------- | ------------------------------------------------------------ |
| Session transcripts             | Owned by the harness. pi: `~/.pi/agent/sessions/--<cwd>--/…`  |
| Projects                        | `<dataDir>/projects.json`                                    |
| Workspaces + sessions index (title, pin, unread, model, session ref…) | `<dataDir>/workspaces.json` `{ version: 1, workspaces, sessions }` |
| Pre-I-035 chat index (no longer read; kept as a backup) | `<dataDir>/chats.json`               |
| Settings (overrides only)       | `<dataDir>/settings.json`                                    |
| Scratch cwd for non-project chats | `<dataDir>/scratch/`                                       |
| Data-dir lock (running server)  | `<dataDir>/server.lock` (see below)                          |

`dataDir` = `~/Library/Application Support/pi-ui` on macOS (override with `PI_UI_DATA_DIR`).
Only sessions created by pi-ui are listed; sessions started in the terminal are not imported.
Because transcripts stay in pi's own format, a pi-ui session can still be resumed with `pi --session`.

**Migration (I-035)**: when `workspaces.json` doesn't exist and `chats.json` does, the store turns
every chat into a workspace with exactly one main session, **both keeping the chat's id**
(`workspace.id = session.id = session.workspaceId = chat.id`), so `/chats/:id` URLs and the pi
session files (`sessionRef`, untouched) keep working. Workspace gets projectId, title/titleSource,
cwd, pinned/pinOrder, createdAt, lastActivityAt (`layout: null`); the session gets title/titleSource,
harness, sessionRef, unread, lastRunFailed, runInProgress, interrupted, createdAt, lastActivityAt,
model, thinkingLevel. `workspaces.json` is written immediately; since the migration only runs
while it's missing, it runs once. An unreadable `chats.json` is left alone (retried next start).
New workspaces get fresh ids for the workspace and its first session (they differ).

### Data-dir lock

Only one server may use a data folder (`apps/server/src/services/data-lock.ts`). Before touching
any data, the server creates `<dataDir>/server.lock` exclusively:

```json
{ "pid": 12345, "port": 4317, "host": "127.0.0.1", "kind": "dev", "startedAt": 1790461600277 }
```

`kind` = `PI_UI_SERVER_KIND` (default `"dev"`; the desktop app sets `"desktop"`). `port`/`host`
are rewritten with the actual address once listening (so `PI_UI_PORT=0` works). If the file
already exists, it is **stale** and replaced when its `pid` is dead (`kill(pid, 0)` → ESRCH), the
file is unreadable, or `GET http://host:port/api/settings` doesn't answer 2xx within ~1s.
Otherwise the server prints one line ("The pi-ui data folder is in use by the <kind> server on
http://host:port (pid N). Quit it first — or open that URL.") and **exits with code 3**. The lock
is removed on shutdown and in a `process.on("exit")` hook, but only while it still holds our pid
and `startedAt`. `PI_UI_NO_LOCK=1` skips it (tests). Desktop app: read the lock first; if it's
live (same checks), connect to its `host:port` instead of starting a server, and treat exit
code 3 from its own server the same way.

### Ordering

Projects are ordered manually by `Project.sortOrder` (ascending; new projects get min − 1, i.e.
the top). Project pinning is gone. Chats are never re-sorted by activity: unpinned chats sort by
`createdAt` (newest first, client-side); pinned chats sit at the top of their own list (a project,
or standalone) ordered by `Workspace.pinOrder`. (Here "chat" = workspace, the sidebar row.) The server never uses `lastActivityAt` for ordering.
Older data is migrated when the store loads: projects get `sortOrder` from their previous order
(pinned first, then most recent activity) and lose `pinned`; pinned chats without `pinOrder`
get one per list (most recent activity first).

## Server API

REST under `/api` (JSON). Errors: `{ "error": string }` with 4xx/5xx.

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
| GET    | `/chats`                      | legacy alias of `GET /workspaces` (the desktop app's quit check counts `working`/`blocked`) |
| GET    | `/sessions`                   | → `SessionSummary[]` (all workspaces)          |
| GET    | `/sessions/:id`               | → `SessionDetail` `{ session, transcript, state, pendingUiRequests }` (starts the agent if needed) |
| PATCH  | `/sessions/:id`               | `UpdateSessionRequest` `{ title?, unread?, interrupted?: false }` → `SessionSummary`; `interrupted: false` (only value accepted) dismisses the interrupted state |
| DELETE | `/sessions/:id`               | → 204: closes a tab (stops the agent, deletes its file, plus sub-agents it spawned); 409 for a workspace's last main session |
| POST   | `/sessions/:id/prompt`        | `PromptRequest` → 204 (empty text OK with images) |
| POST   | `/sessions/:id/abort`         | → 204                                          |
| PUT    | `/sessions/:id/model`         | `ModelRef` → 204                               |
| PUT    | `/sessions/:id/thinking`      | `{ level }` → 204                              |
| POST   | `/sessions/:id/ui-response`   | `UiResponse` → 204                             |
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
  shell's PATH, `PI_UI_STATIC_DIR` and `PI_UI_EXIT_ON_STDIN_CLOSE=1`, waits for `GET /api/settings`,
  then navigates the window there (same origin, so the loopback Host/Origin checks pass). Quit
  sends SIGTERM; if the app dies, the closed stdin pipe stops the server. Log:
  `~/Library/Logs/io.github.jas7457.pi-ui/server.log`. Missing node/pi → native error dialog.
- One server per data folder (`<dataDir>/server.lock`, see `services/data-lock.ts`): before
  spawning, the app reads the lock; if its pid is alive and `GET /api/settings` answers, it points
  the window at that server (e.g. `pnpm dev` on :4317) instead, shows a one-time notice ("Using
  the dev server that's already running…") and leaves it running on quit. The bundled server is
  started with `PI_UI_SERVER_KIND=desktop`; if it loses a startup race it exits with code 3 and
  the app connects to the lock's owner. If a borrowed server goes away for ~9s the app offers
  "Start Server" (its own).
- Quit confirmation (`src-tauri/src/quit.rs`): ⌘Q / Dock Quit / AppleScript `quit` go through
  `-[NSApplication terminate:]`, which tao can't veto, so the app adds
  `applicationShouldTerminate:` to tao's app delegate. It asks our own server `GET /api/chats`
  (legacy alias of `/api/workspaces`); if any workspace is `working`/`blocked` it cancels and shows "N chats are still working. Quitting
  stops them." [Quit] [Cancel]. No prompt when the server isn't ours or can't be reached.
- `pnpm tauri:dev` loads the Vite dev server instead and starts no bundled server
  (`scripts/dev-servers.mjs` reuses or starts `:4317`/`:5317`).
- Dev identity (I-031): `src-tauri/.cargo/config.toml` sets `scripts/dev-app-runner.sh` as the
  cargo runner, so `cargo run` / `tauri dev` start the debug binary from inside a minimal
  `target/debug/pi-ui (dev).app` (hard link + Info.plist + `icons/dev/icon.icns`, the icon with a
  DEV band made from `icon/icon-dev.svg`) via `exec`, keeping the pid for hot-reload. A bare
  executable has no bundle, so the Dock and switchers (AltTab reads `NSRunningApplication.icon`)
  showed the generic exec icon. Dev builds also use their own identifier
  `io.github.jas7457.pi-ui.dev` (`src-tauri/src/dev.rs`): the single-instance socket is keyed on it,
  and with a shared id opening `/Applications/pi-ui.app` while `tauri dev` ran only focused the
  dev window. `dev.rs` also undoes Tauri's dev-time Dock icon override so the Dock shows the DEV
  icon. `pnpm tauri:install` re-registers the installed bundle with LaunchServices (`lsregister
  -f`). Check what macOS reports with `swift apps/desktop/scripts/check-app-icon.swift`.
- Web side: `lib/desktop.ts` is the only bridge (dynamic `@tauri-apps/*` imports, no-ops in a
  browser); `<html data-desktop>` switches the page/sidebar to transparent over the window's
  vibrancy. Menu items emit `pi-ui:menu` events handled by `useGlobalShortcuts`.
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

- **One server per data folder** (2026-09-26): `pnpm dev` and the desktop app share the data
  folder, so a lock file (`server.lock`) guarantees a single owner. A second server refuses with
  exit code 3; the desktop app reuses a live server's port instead of starting its own.

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

- **Session storage stays harness-owned, in the harness's default location** (2026-09-26). Every
  harness must keep its own session format to resume conversations, so pi-ui stores only an index
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
  title via a one-shot `pi -p`. User-edited titles are never overwritten. The title model is
  `settings.models.titleModel`, or when unset `anthropic/claude-haiku-4-5` if the harness lists it,
  else the chat's model (a default, not a stored value).
- **Tool grouping** is a pure function with options (e.g. whether thinking breaks a group) so the
  behaviour can be changed in one place.
- **Closed sub-agents are deleted** (I-055, user decision 2026-09-26): closing a sub-agent removes
  its tab and conversation, like a cmux pane; its report_done summary lives on in the parent chat.
  There is no "finished agents" list. Only crashed ones keep their tab (shown without restarting).
