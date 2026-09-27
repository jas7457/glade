# AGENTS.md — how we work on pi-ui

pi-ui is a desktop-style GUI for the [pi](https://github.com/earendil-works/pi) coding agent
(web app now, packaged with Tauri later). Read `docs/ARCHITECTURE.md` before changing code.

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

## Issue queue

When the user reports issues or ideas, follow `.agents/skills/issue-queue/SKILL.md`: record them
in the `## Inbox` section of PLAN.md and **do not start work** until the user says "go". Then split
the queue into sub-agent workstreams by file ownership, integrate, tick items, and commit.

## Commands

```bash
pnpm install
pnpm dev            # server (:4317) + web (:5317). Open http://127.0.0.1:5317
PI_UI_HARNESS=fake pnpm dev   # UI development without an LLM / pi
pnpm dev:agent --name <agent> [--real] [--keep]   # agents: throwaway sandbox (see below)
pnpm test           # all vitest projects
pnpm typecheck      # all packages
pnpm check          # typecheck + test — must pass before you commit
```

## Testing as an agent: use a sandbox (I-052)

The servers on :4317/:5317 and the data folder (`~/Library/Application Support/pi-ui`) belong to
the user. **Agents never write to them**: no creating/renaming/deleting chats or projects, no
prompts, no settings changes, no `PI_UI_DATA_DIR` pointing at the real folder. Read-only
screenshots of the user's running app are fine. For anything that writes data, start a sandbox:

```bash
pnpm dev:agent --name <agent> > /tmp/pi-ui-<agent>.log 2>&1 &   # background it, then read the log
#   prints Web http://127.0.0.1:<port>, API http://127.0.0.1:<port>/api, data/repo/log paths
pnpm dev:agent --name <agent> --real    # real pi harness (costs tokens: one short prompt, e.g.
                                        #   claude-haiku-4-5 with thinking off)
pnpm dev:agent --name <agent> --stop    # done: stops it and deletes everything it created
```

- Each sandbox has its own free ports (never 4317/5317) and data under
  `/tmp/pi-ui-sandbox/<name>`, seeded with a project (`sample-repo`, a small git repo) and a few
  chats. The fake harness is the default; use `--real` only when the task needs real pi.
- Same `--name` = shared sandbox (ref-counted); different names = separate sandboxes.
- The server runs under `tsx watch` and the web under Vite, so your edits reload live.
- **Clean up**: stop your sandbox when done (`--stop`, Ctrl-C, or `kill <pid>` of the
  `pnpm dev:agent` process). The last user out deletes the folder and the pi session files its
  chats created in `~/.pi/agent/sessions`. `--keep` keeps it for inspection (resumed by the next
  start with that name; otherwise swept after 24h). `pnpm dev:agent --sweep` removes every
  sandbox nobody uses.
- Server tests still use `FakeHarness` in-process (`pnpm test`), no sandbox needed.

## Rules

- **TypeScript everywhere**, strict mode. No `any` unless unavoidable and commented.
- **Tests as we go.** New logic ships with tests (Vitest). Pure logic (reducers, translators,
  grouping) gets unit tests; components get @testing-library/preact tests for behaviour that
  matters; the server is tested against `FakeHarness`, never a real LLM.
- **Harness-agnostic UI.** Nothing outside `apps/server/src/harness/<name>/` may know about a
  specific agent's wire format. Everything crosses the boundary as `@pi-ui/protocol` types.
- **Reusable components.** UI primitives live in `apps/web/src/ui/` and are the only place raw
  styling decisions are made. Features compose primitives. If you need a new kind of control,
  add a primitive rather than one-off styling.
- **Native look.** Follow macOS conventions: system font, 13px base, compact controls, no hover
  pointer cursors, subtle separators, chrome text not selectable. Use semantic color tokens from
  `styles.css` (`bg-surface`, `text-fg-muted`, `border-separator`…), never raw colors.
- **State** lives in Preact signals under `apps/web/src/state/`. Components read signals; side
  effects go through the action functions there.
- **Routing**: every screen is routable (refresh keeps you in place). Build paths with
  `apps/web/src/app/routes.ts` helpers.
- Keep files focused; prefer small modules with a header comment explaining their role.
- Commit messages: imperative, scoped, e.g. `chat: group consecutive tool calls`.
