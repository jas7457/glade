# AGENTS.md — how we work on Glade

Glade (formerly pi-ui, renamed in PLAN.md I-059) is a native-feeling macOS app (Tauri) and web UI
for coding agents. It runs the [pi](https://github.com/earendil-works/pi) harness today and is
designed to support other harnesses (e.g. Claude Code) later. Read
`docs/ARCHITECTURE.md` before changing code.

## Picking up where we left off (new sessions start here)

1. Read `PLAN.md` top to bottom: `## Inbox` holds every open item (`- [ ] **I-###**`) with the
   user's intent (in the agent's own words, never quotes: see the issue-queue skill), notes, decisions and open questions; ticked items have an `Outcome:` line.
   `## Future features` holds ideas that are *not* planned. Look for "Open question" and
   "Status:" lines: they are the loose ends.
2. Skim `CHANGELOG.md` `[Unreleased]` for what the user already has, and `git log --oneline -20`.
3. Nothing is started without the user's "go" (see Issue queue). When in doubt, summarise the open
   Inbox items and ask.

Related repos and places:
- GitHub: `jas7457/glade` (private; formerly `jas7457/pi-ui`, which redirects). Push after every commit.
- `the extension kit` (separate git repo): the user's pi extensions, incl. `extensions/agent-teams`
  (`spawn_agent`, `message_agent`, …) with a cmux backend and a Glade backend (`glade.ts`, used
  when `GLADE_URL`/`GLADE_TOKEN` are set; the pre-rename `PI_UI_*` names work too). Changes
  there are committed and pushed there.
- pi itself: installed globally (`which pi`); docs in its package's `docs/` folder (rpc.md,
  session-format.md, extensions.md, skills.md).
- User data: `~/Library/Application Support/Glade`; pi sessions: `~/.pi/agent/sessions`.

## The ledger (mandatory)

We keep a strict ledger of planned and finished work:

1. **`PLAN.md`** is the single source of truth for what is planned. Every piece of work must map
   to a checklist item there. If you are asked to do something that isn't listed, add it first
   (in the right phase), then do it.
2. When an item is finished, tick it (`- [x]`) **in the same change** that implements it, and
   append the date: `- [x] Thing (2026-09-26)`.
3. **`CHANGELOG.md`** gets a matching entry under `## [Unreleased]` for every ticked item,
   grouped by `Added` / `Changed` / `Fixed` / `Removed` (Keep a Changelog format). Write it for
   a user, not a compiler: what can they do now?
4. Never delete plan items. If something is dropped, strike it through and say why:
   `- [ ] ~~Thing~~ — dropped: reason`.
5. Decisions that shape the codebase go in the "Decisions" section of `docs/ARCHITECTURE.md`.
6. **Write the user's intent, never their words.** PLAN.md, docs, commit messages and code comments
   describe what the user wants and decided in your own words; no verbatim quotes (the repo is going
   public, and dictated requests ramble). No personal paths or private-project details either.

## Issue queue

When the user reports issues or ideas, follow `.agents/skills/issue-queue/SKILL.md`: record them
in the `## Inbox` section of PLAN.md and **do not start work** until the user says "go". Then split
the queue into sub-agent workstreams by file ownership, integrate, tick items, and commit.
Ideas for later go to `## Future features` in PLAN.md (`F-###` ids) and are never worked on until the
user promotes them to the Inbox.

## Lead routine (the session coordinating sub-agents)

- Split work by **file ownership** so parallel workers never edit the same files; do shared
  protocol/API contract changes yourself first. Workers never stage or commit and never edit
  PLAN.md/CHANGELOG.md.
- While workers run, commit **explicit paths only** (`git add <paths>`; `git commit -- <paths>`),
  never `git add -A`, so another worker's half-finished files aren't swept in. If a shared file
  mixes two workers' changes, wait and commit both together.
- Before pushing, verify the commit in a clean worktree:
  `git worktree add /tmp/glade-verify HEAD && cd /tmp/glade-verify && pnpm install --offline --frozen-lockfile && pnpm typecheck && pnpm test`
  (then `git worktree remove --force /tmp/glade-verify`).
- Tick the Inbox items (`Outcome:` line), add CHANGELOG entries, record decisions in
  `docs/ARCHITECTURE.md`, push.
- **Only install the app when the user explicitly asks** (`pnpm tauri:install`; needs
  `. "$HOME/.cargo/env"` in non-login shells). Building takes a while, so never run it on your own
  after a round or a fix; offer it instead. It doesn't quit the running app; the user reopens it.

## Commands

```bash
pnpm install
pnpm dev            # server (:4317) + web (:5317). Open http://127.0.0.1:5317
GLADE_HARNESS=fake pnpm dev   # UI development without an LLM / pi
pnpm dev:agent --name <agent> [--real] [--keep]   # agents: throwaway sandbox (see below)
pnpm test           # all vitest projects
pnpm typecheck      # all packages
pnpm check          # typecheck + test — must pass before you commit
```

## Testing as an agent: use a sandbox (I-052)

The servers on :4317/:5317 and the data folder (`~/Library/Application Support/Glade`) belong to
the user. **Agents never write to them**: no creating/renaming/deleting chats or projects, no
prompts, no settings changes, no `GLADE_DATA_DIR` pointing at the real folder. Read-only
screenshots of the user's running app are fine. For anything that writes data, start a sandbox:

