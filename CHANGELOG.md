# Changelog

All notable changes to Glade (formerly pi-ui). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every entry corresponds to a ticked item in PLAN.md.

## [Unreleased]

### Added

- Codex chats: your Codex skills and `/review` (uncommitted changes, `base <branch>`, `commit <sha>`
  or your own instructions) in the `/` menu, and `!cmd` / `!!cmd` shell commands in the chat's
  folder; `!` output is shared with Codex.
- Codex as an agent: when `codex` is installed, Settings → Agents offers it, using your own Codex
  login. Codex chats stream replies, commands, file edits with diffs, MCP calls, web searches and
  plans; pick Codex's models and reasoning effort, stop or steer a run, answer approval cards
  worded like Codex's own, and switch between Read only / Auto / Full access per chat. When your
  Codex usage runs out, the chat says so with the reset date.
- Claude Code chats ask for permission the way the CLI does (Yes / Yes, and don't ask again for … /
  No, and tell Claude what to do differently; keys 1–3 and Esc), and have permission modes
  (Default, Accept edits, Plan, Auto, Bypass) in a pill next to the model, switched with
  Shift+Tab; each chat keeps its own mode.
- Claude Code as an agent: if `claude` is installed, it shows up on the Agents page and in the
  agent picker, using your own Claude Code install and login. Chats stream text, thinking and tool
  calls (with diffs and a plan card), with Claude's models and thinking levels, its permission
  prompts as Glade's permission card, and they resume after restarts. Stop, steering, slash
  commands, /compact, the context meter, titles, side questions and Glade sub-agents work too.
- iPhone: the chat's model and thinking level show under its title; tap to change them.
- iPhone: name your iPhone when pairing or in Settings, and every Mac shows that name.
- iPhone: search now looks inside your chats too (showing the matching passage and opening at
  that message), and an Ask row finds a chat from a description, across all your connected Macs.
- Folders in the chat list: group projects and standalone chats in top-level folders, or a
  project's chats in folders inside it (one level deep). Create, rename and delete them; drag
  things in or use Move to Folder (on iPhone: long-press). Deleting a folder moves its contents
  back out.
- Side questions: ask follow-ups right in the same card. Answers in long chats now see the start
  of the chat and your earlier messages, not just the latest part, and the card says when an answer
  only saw part of the chat. Tell the Agent / Add to Queue pass on the whole thread.
- The Glade iPhone app (early, simulator only for now): it runs no server of its own and connects
  to your Macs. On first launch, Connect to a Device pairs it with a Mac from its Share This
  Device… link or code; the Mac sees an "iPhone" asking to connect, and the token is kept in the
  iPhone's Keychain. Scan QR Code reads the code the Mac shows (asks for the camera first).
  Then: all your chats from every Mac in one list (by project, with working / needs you /
  unread, search), a chat full screen with a touch composer (↩ is a new line; hold Send for
  follow-up or Ask Aside), model and thinking pickers as sheets, sub-agents as cards you can
  open, the chat list as a slide-over, new chats, and Settings for your Macs (rename,
  disconnect, their AI settings read-only) and the theme.

- Update Now in Settings → About: when you're behind, Glade pulls, installs and rebuilds itself
  with live progress, then restarts on the new version (right away, or once your chats finish).
- Glade lives in the menu bar: ⌘Q closes the window but keeps chats, sub-agents and sharing
  running; quit for real with Quit Glade Completely (menu bar or ⌥⌘Q). The menu bar leaf (with a small badge while chats work or need you) has a menu that shows
  working chats and sharing, and opens Glade, a new chat or Settings. New options: Show in Dock
  and Open at login.
- Glade keeps your Mac awake while a chat is working, and while it's shared with a connected
  device (on power; optional on battery). The display can still sleep.
- Settings → About shows which build you're running and whether it's behind GitHub's main, and
  Connections tells you when another device runs an older or newer Glade.
- Pair your own devices without typing a code: click Connect on a device found on your tailnet,
  check that both screens show the same number, and press Allow on the other device. Works when
  both are signed in to the same Tailscale account; otherwise Glade asks for the code as before.
- Ask a side question while the agent works: type `/btw …`, or type while it's busy and press
  Ask Aside (⌥↩). The answer appears right away in a card the agent never sees, with buttons
  to tell the agent or queue it. An optional cheaper model for these is in Settings → Models.
- Notifications: when a chat needs your input, finishes or fails while Glade is in the background,
  macOS shows a banner ("On Mac Studio" for remote chats); clicking it opens the chat. Choose which
  in Settings → General → Notifications.
- Tailscale: with "Let other devices use this device" on, Glade shares itself on your tailnet over
  HTTPS (`https://<your-mac>.<tailnet>.ts.net`, only your devices, never public) and turns the
  share off again with the switch. Settings shows Tailscale's status and how to fix it (install,
  sign in, enable HTTPS), and Connect to a Device lists Glade devices found on your tailnet.
- Pair devices: Settings → Remote Access → Share This Device shows a QR code, a link and a short
  code. The other device enters it under Connect to a Device, you click Allow, and it sees this Mac's
  projects and chats. Paired devices are listed with Rename and Revoke; revoking cuts them off at
  once. Other devices can't connect at all unless you turn on "Let other devices use this device".
