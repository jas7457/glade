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

Requires Node ≥ 22 and `pi` on your PATH (configurable in Settings → Agent).

- Plan & progress: [PLAN.md](PLAN.md) · Changes: [CHANGELOG.md](CHANGELOG.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Contributor/agent rules: [AGENTS.md](AGENTS.md)
