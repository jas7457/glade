# Changelog

All notable changes to pi-ui. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every entry corresponds to a ticked item in PLAN.md.

## [Unreleased]

### Added

- Project skeleton: pnpm monorepo with web app, server and shared protocol package.
- Working agreement for humans and agents (AGENTS.md), plan ledger (PLAN.md), architecture notes.
- Shared protocol describing models, transcripts and streaming agent events independent of pi.
- Server-side pi integration: runs `pi --mode rpc` per chat, translates its events, keeps a pool
  of agent processes, and tracks running/unread state and chat titles.
- Fake agent harness so the UI can be developed and tested without a real model.
- App data (projects, chat list, settings) stored in `~/Library/Application Support/pi-ui`.
- Web app scaffold with macOS-style light/dark design tokens and first UI components.
- Server API (REST + WebSocket push) serving the web app; it only accepts connections from this
  computer.
- Folder browser for picking project folders.
- Chat status tracking: each chat is idle, unread, working, or blocked (waiting for your answer),
  and failed runs are flagged. Updates are pushed live, and chats only count as read while the
  window is visible.
- Automatic chat titles: an instant title from your first message, replaced by a short
  model-generated title unless you've renamed the chat.
- Chat screen: editable title, project and folder in the header, live "Working…" / "Needs your
  input" status, and a menu to rename, pin or delete the chat.
- New chat screen: type your first message and the chat is created and opened; model and
  thinking level start from your defaults.
- Rich transcript: formatted markdown with syntax-highlighted, copyable code blocks, collapsible
  "Thought" sections, inline error notices, and compaction/system notes. It follows the reply as
  it streams, and stops following when you scroll up ("Jump to latest" brings you back).
- Tool calls are summarised in one line each ("Ran `npm test`", "Edited src/app.ts +3 −1");
  consecutive calls collapse into "Ran N tool calls". Expand to see terminal output, file
  contents, or a diff of the edit.
- Composer: grows as you type, sends with Enter or ⌘Enter (per settings), accepts pasted,
  dropped or attached images, and has model and thinking-level pickers. While the agent works you
  can stop it (button or Esc) or queue more messages, which show above the input.
- When the agent asks a question (choose / confirm / type / edit), it appears as a highlighted
  card above the composer; agent crashes show as a dismissible banner.
- App shell like a native Mac app: resizable, collapsible sidebar (⌘\\), light/dark/auto theme,
  font size, and keyboard shortcuts (⌘N new chat, ⌘, settings).
- Sidebar with Projects (each a folder on disk, with its chats) and standalone Chats: pin, rename
  inline, delete, "Show more", and right-click menus.
- Status on every chat: spinner while working, amber mark when it needs your input, blue dot for
  unread (red if the last run failed). Collapsed projects show their most urgent chat.
- Notifications: the window title shows how many chats need attention; system notifications
  when a background chat finishes or needs input; an in-app toast with "View" when another chat
  finishes while you're using the app.
- Add Project dialog with a folder browser (or paste a path, `~` supported).
- Settings: General, Models (defaults, title model, show/hide models), Appearance, Agent
  (pi path, arguments, process limits, auto-compaction/retry).

- Create Project dialog like Codex: name the project and choose its folder with the native macOS
  folder picker. The name fills in from the folder unless you've typed one.

- pi-ui as a Mac app: `pnpm tauri:install` builds it and installs it in /Applications. It starts
  its own server, finds your node and pi automatically, and has native traffic lights, a
  translucent sidebar, the native folder picker, notifications, a dock badge with chats needing
  attention, and a proper menu bar. Closing the window keeps agents running; ⌘Q quits.
- `pnpm tauri:dev` opens the desktop window on the live dev server.

- Context meter in the composer: see how full the conversation's context is (amber near the limit),
  plus the session cost where it applies.
- Slash commands: type `/` for a menu of pi-ui commands (/compact, /new, /name, /model,
  /thinking, /export, /stats, /settings) and your pi extension commands and skills.
- Compacting shows a divider in the chat with how much context was freed.

- Claude subscription usage in the sidebar footer: current session, weekly and per-model limits
  with reset times, updated every minute and after each run; warns when a limit gets close.

### Changed

- The chat header no longer shows the working folder path, just the title and project.

- Roomier sidebar with clearer grouping: taller rows, more space between sections, and
  project chats indented under their project.
- Settings sidebar grouped into App (General, Appearance) and AI (Models, Agent (pi)).
- A chat's status (working, needs input, unread, failed) now shows to the left of its title
  and stays visible when you hover the row.

- Deleting a chat is permanent: its conversation file is erased, not moved to the Trash.

### Fixed

- Large photos can be attached: images are shrunk to the model's limits before sending
  (e.g. an 11 MB phone photo goes out as about 200 KB), and anything still too big gets a clear message.
- Provider errors read as a sentence ("Image exceeds 10 MB maximum") with the raw error under
  "Details", instead of a wall of JSON.

### Removed

- The built-in folder browser (replaced by the native macOS folder picker).

- Archiving chats (and the Archived Chats settings page). Chats are kept or deleted.