- Environments: every Glade is an environment, and projects belong to the machine whose files
  they are. Settings → Remote Access (off by default) lets this app show other Glade environments
  next to this Mac's projects in one list, marked with a globe. Pickers and agent settings follow
  the chat's machine.
- Glade's own folder browser in Add Project: type a path with autocomplete, browse with the
  keyboard, see git repos, create folders. It works for remote machines too.
- ACP agents: add any agent that speaks the Agent Client Protocol (Gemini CLI, Claude Code via an
  adapter, goose, …) in Settings → Agents and pick it for a new chat. Tool calls, plans, permission
  requests and history work like other chats. Nothing is set up by default.
- Sub-agents and chat tools now come with Glade itself (no ext-kit needed); new setting Settings →
  Agent → Use sub-agents.
- When starting a worktree chat you can bring your uncommitted changes along; your project folder
  keeps its copy.
- Click any image in a chat to see it large (←/→ between images, Copy image).
- Message times: hover a message to see when it was sent, with Today / Yesterday dividers between days.
- New-chat bar above the composer: pick the project, Local or a new worktree, and the branch. In
  Local mode switching branch is refused while you have uncommitted changes, with a Commit… button
  right there.
- Every git chat shows where it works in its header ("Local · main" / "Worktree · glade/…"), kept up
  to date.
- Work in a git worktree: switch on "New worktree" when starting a chat in a git project and it gets
  its own branch and folder. Deleting it asks whether to keep the branch, merge it or discard it.
- Changes panel: the header shows how many files git sees changed; open it to review diffs, discard
  files and commit (with a generated message).
- Saved prompts: keep reusable prompts globally or per project (Settings → Prompts) and insert them
  from the composer's `/` menu.
- "Rename with AI" in ⌘K and the tab's right-click menu.
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

- When your Mac offers more than one agent, every chat shows which agent it runs on (the default
  one too): a badge in the chat header, and before the model on the iPhone's chat title line.
- The model picker shows Claude Code's models with their version and a short description
  ("Opus 5.5 — Best for everyday, complex tasks") under a "Claude Code" header.
- Long chats open faster on the Mac and iPhone: they start with the latest messages and load older
  ones as you scroll up.
- iPhone: when a Mac can't be reached, the phone says what to check (awake with Glade open,
  Tailscale on) and offers Retry.
- Every item in the sidebar's chat, project and folder menus now has an icon, on the Mac and in
  the iPhone's long-press sheets.
- iPhone: New Chat now looks like a chat: the same floating text box (attachments, Model &
  Thinking), a welcome in the middle, and Mac / Project chips above the text box; the agent is
  picked in the Model & Thinking sheet.
- On the iPhone: the text box is a slim pill until you tap it, then grows full width; model and
  thinking level share one button that opens one sheet; no more ↑ ↓ ✓ bar over the keyboard.
- Tool rows show file paths relative to the chat's folder (e.g. "Edited packages/protocol/src/api.ts");
  paths elsewhere are shortened with ~, and hovering shows the full path.
- Settings are simpler: General opens with your Glade version and Update Now, then the theme;
  the About and Appearance pages and the Text size setting are gone. Agents lists only pi and
  Claude Code, and an agent that isn't installed can't be switched on (it says what Glade looked
  for). The pi path, extra arguments, auto-compaction, auto-retry and idle-agent settings are gone
  (compaction and retry are always on).
- Settings lists Agents before Models, since the agents decide which models there are.
- Images (screenshots, pasted pictures) and uploaded files are stored as files next to the
  database instead of inside it, one folder per chat, so the database stays small (yours: about
  60 MB → 13 MB). Deleting a chat deletes its folder and everything it stored, right away.
- Settings → Agents lists every supported agent (pi, Claude Code, Gemini CLI, Codex, your own
  ACP agents) with whether it's installed, an Enable switch, its settings and install links.
  Only enabled agents are offered, also to other devices. A "Settings for" switcher picks the
  device, and another device's settings are view-only: change them on that device.
- Sending is simpler: ↩ sends (and steers a working agent), ⌘↩ sends a follow-up that waits
  until it's done, ⌥↩ asks aside, ⇧↩ adds a line. Holding ⌘ shows the follow-up button. The
  "Send message with" and "While the agent is working" settings are gone.
- The README has a guide to remote access: setup, security, keeping a Mac available, updating
  and troubleshooting.
- Command rows no longer start with a long `cd /path/to/project &&`: a cd into the chat's folder
  is hidden, and a subfolder shows as a small label (e.g. `apps/web`) before the command.
- Sub-agents get a short title when they start (shown in their tab), and hovering an agent's chip
  shows that title and what it's doing now in plain words instead of the whole prompt.
- Starting a sub-agent shows its card straight away ("Starting an agent…"), and a sub-agent's
  task card names the chat it came from, with the full title on hover and a click to open it.
