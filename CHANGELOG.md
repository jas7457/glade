# Changelog

All notable changes to Glade (formerly pi-ui). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every entry corresponds to a ticked item in PLAN.md.

## [Unreleased]

### Added

- Attach any file (PDFs, logs, zips, code…) with the paperclip, drag-and-drop or paste. The agent
  gets its path and reads it itself; your message shows the files as chips you can reveal in Finder.
- `@` file mentions show as small file and folder chips in sent messages.
- Opening a message result from ⌘K search jumps to that exact message and highlights it.
- The agent can find, read and open your other chats ("open the chat where we talked about the
  sidebar") with new `find_chats`, `read_chat` and `open_chat` tools.
- The Mac app reopens where you left off: the last chat (and tab) or settings page. Sidebar width
  and collapsed projects are remembered across restarts too.
- Run shell commands from the composer: `!command` runs it in the chat's folder and the agent sees
  the output with your next message; `!!command` runs it without telling the agent.
- `/name` without a title asks the small model to name the chat from what you've discussed so far.
- Settings → Models → Sub-agents: pick a cheaper model and thinking level for agents your chats
  start (default: same as the parent chat).
- Mark a chat as unread from the sidebar, a tab's menu or ⌘K, so you remember to come back to it.
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

- Drag projects to reorder them; pinned chats can be dragged within their pinned group. Project
  and pinned-chat menus also have Move Up / Move Down.
- Chats cut off by quitting or a crash are marked, with a banner to Continue or Dismiss.
- "Open in VS Code" button on project chats and the project's new-chat screen.
- Only one pi-ui server can use the data folder at a time; a second one explains what's running.

- ⌘K command palette: jump to any chat or project, or run actions (new chat, add project,
  settings, theme, rename/pin/delete the current chat…).

- The Mac app asks before quitting while chats are still working.
- If the dev server is already running, the Mac app uses it instead of starting a second server
  on the same data.

- Tabs in a workspace: open more conversations in the same folder with **+** (⌘T in the Mac app),
  rename or close them, and see each tab's status. A chat's sub-agents appear as tabs in a
  resizable right-hand pane that hides when there are none. Double-click a tab to maximize it.

- `pnpm dev:agent`: throwaway, self-cleaning pi-ui servers for agents, so testing never touches your
  data.

- Sub-agents inside pi-ui: when a chat's agent delegates with `spawn_agent`, each sub-agent runs as a
  tab in the right-hand pane, and its result comes back to the chat.
- `@` in the message box searches the project's files and inserts a file reference.
- Search inside chats from ⌘K (matching messages with snippets), and ask for a chat in plain words
  ("?" then e.g. "the chat about the new button"): a fast model picks the best match.
- Settings → Slash Commands: choose which commands appear in the `/` menu.

### Changed

- Internal: the server's core was split into small focused modules (no visible change); future
  features and parallel work are safer.
- Web searches and fetches, messages to sub-agents and MCP tool calls now have their own colours
  and readable summaries ("Searched the web for …", "Messaged reviewer: …", "Called
  chrome-devtools › take_snapshot") instead of a grey raw tool name.
- Finished "Ran 3 tool calls" rows are coloured like single tool calls, by the kind of tool they
  used most (green for commands, blue for reads, …), instead of grey.
- Replies use the same softer palette as agents: inline code is violet and list numbers and bullets
  are sky blue.
- Sub-agent chips above the composer have a fixed width, so they no longer jump around as their
  latest message changes.
- Sub-agents get a fun name and their own colour ("Maya · reviewer"). They show as small chips
  above the composer and as a live card where they were started, which turns into their report when
  they finish.
- Sub-agents show as a compact list above the composer (status, model, what each is doing, time),
  with Stop all. Their conversation opens on the right only when you click one, and closing that pane
  keeps them running.
- `pnpm tauri:install` no longer quits Glade: it replaces the app on disk and the new version starts
  the next time you open it (`--when-idle` is gone).
- "Working…" and "Thinking…" are grey again with a small rainbow shimmer sweeping across, instead
  of a fully rainbow label.
- More colour in chats: teal inline code, coloured list markers and links, a rainbow "Working…"
  (violet-blue "Thinking…"), and tool calls coloured by kind (shell green, read blue, edit amber…).
- Sub-agent reports show as a compact card you can expand, rendered as Markdown, instead of a long
  raw-text message.
- The "Title model" setting is now "Small model": one quick model for naming chats, summaries and
  search. Your choice carries over.
- Tool calls are described in an agent-neutral way (shell, read, edit, search…), so other agents'
  tool calls will display just like pi's. pi chats look the same as before.
- Under the hood, Glade can now run more than one kind of agent: each chat remembers which agent
  it was created with, settings are kept per agent (pi's are migrated automatically), and controls
  an agent doesn't support are hidden. pi works exactly as before.
- While the agent works, the "Working…" row stays in place for the whole run instead of blinking
  between tool calls, shows "Thinking…" while the model thinks, and counts the elapsed time
  ("Working… 1m 12s"). Tool groups and tool rows show how long they took.
- Replies stream in smoothly, even short ones that the provider sends in one piece, and there's no
  more silent pause before the text appears.
- **pi-ui is now Glade**: new name, new leaf icon, `/Applications/Glade.app` (the old app is removed
  on install). Your data is copied to `~/Library/Application Support/Glade` on first start; the old
  folder stays as a backup. `GLADE_*` environment variables replace `PI_UI_*` (old names still work).

- The Mac app always runs its own server and can run alongside `pnpm dev` on the same data: chats
  created in one appear in the other, and a chat running in one is read-only in the other until it's
  idle.
- Usage moved from the sidebar into the chat: hover the context ring next to the model picker for
  context, cost and (for Claude models) your subscription limits.
- `pnpm tauri:install --when-idle` waits until no chat is working before updating the app.

- Every tab can be closed; closing a chat's last tab asks, then deletes the chat.

- Sub-agent tabs show when they're done (✓) or stopped, with the task and result on hover and in a
  bar above the conversation.

- Tabs are as wide as their titles (up to a limit), and the active tab has a blue line on top.
- Mac app menu: New Tab ⌘T, Close Tab ⌘W, Close Window ⇧⌘W, and Show Next/Previous Tab ⌃Tab / ⌃⇧Tab.

- New chats list your pi commands and skills in the `/` menu too, and every group is sorted A→Z.
- "Default" model now means the model set in pi (e.g. Claude Opus 5.5) rather than the first model
  in the list, for new chats and in Settings.

- Under the hood, each sidebar row is now a workspace that can hold several conversations
  (groundwork for tabs and sub-agents). Existing chats were migrated automatically.

- Sidebar: projects line up with the section headers, chats inside a project line up with the
  project name, and a chat's status sits on the right again (swapping to its actions on hover).

- Tooltips, menus and popovers stand out from what's behind them (lighter layer, thin border,
  deeper shadow).
- Sidebar alignment: chat status dots line up with the section headers and projects are indented
  by the status width, leaving less empty space on the left.

- The context meter tooltip is shorter (no auto-compact note) and also shows your Claude
  subscription limits with reset times.

- Softer text: light grey instead of near-white, with dedicated sidebar text colours (brighter for
  the selected and unread chats).
- ⌘B toggles the sidebar (⌘\\ still works).

- The sidebar no longer reorders when messages arrive: projects keep their manual order, chats are
  newest-created first with pinned chats on top.
- Chat titles are generated with Claude Haiku by default (cheaper; change it in Settings → Models).

- The chat header no longer shows the working folder path, just the title and project.

- Roomier sidebar with clearer grouping: taller rows, more space between sections, and
  project chats indented under their project.
- Settings sidebar grouped into App (General, Appearance) and AI (Models, Agent (pi)).
- A chat's status (working, needs input, unread, failed) now shows to the left of its title
  and stays visible when you hover the row.

- Deleting a chat is permanent: its conversation file is erased, not moved to the Trash.
- Dialogs look cleaner: confirmations are wider and left-aligned with a short heading, the chat or
  project name in the text (long names are shortened), a red icon for destructive actions and
  compact buttons on the right. Create project and every confirmation share the same design.

### Fixed

- New sub-agents no longer pop the side pane open just because you opened an earlier one; the pane
  closes once its last agent is gone and only opens when you click an agent.
- Reopening a chat no longer adds a duplicate title entry to pi's session file each time.
- Long replies no longer appear as one big block after the agent thinks: the text streams in at a
  steady pace from the start.
- A chat you mark as unread stays unread even when it's open in another Glade window or server.
- Status dots stay visible on the highlighted row in the ⌘K palette.

- Finished sub-agents close their tab (the conversation is deleted; its result stays in the parent
  chat), and asking an agent to close an already-closed sub-agent no longer fails.
- Tabs no longer stay stuck on "Working…" after a session is stopped.

- Moving through a long `/` menu or ⌘K list with the arrow keys no longer makes the list jump.
- A message sent right after another is queued instead of failing with "already processing".

- Agents started by pi-ui no longer inherit the terminal's cmux settings, so they can't open panes
  in your cmux window.

- pi-ui shows its icon in AltTab and the Dock. Dev builds run as "pi-ui (dev)" with a DEV icon and
  no longer take over when you open the installed app.

- The text cursor no longer touches the folder icon in the Create project name field.

- The dev server no longer shows "Not found" after restarting while the web app was being rebuilt.

- Dialogs no longer open off to the left and then jump to the centre.
- The usage gauge says the weekday ("Resets Saturday") for resets a week away.

- Large photos can be attached: images are shrunk to the model's limits before sending
  (e.g. an 11 MB phone photo goes out as about 200 KB), and anything still too big gets a clear message.
- Provider errors read as a sentence ("Image exceeds 10 MB maximum") with the raw error under
  "Details", instead of a wall of JSON.

### Removed

- The Apple Intelligence "Write with Siri" button no longer pops up next to the message box in the
  Mac app.

- System notifications and the "chat finished" pop-ups. Chat status shows in the sidebar, the window
  title count and the Dock badge (unread, waiting for input, interrupted).

- Pinning projects (projects are ordered by dragging instead).

- The built-in folder browser (replaced by the native macOS folder picker).

- Archiving chats (and the Archived Chats settings page). Chats are kept or deleted.
