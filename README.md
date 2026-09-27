# pi-ui

A native-feeling desktop GUI for the [pi](https://github.com/earendil-works/pi) coding agent:
projects mapped to folders on disk, multiple chats per project, streaming markdown, grouped tool
calls, and model/thinking pickers right in the composer.

```bash
pnpm install
pnpm dev                        # http://127.0.0.1:5317
PI_UI_HARNESS=fake pnpm dev     # no LLM needed
pnpm check                      # typecheck + tests
```

### Sandboxes for agents

`pnpm dev:agent --name <agent> [--real] [--keep]` starts a throwaway pi-ui (server + web) on free
ports with its own sample data under `/tmp/pi-ui-sandbox/<name>`, so coding agents can test
without touching your data folder or your servers on :4317/:5317. It is deleted (including the pi
session files its chats created) when the last process using it exits. `--stop` stops a sandbox,
`--sweep` removes abandoned ones. See [AGENTS.md](AGENTS.md#testing-as-an-agent-use-a-sandbox-i-052).

Requires Node ≥ 22 and `pi` on your PATH (configurable in Settings → Agent).

- Plan & progress: [PLAN.md](PLAN.md) · Changes: [CHANGELOG.md](CHANGELOG.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Contributor/agent rules: [AGENTS.md](AGENTS.md)