- Sub-agents draw from 316 names, and a chat doesn't reuse a name until it has used them all.
- Remote devices show their status as a coloured dot (connected, connecting, off, needs
  attention) in Connections, the globe popover and the sidebar, and a device that turns remote
  access back on is noticed within seconds (instantly when you switch back to Glade).
- Sub-agent tabs can't be closed by accident any more: use Remove Sub-agent… (right-click the tab
  or the ⋯ menu), which asks first. Hide the pane with the new Hide button, Esc, ⌥⌘B, or by
  clicking the agent's chip again.
- Connect to a Device shows who you're connecting to and no longer asks for your own name; each
  device names its connections itself (Rename in the Connections row), and that name is used
  everywhere. Devices found on your tailnet now show up on their own, with a Refresh button.
- Remote Access is simpler: the sharing switch sits right under the main switch, and one
  Connections list shows every device with "You use it" and/or "Uses this device", next to
  Connect to a Device… and Share This Device….
- The Mac app keeps the keys for Macs you've paired with in the macOS Keychain instead of its web
  storage (moved over automatically).
- Settings → Remote Access has one Remote access switch: off turns everything remote off (and cuts
  off devices using this Mac); on shows your environments and, separately, "Let other devices use
  this Mac". Other Macs you use stay listed with their status (turned off there, offline, can't
  reach, needs pairing) and reconnect on their own.
- Settings reopens on the page you had open last (and the machine you had picked there).
- Destructive buttons in confirm dialogs (Close Tab, Delete Chat, Delete Project, …) are now a
  filled red button, so they stand out clearly from Cancel.
- Live updates are numbered: after a dropped connection or a server restart, every open window
  catches up on exactly what it missed, without reloading, and a retried send can't post a message
  twice. Long chats open with the most recent turns and a "Load earlier messages" button.
- Glade now keeps all its data, including every conversation, in its own database (`glade.db`).
  Existing chats are copied in automatically the first time the new version starts (quit any older
  Glade first; it tells you if one is still running). Chats load without starting the agent, and
  search, titles and Ask work the same for every agent. Glade now needs Node 22.13 or newer.
- The lead agent now knows its sub-agents by the names you see (Leo, Remy, …) and uses them when it
  talks to you.
- Sub-agent chips above the composer show a pointer cursor, so it's clear they open the agent.
- Dialogs look like native macOS alerts: everything lines up, regular-size buttons, and destructive
  actions in red text instead of a big red button.
- Pasted images in the composer open large when clicked, like sent ones.
- Images in a chat show a zoom-in cursor on hover, so it's clear they open large.
- Message times show just below each message (right under yours, left under the agent's).
- A sub-agent's task (and later messages from the main agent) shows as a compact "Task from main"
  card instead of a huge message from you; very long messages collapse with "Show more".
- "Messaged …" and "Closed …" rows use the sub-agent's fun name and colour ("Messaged Kit ·
  context-bar: …"), and expand to the message itself instead of raw JSON.
- Links in replies stand out: a soft sky-blue chip with a link icon in front.
- The agent's chat tools have their own colour and readable rows ("Found 3 chats for …", "Opened
  chat …").
- Sub-agent reports no longer end up in chat titles or summaries, and search shows them as agent
  messages rather than your words.
- Sub-agent chips are narrower and left-aligned, and start with the agent's status (spinner, check,
  needs input, failed) instead of a coloured dot.
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

- iPhone voice mode: the highlighted word follows the voice in order on long replies instead of
  jumping between paragraphs, and the text scrolls only now and then instead of with every word.
- iPhone: while the agent works, the slim text box shows Stop instead of an empty Send, so
  "Steer the agent…" fits on one line.
- Codex: Stop also ends the command the agent was running, instead of leaving it running in the
  background.
- Codex: commands on cards and approval prompts read `npm test`, not `/bin/zsh -lc 'npm test'`.
- Codex: sub-agents Codex starts on its own show as a card and a "finished: …" notice, and Glade's
  sub-agent tools no longer clash with Codex's built-in ones.
- iPhone: a chat whose Mac drops no longer goes blank; it says the Mac can't be reached, with Retry.
- Choosing a folder in "Move to Folder" (or any other submenu item) now works; the click used to
  close the menu without doing anything.
- Opening a search result flashes the matching message again (it flashed an invisible timestamp).
- The menu bar menu stays open while it updates (e.g. when a chat finishes as you look at it).
- The Send button stays in place while an agent works (disabled until you type), and Ask Aside
  is a solid violet button that matches Stop and Send; side-question cards use the same violet.
- Picking a device (or any option from a menu) inside a dialog no longer closes the dialog, so
  you can create a project on another device again.
- Sub-agent cards and chips say "Thinking…" between steps instead of flashing "Starting…".
- Very wide images in chats shrink to fit instead of being cut off.
- Links in the Mac app open in your default browser again (chats, tool output, settings, dialogs),
  and the app never navigates away from Glade.
- "Open in VS Code" in a worktree chat opens the worktree, not the main project folder.
- The thinking picker and context meter no longer disappear after a Glade server restarts or hands a
  chat back.
- Paragraphs in replies have space between them again, so separate paragraphs are easy to tell apart.
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
