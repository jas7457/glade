# Architecture

```
┌──────────── apps/web (Preact) ────────────┐        ┌──────────── apps/server (Node) ─────────────┐
│ routes → features → ui primitives          │  REST  │ http/ (Hono routes, security)                │
│ state/ (signals) ← lib/socket (push)       │ ◄────► │ services/AppService (projects, chats, pool)  │
│ applyAgentEvent() folds live events        │   WS   │ harness/<name>/ (pi, fake, …)                │
└────────────────────────────────────────────┘        │   └─ pi: one `pi --mode rpc` per open chat   │
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

- Spawns `pi --mode rpc [--session <file>] [--model p/id] [--thinking lvl]` with `cwd` = project
  folder (or the scratch folder for standalone chats).
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
- **Harness commands** come from `GET /api/chats/:id/commands` (pi: `get_commands`), are cached
  in the chat store (`commands` signal, fetched once per chat when it opens) and are sent as a
  normal prompt; pi expands skills/templates and runs extension commands itself.

The server returns harness commands only and the web merges them after its built-ins (a harness
command with a built-in's name is hidden). The new-chat composer has no agent yet, so it offers
only built-ins that don't need a chat (`/model`, `/thinking`, `/settings`).

## Data on disk

| What                            | Where                                                        |
| ------------------------------- | ------------------------------------------------------------ |
| Session transcripts (per chat)  | Owned by the harness. pi: `~/.pi/agent/sessions/--<cwd>--/…`  |
| Projects                        | `<dataDir>/projects.json`                                    |
| Chat index (title, pin, unread, model, session ref) | `<dataDir>/chats.json`                   |
| Settings (overrides only)       | `<dataDir>/settings.json`                                    |
| Scratch cwd for non-project chats | `<dataDir>/scratch/`                                       |

`dataDir` = `~/Library/Application Support/pi-ui` on macOS (override with `PI_UI_DATA_DIR`).
Only chats created by pi-ui are listed; sessions started in the terminal are not imported.
Because transcripts stay in pi's own format, a pi-ui chat can still be resumed with `pi --session`.

## Server API

REST under `/api` (JSON). Errors: `{ "error": string }` with 4xx/5xx.

| Method | Path                          | Body / notes                                   |
| ------ | ----------------------------- | ---------------------------------------------- |
| GET    | `/projects`                   | → `Project[]`                                  |
| POST   | `/projects`                   | `CreateProjectRequest` → `Project`             |
| PATCH  | `/projects/:id`               | `UpdateProjectRequest` → `Project`             |
| DELETE | `/projects/:id`               | removes project + its chats → 204              |
| GET    | `/chats`                      | → `ChatSummary[]`                              |
| POST   | `/chats`                      | `CreateChatRequest` → `ChatDetail`             |
| GET    | `/chats/:id`                  | → `ChatDetail` (starts the agent if needed)    |
| PATCH  | `/chats/:id`                  | `UpdateChatRequest` → `ChatSummary`            |
| DELETE | `/chats/:id`                  | → 204 (session file permanently deleted)       |
| POST   | `/chats/:id/prompt`           | `PromptRequest` → 204 (empty text OK with images) |
| POST   | `/chats/:id/abort`            | → 204                                          |
| PUT    | `/chats/:id/model`            | `ModelRef` → 204                               |
| PUT    | `/chats/:id/thinking`         | `{ level }` → 204                              |
| POST   | `/chats/:id/ui-response`      | `UiResponse` → 204                             |
| GET    | `/chats/:id/commands`         | → `SlashCommand[]`: the harness's commands only (extensions, skills, prompts); built-ins live in the web app |
| POST   | `/chats/:id/compact`          | `{ instructions? }` (body optional) → `CompactResult`; 409 while a reply is running |
| POST   | `/chats/:id/export`           | `{ reveal? }` (body optional) → `{ path }` (HTML file; pi: `~/Downloads/pi-session-….html`) |
| POST   | `/fs/reveal`                  | `{ path }` → 204; reveals a file this server exported in Finder (404 for other paths, 501 off macOS) |
| GET    | `/models[?refresh=1]`         | → `ModelInfo[]`                                |
| GET    | `/settings`                   | → `Settings`                                   |
| PATCH  | `/settings`                   | `DeepPartial<Settings>` → `Settings`           |
| POST   | `/fs/pick-folder`             | `{ prompt?, defaultPath? }` → `PickFolderResponse`; native macOS dialog (osascript), 501 elsewhere |

WebSocket `/ws`: server pushes `ServerMessage` (`chat_event`, `chat_upsert`, `chat_removed`,
`project_upsert`, `project_removed`, `settings`, `models`). Client sends
`{ type: "viewing", chatId }` so runs finishing on screen aren't marked unread.

## Chat status

Every `ChatSummary` carries a derived `status` (`packages/protocol/src/status.ts`), computed on
the server and pushed via `chat_upsert` on every change. Precedence, most urgent first:

| Status    | Meaning                                                                   | Source                               |
| --------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `blocked` | Agent is paused waiting for the user (confirm/select/input/editor dialog) | pending `ui_request`s (deterministic) |
| `working` | Agent is running                                                          | session `isRunning`                  |
| `unread`  | A run ended while the chat wasn't on screen in a visible window           | `run_end` with no viewers            |
| `idle`    | Nothing new                                                               | —                                    |

`lastRunFailed` marks runs that ended in an error or crash (user aborts don't count). A model
asking a question in plain text can't be detected reliably; it ends the run and shows as
`unread`. The client tells the server which chat is on screen (`viewing`), but only while the
document is visible, so chats finishing behind a hidden window still become unread.
Project rows, the window title and notifications use `aggregateChatStatus` / `needsAttention`.

## Security

The server binds to `127.0.0.1` and rejects requests whose `Host` isn't a loopback name
(DNS-rebinding protection) and WebSocket upgrades / mutating requests whose `Origin` isn't
loopback. Remote access (a later phase) will add a token and configurable bind address.

## Web app

- `src/app/` — router (`createBrowserRouter`), layout, `routes.ts` path helpers.
- `src/ui/` — primitives (only place with raw styling decisions).
- `src/features/<feature>/` — sidebar, chat, settings, projects. Each exposes an `index.ts`.
- `src/state/` — signals: `store.ts` (projects, chats, models, settings), `chat-session.ts`
  (per-chat transcript/state, `useChatSession(chatId)`), `toasts.ts`.
- The transcript and composer take only a `chatId`, so they can be embedded anywhere.

Routes: `/` (new chat), `/chats/:chatId`, `/projects/:projectId` (new chat in project),
`/projects/:projectId/chats/:chatId`, `/settings/:section`.

## Desktop app (`apps/desktop`)

- `pnpm tauri:build` runs `scripts/bundle-server.mjs` (web build + esbuild bundle of the server
  into one `server.mjs`), staged in `dist-bundle/` and shipped as the `app/` resource.
- On launch (`src-tauri/src/server.rs`) the app resolves `node`/`pi` via `$SHELL -ilc` (falling
  back to nvm/Homebrew dirs), starts `node server.mjs` on a free loopback port with the login
  shell's PATH, `PI_UI_STATIC_DIR` and `PI_UI_EXIT_ON_STDIN_CLOSE=1`, waits for `GET /api/settings`,
  then navigates the window there (same origin, so the loopback Host/Origin checks pass). Quit
  sends SIGTERM; if the app dies, the closed stdin pipe stops the server. Log:
  `~/Library/Logs/io.github.jas7457.pi-ui/server.log`. Missing node/pi → native error dialog.
- `pnpm tauri:dev` loads the Vite dev server instead and starts no bundled server
  (`scripts/dev-servers.mjs` reuses or starts `:4317`/`:5317`).
- Web side: `lib/desktop.ts` is the only bridge (dynamic `@tauri-apps/*` imports, no-ops in a
  browser); `<html data-desktop>` switches the page/sidebar to transparent over the window's
  vibrancy. Menu items emit `pi-ui:menu` events handled by `useGlobalShortcuts`.
- Closing the window hides it (agents keep running); the Dock icon reopens it; ⌘Q quits.

## Decisions

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
  title via a one-shot `pi -p`. User-edited titles are never overwritten.
- **Tool grouping** is a pure function with options (e.g. whether thinking breaks a group) so the
  behaviour can be changed in one place.
