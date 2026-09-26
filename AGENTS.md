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
pnpm test           # all vitest projects
pnpm typecheck      # all packages
pnpm check          # typecheck + test — must pass before you commit
```

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
