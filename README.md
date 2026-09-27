# Glade

A native-feeling desktop GUI for the [pi](https://github.com/earendil-works/pi) coding agent:
projects mapped to folders on disk, multiple chats per project, streaming markdown, grouped tool
calls, and model/thinking pickers right in the composer.

```bash
pnpm install
pnpm dev                        # http://127.0.0.1:5317
GLADE_HARNESS=fake pnpm dev     # no LLM needed
pnpm check                      # typecheck + tests
```

### Sandboxes for agents

`pnpm dev:agent --name <agent> [--real] [--keep]` starts a throwaway Glade (server + web) on free
ports with its own sample data under `/tmp/glade-sandbox/<name>`, so coding agents can test
without touching your data folder or your servers on :4317/:5317. It is deleted (including the pi
session files its chats created) when the last process using it exits. `--stop` stops a sandbox,
`--sweep` removes abandoned ones. See [AGENTS.md](AGENTS.md#testing-as-an-agent-use-a-sandbox-i-052).

### Desktop app and dogfooding

`pnpm tauri:install` builds the macOS app and installs it as `/Applications/Glade.app`. The app
always runs its own server, and it shares your data folder safely with `pnpm dev` running at the
same time: chats created in one show up in the other within a second, and a chat that is working
in one is read-only in the other ("Running in Glade (dev) — open it there or wait until it's
idle"). So you can develop Glade *from inside Glade*:

- Do your real work (the chats that orchestrate agents) in the **installed app**.
- Run **`pnpm dev`** alongside it for development. When an agent edits `apps/server/**`, only the
  dev server restarts; chats running in the app keep going. Chats running *in the dev server*
  stop and show as interrupted (with Continue).
- Agents test only in **`pnpm dev:agent`** sandboxes, never against the app or your data folder.
- **Update the app with `pnpm tauri:install --when-idle`**: it builds first, then waits (showing
  which chats it's waiting for) until no chat on the app's server is working or waiting for
  input, then quits the app and installs. Without `--when-idle`, quitting asks for confirmation
  if chats are working and the install stops if you cancel.

See [AGENTS.md](AGENTS.md#dogfooding-developing-glade-from-inside-glade-i-058) for details.

**Renamed from pi-ui** (I-059): on its first start Glade copies your data from
`~/Library/Application Support/pi-ui` into `~/Library/Application Support/Glade` (the old folder
stays as a backup), and the old `PI_UI_*` environment variables still work as fallbacks for the
new `GLADE_*` ones.

Requires Node ≥ 22 and `pi` on your PATH (configurable in Settings → Agent).

- Plan & progress: [PLAN.md](PLAN.md) · Changes: [CHANGELOG.md](CHANGELOG.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Contributor/agent rules: [AGENTS.md](AGENTS.md)
