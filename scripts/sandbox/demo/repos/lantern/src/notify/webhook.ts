import type { Alert, Notifier } from "./index.js";

export function webhookNotifier(url: string, headers: Record<string, string> = {}): Notifier {
  return {
    async send(alert: Alert) {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          event: alert.kind === "down" ? "check.down" : "check.recovered",
          check: { id: alert.check.id, name: alert.check.name, url: alert.check.url },
          result: alert.result,
        }),
      });
    },
  };
}
