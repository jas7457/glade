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
| DELETE | `/chats/:id`                  | → 204 (session file moved to Trash)            |
| POST   | `/chats/:id/prompt`           | `PromptRequest` → 204 (empty text OK with images) |
| POST   | `/chats/:id/abort`            | → 204                                          |
| PUT    | `/chats/:id/model`            | `ModelRef` → 204                               |
| PUT    | `/chats/:id/thinking`         | `{ level }` → 204                              |
| POST   | `/chats/:id/ui-response`      | `UiResponse` → 204                             |
| GET    | `/models[?refresh=1]`         | → `ModelInfo[]`                                |
| GET    | `/settings`                   | → `Settings`                                   |
| PATCH  | `/settings`                   | `DeepPartial<Settings>` → `Settings`           |
| GET    | `/fs/dirs[?path=]`            | → `DirectoryListing` (folders only; default ~) |

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

## Decisions

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
