# Lantern

A tiny self-hosted uptime monitor. Point it at a few URLs, and Lantern checks them on a schedule,
keeps 30 days of results in SQLite, serves a status dashboard and tells Slack (or any webhook)
when something goes down or comes back.

```bash
npx lantern serve --config lantern.config.json   # dashboard on http://localhost:7070
npx lantern check https://example.com            # one-off check
```

## Configuration

```json
{
  "checks": [
    { "id": "api", "name": "Public API", "url": "https://api.example.com/health", "intervalSec": 30, "timeoutMs": 5000 }
  ],
  "notify": [{ "type": "slack", "webhookUrl": "https://hooks.slack.com/services/…" }]
}
```

| Field         | Default | What it does                              |
| ------------- | ------- | ----------------------------------------- |
| `intervalSec` | 60      | Seconds between two runs of the check     |
| `timeoutMs`   | 10000   | A response slower than this counts as down |
| `expectStatus`| 200–399 | Status codes that count as up             |

## Development

```bash
pnpm install
pnpm dev     # API + dashboard with reload
pnpm test
```

MIT licensed.
