# Contributing to Glade

Glade is a Tauri macOS app and a web UI over a local Node server. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing code, and [AGENTS.md](AGENTS.md) for
how work is planned and recorded ([PLAN.md](PLAN.md), [CHANGELOG.md](CHANGELOG.md)). Coding agents
follow AGENTS.md too.

## Develop

Requires Node ≥ 22.13 (for its built-in SQLite), pnpm, and at least one agent CLI on your PATH
(`pi`, `claude` or `codex`). Rust and the Xcode Command Line Tools for the Mac app.

```bash
pnpm install
pnpm dev                        # server :4317 + web :5317 → http://127.0.0.1:5317
GLADE_HARNESS=fake pnpm dev     # no LLM needed
pnpm check                      # typecheck + tests (must pass before a commit)
pnpm tauri:install              # build the Mac app into /Applications
```

## Sandboxes

`pnpm dev:agent --name <name> [--real] [--keep] [--demo]` starts a throwaway Glade (server + web)
on free ports with its own sample data under `/tmp/glade-sandbox/<name>`, so you and coding agents
can test without touching your data folder or your servers on :4317/:5317. It's deleted
(including the pi session files its chats created) when the last process using it exits.
`--stop` stops a sandbox, `--sweep` removes abandoned ones. `--demo` seeds the scripted demo used
for the website's screenshots and videos (`pnpm capture` re-records them; see
[site/public/media/README.md](site/public/media/README.md)). Details in
[AGENTS.md](AGENTS.md#testing-as-an-agent-use-a-sandbox-i-052).

## Developing Glade from inside Glade

The installed app always runs its own server and shares your data folder safely with `pnpm dev`
running at the same time: chats created in one show up in the other within a second, and a chat
that's working in one is read-only in the other. So:

- Do your real work (the chats that orchestrate agents) in the **installed app**.
- Run **`pnpm dev`** alongside it. When an agent edits `apps/server/**`, only the dev server
  restarts; chats running in the app keep going. Chats running *in the dev server* stop and show
  as interrupted (with Continue).
- Agents test only in **`pnpm dev:agent`** sandboxes, never against the app or your data folder.
- **`pnpm tauri:install`** builds and replaces `/Applications/Glade.app` without quitting the
  running app; Glade then restarts into the new version once no chat is working.

See [AGENTS.md](AGENTS.md#dogfooding-developing-glade-from-inside-glade-i-058).

## Website

The site lives in [`site/`](site/) (Vite + GSAP) and deploys to GitHub Pages from `main`:
`pnpm --filter @glade/site dev`.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