```bash
pnpm dev:agent --name <agent> > /tmp/glade-<agent>.log 2>&1 &   # background it, then read the log
#   prints Web http://127.0.0.1:<port>, API http://127.0.0.1:<port>/api, data/repo/log paths
pnpm dev:agent --name <agent> --real    # real pi harness (costs tokens: one short prompt, e.g.
                                        #   claude-haiku-4-5 with thinking off)
pnpm dev:agent --name <agent> --stop    # done: stops it and deletes everything it created
```

- Each sandbox has its own free ports (never 4317/5317) and data under
  `/tmp/glade-sandbox/<name>`, seeded with a project (`sample-repo`, a small git repo) and a few
  chats. The fake harness is the default; use `--real` only when the task needs real pi.
- Same `--name` = shared sandbox (ref-counted); different names = separate sandboxes.
- The server runs under `tsx watch` and the web under Vite, so your edits reload live.
- **Clean up**: stop your sandbox when done (`--stop`, Ctrl-C, or `kill <pid>` of the
  `pnpm dev:agent` process). The last user out deletes the folder and the pi session files its
  chats created in `~/.pi/agent/sessions`. `--keep` keeps it for inspection (resumed by the next
  start with that name; otherwise swept after 24h). `pnpm dev:agent --sweep` removes every
  sandbox nobody uses.
- Server tests still use `FakeHarness` in-process (`pnpm test`), no sandbox needed.
- Claude Code (I-173) is offered in sandboxes too when `claude` is installed, and it is **real**
  (it uses the user's login and costs money). Don't pick it unless the task needs a real Claude run;
  then use `haiku`, thinking off, and `GLADE_CLAUDE_MAX_BUDGET_USD=0.05` / `GLADE_CLAUDE_MAX_TURNS=4`.

## Dogfooding: developing Glade from inside Glade (I-058)

The user develops Glade with the installed app (`/Applications/Glade.app`). The setup:

- **The installed app is for real work.** Its chats (including the one orchestrating a round of
  sub-agents) run in the app's own server (`GLADE_SERVER_KIND=desktop`, a free port). Sub-agents
  run in the same server as their parent chat.
- **`pnpm dev` runs alongside it** on the same data folder (`:4317`/`:5317`). That's safe (I-062):
  every server has its own agent processes; shared files are written under a lock and watched;
  a chat runs in one server at a time (session leases). In the other server it is read-only
  while it's working, and typing in it takes it over once it's idle there.
- **Agents never touch either of them**: the rules in "Testing as an agent" still apply, test in
  `pnpm dev:agent` sandboxes only. Agent processes don't inherit the app server's port/host/kind
  (`GLADE_PORT`, `GLADE_SERVER_KIND`, … are stripped, see `harness/pi/child-env.ts`).
- **Updating the app**: `pnpm tauri:install` builds and swaps the new bundle into
  `/Applications/Glade.app` without quitting the running app (I-082); the new version starts the
  next time the user quits and reopens Glade. Agents don't install; the lead does, only when the user asks for it. To test a
  release build next to the installed app, run its binary with a temp data folder and its own
  identifier: `GLADE_APP_IDENTIFIER=io.github.jas7457.glade.<agent> GLADE_DATA_DIR=/tmp/…
  apps/desktop/src-tauri/target/release/bundle/macos/Glade.app/Contents/MacOS/glade`.

What happens to running chats when a server stops:

| Event | Chats running in that server | Chats running in the other server |
| --- | --- | --- |
| `tsx watch` restarts the dev server (an agent edited `apps/server/**`) | cut off; shown as interrupted (Continue) | unaffected |
| App quit (e.g. to start a newly installed version) | quit asks first if any are working/blocked; cut-off runs show as interrupted (the dev server marks them within ~2s) | unaffected |
| A server crashes | the other server marks its runs interrupted within ~2s | unaffected |

So: keep orchestrating chats in the app, and don't quit it in the middle of a round.

## Rules

- **TypeScript everywhere**, strict mode. No `any` unless unavoidable and commented.
- **Tests as we go.** New logic ships with tests (Vitest). Pure logic (reducers, translators,
  grouping) gets unit tests; components get @testing-library/preact tests for behaviour that
  matters; the server is tested against `FakeHarness`, never a real LLM.
- **Harness-agnostic UI.** Nothing outside `apps/server/src/harness/<name>/` may know about a
  specific agent's wire format. Everything crosses the boundary as `@glade/protocol` types.
- **Shared client core.** The desktop web UI (`apps/web`) and the iPhone app (`apps/iphone`) share
  `packages/app-core` (`@glade/app-core`): UI primitives, state, the chat feature, the API client.
  Import it as `@glade/app-core/<path under src>` (e.g. `@glade/app-core/state/store`); `@/…` in
  `apps/web` is the desktop layout only. Desktop-only code (sidebar, tabs, settings, palette,
  Mac-shell bridges) stays in `apps/web`; app-core never imports from an app.
- **Reusable components.** UI primitives live in `packages/app-core/src/ui/` and are the only place raw
  styling decisions are made. Features compose primitives. If you need a new kind of control,
  add a primitive rather than one-off styling.
- **Native look.** Follow macOS conventions: system font, 13px base, compact controls, no hover
  pointer cursors, subtle separators, chrome text not selectable. Use semantic color tokens from
  `packages/app-core/src/styles.css` (`bg-surface`, `text-fg-muted`, `border-separator`…), never raw colors.
- **State** lives in Preact signals under `packages/app-core/src/state/`. Components read signals; side
  effects go through the action functions there.
- **Routing**: every screen is routable (refresh keeps you in place). Build paths with
  `packages/app-core/src/app/routes.ts` helpers.
- Keep files focused; prefer small modules with a header comment explaining their role.
- Commit messages: imperative, scoped, e.g. `chat: group consecutive tool calls`.
