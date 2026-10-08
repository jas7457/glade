import type { CheckConfig, NotifierConfig } from "../config.js";
import type { CheckResult } from "../checks/http.js";
import { slackNotifier } from "./slack.js";
import { webhookNotifier } from "./webhook.js";

export interface Alert {
  check: CheckConfig;
  result: CheckResult;
  kind: "down" | "recovered";
}

export interface Notifier {
  send(alert: Alert): Promise<void>;
}

export function createNotifier(configs: NotifierConfig[]): Notifier {
  const targets = configs.map((config) => {
    switch (config.type) {
      case "slack":
        return slackNotifier(config.webhookUrl);
      case "webhook":
        return webhookNotifier(config.url, config.headers);
    }
  });
  return {
    async send(alert) {
      await Promise.all(targets.map((t) => t.send(alert)));
    },
  };
}
