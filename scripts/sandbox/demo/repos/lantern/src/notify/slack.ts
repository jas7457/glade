import type { Alert, Notifier } from "./index.js";

export function slackNotifier(webhookUrl: string): Notifier {
  return {
    async send({ check, result, kind }: Alert) {
      const icon = kind === "down" ? ":red_circle:" : ":large_green_circle:";
      const detail = result.error ?? `HTTP ${result.status} in ${result.latencyMs} ms`;
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `${icon} *${check.name}* is ${kind === "down" ? "down" : "back up"} (${detail})` }),
      });
    },
  };
}
