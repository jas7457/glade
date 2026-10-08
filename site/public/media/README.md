# Website media

Screenshots and videos of Glade for the website (I-209). The script that makes them is
`tools/capture/capture.mjs`. Everything is recorded from the **demo sandbox** (`pnpm dev:agent --demo`), never from
anyone's real chats. The demo is a made-up open-source project, "Lantern", a small TypeScript
uptime monitor, with scripted conversations played by stand-ins for pi, Claude Code and Codex
(`apps/server/src/harness/demo/`). The repo, diffs, worktree and changes are real files in the
sandbox.

## Regenerate

```bash
pnpm install
pnpm --filter @glade/capture exec playwright-core install ffmpeg   # once: Playwright's ffmpeg (WebM)
open -a Xcode                                                       # the iPhone shots drive the simulator through Xcode
pnpm capture                       # everything, ~6 min: starts a fresh demo sandbox and removes it after
pnpm capture --only hero,search    # some items (re-recorded in a fresh sandbox)
pnpm capture --only hero-story     # the hero story (runs last: it trims the sidebar first)
pnpm capture --no-iphone           # skip the simulator
```

Needs Google Chrome (`/Applications/Google Chrome.app`, driven headless by Playwright), Xcode
with the iPhone 18 Pro simulator (see `docs/design/iphone-app.md` §3) and macOS's own `swiftc` /
`sips`. MP4s are encoded with AVFoundation (`tools/capture/lib/encode-mp4.swift`), so no system
ffmpeg is needed. The capture builds the web app once and the sandbox's server serves that
build without watching for changes, so edits made elsewhere during a run don't show up in it.
The run is scripted and the content is the same every time. Ages ("2m") and clock times come from
the moment you capture.

## Formats

- **Mac stills**: PNG, 2880×1800 (1440×900 CSS px, rendered at 3× and saved at 2×), dark mode.
  The window content only: no shadow and no rounded corners (the site draws those). Chrome renders
  the web UI dressed like the Mac app: `<html data-desktop>` (the app's own translucent, tinted
  sidebar), a plain dark stand-in for the window's vibrancy behind it, and traffic-light buttons
  at the top left (`tools/capture/lib/browser.mjs`).
- **Videos**: 30 fps, muted, 1920×1200 (recorded at 2×): `<name>.webm` (VP9) + `<name>.mp4` (H.264)
  + `<name>.png` (the poster, the video's first frame at the same size; `subagent-tabs` uses a
  frame from the middle instead, for it and its focus clip, since its first frame has no side pane yet).
- **Hero story** (`hero-story.*`): 30 fps, 2880×1800 (1440×900 CSS px at 2×, the window's full
  sharpness, for showing it large), WebM + MP4 + poster PNG (the first frame), plus
  `hero-story.json`: `{ width, height, duration, steps: [{ id, label, caption, start, end, rect }] }`.
  `width`/`height` are the window in CSS px; `start`/`end` are seconds into the video; `rect`
  (`{ x, y, w, h }`, CSS px) is the element that step is about, measured in the page during the
  recording. `caption` is an optional one-line sentence for the step.
- **Focus versions** (every feature asset except the heroes, `agents-claude` and the iPhone shots):
  `<name>-focus.png` for stills (only the region that matters, rendered at 3×, so text is large and
  sharp). For videos, `<name>-focus.webm` / `.mp4` / `.png`: the region cropped from the same
  recording at its full 2× resolution, plus its poster. `focus.json` gives each region as
  `{ x, y, w, h }` in the full capture's CSS px (the 1440×900 window), so the site can zoom from the
  whole window into it. Focus regions are kept between about 1.6:1 and 3.4:1 (never taller than
  16:10) so each fits on one screen next to its text. A focus video may cover only part of its
  recording (`search-focus`: while the palette is open).
- **iPhone**: PNG, 1206×2622 bare simulator screenshots (iPhone 18 Pro, dark, status bar 9:41 and full
  battery), no device frame.

## Files

| File | What it shows |
| --- | --- |
| `hero-story.webm` / `.mp4` / `.png` / `.json` | ~23 s, the website's hero. One story from an empty New Chat in the project: the agent menu (pi, Claude Code, Codex) opens briefly over the composer with its model and thinking pickers; a question is typed ("Every hour the checks stall … Can you find out why and fix it?"); on send the chat appears at the top of the project in the sidebar with a quick title, then its generated one ("Speed up pruning old results"); the reply thinks (opened), runs a group of three calls (read, search, query plan; opened so they appear one by one), edits `src/store.ts` (its diff opened), times the fix and runs the tests, then a short summary; the header shows 1 changed file. The sidebar is trimmed to three project chats and two standalone ones; no side panes. Steps in the JSON: `agent` (Pick an agent), `ask` (Ask), `sidebar` (It shows up in the sidebar), `work` (Watch it work), `done` (Done). |
| `hero.webm` / `.mp4` / `.png` | ~15 s. A follow-up typed into a pi chat ("add jitter … update the README and tests in parallel"). Thinking, grouped reads, two sub-agents spawned (their cards and the chips above the composer update as they work), edits, a type check, then the summary once both report. The sidebar shows the project's other chats. |
| `subagents.webm` / `.mp4` / `.png` | ~14 s. A new chat sends three sub-agents off in parallel (API validation, SQLite query plans, server tests). Their cards and the chips above the composer update as they work, the reports land, and a summary table follows. Focus: the cards and the summary below them (16:10). |
| `subagent-tabs.webm` / `.mp4` / `.png` | ~19 s. A new chat ("make Lantern easy to self-host") sends three sub-agents off: Docker image, health check route, deployment guide. At ~1 s the Docker agent's card opens its tab in the side pane (widened to 2/3; tabs for all three agents): its task, its thinking, a group of reads, then its writes and `docker build` (opened as they come in). From ~5 s a message is typed in its own composer ("Also keep the SQLite database on a volume, so the results survive a redeploy.") and sent at ~9 s; it's delivered once the build finishes (a steer), and the agent answers: its thinking (opened), "Good call. `dbPath` defaults to…", then the adjusted work (Dockerfile edited +5 −1, rebuild, a check that the database survives a new container) and its report at ~17 s. The other two agents finish around 15 s and their tabs close; the one you wrote to stays open, and the chat starts its summary. Poster: ~13 s (all three tabs, the message, the answer). Focus: the side pane from its tabs down (16:10, from when it opens); the pane's content is kept in that region by extra space at its bottom, so the latest lines stay in frame. The chat is deleted after the capture. |
| `search.webm` / `.mp4` / `.png` | ~8 s. ⌘K, typing "backoff": a chat, a message and two bookmarks come up. Picking the bookmark jumps to its message in another chat. Focus: the palette, ~3.4 s from when the query has narrowed the list until just before Enter, cropped to the palette's largest extent in that time, so it stays in frame throughout. |
| `composer.webm` / `.mp4` / `.png` | ~6 s, optional. While pi works, a message is typed and the Send button changes as ⌘ (follow-up) and ⌥ (ask aside) are held. Focus: the composer and the agent working above it (3:1). |
| `agents.png` | New chat in the project with the agent menu open: pi (default), Claude Code, Codex. Focus: the menu over the composer. |
| `agents-settings.png` | Settings → Agents: pi, Claude Code and Codex installed and enabled. Focus: the agents list. |
| `agents-claude.png` | A Claude Code chat (Claude Sonnet 5.5, Accept edits mode) fixing a chart flicker. (Extra, no focus.) |
| `worktrees.png` | A worktree chat (branch `discord-notifier`) with the changes panel open and two files' diffs expanded. Focus: the top of the changes panel (the files and the start of a diff, 16:10). |
| `bookmarks.png` | A chat with sub-agent cards, a bookmarked reply (the ribbon) and the header's Bookmarks list open. Focus: the list, the cards and the ribboned reply. |
| `terminal.png` | A terminal tab next to the chat tab: `git log`, `git status`, `pnpm test`. Focus: the tabs and the terminal's output (inside the chat column: no sidebar edge). |
| `local-models.png` | Settings → Local Models: llama-server with Qwen3.8 14B loaded, used by one chat. Focus: the memory bar and the models list. |
| `remote.png` | Settings → Remote Access: sharing on over Tailscale, a MacBook Air and the iPhone connected. Focus: Connections (Connect/Share and the two devices). |
| `iphone-list.png` | iPhone: the chat list (the project and standalone chats). |
| `iphone-chat.png` | iPhone: the hero's chat (sub-agent cards and the summary). |
| `iphone-voice.png` | iPhone: conversation mode reading a reply aloud, with the current word highlighted. |
| `iphone-voice-chat.png` | iPhone: the same moment minimized into the chat: the highlight follows in the reply. (Extra.) |
| `focus.json` | The focus regions (see Formats). |

## How it's faked (all in the sandbox only)

- **Agents**: `GLADE_HARNESS=demo` registers scripted harnesses with the ids and labels `pi`,
  `claude`, `codex`. It only turns on in a `pnpm dev:agent` sandbox with a temporary data folder
  (`harnessMode` in `apps/server/src/config.ts`). A message typed while one works (a steer) is
  delivered after its current tool calls, like pi's; a sub-agent script's `onMessage` is its
  scripted answer (the Docker agent in `subagent-tabs`).
- **Local models**: `scripts/fake-llama-server.mjs --demo`. The memory bar's total is the RAM
  of the Mac you capture on.
- **Tailscale**: `scripts/sandbox/demo/fake-tailscale.mjs` via `GLADE_TAILSCALE_CLI`. The MacBook
  Air is paired through the real invite flow by the seed script; the iPhone simulator is paired
  for real over loopback (its address is shown as a tailnet one).
- **Terminal**: zsh with the sandbox's own `ZDOTDIR` (a clean prompt, no user dotfiles); `pnpm test`
  there prints canned Vitest output.
- **Voice**: the iPhone debug build is launched with `--glade-fake-voice`, which uses the app's fake
  voice engine, because speech recognition doesn't start in the simulator. The reply is read
  word by word.
